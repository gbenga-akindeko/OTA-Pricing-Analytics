# TVD OTA FareIQ :: the plain step-by-step guide

This picks up exactly where you are now and takes you to a working platform.

You have already done a lot. The foundation is built. What follows is written
so you can copy, paste, look at the result, and move on. Every step tells you
what to type, what you should see, and what to do when you do not see it.

**You are here:** Part 1. Everything before it is done.

---

## How to read this

Each step has three parts:

> **Do this** — the command to copy and paste
> **You should see** — what a working result looks like
> **If it goes wrong** — the fix

Never skip a "You should see". If it does not match, stop and fix it. Moving
on with a broken step is how you lose an afternoon to a problem you created an
hour earlier.

---

## Part 0 :: set up your terminal

You must do this **every time you open a new terminal window**. These
variables disappear when you close the window.

> **Do this**

```bash
cd ~/Documents/FareIQ
source .venv/bin/activate

export GCP_PROJECT=tvd-fareiq-prod
export GCP_REGION=europe-west2
export BQ_LOCATION=europe-west2
export RAW_BUCKET=tvd-fareiq-prod-fareiq-raw
export AR=europe-west2-docker.pkg.dev/tvd-fareiq-prod/tvd-ota-fareiq

gcloud config set project $GCP_PROJECT
```

> **You should see**

```
Updated property [core/project].
```

And your prompt should start with `(.venv)`.

**Tip to save yourself repeating this:** paste those `export` lines into a
file called `~/fareiq-env.sh`, then in future just run `source ~/fareiq-env.sh`.

---

## Part 1 :: fix the build (your current blocker)

### 1.1 Understand why it failed

You ran something like `gcloud builds submit --file ...`. That flag does not
exist. It is `--config`, and it points at a YAML file, not a Dockerfile.

There is a second, deeper problem. `gcloud builds submit --tag` only works
when the Dockerfile sits at the top of the folder you are uploading. Ours sits
in `services/collector_svc/`, and it needs the whole repository as context
because it copies `src/` and `sql/`. So neither simple form works.

You have two ways out. Use **Option A**. It is faster and you already have
Docker Desktop running.

### 1.2 Get the updated code

Your local copy is older than the current repository, and the new one already
contains the `COLLECTOR_INIT` telemetry fix you made plus several things you
will need in the next parts. Take the whole new copy.

> **Do this**

```bash
cd ~/Documents
mv FareIQ FareIQ-backup-$(date +%Y%m%d)
# unzip the new TVD_OTA_FareIQ.zip here, so you get ~/Documents/FareIQ again
cd FareIQ
python3.11 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pip install pandas scikit-learn
pytest tests -q
```

> **You should see**

```
105 passed in 2.16s
```

> **If it goes wrong**
>
> If `pip install -e ".[dev]"` fails, check you are on Python 3.11 with
> `python --version`. Nothing else in this guide will work on 3.12 or 3.10.

Your old folder is still there as `FareIQ-backup-YYYYMMDD` if you need to
compare anything.

### 1.3 Build the image on your own machine (Option A)

> **Do this**

```bash
cd ~/Documents/FareIQ
source ~/fareiq-env.sh      # or re-run the exports from Part 0

gcloud auth configure-docker europe-west2-docker.pkg.dev --quiet

docker build \
  --platform linux/amd64 \
  -f services/collector_svc/Dockerfile \
  -t $AR/collector_svc:v3 \
  -t $AR/collector_svc:latest \
  .
```

**The `--platform linux/amd64` is not optional.** If you are on an Apple
Silicon Mac (M1, M2, M3, M4), leaving it out builds an ARM image. It will push
fine, then Cloud Run will fail to start it with an error that does not mention
architecture at all, and you will lose an hour.

The final `.` is also not optional. It means "use this whole folder as the
build context", which is what lets the Dockerfile find `src/` and `sql/`.

> **You should see**

A long stream of build steps, ending with something like:

```
=> => naming to europe-west2-docker.pkg.dev/tvd-fareiq-prod/tvd-ota-fareiq/collector_svc:v3
```

> **If it goes wrong**
>
> - `Cannot connect to the Docker daemon` — Docker Desktop is not running. Open it, wait for the whale icon to settle, try again.
> - `failed to compute cache key: "/src" not found` — you are not in `~/Documents/FareIQ`, or you left off the final `.`.

### 1.4 Push it

> **Do this**

```bash
docker push $AR/collector_svc:v3
docker push $AR/collector_svc:latest
```

> **You should see**

Several `Pushed` lines and a final digest line.

> **If it goes wrong**
>
> `denied: Permission "artifactregistry.repositories.uploadArtifacts" denied` —
> run `gcloud auth login` again, then redo step 1.3's
> `gcloud auth configure-docker` line.

### 1.5 The cloud alternative (Option B, only if Docker will not cooperate)

The repository now contains a `cloudbuild.yaml` that solves the context
problem properly.

```bash
gcloud builds submit \
  --config cloudbuild.yaml \
  --substitutions=_SERVICE=collector_svc,_REGION=europe-west2 \
  .
```

This is slower (two to four minutes) but it always produces the right
architecture, so it is the safer option if you are unsure.

---

## Part 2 :: deploy the new collector

### 2.1 Stop the scheduler first

Your T1 job runs every 15 minutes. Turn it off while you work, so you are not
chasing runs you did not start.

> **Do this**

```bash
gcloud scheduler jobs pause tvd-ota-fareiq-collector-t1 --location=$GCP_REGION
```

> **You should see**

```
Paused job [tvd-ota-fareiq-collector-t1].
```

### 2.2 Deploy

> **Do this**

```bash
gcloud run deploy tvd-ota-fareiq-collector \
  --image=$AR/collector_svc:v3 \
  --region=$GCP_REGION \
  --no-allow-unauthenticated \
  --service-account=tvd-ota-fareiq-collector-sa@$GCP_PROJECT.iam.gserviceaccount.com \
  --set-env-vars=GCP_PROJECT=$GCP_PROJECT,BQ_LOCATION=$BQ_LOCATION,RAW_BUCKET=$RAW_BUCKET \
  --memory=2Gi --cpu=2 --timeout=900 --concurrency=8 \
  --min-instances=0 --max-instances=20
```

> **You should see**

```
Service [tvd-ota-fareiq-collector] revision [tvd-ota-fareiq-collector-00003-xyz] has been deployed
and is serving 100 percent of traffic.
Service URL: https://tvd-ota-fareiq-collector-208705843164.europe-west2.run.app
```

Note the revision number went up to `00003`. That is how you know your new
code is live.

> **If it goes wrong**
>
> `Revision is not ready and cannot serve traffic. The user-provided container
> failed to start` — almost always the ARM architecture problem from 1.3.
> Rebuild with `--platform linux/amd64`.
>
> To read the real error: `gcloud run services logs read tvd-ota-fareiq-collector --region=$GCP_REGION --limit=50`

### 2.3 Save the URL

> **Do this**

```bash
export COLLECTOR=$(gcloud run services describe tvd-ota-fareiq-collector \
  --region=$GCP_REGION --format='value(status.url)')
export TOKEN=$(gcloud auth print-identity-token)
echo $COLLECTOR
```

Add the `COLLECTOR=` line to your `~/fareiq-env.sh`. The `TOKEN` expires after
about an hour, so you will re-run that line often.

---

## Part 3 :: prove the telemetry fix works

This is the whole reason you rebuilt. Before the fix, a collector that could
not start was invisible. Now it should be reported.

> **Do this**

```bash
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"tier":"T1","dry_run":true}' \
  $COLLECTOR/collect | python3 -m json.tool
```

> **You should see**

```json
{
  "run_id": "...",
  "planned_requests": 72,
  "collectors_ready": [],
  "collectors_failed": ["own_pss", "amadeus", "sabre", "verteil", "ndc_direct"],
  "planned_calls": 0,
  "errors": [
    {"source_id": "own_pss", "error_type": "COLLECTOR_INIT",
     "message": "404 Secret Version [latest] not found."},
    ...
  ],
  "dry_run": true
}
```

**This output is a success, not a failure.** The four collectors genuinely
cannot start, because the four secrets have no values in them yet. The point
is that the platform now *says so* instead of quietly reporting zero.

> **If you instead see** `"collectors_failed": []` and `"planned_calls": 288`,
> your old image is still serving. Check the revision:
> `gcloud run revisions list --service=tvd-ota-fareiq-collector --region=$GCP_REGION --limit=3`

### 3.1 Check a real run records it too

> **Do this**

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"tier":"T1","max_requests":2}' $COLLECTOR/collect | python3 -m json.tool
```

> **You should see** an HTTP 503 with a message naming each failed source. That
> is the new behaviour: a run where nothing could start is an error, not a
> silent empty run.

Then confirm it reached BigQuery:

```bash
bq query --use_legacy_sql=false \
"SELECT collection_run_id, planned_requests, calls_made, error_count,
        SUBSTR(error_sample, 1, 200) AS sample
 FROM \`$GCP_PROJECT.tvd_fareiq_ops.collection_run\`
 ORDER BY started_at DESC LIMIT 3"
```

`error_count` should be 5, and `sample` should contain `COLLECTOR_INIT`.

**Stage A is now complete.**

---

## Part 4 :: run the whole platform with fake data

This is the part that unblocks you. You do not have supplier credentials and
you may not have them for weeks. You do not need them to prove everything
else works.

The repository now contains a synthetic market generator. It produces
believable offers for your ten routes: five sellers, different fee structures,
a booking curve, occasional outliers. Everything downstream (true customer
cost, market median, price index, the pricing engine, the mining job, the
dashboard) can be fully tested against it.

**It cannot be switched on by accident.** It only registers itself when the
environment variable `FAREIQ_ALLOW_MOCK=1` is set, every offer it makes is
tagged `SYNTHETIC_DATA_DO_NOT_PRICE_AGAINST`, and every competitor it invents
has a seller id starting `mock_`, so you can find and delete all of it later
with one query.

### 4.1 See it working on your own laptop first

No cloud involved. This takes five seconds and tells you the generator is sane.

> **Do this**

```bash
cd ~/Documents/FareIQ && source .venv/bin/activate
FAREIQ_ALLOW_MOCK=1 PYTHONPATH=src python - <<'PY'
import asyncio
from datetime import date, timedelta
from fareiq.collectors.mock import MockMarketCollector
from fareiq.core.models import ShopRequest

c = MockMarketCollector(collection_run_id="demo")
r = ShopRequest(origin="LOS", destination="LHR",
                departure_date=date.today() + timedelta(days=30),
                cabin="ECONOMY", pos_country="NG", currency="NGN")
res = asyncio.run(c.collect(r))
print(f"{'SELLER':<22}{'CARRIER':<9}{'HEADLINE':>12}{'BAG':>9}{'SEAT':>8}{'ALL-IN':>12}")
for o in sorted(res.offers, key=lambda x: x.displayed_total):
    bag  = next((float(a.amount) for a in o.quoted_ancillaries if a.type.value=="BAG_1ST"), 0)
    seat = next((float(a.amount) for a in o.quoted_ancillaries if a.type.value=="SEAT_STD"), 0)
    print(f"{o.seller_id:<22}{o.marketing_carrier:<9}{float(o.displayed_total):>12,.0f}"
          f"{bag:>9,.0f}{seat:>8,.0f}{float(o.displayed_total)+bag+seat:>12,.0f}")
print(f"\n{len(res.offers)} offers from {len({o.seller_id for o in res.offers})} sellers")
PY
```

> **You should see** a table like this:

```
SELLER                CARRIER      HEADLINE      BAG    SEAT      ALL-IN
us                    AF            939,000        0       0     939,000
us                    VS            950,200        0       0     950,200
mock_competitor_b     BA            969,500   45,000       0   1,014,500
mock_airline_direct   VS            986,000        0  18,000   1,004,000
mock_competitor_c     VS          1,016,700        0       0   1,016,700
...
8 offers from 5 sellers
```

Look at `mock_competitor_b`. Headline ₦969,500 against our ₦950,200, so it
looks ₦19,300 dearer. All in it is ₦1,014,500 against our ₦950,200, so it is
actually ₦64,300 dearer. That gap is the platform's entire reason to exist,
and you are now seeing it on your own screen.

### 4.2 Turn it on in the cloud

> **Do this**

```bash
gcloud run services update tvd-ota-fareiq-collector \
  --region=$GCP_REGION \
  --update-env-vars=FAREIQ_ALLOW_MOCK=1
```

> **You should see** a new revision deployed, serving 100 percent of traffic.

### 4.3 Collect a real batch of fake data

> **Do this**

```bash
export TOKEN=$(gcloud auth print-identity-token)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"tier":"T1","source_ids":["mock_market"],"horizon_days":[3,7,14,30,60,90],"cabins":["ECONOMY","BUSINESS"]}' \
  $COLLECTOR/collect | python3 -m json.tool
```

> **You should see**

```json
{
  "run_id": "...",
  "requests": 96,
  "calls": 96,
  "offers": 760,
  "rows_loaded": 760,
  "errors": 0,
  "gcs_uri": "gs://tvd-fareiq-prod-fareiq-raw/offers/dt=2026-09-27/hour=.../run_....jsonl",
  "duration_s": 3.1
}
```

`offers` and `rows_loaded` must match. That single line proves the collector,
the GCS write and the BigQuery load all work.

> **If `rows_loaded` is 0 but `offers` is not** — the BigQuery load failed.
> Read the error: `gcloud run services logs read tvd-ota-fareiq-collector --region=$GCP_REGION --limit=30`

### 4.4 Build up a few days of history

The pricing engine needs history. The mining job needs more. Run the sweep
several times with different departure horizons so the warehouse has depth.

> **Do this**

```bash
for h in 1 3 5 7 10 14 21 30 45 60 90; do
  echo "horizon $h"
  curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "{\"tier\":\"T1\",\"source_ids\":[\"mock_market\"],\"horizon_days\":[$h],\"cabins\":[\"ECONOMY\"]}" \
    $COLLECTOR/collect | python3 -c "import sys,json;d=json.load(sys.stdin);print('  offers:',d['offers'])"
done
```

> **You should see** eleven lines, each reporting offers collected.

### 4.5 Check what landed

> **Do this**

```bash
bq query --use_legacy_sql=false \
"SELECT seller_id, COUNT(*) AS offers,
        ROUND(AVG(displayed_total)) AS avg_price,
        COUNT(DISTINCT request_origin || '-' || request_destination) AS routes
 FROM \`$GCP_PROJECT.tvd_fareiq_raw.offer_snapshot\`
 WHERE DATE(collected_at) = CURRENT_DATE()
 GROUP BY seller_id ORDER BY offers DESC"
```

> **You should see** five sellers, each with hundreds of offers across ten
> routes.

**Stage B is now complete.** You have a working collection pipeline with real
data flowing into BigQuery, without a single supplier credential.

---

## Part 5 :: deploy the pricing service

This is the half of the platform that has not been deployed at all yet.

### 5.1 Build and push

> **Do this**

```bash
cd ~/Documents/FareIQ

docker build \
  --platform linux/amd64 \
  -f services/pricing_svc/Dockerfile \
  -t $AR/pricing_svc:v1 \
  -t $AR/pricing_svc:latest \
  .

docker push $AR/pricing_svc:v1
docker push $AR/pricing_svc:latest
```

This image is bigger than the collector because it carries pandas and
scikit-learn. Expect three to six minutes.

### 5.2 Give its service account what it needs

Your `deploy/iam.sh` did not finish, so do these by hand.

> **Do this**

```bash
SA=tvd-ota-fareiq-pricing-sa@$GCP_PROJECT.iam.gserviceaccount.com

gcloud projects add-iam-policy-binding $GCP_PROJECT \
  --member="serviceAccount:$SA" --role="roles/bigquery.jobUser" --condition=None

for ds in tvd_fareiq_mart tvd_fareiq_ml; do
  bq add-iam-policy-binding --member="serviceAccount:$SA" \
     --role="roles/bigquery.dataEditor" "$GCP_PROJECT:$ds"
done

bq add-iam-policy-binding --member="serviceAccount:$SA" \
   --role="roles/bigquery.dataViewer" "$GCP_PROJECT:tvd_fareiq_raw"
```

> **If `bq add-iam-policy-binding` fails** with an allowlist error (the same
> problem that stopped `iam.sh`), use the console instead: BigQuery → the
> dataset → **Sharing** → **Permissions** → **Add principal**, paste the
> service account, pick the role.

### 5.3 Deploy

> **Do this**

```bash
gcloud run deploy tvd-ota-fareiq-pricing \
  --image=$AR/pricing_svc:v1 \
  --region=$GCP_REGION \
  --no-allow-unauthenticated \
  --service-account=tvd-ota-fareiq-pricing-sa@$GCP_PROJECT.iam.gserviceaccount.com \
  --set-env-vars=GCP_PROJECT=$GCP_PROJECT,BQ_LOCATION=$BQ_LOCATION \
  --memory=4Gi --cpu=2 --timeout=1800 --concurrency=4 \
  --min-instances=0 --max-instances=10

export PRICING=$(gcloud run services describe tvd-ota-fareiq-pricing \
  --region=$GCP_REGION --format='value(status.url)')
echo $PRICING
```

Add `PRICING=` to `~/fareiq-env.sh`.

### 5.4 Check it can reach the warehouse

> **Do this**

```bash
curl -s -H "Authorization: Bearer $TOKEN" $PRICING/healthz | python3 -m json.tool
```

> **You should see**

```json
{
  "status": "ok",
  "engine_version": "dev",
  "bq_location": "europe-west2",
  "warehouse": "reachable",
  "revision": "tvd-ota-fareiq-pricing-00001-abc"
}
```

`"warehouse": "reachable"` is the line that matters. If it says
`"unreachable"`, step 5.2 did not take effect. Wait two minutes (IAM is
eventually consistent) and try again before changing anything.

**Stage D is now started.**

---

## Part 6 :: turn raw offers into pricing recommendations

### 6.1 Load real FX rates first

Without this, every non-NGN offer is thrown away. Your mock data is all in
NGN so it would work anyway, but real data will not, and you should fix it now
while you remember.

> **Do this** (substitute today's real rates)

```bash
bq query --use_legacy_sql=false \
"INSERT INTO \`$GCP_PROJECT.tvd_fareiq_mart.dim_fx_rate\`
   (rate_date, from_currency, to_currency, rate, source_id)
 VALUES
   (CURRENT_DATE(), 'USD', 'NGN', 1580.00, 'manual'),
   (CURRENT_DATE(), 'GBP', 'NGN', 2010.00, 'manual'),
   (CURRENT_DATE(), 'EUR', 'NGN', 1720.00, 'manual'),
   (CURRENT_DATE(), 'AED', 'NGN', 430.00,  'manual'),
   (CURRENT_DATE(), 'ZAR', 'NGN', 88.00,   'manual')"
```

> **You should see** `Number of affected rows: 5`.

**Stage F is now done** for today. You still need a daily feed eventually,
but this unblocks you.

### 6.2 Run the transform

This turns raw offers into `fact_offer` (with true customer cost) and then
into `fact_market_snapshot` (with the market median and your price index).

> **Do this**

```bash
export TOKEN=$(gcloud auth print-identity-token)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"window_hours":24}' $PRICING/transform | python3 -m json.tool
```

> **You should see** two steps, each with a `job_id` and a `seconds` figure.

### 6.3 Look at the true customer cost

This is the moment the platform earns its name. Look carefully.

> **Do this**

```bash
bq query --use_legacy_sql=false \
"SELECT seller_id,
        COUNT(*) AS offers,
        ROUND(AVG(displayed_total_base)) AS headline,
        ROUND(AVG(true_customer_cost_base)) AS true_cost,
        ROUND(AVG(true_customer_cost_base - displayed_total_base)) AS hidden_fees
 FROM \`$GCP_PROJECT.tvd_fareiq_mart.fact_offer\`
 WHERE DATE(collected_at) = CURRENT_DATE()
 GROUP BY seller_id ORDER BY true_cost"
```

> **You should see** `hidden_fees` at 0 for `us`, and a real number for the
> sellers that charge for bags and seats. If `hidden_fees` is 0 everywhere,
> the fee resolution is not working and the platform is just comparing
> headline prices, which is the exact failure it exists to prevent.

### 6.4 Check your market position

> **Do this**

```bash
bq query --use_legacy_sql=false \
"SELECT route_key, departure_date, competitor_sellers AS panel,
        ROUND(our_comparable_cost) AS ours,
        ROUND(market_median) AS market,
        ROUND(price_index_vs_median, 3) AS price_index,
        our_market_rank AS rank
 FROM \`$GCP_PROJECT.tvd_fareiq_mart.fact_market_snapshot\`
 WHERE snapshot_date = CURRENT_DATE()
 ORDER BY price_index DESC LIMIT 15"
```

> **You should see** a price index around 0.9 to 1.1 and a panel of 3 or 4.
> A panel below 3 means the engine will refuse to act on that row, which is
> correct behaviour.

### 6.5 Generate recommendations

Dry run first, always.

> **Do this**

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"dry_run":true}' $PRICING/recommend | python3 -m json.tool
```

> **You should see** a `cells` count and three sample rows. Read the
> `rationale` in each. It should name a real route, a real competitor and real
> figures, in plain English.

Then run it for real:

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{}' $PRICING/recommend | python3 -m json.tool
```

> **You should see** `cells_scored`, `actionable` and `p1` counts.

### 6.6 Read the recommendations

> **Do this**

```bash
bq query --use_legacy_sql=false \
"SELECT route_key, departure_date, classification, action, priority,
        ROUND(current_price) AS now, ROUND(recommended_price) AS should_be,
        ROUND(price_change_pct * 100, 1) AS change_pct,
        ROUND(confidence, 2) AS conf,
        SUBSTR(rationale, 1, 110) AS why
 FROM \`$GCP_PROJECT.tvd_fareiq_mart.fact_price_recommendation\`
 WHERE review_date = CURRENT_DATE() AND action != 'HOLD'
 ORDER BY ABS(expected_margin_impact) DESC LIMIT 10"
```

**Stage D is now complete.** The platform has gone from a shopping request to
a priced recommendation with a written justification.

### 6.7 Run the mining job

> **Do this**

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"lookback_days":90,"dry_run":true}' $PRICING/mine | python3 -m json.tool
```

With only one day of history most detectors will correctly find nothing. That
is the right answer. Come back to this after a week of collection.

---

## Part 7 :: switch the schedulers on

Only now, with every piece proven by hand.

### 7.1 Create all eight jobs

> **Do this**

```bash
cd ~/Documents/FareIQ
bash deploy/schedulers.sh
```

> **You should see** eight jobs listed at the end.

> **If it fails** saying it cannot find the pricing service, you skipped Part 5.

### 7.2 Point the collection jobs at the mock source for now

The jobs default to the four real sources, which still have no credentials.
While you are testing, change them to the mock source.

> **Do this**

```bash
for job in t1 t2 t3; do
  gcloud scheduler jobs update http tvd-ota-fareiq-collect-$job \
    --location=$GCP_REGION \
    --message-body='{"tier":"T1","source_ids":["mock_market"],"horizon_days":[3,7,14,30,60,90],"cabins":["ECONOMY"]}'
done
```

### 7.3 Resume T1 and watch one run

> **Do this**

```bash
gcloud scheduler jobs resume tvd-ota-fareiq-collector-t1 --location=$GCP_REGION 2>/dev/null
gcloud scheduler jobs run tvd-ota-fareiq-collect-t1 --location=$GCP_REGION
sleep 45
bq query --use_legacy_sql=false \
"SELECT collection_run_id, calls_made, offers_collected, error_count
 FROM \`$GCP_PROJECT.tvd_fareiq_ops.collection_run\`
 ORDER BY started_at DESC LIMIT 1"
```

> **You should see** a non-zero `offers_collected` and `error_count` of 0.

**Stage E is now complete.** Leave it running for a week to build history.

---

## Part 8 :: the dashboard

Takes about 45 minutes. This is the part the pricing team actually uses.

### 8.1 Push the code

> **Do this**

```bash
npm install -g @google/clasp
cd ~/Documents/FareIQ/appsscript/webapp
clasp login
clasp create --type webapp --title "TVD OTA FareIQ"
clasp push
```

> **You should see** `Pushed 7 files.`

### 8.2 Set the configuration

Open the script: `clasp open`. Go to **Project Settings** (the gear on the
left) → **Script Properties** → **Add script property**. Add seven:

| Property | Value |
|---|---|
| `GCP_PROJECT` | `tvd-fareiq-prod` |
| `BQ_LOCATION` | `europe-west2` |
| `PRICING_SERVICE_URL` | your `$PRICING` URL |
| `CONFIG_SHEET_ID` | leave blank for now |
| `GROUP_ANALYSTS` | your analysts group email |
| `GROUP_LEADS` | your leads group email |
| `GROUP_EXEC` | your exec group email |

Setting them here rather than in code is deliberate: a URL in `Config.gs` ends
up in version control, and eventually in a screenshot.

### 8.3 Turn on BigQuery for the script

In the editor, left sidebar → **Services** → **+** → **BigQuery API** → **Add**.

### 8.4 Deploy it

**Deploy** → **New deployment** → gear icon → **Web app**.

- Description: `v1`
- Execute as: **Me**
- Who has access: **Anyone within your domain**

Click **Deploy**, then **Authorize access** and accept the permission screen.

Copy the **Web app URL**.

### 8.5 Grant the running identity access to BigQuery

Because you chose "Execute as: Me", the app runs as **your** Google account.
Your account already has access, so it will work today. That is fine for
testing and wrong for production, because the app stops working the day you
change role. Fix that in Part 11.

### 8.6 Open it

Paste the URL into your browser.

> **You should see** the navy header with the TravelDen wordmark, a freshness
> badge showing how long ago data was collected, and eight tiles with real
> numbers from your mock data.

> **If you see "No access"** — your account is not in any of the three
> Workspace groups. Add yourself to `pricing-leads@`.
>
> **If the tiles are blank but the page loads** — BigQuery is reachable but
> the account lacks `bigquery.jobUser`. Grant it:
> ```bash
> gcloud projects add-iam-policy-binding $GCP_PROJECT \
>   --member="user:YOUR_EMAIL@yourdomain.com" \
>   --role="roles/bigquery.jobUser" --condition=None
> ```

### 8.7 Try an approval

Go to the **Daily review** tab. Find a row with an Approve button. Click it.

> **You should see** a green bar saying "Decision recorded in the audit trail."

Then check it was really recorded:

```bash
bq query --use_legacy_sql=false \
"SELECT decided_by, decision, ROUND(current_price) AS before,
        ROUND(approved_price) AS approved, apply_status
 FROM \`$GCP_PROJECT.tvd_fareiq_mart.fact_price_decision\`
 ORDER BY decided_at DESC LIMIT 5"
```

`decided_by` must be **your email address**, not a service account. If it is a
service account, the control model is broken and you should stop and tell me.

### 8.8 Try to break the floor

Click **Modify** on any row. Type a price well below the stated policy floor.
Submit.

> **You should see** a red bar refusing it and naming both prices.

If it accepts, do not go live. That refusal is the single most important
guardrail in the platform.

**Stage G and Stage H are now largely complete.**

---

## Part 9 :: the configuration workbook

This is how the pricing team owns the rules without touching code.

1. Create a Google Sheet called **TVD OTA FareIQ Pricing Config**.
2. Create five tabs named exactly: `Routes`, `Pricing Rules`, `Competitors`,
   `Daily Review`, `Sync Log`.
3. Put the header rows in (the exact column names are in
   `docs/DEPLOYMENT.md`, Stage 9).
4. Copy the Sheet ID out of its URL: the long string between `/d/` and `/edit`.
5. Push the Sheet script:

```bash
cd ~/Documents/FareIQ/appsscript
clasp create --type sheets --parentId "PASTE_SHEET_ID_HERE" --title "FareIQ Sheet Automation"
clasp push
```

6. In that script's properties set `GCP_PROJECT`, `PRICING_SERVICE_URL` and
   `DIGEST_RECIPIENTS`.
7. Run `installTriggers()` once from the editor. This creates the 06:45 sheet
   pull and the 07:00 email.
8. Go back to the **web app's** script properties and paste the Sheet ID into
   `CONFIG_SHEET_ID`.

---

## Part 10 :: switch to the real channels

Your four platforms are **Amadeus**, **Sabre**, **Verteil** (NDC aggregator)
and **direct airline NDC**. Do them one at a time, in that order. Never all
four at once: when something fails you want to know which one.

### 10.0 Rename the secrets if you created the old ones

The bootstrap script now creates the right names. If you already made secrets
called `amadeus_sds`, `duffel_ndc` or `licensed_market_feed`, they are not
used any more. Create the correct four:

```bash
for s in amadeus sabre verteil ndc_direct; do
  gcloud secrets create tvd-ota-fareiq-$s \
    --replication-policy=user-managed --locations=$GCP_REGION 2>/dev/null || true
done

for s in amadeus sabre verteil ndc_direct own_pss; do
  gcloud secrets add-iam-policy-binding tvd-ota-fareiq-$s \
    --member="serviceAccount:tvd-ota-fareiq-collector-sa@$GCP_PROJECT.iam.gserviceaccount.com" \
    --role=roles/secretmanager.secretAccessor
done
```

Delete the unused ones once everything works:
`gcloud secrets delete tvd-ota-fareiq-duffel_ndc`.

### 10.1 Amadeus first

Easiest production access of the four, and the broadest schedule coverage.

```bash
cat > /tmp/amadeus.json <<'JSON'
{"client_id":"REAL_ID","client_secret":"REAL_SECRET"}
JSON
gcloud secrets versions add tvd-ota-fareiq-amadeus --data-file=/tmp/amadeus.json
shred -u /tmp/amadeus.json 2>/dev/null || rm -P /tmp/amadeus.json
```

Never type a credential directly into a command. Your shell history keeps it
forever.

Test that one source alone, three requests only:

```bash
export TOKEN=$(gcloud auth print-identity-token)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"tier":"T1","source_ids":["amadeus"],"horizon_days":[30],"cabins":["ECONOMY"],"max_requests":3}' \
  $COLLECTOR/collect | python3 -m json.tool
```

> **You should see** `"collectors_ready": ["amadeus"]` and a non-zero `offers`
> count.

> **Use the test host first if you have one.** Amadeus test credentials return
> cached data. That is fine for proving the plumbing and useless for pricing,
> so switch to production credentials before you believe any number.

### 10.2 Sabre

```bash
cat > /tmp/sabre.json <<'JSON'
{"client_id":"REAL_ID",
 "client_secret":"REAL_SECRET",
 "pcc":"YOUR_PCC",
 "base_url":"https://api.sabre.com"}
JSON
gcloud secrets versions add tvd-ota-fareiq-sabre --data-file=/tmp/sabre.json
shred -u /tmp/sabre.json 2>/dev/null || rm -P /tmp/sabre.json
```

Two Sabre-specific notes:

- **The PCC is required.** Without your pseudo city code the request is
  rejected, and the error message will not say so clearly.
- **Use `https://api-crt.cert.havail.sabre.com` as `base_url` while testing.**
  That is the certification host. Move to `https://api.sabre.com` only when
  the parsing is proven.

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"tier":"T1","source_ids":["sabre"],"horizon_days":[30],"cabins":["ECONOMY"],"max_requests":3}' \
  $COLLECTOR/collect | python3 -m json.tool
```

### 10.3 Verteil

This one needs values only Verteil can give you, which is why they live in
the secret rather than in the code. Take them from the onboarding pack.

```bash
cat > /tmp/verteil.json <<'JSON'
{"base_url":"https://FROM_VERTEIL_PACK",
 "shop_path":"/entrygate/rest/request:airShopping",
 "ndc_version":"17.2",
 "third_party_id":"ALL",
 "username":"REAL_USERNAME",
 "password":"REAL_PASSWORD",
 "corporate_code":"TVD"}
JSON
gcloud secrets versions add tvd-ota-fareiq-verteil --data-file=/tmp/verteil.json
shred -u /tmp/verteil.json 2>/dev/null || rm -P /tmp/verteil.json
```

The adapter is written to the IATA NDC AirShopping schema, which is what an
aggregator serves. If Verteil's envelope differs, you will see a
`PARSE_ERROR` rather than a crash. Send me one real response body and I will
adjust the parser: no other part of the platform changes.

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"tier":"T1","source_ids":["verteil"],"horizon_days":[30],"cabins":["ECONOMY"],"max_requests":2}' \
  $COLLECTOR/collect | python3 -m json.tool
```

> **Watch the baggage field.** NDC is the one channel that returns branded
> fares and priced ancillaries in the same message. If `included_checked_bags`
> comes back populated here, your true customer cost just got materially more
> accurate than it can ever be from a GDS.

### 10.4 Direct airline NDC

One secret per carrier. Start with whichever carrier gives you the most
revenue on LOS routes.

```bash
cat > /tmp/ndc.json <<'JSON'
{"base_url":"https://FROM_THE_AIRLINE",
 "default_carrier":"VS",
 "username":"REAL_USERNAME",
 "password":"REAL_PASSWORD"}
JSON
gcloud secrets versions add tvd-ota-fareiq-ndc_direct --data-file=/tmp/ndc.json
shred -u /tmp/ndc.json 2>/dev/null || rm -P /tmp/ndc.json
```

**This is the one that matters most competitively.** Amadeus, Sabre and
Verteil all tell you what a flight *costs you*. A direct NDC price is what the
airline *sells to the customer*, so it is the only genuine competitor
benchmark you have until a licensed feed is contracted. See the note at the
end of this part.

### 10.5 Set the own-PSS URL

Your own booking engine needs a base URL as well as a key:

```bash
gcloud run services update tvd-ota-fareiq-collector --region=$GCP_REGION \
  --update-env-vars=OWN_ENGINE_URL=https://booking.travelden.example
```

### 10.6 Check what each channel actually returned

```bash
bq query --use_legacy_sql=false \
"SELECT channel, seller_type, offers, routes, carriers,
        avg_comparable_cost, avg_fee_confidence, baggage_coverage, blocked_rows
 FROM \`$GCP_PROJECT.tvd_fareiq_mart.v_channel_health\`
 WHERE obs_date = CURRENT_DATE() ORDER BY offers DESC"
```

> **You should see** a row per channel. `baggage_coverage` will be highest on
> Verteil and direct NDC, and lowest on the two GDSs. That is expected and it
> is exactly why NDC is worth the integration effort.

### 10.7 Look at the channel spread

This is the view that will pay for the platform fastest.

```bash
bq query --use_legacy_sql=false \
"SELECT route_key, departure_date, marketing_carrier, channels_priced,
        cheapest_channel, cheapest_cost, dearest_cost, spread_abs, spread_pct, spread_band
 FROM \`$GCP_PROJECT.tvd_fareiq_mart.v_channel_arbitrage\`
 WHERE obs_date = CURRENT_DATE() AND spread_band = 'MATERIAL'
 ORDER BY spread_abs DESC LIMIT 20"
```

> **You should see** the same flight priced differently across Amadeus, Sabre
> and Verteil. Every row with a `MATERIAL` spread is money you are leaving on
> the table by booking through the wrong channel, before any pricing decision
> is made.

### 10.8 Switch the schedulers over

```bash
for job in t1 t2 t3; do
  gcloud scheduler jobs update http tvd-ota-fareiq-collect-$job \
    --location=$GCP_REGION \
    --message-body='{"tier":"T1","horizon_days":[1,3,7,14,21,30,45,60,90],"cabins":["ECONOMY","BUSINESS"]}'
done
```

Removing `source_ids` puts them back on the production set.

---

### Something you need to know before you read a "market median"

Amadeus, Sabre and Verteil are **supply** channels. They tell you what a
flight costs you through that channel. None of them tells you what a competing
OTA is charging a customer.

The platform now separates these properly:

| Source | Type | Counts in the market median? |
|---|---|---|
| Our booking engine | `US` | No, it is the price being judged |
| Amadeus | `GDS_CHANNEL` | **No**, it is our cost |
| Sabre | `GDS_CHANNEL` | **No**, it is our cost |
| Verteil | `NDC_CHANNEL` | **No**, it is our cost |
| Airline direct NDC | `AIRLINE_DIRECT` | **Yes**, a customer can buy it |
| A licensed feed | `COMPETITOR_OTA` | Yes, when you contract one |

So with today's four platforms your competitor panel is airline-direct only,
usually one or two sellers per route. The engine requires three before it will
act on a price, so **most cells will correctly report `INVESTIGATE`**. That is
the platform being honest, not broken.

You have three ways forward, and you can do more than one:

1. **Connect more carriers via direct NDC.** Each one adds a real competitor
   to the panel. Three or four carriers on a route and the engine starts
   pricing properly.
2. **Contract a licensed competitor feed.** This is the only source that
   answers "what is a rival OTA charging". It takes three to six weeks, so
   start the conversation now even if you decide against it later.
3. **Use the platform for channel arbitrage first.** Section 10.7 needs no
   competitor data at all and is worth real money on day one. The competitive
   pricing half can follow once the panel is wide enough.

My recommendation: do 3 immediately, 1 over the next month, and open the
conversation on 2 this week.

## Part 11 :: clean up before go-live

### 11.1 Delete every synthetic row

Do this the moment real data starts flowing. Synthetic prices in a production
mart is the one mistake here that could cost real money.

```bash
gcloud run services update tvd-ota-fareiq-collector --region=$GCP_REGION \
  --remove-env-vars=FAREIQ_ALLOW_MOCK

bq query --use_legacy_sql=false \
"DELETE FROM \`$GCP_PROJECT.tvd_fareiq_raw.offer_snapshot\` WHERE source_id = 'mock_market';
 DELETE FROM \`$GCP_PROJECT.tvd_fareiq_mart.fact_offer\` WHERE source_id = 'mock_market';
 DELETE FROM \`$GCP_PROJECT.tvd_fareiq_mart.fact_market_snapshot\` WHERE snapshot_date < CURRENT_DATE();
 DELETE FROM \`$GCP_PROJECT.tvd_fareiq_mart.fact_price_recommendation\` WHERE review_date < CURRENT_DATE();
 DELETE FROM \`$GCP_PROJECT.tvd_fareiq_mart.dim_seller\` WHERE seller_id LIKE 'mock_%';"
```

Then verify nothing survived:

```bash
bq query --use_legacy_sql=false \
"SELECT COUNT(*) AS synthetic_rows_left
 FROM \`$GCP_PROJECT.tvd_fareiq_mart.fact_offer\`
 WHERE source_id = 'mock_market' OR seller_id LIKE 'mock_%'"
```

Must be 0.

### 11.2 Narrow the collector's permissions

It currently holds `bigquery.dataEditor` at project level, which lets it write
anywhere including the audit trail.

```bash
SA=tvd-ota-fareiq-collector-sa@$GCP_PROJECT.iam.gserviceaccount.com

gcloud projects remove-iam-policy-binding $GCP_PROJECT \
  --member="serviceAccount:$SA" --role="roles/bigquery.dataEditor" --condition=None

for ds in tvd_fareiq_raw tvd_fareiq_ops; do
  bq add-iam-policy-binding --member="serviceAccount:$SA" \
     --role="roles/bigquery.dataEditor" "$GCP_PROJECT:$ds"
done
bq add-iam-policy-binding --member="serviceAccount:$SA" \
   --role="roles/bigquery.dataViewer" "$GCP_PROJECT:tvd_fareiq_mart"
```

Then re-run one collection to confirm it still works. If it fails, you removed
something it needed: put the project-level role back, run the collection, and
read the logs to see exactly which dataset it wanted.

### 11.3 Redeploy the dashboard under a service identity

Change the Apps Script deployment from "Execute as: Me" to the
`tvd-ota-fareiq-workspace` service account, and grant that account
`bigquery.dataViewer` on the mart plus `bigquery.jobUser` on the project. The
full commands are in `docs/DEPLOYMENT.md`, Stage 8.

### 11.4 Final check

```bash
cd ~/Documents/FareIQ
bash deploy/99_verify.sh
```

Resolve every `FAIL`.

### 11.5 Confirm nothing is public

```bash
for s in tvd-ota-fareiq-collector tvd-ota-fareiq-pricing; do
  echo "== $s"
  gcloud run services get-iam-policy $s --region=$GCP_REGION --format=json | grep -c allUsers
done
```

Both must print `0`.

---

## Your order of work from here

| # | Do | Where |
|---|---|---|
| 1 | Take the new code, rebuild the collector locally with `--platform linux/amd64`, deploy | Part 1 and 2 |
| 2 | Confirm `COLLECTOR_INIT` now appears in the dry run | Part 3 |
| 3 | Turn on the mock source, collect a few hundred offers | Part 4 |
| 4 | Deploy the pricing service | Part 5 |
| 5 | Load FX, transform, recommend, read a rationale | Part 6 |
| 6 | Turn the schedulers on against the mock source, leave it a week | Part 7 |
| 7 | Deploy the dashboard, approve something, try to break the floor | Part 8 |
| 8 | Build the config workbook | Part 9 |
| 9 | When credentials land, one supplier at a time | Part 10 |
| 10 | Delete the synthetic data, narrow the IAM, verify | Part 11 |

Parts 1 to 6 are one focused day. Parts 7 to 9 are a second day. Part 10 waits
on your suppliers, and Part 11 is an hour.

---

## Quick reference

### Set up a terminal

```bash
cd ~/Documents/FareIQ && source .venv/bin/activate && source ~/fareiq-env.sh
export TOKEN=$(gcloud auth print-identity-token)
```

### Call a service

```bash
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"...":"..."}' $PRICING/endpoint | python3 -m json.tool
```

### Read the logs when something fails

```bash
gcloud run services logs read tvd-ota-fareiq-collector --region=$GCP_REGION --limit=50
gcloud run services logs read tvd-ota-fareiq-pricing   --region=$GCP_REGION --limit=50
```

### Rebuild and redeploy anything

```bash
docker build --platform linux/amd64 -f services/SERVICE/Dockerfile -t $AR/SERVICE:vN .
docker push $AR/SERVICE:vN
gcloud run deploy SERVICE_NAME --image=$AR/SERVICE:vN --region=$GCP_REGION
```

### Stop everything immediately

```bash
for j in $(gcloud scheduler jobs list --location=$GCP_REGION --format='value(name)' | grep fareiq); do
  gcloud scheduler jobs pause "$j" --location=$GCP_REGION
done
```

Nothing is lost. The dashboard keeps serving history and no new recommendation
is produced.

---

## Errors you are most likely to hit

| What you see | What it means | Fix |
|---|---|---|
| `unrecognized arguments: --file` | Wrong gcloud flag | Build locally (1.3) or use `--config cloudbuild.yaml` |
| `container failed to start` | ARM image on Cloud Run | Rebuild with `--platform linux/amd64` |
| `Secret Version [latest] not found` | Secret exists but is empty | Expected until Part 10. Use the mock source |
| `verteil secret needs base_url` | Verteil secret missing its endpoint | Add `base_url` from the Verteil onboarding pack |
| Sabre returns 400 with no detail | Missing or wrong PCC | Put your pseudo city code in the Sabre secret |
| `403 Permission denied` on a curl | Token expired (they last about an hour) | `export TOKEN=$(gcloud auth print-identity-token)` |
| `offers: 0, errors: 0` | Collectors could not start | Read `collectors_failed` in the dry run |
| `rows_loaded: 0` but offers exist | BigQuery load failed | Read the Cloud Run logs |
| `BLOCKING_NO_FX_RATE` | Missing exchange rate | Part 6.1 |
| Everything is `INVESTIGATE` | Fewer than 3 competitors | Correct behaviour. Check which seller stopped reporting |
| Dashboard says "No access" | Not in a Workspace group | Add yourself to `pricing-leads@` |
| Dashboard loads, tiles blank | Missing `bigquery.jobUser` | Grant it at project level |
| `cannot connect to Docker daemon` | Docker Desktop not running | Open it and wait for the whale icon |

---

## One thing to remember

The mock source exists so you never have to sit and wait for a supplier
contract. Everything except the accuracy of the prices themselves can be
proven against it: the collection path, the true-cost model, the market
statistics, the pricing engine, the mining detectors, the dashboard, the
approval flow and the audit trail.

The one rule is that it must never reach production. It refuses to start
without `FAREIQ_ALLOW_MOCK=1`, every offer it makes is tagged as synthetic,
and every competitor it invents is named `mock_something`. Part 11.1 removes
all of it in one command.
