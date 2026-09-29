#!/usr/bin/env bash
# TVD OTA FareIQ :: run the whole pipeline on synthetic data
#
# Lets the platform be exercised end to end before any supplier credential
# exists: mock collection -> transform -> market snapshot -> recommendations.
#
# Mock data only ever goes through the TEST collector, which is the service
# carrying FAREIQ_ALLOW_MOCK=1. The production collector stays clean, so
# switching to real channels later is a scheduler change, not a clean-up job.
#
# Usage
#   bash deploy/run_mock_pipeline.sh               collect, transform, dry-run recommend
#   bash deploy/run_mock_pipeline.sh --apply       ...and write the recommendations
#   bash deploy/run_mock_pipeline.sh --schedule    ...and keep it running on Cloud Scheduler
#   bash deploy/run_mock_pipeline.sh --skip-collect --apply   reuse data already loaded
#   bash deploy/run_mock_pipeline.sh --seed-bookings          ...and fake our own bookings
#
# --seed-bookings writes one synthetic ticketed booking per market cell, with a
# supplier cost of 90.5% of our mock price (the mock's own convention). The
# engine refuses to move a price without a supplier cost, and that only comes
# from fact_booking, so without it every cell reports INVESTIGATE. The rows
# carry channel 'MOCK' and booking references starting 'MOCK-'.
#
# Overrides (environment)
#   GCP_PROJECT     default tvd-fareiq-prod
#   GCP_REGION      default europe-west2
#   MOCK_COLLECTOR  default tvd-ota-fareiq-collector-test
#   HORIZONS        default "1,3,7,14,21,30,45,60,90"
#   CABINS          default "ECONOMY","BUSINESS"
#   WINDOW_HOURS    default 72
#   TRIPS           default "ONE_WAY","ROUND_TRIP"
#   STAY_DAYS       default 14 (return date for round trips)
#
# Everything the mock writes carries source_id 'mock_market' and seller ids
# starting 'mock_'; seeded bookings carry channel 'MOCK'.
# docs/STEP_BY_STEP.md Part 11.1 deletes all of it.
set -euo pipefail

PROJECT="${GCP_PROJECT:-tvd-fareiq-prod}"
REGION="${GCP_REGION:-europe-west2}"
COLLECTOR_SVC="${MOCK_COLLECTOR:-tvd-ota-fareiq-collector-test}"
PRICING_SVC="tvd-ota-fareiq-pricing"
PROD_COLLECTOR="tvd-ota-fareiq-collector"
SCHEDULER_SA="tvd-ota-fareiq-scheduler@${PROJECT}.iam.gserviceaccount.com"
T1_JOB="tvd-ota-fareiq-collector-t1"
HORIZONS="${HORIZONS:-1,3,7,14,21,30,45,60,90}"
CABINS="${CABINS:-\"ECONOMY\",\"BUSINESS\"}"
TRIPS="${TRIPS:-\"ONE_WAY\",\"ROUND_TRIP\"}"
STAY_DAYS="${STAY_DAYS:-14}"
WINDOW_HOURS="${WINDOW_HOURS:-72}"

APPLY=0; SCHEDULE=0; COLLECT=1; SEED=0
for arg in "$@"; do
  case "$arg" in
    --apply)        APPLY=1 ;;
    --schedule)     SCHEDULE=1 ;;
    --skip-collect) COLLECT=0 ;;
    --seed-bookings) SEED=1 ;;
    -h|--help)      sed -n '2,36p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[32mOK\033[0m  %s\n' "$1"; }
warn() { printf '    \033[33m!!\033[0m  %s\n' "$1"; }
die()  { printf '\n\033[31mSTOPPED:\033[0m %s\n' "$1" >&2; exit 1; }

PY="$(command -v python3 || command -v python || true)"
[[ -n "$PY" ]] || die "python3 not found. Activate the project venv first: source .venv/bin/activate"
command -v gcloud >/dev/null || die "gcloud not found. Run: source ~/Downloads/google-cloud-sdk/path.zsh.inc"
command -v bq     >/dev/null || die "bq not found (it ships with the Google Cloud SDK)."

# The mock must never be pointed at production by accident.
if [[ "$COLLECTOR_SVC" == "$PROD_COLLECTOR" && "${ALLOW_PROD_MOCK:-0}" != "1" ]]; then
  die "MOCK_COLLECTOR is the production collector. Use the test service, or set ALLOW_PROD_MOCK=1 if you really mean it."
fi

# Print one field from JSON on stdin. $1 is a Python expression over d.
jget() { "$PY" -c "import sys,json; d=json.load(sys.stdin); print($1)"; }

# POST JSON to a service. Prints the body on 200, otherwise shows it and fails.
post() {
  local url="$1" body="$2" resp code
  resp="$(curl -sS -m 900 -X POST \
            -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
            -d "$body" -w $'\n%{http_code}' "$url")" || return 1
  code="${resp##*$'\n'}"; resp="${resp%$'\n'*}"
  if [[ "$code" != "200" ]]; then
    printf '    HTTP %s from %s\n    %s\n' "$code" "$url" "$resp" >&2
    return 1
  fi
  printf '%s' "$resp"
}

get() {
  curl -sS -m 60 -H "Authorization: Bearer ${TOKEN}" "$1"
}

# Single-row BigQuery query, printed as one CSV line.
bqrow() {
  local out
  if ! out="$(bq --quiet --project_id="$PROJECT" --location="$REGION" --format=csv \
                query --use_legacy_sql=false "$1" 2>&1)"; then
    printf '%s\n' "$out" >&2
    return 1
  fi
  printf '%s\n' "$out" | tail -n 1
}

# Run a statement where only success matters (DML, DDL).
bqexec() {
  local out
  if ! out="$(bq --quiet --project_id="$PROJECT" --location="$REGION" \
                query --use_legacy_sql=false "$1" 2>&1)"; then
    printf '%s\n' "$out" >&2
    return 1
  fi
}

svc_url() {
  gcloud run services describe "$1" --region="$REGION" --project="$PROJECT" \
    --format='value(status.url)'
}

# ----------------------------------------------------------------------------
say "Preflight"

COLLECTOR_URL="$(svc_url "$COLLECTOR_SVC")" || die "Cannot find Cloud Run service $COLLECTOR_SVC."
PRICING_URL="$(svc_url "$PRICING_SVC")"     || die "Cannot find Cloud Run service $PRICING_SVC."
TOKEN="$(gcloud auth print-identity-token)" || die "No identity token. Run: gcloud auth login"

mock_flag="$(gcloud run services describe "$COLLECTOR_SVC" --region="$REGION" --project="$PROJECT" \
  --format=json | jget 'next((e.get("value","") for e in d["spec"]["template"]["spec"]["containers"][0].get("env",[]) if e["name"]=="FAREIQ_ALLOW_MOCK"), "")')"
[[ "$mock_flag" == "1" ]] || die "$COLLECTOR_SVC does not have FAREIQ_ALLOW_MOCK=1. Add it with:
  gcloud run services update $COLLECTOR_SVC --region=$REGION --project=$PROJECT --update-env-vars=FAREIQ_ALLOW_MOCK=1"
ok "$COLLECTOR_SVC has FAREIQ_ALLOW_MOCK=1"

c_health="$(get "$COLLECTOR_URL/health")"
[[ "$c_health" == *'"status":"ok"'* ]] || die "Collector /health failed: $c_health"
ok "collector healthy: $(printf '%s' "$c_health" | jget 'd["revision"]')"

p_health="$(get "$PRICING_URL/health")"
[[ "$p_health" == *'"status":"ok"'* ]] || die "Pricing /health failed: $p_health"
ok "pricing healthy: $(printf '%s' "$p_health" | jget 'd["revision"] + "  engine " + d["engine_version"]')"

rules="$(bqrow "SELECT COUNT(*) FROM \`${PROJECT}.tvd_fareiq_mart.dim_pricing_rule\` WHERE is_active AND scope_type = 'GLOBAL'")"
if [[ "${rules:-0}" -gt 0 ]]; then
  ok "$rules active GLOBAL pricing rule(s)"
else
  warn "No active GLOBAL pricing rule. Recommendations will run on code defaults."
  warn "Seed one with: GCP_PROJECT=$PROJECT bash deploy/01_seed_config.sh"
fi

routes="$(bqrow "SELECT COUNT(*) FROM \`${PROJECT}.tvd_fareiq_mart.dim_route\` WHERE is_monitored AND monitoring_tier = 'T1'")"
[[ "${routes:-0}" -gt 0 ]] || die "No monitored T1 routes in dim_route, so there is nothing to collect."
ok "$routes monitored T1 route(s)"

# ----------------------------------------------------------------------------
if [[ "$COLLECT" == "1" ]]; then
  say "Collecting mock offers through $COLLECTOR_SVC"
  body="{\"tier\":\"T1\",\"source_ids\":[\"mock_market\"],\"horizon_days\":[${HORIZONS}],\"cabins\":[${CABINS}],\"trip_types\":[${TRIPS}],\"stay_days\":${STAY_DAYS}}"
  resp="$(post "$COLLECTOR_URL/collect" "$body")" || die "Collection failed (response above)."
  offers="$(printf '%s' "$resp" | jget 'd["offers"]')"
  loaded="$(printf '%s' "$resp" | jget 'd["rows_loaded"]')"
  errs="$(printf '%s' "$resp"   | jget 'd["errors"]')"
  printf '    run %s: %s requests, %s offers, %s loaded, %s errors\n' \
    "$(printf '%s' "$resp" | jget 'd["run_id"]')" \
    "$(printf '%s' "$resp" | jget 'd["requests"]')" "$offers" "$loaded" "$errs"
  [[ "$offers" -gt 0 ]]        || die "The mock returned no offers."
  [[ "$offers" == "$loaded" ]] || die "Only $loaded of $offers offers reached BigQuery. Read: gcloud run services logs read $COLLECTOR_SVC --region=$REGION --limit=30"
  ok "every offer reached tvd_fareiq_raw.offer_snapshot"
else
  say "Skipping collection (--skip-collect)"
fi

# ----------------------------------------------------------------------------
if [[ "$SEED" == "1" ]]; then
  say "Seeding synthetic bookings (supplier cost for our mock offers)"
  # fact_offer must hold this window's offers before bookings can be derived
  # from them, so run the transform once first. It is idempotent.
  post "$PRICING_URL/transform" "{\"window_hours\":${WINDOW_HOURS}}" >/dev/null \
    || die "Transform failed before seeding (response above)."
  bqexec "
    MERGE \`${PROJECT}.tvd_fareiq_mart.fact_booking\` T
    USING (
      SELECT
        TO_HEX(SHA256(CONCAT('mock|', route_key, '|', CAST(departure_date AS STRING), '|', cabin, '|', pos_country))) AS booking_sk,
        CURRENT_TIMESTAMP() AS booked_at,
        CURRENT_DATE() AS booking_date,
        route_key, departure_date,
        DATE_DIFF(departure_date, CURRENT_DATE(), DAY) AS booking_lead_days,
        cabin, marketing_carrier, fare_family, pos_country,
        CAST(ROUND(price * 0.905) AS NUMERIC) AS supplier_cost_base,
        price AS selling_price_base
      FROM (
        SELECT route_key, departure_date, cabin, pos_country,
               ANY_VALUE(marketing_carrier) AS marketing_carrier,
               ANY_VALUE(fare_family) AS fare_family,
               MIN(displayed_total_base) AS price
        FROM \`${PROJECT}.tvd_fareiq_mart.fact_offer\`
        WHERE collected_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${WINDOW_HOURS} HOUR)
          AND source_id = 'mock_market' AND is_our_offer
        GROUP BY 1, 2, 3, 4
      )
    ) S
    ON T.booking_sk = S.booking_sk AND T.booking_date = S.booking_date
    WHEN NOT MATCHED THEN INSERT
      (booking_sk, booking_reference, booked_at, booking_date, route_key, departure_date,
       booking_lead_days, cabin, marketing_carrier, fare_family, channel, customer_segment,
       pos_country, pax_count, supplier_cost_base, selling_price_base, markup_base,
       gross_margin_base, gross_margin_pct, status)
    VALUES
      (S.booking_sk, CONCAT('MOCK-', SUBSTR(S.booking_sk, 1, 12)), S.booked_at, S.booking_date,
       S.route_key, S.departure_date, S.booking_lead_days, S.cabin, S.marketing_carrier,
       S.fare_family, 'MOCK', 'MOCK', S.pos_country, 1, S.supplier_cost_base,
       S.selling_price_base, S.selling_price_base - S.supplier_cost_base,
       S.selling_price_base - S.supplier_cost_base,
       SAFE_DIVIDE(S.selling_price_base - S.supplier_cost_base, S.selling_price_base),
       'TICKETED')" || die "Could not seed synthetic bookings (error above)."
  booked="$(bqrow "SELECT COUNT(*) FROM \`${PROJECT}.tvd_fareiq_mart.fact_booking\` WHERE booking_date = CURRENT_DATE() AND channel = 'MOCK'")"
  ok "$booked synthetic booking(s) for today (channel 'MOCK')"
fi

# ----------------------------------------------------------------------------
say "Transform: raw -> fact_offer -> fact_market_snapshot (last ${WINDOW_HOURS}h)"
post "$PRICING_URL/transform" "{\"window_hours\":${WINDOW_HOURS}}" >/dev/null \
  || die "Transform failed (response above). Logs: gcloud run services logs read $PRICING_SVC --region=$REGION --limit=40"
ok "both transform steps completed"

IFS=, read -r fo_total fo_blocked <<<"$(bqrow "
  SELECT COUNT(*),
         COUNTIF(EXISTS(SELECT 1 FROM UNNEST(dq_flags) f WHERE f LIKE 'BLOCKING_%'))
  FROM \`${PROJECT}.tvd_fareiq_mart.fact_offer\`
  WHERE collected_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${WINDOW_HOURS} HOUR)")"
printf '    fact_offer: %s rows in window, %s blocked by data quality\n' "$fo_total" "$fo_blocked"
[[ "${fo_total:-0}" -gt 0 ]] || die "fact_offer is empty for the window. Did the collection land?"
if [[ "$fo_blocked" == "$fo_total" ]]; then
  die "Every offer is blocked, so the market snapshot will be empty. Check dq_flags:
  bq query --use_legacy_sql=false --location=$REGION 'SELECT dq_flags, COUNT(*) FROM \`${PROJECT}.tvd_fareiq_mart.fact_offer\` WHERE collected_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${WINDOW_HOURS} HOUR) GROUP BY 1'"
fi

IFS=, read -r ms_cells ms_ours <<<"$(bqrow "
  SELECT COUNT(*), COUNTIF(our_comparable_cost IS NOT NULL)
  FROM \`${PROJECT}.tvd_fareiq_mart.fact_market_snapshot\`
  WHERE snapshot_date = CURRENT_DATE()")"
printf '    fact_market_snapshot today: %s cells, %s with our own price\n' "$ms_cells" "$ms_ours"
ms_cost="$(bqrow "SELECT COUNTIF(our_supplier_cost IS NOT NULL) FROM \`${PROJECT}.tvd_fareiq_mart.fact_market_snapshot\` WHERE snapshot_date = CURRENT_DATE()")"
if [[ "${ms_cost:-0}" -gt 0 ]]; then
  ok "$ms_cost cell(s) carry a supplier cost"
else
  warn "No cell has a supplier cost, so every recommendation will be INVESTIGATE."
  warn "Add --seed-bookings to fake our own bookings for the mock run."
fi
[[ "${ms_ours:-0}" -gt 0 ]] || die "No market cell for today carries our price, so /recommend has nothing to score."
ok "market snapshot built"

# ----------------------------------------------------------------------------
say "Recommendations (dry run)"
dry="$(post "$PRICING_URL/recommend" '{"dry_run":true}')" || die "Recommend dry run failed (response above)."
printf '%s' "$dry" | "$PY" -c '
import sys, json
d = json.load(sys.stdin)
print("    cells to score: %s" % d["cells"])
for r in d.get("sample", []):
    print("    - %s %s %s: %s -> %s  [%s %s]" % (
        r["route_key"], r["departure_date"], r["cabin"],
        round(r["current_price"] or 0), round(r["recommended_price"] or 0),
        r["action"], r["priority"]))
    print("      %s" % (r.get("rationale") or "")[:160])
'

if [[ "$APPLY" == "1" ]]; then
  say "Writing recommendations"
  res="$(post "$PRICING_URL/recommend" '{}')" || die "Recommend failed (response above)."
  printf '%s' "$res" | jget '"    scored %s, actionable %s, P1 %s (engine %s)" % (d["cells_scored"], d["actionable"], d["p1"], d["engine_version"])'
  ok "written to tvd_fareiq_mart.fact_price_recommendation"
else
  warn "Dry run only. Re-run with --apply to write recommendations."
fi

# ----------------------------------------------------------------------------
if [[ "$SCHEDULE" == "1" ]]; then
  say "Scheduling the mock pipeline"

  # The scheduler identity needs to invoke both services.
  for svc in "$COLLECTOR_SVC" "$PRICING_SVC"; do
    gcloud run services add-iam-policy-binding "$svc" --region="$REGION" --project="$PROJECT" \
      --member="serviceAccount:${SCHEDULER_SA}" --role="roles/run.invoker" >/dev/null
  done
  ok "scheduler can invoke $COLLECTOR_SVC and $PRICING_SVC"

  collect_body="{\"tier\":\"T1\",\"source_ids\":[\"mock_market\"],\"horizon_days\":[${HORIZONS}],\"cabins\":[${CABINS}],\"trip_types\":[${TRIPS}],\"stay_days\":${STAY_DAYS}}"
  if gcloud scheduler jobs describe "$T1_JOB" --location="$REGION" --project="$PROJECT" >/dev/null 2>&1; then
    gcloud scheduler jobs update http "$T1_JOB" --location="$REGION" --project="$PROJECT" \
      --schedule="0 * * * *" --time-zone="Africa/Lagos" \
      --uri="${COLLECTOR_URL}/collect" --http-method=POST \
      --update-headers="Content-Type=application/json" \
      --message-body="$collect_body" \
      --oidc-service-account-email="$SCHEDULER_SA" --oidc-token-audience="$COLLECTOR_URL" >/dev/null
  else
    gcloud scheduler jobs create http "$T1_JOB" --location="$REGION" --project="$PROJECT" \
      --schedule="0 * * * *" --time-zone="Africa/Lagos" \
      --uri="${COLLECTOR_URL}/collect" --http-method=POST \
      --headers="Content-Type=application/json" \
      --message-body="$collect_body" \
      --oidc-service-account-email="$SCHEDULER_SA" --oidc-token-audience="$COLLECTOR_URL" >/dev/null
  fi
  gcloud scheduler jobs resume "$T1_JOB" --location="$REGION" --project="$PROJECT" >/dev/null 2>&1 || true
  ok "$T1_JOB: hourly mock collection on $COLLECTOR_SVC"

  # Same names deploy/schedulers.sh uses, so running that script later simply
  # replaces these with the production versions.
  pricing_job() {
    local name="$1" schedule="$2" path="$3" body="$4"
    gcloud scheduler jobs delete "$name" --location="$REGION" --project="$PROJECT" --quiet >/dev/null 2>&1 || true
    gcloud scheduler jobs create http "$name" --location="$REGION" --project="$PROJECT" \
      --schedule="$schedule" --time-zone="Africa/Lagos" \
      --uri="${PRICING_URL}${path}" --http-method=POST \
      --headers="Content-Type=application/json" --message-body="$body" \
      --oidc-service-account-email="$SCHEDULER_SA" --oidc-token-audience="$PRICING_URL" \
      --attempt-deadline=1800s >/dev/null
    ok "$name: $schedule (Africa/Lagos) -> $path"
  }
  pricing_job tvd-ota-fareiq-transform "30 5 * * *" /transform '{"window_hours":24}'
  pricing_job tvd-ota-fareiq-recommend "15 6 * * *" /recommend '{}'

  warn "Hourly mock collection is now live. Pause it with:"
  warn "  gcloud scheduler jobs pause $T1_JOB --location=$REGION --project=$PROJECT"
fi

say "Done"
cat <<EOF
    Everything written today is synthetic (source_id 'mock_market', sellers 'mock_*',
    bookings with channel 'MOCK').
    Before go-live, run the clean-up in docs/STEP_BY_STEP.md Part 11.1.
EOF
