# TVD OTA FareIQ :: deployment runbook

Everything needed to take this repository from nothing to a platform producing
approved price changes every morning. Follow it in order; each stage depends on
the one before it.

Read time twenty minutes. Execution time about four hours of hands-on work,
spread across roughly two weeks of waiting for accounts, contracts and the
first fortnight of collected history.

**Conventions.** Commands run from the repository root on a machine with
`gcloud`, `bq`, `docker`, `git`, `node` and Python 3.11. Every script is
idempotent: rerunning after a partial failure is the normal recovery path, not
a risk.

---

## Contents

| Stage | What it does | Time | Blocking? |
|---|---|---|---|
| [0](#stage-0--before-you-touch-a-console) | Prerequisites and decisions | 1 week lead | Yes |
| [1](#stage-1--project-bootstrap) | Project, APIs, bucket, registry, secrets | 20 min | Yes |
| [2](#stage-2--identity-and-access) | Service accounts, IAM, groups | 30 min | Yes |
| [3](#stage-3--the-warehouse) | Datasets, tables, views | 15 min | Yes |
| [4](#stage-4--seed-the-configuration) | Routes, sellers, rules, FX | 20 min | Yes |
| [5](#stage-5--cicd) | GitHub, Workload Identity Federation | 30 min | No |
| [6](#stage-6--the-services) | Build and deploy Cloud Run | 25 min | Yes |
| [7](#stage-7--the-schedule) | Cloud Scheduler jobs | 10 min | Yes |
| [8](#stage-8--the-dashboard) | Apps Script web app | 45 min | Yes |
| [9](#stage-9--the-configuration-workbook) | Google Sheet and triggers | 30 min | Yes |
| [10](#stage-10--first-run-and-verification) | End to end, checked | 1 hour | Yes |
| [11](#stage-11--the-shadow-fortnight) | Run without acting | 2 weeks | Yes |
| [12](#stage-12--go-live) | Hand it to the pricing team | 1 hour | Yes |
| [13](#operations) | Running it, and fixing it | ongoing | |

---

## Stage 0 :: before you touch a console

These take days to obtain, so start them first and do the technical work while
you wait.

### Decisions that cannot be changed later

| Decision | Recommended | Why it is irreversible |
|---|---|---|
| BigQuery location | `europe-west2` | Cross-region joins are not permitted. Moving a year of history means a rebuild. |
| Base currency | `NGN` | Every historical figure is stored converted. Changing it invalidates all history. |
| Project layout | One project | Splitting later means re-granting every IAM binding and moving every dataset. |

On location: `africa-south1` is closer to Lagos, but check BigQuery ML and BI
Engine availability there before choosing it. For a batch pipeline the latency
difference is not material; the feature difference might be.

### Access and accounts to request now

- **GCP** project creator or Owner on an existing project, plus a billing
  account. A budget of USD 300 a month covers the first quarter comfortably.
- **Google Workspace** admin able to create three groups and approve an Apps
  Script web app that reads group membership.
- **Amadeus Self-Service** production credentials. Test credentials return
  cached data and will make everything look fine while being wrong.
- **Sabre** client id, client secret and your PCC. Use the certification host
  (`api-crt.cert.havail.sabre.com`) until parsing is proven.
- **Verteil** onboarding pack: base URL, shop path, NDC version and auth
  headers. These differ per account, which is why the adapter reads them from
  the secret rather than hard-coding them.
- **Direct airline NDC** credentials, one carrier at a time. This is the only
  one of the four that is a genuine competitor benchmark rather than a supply
  cost, so prioritise the carriers that matter most on LOS routes.
- **Licensed competitor feed**, optional but worth starting now. It is the
  only source that answers "what is a rival OTA charging", and contracting
  takes three to six weeks. Without it the competitor panel is airline-direct
  only and most cells will correctly refuse to price.
- **Your own booking engine** read API, returning net fare and supplier cost.
  Confirm supplier cost is available per booking before anything else; if it
  is not, the margin half of the platform is unbuildable and you want to know
  in week one.

### Workspace groups

```
pricing-analysts@yourdomain.com    the daily review, approvals
pricing-leads@yourdomain.com       everything analysts see, plus ops telemetry
commercial-exec@yourdomain.com     read only, no fee tables, no approvals
```

### Local setup

```bash
git clone <your-repo> tvd-ota-fareiq && cd tvd-ota-fareiq
python3.11 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest tests -q          # expect 92 passed
npm install -g @google/clasp
gcloud auth login && gcloud auth application-default login
```

If the tests do not pass on a clean clone, stop. Everything downstream assumes
the pricing logic is sound.

---

## Stage 1 :: project bootstrap

```bash
export GCP_PROJECT=tvd-fareiq-prod
export GCP_REGION=europe-west2
export BQ_LOCATION=europe-west2
export RAW_BUCKET=${GCP_PROJECT}-fareiq-raw
# only when creating a new project:
export BILLING_ACCOUNT=0X0X0X-0X0X0X-0X0X0X

bash deploy/00_bootstrap.sh
```

This enables sixteen APIs, creates the raw bucket with a lifecycle policy
(Nearline at 30 days, Coldline at 90, deleted at 400, matching the raw
dataset's partition expiry), creates the Artifact Registry repository, and
creates four empty secrets.

### Load the credentials

Never paste a credential into a shell that records history. Write a file, pipe
it, then destroy it.

```bash
cat > /tmp/amadeus.json <<'JSON'
{"client_id":"...","client_secret":"..."}
JSON
gcloud secrets versions add tvd-ota-fareiq-amadeus_sds --data-file=/tmp/amadeus.json
shred -u /tmp/amadeus.json
```

Repeat for each. Expected shapes:

| Secret | Shape |
|---|---|
| `tvd-ota-fareiq-own_pss` | `{"api_key":"..."}` |
| `tvd-ota-fareiq-amadeus` | `{"client_id":"...","client_secret":"..."}` |
| `tvd-ota-fareiq-sabre` | `{"client_id":"...","client_secret":"...","pcc":"...","base_url":"https://api.sabre.com"}` |
| `tvd-ota-fareiq-verteil` | `{"base_url":"...","shop_path":"...","ndc_version":"17.2","username":"...","password":"..."}` |
| `tvd-ota-fareiq-ndc_direct` | `{"base_url":"...","default_carrier":"VS","username":"...","password":"..."}` |

Also set the two service base URLs the collectors read from the environment:

```bash
gcloud run services update tvd-ota-fareiq-collector --region=$GCP_REGION \
  --update-env-vars=OWN_ENGINE_URL=https://booking.travelden.example,MARKET_FEED_URL=https://feed.provider.example
```

Run that after Stage 6, when the service exists.

**Verify:** `gcloud secrets list --project=$GCP_PROJECT` shows four secrets,
each with one enabled version.

---

## Stage 2 :: identity and access

Edit the three group addresses at the top of `deploy/iam.sh` to your real
domain, then:

```bash
bash deploy/iam.sh
```

This creates four service accounts and grants each the least it needs.

| Identity | Gets | Deliberately does not get |
|---|---|---|
| `tvd-ota-fareiq-collector-sa` | write `raw` and `ops`, read `mart`, write GCS, read the four secrets | any write to `mart` |
| `tvd-ota-fareiq-pricing-sa` | read `raw`, write `mart` and `ml` | the secrets |
| `tvd-ota-fareiq-scheduler` | invoke both services | any BigQuery access at all |
| `tvd-ota-fareiq-workspace` | read `mart`, invoke the pricing service | **any BigQuery write** |

That last row is the control model in one line. The Apps Script dashboard
cannot write to BigQuery. Every approval goes through the pricing service,
which is the only writer to the audit trail, and it attaches the human's
identity to the record.

### Three controls the script cannot set

Do these in the console now, not later:

1. **Column-level security** on `tvd_fareiq_raw.offer_snapshot.raw_payload`.
   Create a policy tag `contract-content` and apply it. Raw payloads can carry
   contractual content that should not spread past the collector.
2. **A per-user custom quota** in BigQuery. Suggested: 2 TB per user per day.
   Without it, one careless `SELECT *` scans the warehouse.
3. **A billing budget** with alerts at 50%, 80% and 100% of USD 300.

```bash
gcloud billing budgets create --billing-account=$BILLING_ACCOUNT \
  --display-name="FareIQ monthly" --budget-amount=300USD \
  --threshold-rule=percent=0.5 --threshold-rule=percent=0.8 --threshold-rule=percent=1.0
```

**Verify:**
```bash
gcloud projects get-iam-policy $GCP_PROJECT --format=json | grep -c fareiq   # expect 6 or more
```

---

## Stage 3 :: the warehouse

```bash
bash deploy/apply_sql.sh
```

Applies, in dependency order: the five datasets, the raw tables, the mart
dimensions and facts, then the views. Models are skipped by default because
training costs money and there is no data to train on yet.

Every statement is `CREATE ... IF NOT EXISTS` or `CREATE OR REPLACE`, so this
is safe on every deploy and is wired into CI for exactly that reason.

**Verify:**
```bash
bq ls --project_id=$GCP_PROJECT                          # 5 datasets
bq ls --project_id=$GCP_PROJECT tvd_fareiq_mart          # 13 tables, 10 views
bq show --format=prettyjson $GCP_PROJECT:tvd_fareiq_mart | grep location
```

The location must match `BQ_LOCATION` exactly. If it does not, delete the
datasets now and rerun with the right value. This is the one mistake that is
genuinely expensive to fix later.

---

## Stage 4 :: seed the configuration

```bash
bash deploy/01_seed_config.sh
```

Seeds four sources, seven sellers, ten starter routes (LOS and ABV origins),
three pricing rules and an NGN identity FX row. After go-live the pricing team
owns all of it from the Google Sheet and this script is never run again.

### The FX trap

The seed loads only NGN to NGN. Any offer quoted in another currency gets a
`BLOCKING_NO_FX_RATE` flag and is excluded from the market panel. Since
Amadeus and most NDC channels will quote in the carrier's currency, you must
load real rates before the first sweep:

```sql
INSERT INTO `PROJECT.tvd_fareiq_mart.dim_fx_rate`
  (rate_date, from_currency, to_currency, rate, source_id)
VALUES
  (CURRENT_DATE(), 'USD', 'NGN', 1580.00, 'cbn'),
  (CURRENT_DATE(), 'GBP', 'NGN', 2010.00, 'cbn'),
  (CURRENT_DATE(), 'EUR', 'NGN', 1720.00, 'cbn');
```

Wire a daily feed into this table before Stage 10. Naira volatility means
every historical comparison uses the rate of the observation date, never
today's, so a gap in this table is a permanent hole in the history.

**Verify:**
```bash
bq query --use_legacy_sql=false \
 "SELECT (SELECT COUNT(*) FROM \`$GCP_PROJECT.tvd_fareiq_mart.dim_route\` WHERE is_monitored) AS routes,
         (SELECT COUNT(*) FROM \`$GCP_PROJECT.tvd_fareiq_mart.dim_pricing_rule\` WHERE is_active) AS rules,
         (SELECT COUNT(*) FROM \`$GCP_PROJECT.tvd_fareiq_mart.dim_fx_rate\` WHERE rate_date = CURRENT_DATE()) AS fx"
```

---

## Stage 5 :: CI/CD

Optional for a first deploy, essential before anyone else touches the code.

### Workload Identity Federation

No service account keys in GitHub, ever.

```bash
POOL=github-pool
gcloud iam workload-identity-pools create $POOL --location=global \
  --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc github \
  --location=global --workload-identity-pool=$POOL \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository == 'YOUR_ORG/tvd-ota-fareiq'"

gcloud iam service-accounts create tvd-ota-fareiq-deploy
for role in run.admin artifactregistry.writer bigquery.admin iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding $GCP_PROJECT \
    --member="serviceAccount:tvd-ota-fareiq-deploy@${GCP_PROJECT}.iam.gserviceaccount.com" \
    --role="roles/${role}" --condition=None
done

PROJECT_NUM=$(gcloud projects describe $GCP_PROJECT --format='value(projectNumber)')
gcloud iam service-accounts add-iam-policy-binding \
  "tvd-ota-fareiq-deploy@${GCP_PROJECT}.iam.gserviceaccount.com" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUM}/locations/global/workloadIdentityPools/${POOL}/attributeSet/repository/YOUR_ORG/tvd-ota-fareiq"
```

The `attribute-condition` is not optional. Without it any GitHub repository
can assume your deploy identity.

### GitHub configuration

Repository **variables**: `GCP_PROJECT`, `GCP_REGION`, `BQ_LOCATION`,
`RAW_BUCKET`.

Repository **secrets**: `WIF_PROVIDER`
(`projects/NUM/locations/global/workloadIdentityPools/github-pool/providers/github`),
`DEPLOY_SERVICE_ACCOUNT`, `CI_SERVICE_ACCOUNT`, `CLASPRC_JSON`.

The pipeline runs quality checks and a BigQuery dry run of every SQL file on
every pull request, then on merge to `main` builds, deploys with no traffic,
smoke tests, promotes, applies SQL and pushes Apps Script. Protect `main` and
require both checks.

---

## Stage 6 :: the services

```bash
bash deploy/02_deploy_services.sh
```

Builds both images, deploys each with **no traffic**, smoke tests the
candidate revision, then promotes it. If the smoke test fails, traffic is not
promoted and the previous revision keeps serving. That ordering exists because
a bad pricing engine must never reach the morning run.

| Service | Memory | CPU | Timeout | Concurrency | Why |
|---|---|---|---|---|---|
| collector | 2 GiB | 2 | 900s | 8 | I/O bound, many concurrent HTTP calls |
| pricing | 4 GiB | 2 | 1800s | 4 | carries pandas and scikit-learn; each request holds a result set |

Then set the collector's upstream URLs:

```bash
gcloud run services update tvd-ota-fareiq-collector --region=$GCP_REGION \
  --update-env-vars=OWN_ENGINE_URL=https://booking.travelden.example,MARKET_FEED_URL=https://feed.provider.example
```

**Verify:**
```bash
PRICING=$(gcloud run services describe tvd-ota-fareiq-pricing --region=$GCP_REGION --format='value(status.url)')
curl -s -H "Authorization: Bearer $(gcloud auth print-identity-token)" $PRICING/health
```

Expect `"status":"ok"` and `"warehouse":"reachable"`. If the warehouse is
unreachable, the pricing service account is missing its dataset grant.

---

## Stage 7 :: the schedule

```bash
bash deploy/schedulers.sh
```

Eight jobs, all in Africa/Lagos so the schedule reads the way the pricing team
thinks about their day.

| Time | Job | Endpoint |
|---|---|---|
| hourly | tier 1 sweep, 40 highest revenue routes | `collector /collect` |
| every 4h | tier 2 sweep | `collector /collect` |
| 03:00 | tier 3 long tail | `collector /collect` |
| 05:30 | raw to `fact_offer` to `fact_market_snapshot` | `pricing /transform` |
| 05:45 | mining: anomalies, regime shifts, fee moves | `pricing /mine` |
| 06:00 | model refresh, weekdays only | `pricing /refresh-models` |
| 06:15 | write the day's recommendations | `pricing /recommend` |
| 18:00 | measure outcomes at T+7 and T+30 | `pricing /measure-outcomes` |

Pause the sweeps until Stage 10, so you control the first collection by hand:

```bash
for j in tvd-ota-fareiq-collect-t1 tvd-ota-fareiq-collect-t2 tvd-ota-fareiq-collect-t3; do
  gcloud scheduler jobs pause $j --location=$GCP_REGION
done
```

**Verify:** `gcloud scheduler jobs list --location=$GCP_REGION` lists eight
`tvd-ota-fareiq-*` jobs.

---

## Stage 8 :: the dashboard

```bash
cd appsscript/webapp
clasp login
clasp create --type webapp --title "TVD OTA FareIQ"
clasp push
```

### Script properties

In the Apps Script editor, open `Config.gs`, edit the real values into
`setupScriptProperties()`, run it once, then **delete the values from the
function body and push again**. Alternatively set them in Project Settings and
never put them in source at all, which is the better habit.

```
GCP_PROJECT           tvd-fareiq-prod
BQ_LOCATION           europe-west2
PRICING_SERVICE_URL   https://tvd-ota-fareiq-pricing-XXXX.a.run.app
CONFIG_SHEET_ID       (from Stage 9; set it after the Sheet exists)
GROUP_ANALYSTS        pricing-analysts@yourdomain.com
GROUP_LEADS           pricing-leads@yourdomain.com
GROUP_EXEC            commercial-exec@yourdomain.com
```

### Deploy

Editor, **Deploy → New deployment → Web app**:

- Description: `v1`
- **Execute as: Me**
- **Who has access: Anyone within yourdomain.com**

Executing as the deploying identity is what lets analysts read the mart
without each of them holding a BigQuery role. Authorisation is then done per
request against Workspace groups, so removing somebody from a group takes
effect on their next page load.

Deploy as the **`tvd-ota-fareiq-workspace` identity**, not as yourself. If you
deploy as yourself, the app inherits your permissions and stops working the
day you change role.

### Grant the web app identity

```bash
bq add-iam-policy-binding --member="serviceAccount:tvd-ota-fareiq-workspace@${GCP_PROJECT}.iam.gserviceaccount.com" \
  --role="roles/bigquery.dataViewer" "${GCP_PROJECT}:tvd_fareiq_mart"
gcloud projects add-iam-policy-binding $GCP_PROJECT \
  --member="serviceAccount:tvd-ota-fareiq-workspace@${GCP_PROJECT}.iam.gserviceaccount.com" \
  --role="roles/bigquery.jobUser" --condition=None
gcloud run services add-iam-policy-binding tvd-ota-fareiq-pricing \
  --member="serviceAccount:tvd-ota-fareiq-workspace@${GCP_PROJECT}.iam.gserviceaccount.com" \
  --role=roles/run.invoker --region=$GCP_REGION
```

`bigquery.jobUser` at project level is easy to forget: `dataViewer` alone lets
the app see the tables but not run a query against them.

**Verify:** open the web app URL as yourself, then as a test account in each
group. Confirm an account in no group sees the "no access" page, and that an
exec account sees no fee matrix, no daily review and no approval buttons.

---

## Stage 9 :: the configuration workbook

Create a Google Sheet named **TVD OTA FareIQ Pricing Config** with five tabs.

**Routes** — header row exactly:
`route_key, origin, destination, origin_city, destination_city, region_pair,
haul_type, monitoring_tier, strategic_priority, min_margin_pct_floor,
max_discount_pct, is_monitored`

**Pricing Rules** —
`rule_id, rule_name, scope_type, scope_value, cabin, min_margin_pct,
target_margin_pct, max_markup_pct, min_markup_abs, target_price_index,
max_daily_move_pct, priority, effective_from, effective_to, is_active`

**Competitors** —
`seller_id, seller_name, seller_type, is_benchmark, benchmark_weight,
home_market, notes`

Plus empty **Daily Review** and **Sync Log** tabs.

Then:

```bash
cd appsscript
clasp create --type sheets --parentId "<THE_SHEET_ID>" --title "FareIQ Sheet Automation"
clasp push
```

In that script's properties set `GCP_PROJECT`, `PRICING_SERVICE_URL` and
`DIGEST_RECIPIENTS`. Run `installTriggers()` once, which creates the 06:45
sheet pull and the 07:00 Gmail digest.

Finally put the Sheet id into the **web app's** `CONFIG_SHEET_ID` property so
the dashboard footer links to it.

Export the initial config to BigQuery: FareIQ menu → **Push config to
BigQuery**. The sync validates on entry and rejects a malformed route key, a
target margin below the floor, or a daily move cap above 25% without sign-off.

---

## Stage 10 :: first run and verification

Run each step by hand, in order, checking the output before moving on. Do not
resume the schedulers until all of it passes.

```bash
export TOKEN=$(gcloud auth print-identity-token)
export COLLECTOR=$(gcloud run services describe tvd-ota-fareiq-collector --region=$GCP_REGION --format='value(status.url)')
export PRICING=$(gcloud run services describe tvd-ota-fareiq-pricing --region=$GCP_REGION --format='value(status.url)')
```

**1. Plan a sweep without making a single call.**

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"tier":"T1","dry_run":true}' $COLLECTOR/collect
```

Returns the planned request and call counts. Sanity-check the volume against
your rate limits before spending anything.

**2. One narrow real sweep.**

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"tier":"T1","horizon_days":[30],"cabins":["ECONOMY"],"max_requests":20}' \
  $COLLECTOR/collect
```

Expect a non-zero `offers` count and `rows_loaded` matching it. If `errors` is
non-zero, read the sample: an auth failure means a secret is wrong or missing.

**3. Transform.**

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"window_hours":24}' $PRICING/transform
```

**4. Check the true-cost model produced sane figures.**

```sql
SELECT seller_id, COUNT(*) offers,
       ROUND(AVG(displayed_total_base)) headline,
       ROUND(AVG(true_customer_cost_base)) true_cost,
       ROUND(AVG(fee_confidence), 2) fee_conf,
       COUNTIF(ARRAY_LENGTH(dq_flags) > 0) flagged
FROM `PROJECT.tvd_fareiq_mart.fact_offer`
WHERE DATE(collected_at) = CURRENT_DATE()
GROUP BY seller_id ORDER BY offers DESC;
```

`true_cost` should be at or above `headline` for every seller. If they are
identical everywhere, no ancillary data is arriving and the platform is
comparing headline prices, which is the failure mode it exists to prevent.

**5. Recommendations, dry run first.**

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"dry_run":true}' $PRICING/recommend
```

Read the three sample rationales. They should name real routes, real
competitors and real figures. Then run it for real with `{}`.

**6. Mining.**

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"lookback_days":30,"dry_run":true}' $PRICING/mine
```

With only one day of history most detectors correctly find nothing. That is
the right answer, not a fault.

**7. The full verification suite.**

```bash
bash deploy/99_verify.sh
```

Seven groups of checks: infrastructure, warehouse, configuration, services,
schedule, data flow and controls. Resolve every `FAIL` before continuing. A
`WARN` about missing history is expected on day one.

**8. The dashboard.** Open the web app. Confirm the freshness badge shows
minutes not hours, the overview tiles carry real numbers, and the daily review
lists recommendations with working approve buttons.

**9. Approve one recommendation end to end**, then confirm the audit trail
caught it:

```sql
SELECT decision_id, decided_by, decision, current_price, recommended_price,
       approved_price, competitor_benchmark.cheapest_price, confidence, apply_status
FROM `PROJECT.tvd_fareiq_mart.fact_price_decision`
ORDER BY decided_at DESC LIMIT 5;
```

`decided_by` must be the human's email, never a service account. If it is a
service account, the dashboard is writing directly and the control model is
broken.

**10. Try to break the floor.** In the dashboard, modify a price to below the
stated policy floor. The pricing service must refuse with a 422 naming both
prices. If it accepts, stop and fix it before go-live: that refusal is the
single most important guardrail in the platform.

**11. Resume the schedulers.**

```bash
for j in tvd-ota-fareiq-collect-t1 tvd-ota-fareiq-collect-t2 tvd-ota-fareiq-collect-t3; do
  gcloud scheduler jobs resume $j --location=$GCP_REGION
done
```

---

## Stage 11 :: the shadow fortnight

Two weeks of collecting and recommending while nobody acts on the output. This
is not caution for its own sake; it is the only cheap calibration you will get.

**Week 1.** Let history accumulate. Each morning check `deploy/99_verify.sh`
and the coverage number. Fix collection gaps.

**Week 2.** Ask the analysts to work the daily review as if it were live, and
record what they would have done, including where they disagree. Every
disagreement is a rule that is wrong. Adjust the rules in the Sheet, not the
code.

Enable model training once there are roughly six weeks of history:

```bash
APPLY_MODELS=1 bash deploy/apply_sql.sh
```

Before that there is nothing to train on and the elasticity table falls back
to the regional prior, which is the correct behaviour.

**Exit criteria before go-live:**

| Check | Target |
|---|---|
| Panel coverage on tier 1 | ≥ 0.7 |
| Sellers observed per cell | ≥ 3 on 80% of cells |
| Blocking DQ flags | < 2% of rows |
| Fee confidence | ≥ 0.6 average |
| Analyst agreement with the engine | ≥ 60% |
| Margin reconciles to management accounts | within 1% |

---

## Stage 12 :: go-live

1. Confirm every exit criterion above.
2. Circulate the dashboard URL with a one-page note: the engine recommends,
   you decide, and every decision is recorded.
3. Walk the team through one real approval, one modification with a reason,
   and one rejection with a reason.
4. Confirm the 07:00 digest arrives.
5. Agree who owns the morning review and who covers them.
6. Book a review at T+30 against the engine scorecard.

Automation stays off. `auto_apply_enabled` is `False` in `EngineConfig` and
should remain so until the scorecard shows forecast and realised margin
converging, which is Phase 5 in the roadmap and no earlier.

---

## Operations

### The morning, when it is working

07:00 digest lands. Analyst opens the dashboard, works the daily review top
down, stops when the value runs out. Approvals flow to the booking engine.

### When something breaks

| Symptom | Likely cause | Fix |
|---|---|---|
| Dashboard: "no data yet" | transform has not run | `curl -X POST .../transform -d '{"window_hours":24}'` |
| Freshness badge amber | collection stalled | check the collector logs and its rate limits |
| Every recommendation is INVESTIGATE | panel below three sellers | check which seller stopped reporting; look for a `COVERAGE_DROP` signal |
| Many rows blocked by DQ | missing FX rate | load today's rates into `dim_fx_rate` |
| Approvals return 422 | price below the policy floor | correct behaviour: change the rule in the Sheet if the floor is wrong |
| Approvals return 401 | Apps Script identity lost `run.invoker` | re-grant it |
| Dashboard loads but charts are blank | BigQuery reachable, `jobUser` missing | grant `roles/bigquery.jobUser` at project level |
| Recommendations all HOLD | rules not synced | FareIQ menu → Push config to BigQuery |
| BigQuery bill jumped | a view queried `fact_offer` directly | check `INFORMATION_SCHEMA.JOBS` for the largest scans |

### Reruns

Every job is idempotent. To rebuild a day:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"window_hours":24,"window_end":"2026-09-20T23:59:59Z"}' $PRICING/transform
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"review_date":"2026-09-20"}' $PRICING/recommend
```

The transform MERGEs on a deterministic key, and mining replaces its
partition, so neither doubles anything up.

### Rollback

```bash
gcloud run revisions list --service=tvd-ota-fareiq-pricing --region=$GCP_REGION
gcloud run services update-traffic tvd-ota-fareiq-pricing \
  --region=$GCP_REGION --to-revisions=tvd-ota-fareiq-pricing-00012-abc=100
```

Data does not roll back and should not: `fact_price_recommendation` carries the
engine's git SHA and the ruleset hash on every row, so a bad batch is
identifiable and excludable rather than lost.

To stop everything immediately:

```bash
for j in $(gcloud scheduler jobs list --location=$GCP_REGION --format='value(name)' | grep fareiq); do
  gcloud scheduler jobs pause "$j" --location=$GCP_REGION
done
```

Collection stops, the dashboard keeps serving history, and no recommendation
is produced. Nothing is lost.

### Monitoring worth setting up

| Alert | Condition | Why |
|---|---|---|
| Collection stalled | no new `raw.offer_snapshot` rows in 3 hours | everything downstream goes stale silently |
| Coverage collapse | average `coverage_score` below 0.6 | market statistics become unreliable while still computing |
| Recommendation drop | today's count below 70% of the 7-day mean | usually a transform failure |
| Approval rate collapse | under 30% over a week | the rules are wrong |
| Budget | 80% of monthly cap | before the invoice, not after |
| 5xx rate | above 1% on either service | ordinary service health |

### What costs money

| Item | Monthly, 150 routes |
|---|---|
| GDS shopping calls | USD 80 to 250, the largest variable |
| Licensed competitor feed | USD 400 to 1,500, contract dependent |
| BigQuery storage | under USD 20 |
| BigQuery queries | USD 15 to 40, held down by the pre-aggregated views |
| Cloud Run | under USD 25, scale to zero between sweeps |
| Cloud Storage | under USD 5 with the lifecycle policy |
| Apps Script, Sheets, Gmail | included in Workspace |

The hard cap in `config/sources.yaml` stops the pipeline rather than
overspending it. Raise it deliberately, never by accident.

### Quarterly

- Re-review every permitted-public source with Legal. A review older than 90
  days stops collection on its own, which is the intended behaviour, not an
  outage.
- Re-check `benchmark_weight` on each competitor against actual market share.
- Review the engine scorecard: is forecast margin impact converging on
  realised? If not after two quarters, the revenue impact column should be
  removed from the board pack until it is.
- Rotate the API credentials.
