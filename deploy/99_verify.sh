#!/usr/bin/env bash
# TVD OTA FareIQ :: post-deployment verification
#
# Seven groups of checks, run in dependency order, each printing PASS, FAIL
# or WARN.
# Run it after every deployment and on the morning of go-live. A FAIL means
# something downstream will be silently wrong, so fix it before the pricing
# team is told the platform is live.
set -uo pipefail

PROJECT="${GCP_PROJECT:?}"
REGION="${GCP_REGION:-europe-west2}"
LOC="${BQ_LOCATION:-europe-west2}"
RAW_BUCKET="${RAW_BUCKET:-${PROJECT}-fareiq-raw}"

pass=0; fail=0; warn=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail+1)); }
meh()  { printf '  \033[33mWARN\033[0m  %s\n' "$1"; warn=$((warn+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

q() { bq query --use_legacy_sql=false --location="$LOC" --project_id="$PROJECT" \
        --format=csv --quiet "$1" 2>/dev/null | tail -1; }

# ---------------------------------------------------------------- 1 infra
head_ "Infrastructure"
for api in bigquery run cloudscheduler secretmanager artifactregistry; do
  if gcloud services list --enabled --project="$PROJECT" --format='value(config.name)' \
     2>/dev/null | grep -q "^${api}"; then ok "API enabled: ${api}"; else bad "API not enabled: ${api}"; fi
done

if gcloud storage buckets describe "gs://${RAW_BUCKET}" >/dev/null 2>&1; then
  ok "Raw bucket exists: gs://${RAW_BUCKET}"
else bad "Raw bucket missing: gs://${RAW_BUCKET}"; fi

# ---------------------------------------------------------------- 2 warehouse
head_ "Warehouse"
for ds in tvd_fareiq_raw tvd_fareiq_stg tvd_fareiq_mart tvd_fareiq_ml tvd_fareiq_ops; do
  if bq --project_id="$PROJECT" show --format=none "${PROJECT}:${ds}" >/dev/null 2>&1; then
    ok "Dataset: ${ds}"
  else bad "Dataset missing: ${ds}"; fi
done

region="$(bq --project_id="$PROJECT" --format=prettyjson show "${PROJECT}:tvd_fareiq_mart" 2>/dev/null \
          | python3 -c 'import sys,json;print(json.load(sys.stdin).get("location","?"))' 2>/dev/null)"
if [[ "${region,,}" == "${LOC,,}" ]]; then ok "Mart is in ${LOC}"
else bad "Mart is in '${region}', expected '${LOC}'. Cross-region joins are not allowed."; fi

n="$(q "SELECT COUNT(*) FROM \`${PROJECT}.tvd_fareiq_mart.INFORMATION_SCHEMA.TABLES\`")"
if [[ "${n:-0}" -ge 12 ]]; then ok "Mart has ${n} tables and views"
else bad "Mart has only ${n:-0} objects; rerun deploy/apply_sql.sh"; fi

# ---------------------------------------------------------------- 3 config
head_ "Configuration"
for check in \
  "dim_route|SELECT COUNT(*) FROM \`${PROJECT}.tvd_fareiq_mart.dim_route\` WHERE is_monitored|1" \
  "dim_seller|SELECT COUNT(*) FROM \`${PROJECT}.tvd_fareiq_mart.dim_seller\` WHERE is_benchmark|3" \
  "dim_pricing_rule|SELECT COUNT(*) FROM \`${PROJECT}.tvd_fareiq_mart.dim_pricing_rule\` WHERE is_active|1" \
  "dim_source|SELECT COUNT(*) FROM \`${PROJECT}.tvd_fareiq_mart.dim_source\` WHERE is_active|1" ; do
  IFS='|' read -r label sql minimum <<< "$check"
  got="$(q "$sql")"
  if [[ "${got:-0}" -ge "$minimum" ]]; then ok "${label}: ${got} rows"
  else bad "${label}: ${got:-0} rows, need at least ${minimum}. Run deploy/01_seed_config.sh"; fi
done

fx="$(q "SELECT COUNT(*) FROM \`${PROJECT}.tvd_fareiq_mart.dim_fx_rate\` WHERE rate_date = CURRENT_DATE()")"
if [[ "${fx:-0}" -ge 2 ]]; then ok "FX rates loaded for today (${fx})"
elif [[ "${fx:-0}" -ge 1 ]]; then meh "Only ${fx} FX rate today. Non-NGN quotes will be excluded as BLOCKING_NO_FX_RATE."
else bad "No FX rate for today. Every non-NGN offer will be dropped."; fi

# A global rule must exist or the engine silently falls back to code defaults.
g="$(q "SELECT COUNT(*) FROM \`${PROJECT}.tvd_fareiq_mart.dim_pricing_rule\` WHERE is_active AND scope_type='GLOBAL'")"
if [[ "${g:-0}" -ge 1 ]]; then ok "A global pricing rule is active"
else bad "No global pricing rule. The engine would run on code defaults nobody approved."; fi

# ---------------------------------------------------------------- 4 services
head_ "Services"
token="$(gcloud auth print-identity-token 2>/dev/null)"
for name in tvd-ota-fareiq-collector tvd-ota-fareiq-pricing; do
  url="$(gcloud run services describe "$name" --region="$REGION" \
         --format='value(status.url)' 2>/dev/null)"
  if [[ -z "$url" ]]; then bad "${name}: not deployed"; continue; fi
  body="$(curl -sf -m 30 -H "Authorization: Bearer ${token}" "${url}/health" 2>/dev/null)"
  if grep -q '"status":"ok"' <<< "$body"; then
    ok "${name}: healthy ($(grep -o '"revision":"[^"]*"' <<< "$body" | cut -d'"' -f4))"
    if grep -q '"warehouse":"reachable"' <<< "$body"; then ok "${name}: can reach BigQuery"
    elif grep -q '"warehouse"' <<< "$body"; then bad "${name}: cannot reach BigQuery. Check its service account grants."; fi
  else bad "${name}: health check failed"; fi
done

# ---------------------------------------------------------------- 5 schedule
head_ "Schedule"
jobs="$(gcloud scheduler jobs list --location="$REGION" --project="$PROJECT" \
        --format='value(name)' 2>/dev/null | grep -c 'tvd-ota-fareiq' || echo 0)"
if [[ "${jobs:-0}" -ge 8 ]]; then ok "${jobs} scheduler jobs configured"
else bad "Only ${jobs:-0} scheduler jobs. Expected 8. Run deploy/schedulers.sh"; fi

stuck="$(gcloud scheduler jobs list --location="$REGION" --project="$PROJECT" \
         --format='value(name,state)' 2>/dev/null | grep -c 'PAUSED' || echo 0)"
if [[ "${stuck:-0}" -eq 0 ]]; then ok "No paused scheduler jobs"
else meh "${stuck} scheduler jobs are paused"; fi

# ---------------------------------------------------------------- 6 data flow
head_ "Data flow"
raw="$(q "SELECT COUNT(*) FROM \`${PROJECT}.tvd_fareiq_raw.offer_snapshot\` WHERE collected_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)")"
if [[ "${raw:-0}" -gt 0 ]]; then ok "Raw offers in the last 24h: ${raw}"
else meh "No raw offers yet. Expected before the first collection sweep."; fi

off="$(q "SELECT COUNT(*) FROM \`${PROJECT}.tvd_fareiq_mart.fact_offer\` WHERE collected_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)")"
if [[ "${off:-0}" -gt 0 ]]; then ok "Typed offers in the last 24h: ${off}"
else meh "fact_offer is empty for the last 24h. Run the transform."; fi

if [[ "${raw:-0}" -gt 0 && "${off:-0}" -eq 0 ]]; then
  bad "Raw data exists but fact_offer is empty: the transform has not run or is failing."
fi

blocked="$(q "SELECT ROUND(SAFE_DIVIDE(COUNTIF(EXISTS(SELECT 1 FROM UNNEST(dq_flags) f WHERE f LIKE 'BLOCKING_%')), COUNT(*)) * 100, 1) FROM \`${PROJECT}.tvd_fareiq_mart.fact_offer\` WHERE collected_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)")"
if [[ -n "${blocked:-}" && "${blocked%%.*}" -le 5 ]] 2>/dev/null; then ok "Blocking DQ flags on ${blocked}% of rows"
elif [[ -n "${blocked:-}" ]]; then bad "Blocking DQ flags on ${blocked}% of rows. Usually a missing FX rate."; fi

cov="$(q "SELECT ROUND(AVG(coverage_score), 2) FROM \`${PROJECT}.tvd_fareiq_mart.fact_market_snapshot\` WHERE snapshot_date = CURRENT_DATE()")"
if [[ -n "${cov:-}" && "${cov}" != "" ]]; then
  if python3 -c "import sys;sys.exit(0 if float('${cov}')>=0.7 else 1)" 2>/dev/null; then
    ok "Panel coverage today: ${cov}"
  else meh "Panel coverage ${cov} is below 0.7. The engine will decline to act on thin cells."; fi
else meh "No market snapshots today yet."; fi

recs="$(q "SELECT COUNT(*) FROM \`${PROJECT}.tvd_fareiq_mart.fact_price_recommendation\` WHERE review_date = CURRENT_DATE()")"
if [[ "${recs:-0}" -gt 0 ]]; then ok "Recommendations today: ${recs}"
else meh "No recommendations today yet."; fi

# ---------------------------------------------------------------- 7 controls
head_ "Controls"
if bq --project_id="$PROJECT" show --format=none "${PROJECT}:tvd_fareiq_mart.fact_price_decision" >/dev/null 2>&1; then
  ok "Audit table exists"
else bad "fact_price_decision missing: no audit trail."; fi

secrets="$(gcloud secrets list --project="$PROJECT" --format='value(name)' 2>/dev/null | grep -c tvd-ota-fareiq || echo 0)"
if [[ "${secrets:-0}" -ge 4 ]]; then ok "${secrets} credential secrets present"
else bad "Only ${secrets:-0} secrets. Credentials must live in Secret Manager, never in env vars."; fi

novers=0
for s in own_pss amadeus_sds duffel_ndc licensed_market_feed; do
  v="$(gcloud secrets versions list "tvd-ota-fareiq-${s}" --project="$PROJECT" \
       --filter='state=enabled' --format='value(name)' 2>/dev/null | wc -l)"
  [[ "${v:-0}" -eq 0 ]] && novers=$((novers+1))
done
if [[ "$novers" -eq 0 ]]; then ok "All secrets have an enabled version"
else bad "${novers} secrets have no version. Those collectors will fail to start."; fi

printf '\n\033[1mResult: %d passed, %d warnings, %d failures\033[0m\n' "$pass" "$warn" "$fail"
[[ "$fail" -gt 0 ]] && exit 1
exit 0
