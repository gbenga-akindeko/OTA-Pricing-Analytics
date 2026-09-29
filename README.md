# TVD OTA FareIQ

Competitive pricing intelligence and revenue management for the TravelDen OTA,
built on Google Cloud and Google Workspace.

Every morning it answers one question: **what is the market charging today,
where are we positioned, what price should we offer, why, and what revenue or
margin impact should we expect?**

It is a decision support platform. The engine recommends, a pricing analyst
approves, and every decision is written to an append only audit trail.

---

## Repository layout

```
sql/
  00_bootstrap/   datasets, region, retention
  01_raw/         immutable landing tables (offers, fees, our transactions, funnel)
  02_staging/     parameterised transforms: raw -> fact_offer -> fact_market_snapshot
  03_marts/       dimensions and facts, the analytical source of truth
  04_views/       the only surface BI tools may touch
  05_ml/          BigQuery ML models and the elasticity table
src/fareiq/
  core/           domain objects, pricing rules, engine config
  collectors/     one adapter per channel, behind one interface
                  amadeus, sabre, verteil (NDC), direct airline NDC
                  mock.py: a synthetic market for testing without credentials
                  scraping.py: the permitted-public tier, with its guards
  engine/         true customer cost, pricing engine, recommendation logic
                  service_charge.py: channel arbitrage and price advantage
  mining/         anomalies, regime shifts, coverage gaps, price patterns
services/
  collector_svc/  Cloud Run: sweeps sources, lands raw to GCS then BigQuery
  pricing_svc/    Cloud Run: recommendations, mining job, the only writer to the audit trail
appsscript/
  Code.gs         Sheets config sync, fallback approval, Gmail digest
  webapp/         the dashboard: six pages, HTML Service, approvals in place
dashboards/       the Apps Script dashboard specification
docs/             DEPLOYMENT.md runbook, STEP_BY_STEP.md, COMPETITIVE_PRICING.md
deploy/           bootstrap, IAM, SQL apply, seed, deploy, schedulers, verify
config/           source register (this file is a compliance control)
tests/            the commercial rules, encoded
```

---

## The two ideas that make it work

**1. True customer cost.** Headline price is not what the customer pays.
Comparing headline prices produces systematically wrong decisions on routes
where fee structures differ. Every comparison in the platform runs on
`comparable_cost_base`: headline, plus baggage, seat, payment and other fees,
minus the monetised value of flexibility, plus a penalty for connections.

A competitor at 950,000 with a 60,000 bag fee and a 12,000 seat fee costs the
customer 1,022,000. We at 1,000,000 with both included are 22,000 cheaper
while looking 50,000 more expensive. That case is pinned in
`tests/test_true_cost.py`.

**2. The value gate.** A competitor being cheaper is evidence, not an
instruction. A cut is only recommended when it pays for itself. For a constant
elasticity demand curve, margin is flat when share elasticity equals
`price / (price - cost)`. Below that bar, discounting buys volume at a loss,
and the engine says so in plain language: the gap is a supplier cost problem,
not a price problem.

**3. Source arbitrage.** The same flight reaches us through Amadeus, Sabre,
direct NDC and Verteil at four different landed costs, and carriers price NDC
below GDS deliberately. Selling from the cheapest source is margin gained and
price advantage gained at the same time, with no change to what the customer
sees. See `docs/COMPETITIVE_PRICING.md`.

That distinction depends on using the right elasticity. Market demand
elasticity (about -1.4) is what an airline uses to set fare levels.
Competitive share elasticity (typically -4 to -15) is how our share responds
to our position on the same screen as the competition. Flights are close to a
commodity and metasearch sorts by price, so share moves violently. Using the
first number where the second belongs makes the break-even test unreachable
and the engine would never recommend a cut. See `EngineConfig` for the full
note.

---

## Quick start

```bash
pip install -e ".[dev]"
pytest tests -v                              # 130 tests, no cloud dependency
```

Full deployment is in **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**: thirteen
stages from an empty GCP project to a pricing team approving changes every
morning. The short version:

```bash
export GCP_PROJECT=tvd-fareiq-prod GCP_REGION=europe-west2 BQ_LOCATION=europe-west2

bash deploy/00_bootstrap.sh        # APIs, bucket, registry, secret shells
bash deploy/iam.sh                 # least privilege service accounts
bash deploy/apply_sql.sh           # datasets, tables, views
bash deploy/01_seed_config.sh      # routes, sellers, rules, FX
bash deploy/02_deploy_services.sh  # build, deploy no-traffic, smoke test, promote
bash deploy/schedulers.sh          # the daily cadence, Africa/Lagos
bash deploy/99_verify.sh           # 19 checks; resolve every FAIL before go-live
```

The Apps Script dashboard and the configuration workbook are stages 8 and 9 of
the runbook; both are manual, because a web app deployment and a Sheet cannot
be scripted end to end.

Explore the engine without any cloud setup:

```bash
PYTHONPATH=src python -c "
from datetime import date, timedelta
from fareiq.core.config import EngineConfig, DEFAULT_POLICY
from fareiq.core.models import MarketCell
from fareiq.engine.pricing import PricingEngine
"
```

---

## The daily cadence, Africa/Lagos

| Time | What runs | Where |
|---|---|---|
| hourly | T1 route sweep, 40 highest revenue routes | Cloud Scheduler to Cloud Run |
| every 4h | T2 sweep | Cloud Scheduler |
| 03:00 | T3 long tail sweep | Cloud Scheduler |
| 05:30 | raw to `fact_offer` to `fact_market_snapshot` | pricing service |
| 06:00 | model refresh, weekdays | BigQuery ML |
| 06:15 | recommendations written | pricing service |
| 05:45 | mining: anomalies, regime shifts, fee moves | Cloud Run job |
| 06:45 | Daily Review sheet populated | Apps Script trigger |
| 07:00 | Gmail digest to the pricing team | Apps Script trigger |
| through the day | analyst approves, modifies or rejects | dashboard to pricing service |
| 18:00 | outcome measurement at T+7 and T+30 | pricing service |

---

## Compliance posture

`config/sources.yaml` is a control, not documentation. The permitted public
collector reads it at runtime and refuses to run against anything without a
current legal review; a review older than 90 days stops collection
automatically. Preference order is always: our own systems, then contracted
GDS and NDC APIs, then licensed data feeds. Public collection is a last
resort, is rate limited far below what is technically possible, never
circumvents an access control, and carries a trust score that stops it being
the sole basis for a price change.

Every raw row records its `legal_basis`, so any number on any dashboard can be
traced to the right under which it was obtained.

---

## Supply against competition

The four connected platforms are Amadeus, Sabre, Verteil (NDC aggregator) and
direct airline NDC. Three of those four are **supply**: they say what a flight
costs us through that channel, not what a customer could pay elsewhere. The
model keeps the two apart, because mixing them produces a market median that
means nothing.

- `GDS_CHANNEL` and `NDC_CHANNEL` never enter a market statistic. They feed
  `v_channel_arbitrage`, which prices the same flight across every channel we
  hold a contract with. The spread there is routinely larger than any markup
  decision made on top of it.
- `AIRLINE_DIRECT` and `COMPETITOR_OTA` are the competitor panel. Today that
  is direct NDC only, so most cells will honestly report `INVESTIGATE` until
  more carriers are connected or a licensed feed is contracted.

Where scraping is used, `src/fareiq/collectors/scraping.py` enforces the rules
rather than describing them. A source is fetched only if the register lists it,
its terms have been reviewed as permitting collection, and that review is under
90 days old; `robots.txt` is parsed and obeyed per path with its `Crawl-delay`
overriding our own rate limit when it is slower; the user agent identifies us
honestly with a contact address; conditional GETs mean we never re-fetch an
unchanged page; and repeated 429s trip a breaker that pauses the source. A 401
or 403 ends collection from that source rather than starting a workaround: an
access control is a no. `tests/test_scraping.py` pins each of these.

---

## The dashboard

Six pages in an Apps Script web app, replacing Looker Studio: overview, daily
review, competitors, airline fees, routes, and opportunities with the audit
trail. Approve, modify and reject happen in the table, two clicks from the
evidence, and post to the pricing service rather than writing to BigQuery.

Full specification in `dashboards/appsscript_dashboard_spec.md`. Source in
`appsscript/webapp/`.
