#!/usr/bin/env bash
# Cloud Scheduler jobs. All times Africa/Lagos so the schedule reads the way
# the pricing team thinks about their day.
#
# The daily shape:
#   03:00  T3 sweep      long tail routes, once a day
#   every 4h T2 sweep    mid tier
#   :00/:30 T1 sweep     the routes that actually move revenue, every 30 min
#   :10/:40 transform    raw -> fact_offer -> fact_market_snapshot
#   05:45  mining        anomalies, regime shifts, coverage gaps, fee moves
#   06:00  ML refresh    elasticity and fair price (weekdays)
#   :20/:50 recommend    pricing engine rescores every cell, every 30 min
#   06:45  sheet pull    Apps Script trigger, not scheduler
#   07:00  digest        Apps Script trigger
#   18:00  outcomes      measure T+7 results of past decisions
#
# Cost note: every T1 sweep is one search per route, date, cabin and trip
# type. At 30 minutes that is 48 sweeps a day, so check the GDS contract's
# search quota (look-to-book) before pointing this at paid channels.
set -euo pipefail

PROJECT="${GCP_PROJECT:?set GCP_PROJECT}"
REGION="${GCP_REGION:-europe-west2}"
TZ_NAME="Africa/Lagos"
COLLECTOR_URL=$(gcloud run services describe tvd-ota-fareiq-collector --region="$REGION" --format='value(status.url)')
PRICING_URL=$(gcloud run services describe tvd-ota-fareiq-pricing --region="$REGION" --format='value(status.url)')
INVOKER="tvd-ota-fareiq-scheduler@${PROJECT}.iam.gserviceaccount.com"

job () {
  local name="$1" schedule="$2" url="$3" body="$4"
  gcloud scheduler jobs delete "$name" --location="$REGION" --quiet 2>/dev/null || true
  gcloud scheduler jobs create http "$name" \
    --location="$REGION" \
    --schedule="$schedule" \
    --time-zone="$TZ_NAME" \
    --uri="$url" \
    --http-method=POST \
    --headers="Content-Type=application/json" \
    --message-body="$body" \
    --oidc-service-account-email="$INVOKER" \
    --oidc-token-audience="${url%%/[a-z]*}" \
    --attempt-deadline=1800s \
    --max-retry-attempts=3 \
    --min-backoff=30s
}

# ---- collection -------------------------------------------------------
job tvd-ota-fareiq-collect-t1 "*/30 * * * *"  "${COLLECTOR_URL}/collect" \
  '{"tier":"T1","horizon_days":[1,3,7,14,21,30,45,60,90],"cabins":["ECONOMY","BUSINESS"]}'

job tvd-ota-fareiq-collect-t2 "15 */4 * * *"  "${COLLECTOR_URL}/collect" \
  '{"tier":"T2","horizon_days":[3,7,14,30,60,90],"cabins":["ECONOMY"]}'

job tvd-ota-fareiq-collect-t3 "0 3 * * *"     "${COLLECTOR_URL}/collect" \
  '{"tier":"T3","horizon_days":[7,30,60],"cabins":["ECONOMY"]}'

# ---- transform --------------------------------------------------------
job tvd-ota-fareiq-transform  "10,40 * * * *" "${PRICING_URL}/transform" \
  '{"window_hours":2}'

# ---- mining -----------------------------------------------------------
job tvd-ota-fareiq-mining "45 5 * * *" "${PRICING_URL}/mine" \
  '{"lookback_days":90}'

# ---- models (weekdays only: weekend retrains add noise, not signal) ----
job tvd-ota-fareiq-ml-refresh "0 6 * * 1-5"   "${PRICING_URL}/refresh-models" \
  '{"models":["fair_price","elasticity"]}'

# ---- recommendations --------------------------------------------------
job tvd-ota-fareiq-recommend  "20,50 * * * *" "${PRICING_URL}/recommend" '{}'

# ---- outcome measurement ---------------------------------------------
job tvd-ota-fareiq-outcomes   "0 18 * * *"    "${PRICING_URL}/measure-outcomes" \
  '{"lookback_days":[7,30]}'

echo "Scheduler jobs configured in ${REGION} (${TZ_NAME})."
gcloud scheduler jobs list --location="$REGION" --filter="name~fareiq"
