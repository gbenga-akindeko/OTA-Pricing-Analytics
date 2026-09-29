#!/usr/bin/env bash
# TVD OTA FareIQ :: build and deploy the two Cloud Run services
#
# Manual equivalent of the GitHub Actions pipeline, for a first deploy or when
# CI is unavailable. Same shape as CI: deploy with no traffic, smoke test the
# candidate revision, then promote. A bad pricing engine must never reach the
# morning run.
set -euo pipefail

PROJECT="${GCP_PROJECT:?}"
REGION="${GCP_REGION:-europe-west2}"
LOC="${BQ_LOCATION:-europe-west2}"
RAW_BUCKET="${RAW_BUCKET:-${PROJECT}-fareiq-raw}"
AR="${REGION}-docker.pkg.dev/${PROJECT}/tvd-ota-fareiq"
SHA="$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M)"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

deploy_one () {
  local dir="$1" name="$2" mem="$3" cpu="$4" timeout="$5" conc="$6" maxi="$7"

  say "Building ${name}"
  docker build --platform linux/amd64 -f "services/${dir}/Dockerfile" -t "${AR}/${dir}:${SHA}" -t "${AR}/${dir}:latest" .
  docker push "${AR}/${dir}:${SHA}"
  docker push "${AR}/${dir}:latest"

  # --no-traffic is refused when the service does not exist yet, so the very
  # first deploy of a service takes traffic directly. Every later deploy goes
  # in dark and is only promoted after the smoke test.
  local traffic_flags=(--no-traffic --tag=candidate)
  if ! gcloud run services describe "${name}" --region="${REGION}" \
         --project="${PROJECT}" --format='value(metadata.name)' >/dev/null 2>&1; then
    traffic_flags=()
  fi

  say "Deploying ${name}"
  gcloud run deploy "${name}" \
    --image="${AR}/${dir}:${SHA}" \
    --region="${REGION}" \
    --project="${PROJECT}" \
    --no-allow-unauthenticated \
    --service-account="${name}-sa@${PROJECT}.iam.gserviceaccount.com" \
    --set-env-vars="GCP_PROJECT=${PROJECT},BQ_LOCATION=${LOC},GIT_SHA=${SHA},RAW_BUCKET=${RAW_BUCKET}" \
    --memory="${mem}" --cpu="${cpu}" --timeout="${timeout}" \
    --concurrency="${conc}" --min-instances=0 --max-instances="${maxi}" \
    "${traffic_flags[@]}"

  say "Smoke testing the candidate revision"
  local cand token
  cand="$(gcloud run services describe "${name}" --region="${REGION}" \
          --format='value(status.traffic[?tag=`candidate`].url)' | head -1)"
  [[ -z "$cand" ]] && cand="$(gcloud run revisions list --service="${name}" \
          --region="${REGION}" --limit=1 --format='value(status.url)')"
  [[ ${#traffic_flags[@]} -eq 0 ]] && cand="$(gcloud run services describe "${name}" \
          --region="${REGION}" --format='value(status.url)')"
  token="$(gcloud auth print-identity-token)"
  if ! curl -sf -H "Authorization: Bearer ${token}" "${cand}/health" | tee /dev/stderr | grep -q '"status":"ok"'; then
    echo "Smoke test FAILED. Traffic was not promoted; the previous revision is still live." >&2
    exit 1
  fi

  say "Promoting ${name}"
  gcloud run services update-traffic "${name}" --region="${REGION}" --to-latest
}

#           dir             service name                 mem   cpu timeout conc max
deploy_one  collector_svc   tvd-ota-fareiq-collector     2Gi   2   900     8    20
deploy_one  pricing_svc     tvd-ota-fareiq-pricing       4Gi   2   1800    4    10

cat <<EOF

Services deployed.

  Collector  $(gcloud run services describe tvd-ota-fareiq-collector --region="$REGION" --format='value(status.url)')
  Pricing    $(gcloud run services describe tvd-ota-fareiq-pricing   --region="$REGION" --format='value(status.url)')

The pricing service gets more memory and a longer timeout because it carries
pandas and scikit-learn for the mining job, and a lower concurrency because
each request holds a BigQuery result set in memory.

Next: bash deploy/schedulers.sh
EOF
