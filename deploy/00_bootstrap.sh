#!/usr/bin/env bash
# TVD OTA FareIQ :: one-time project bootstrap
#
# Run this once, before anything else. It is idempotent: every step either
# creates the resource or reports that it already exists, so rerunning after a
# partial failure is the normal recovery path.
#
#   export GCP_PROJECT=tvd-fareiq-prod
#   export GCP_REGION=europe-west2
#   export BQ_LOCATION=europe-west2
#   export BILLING_ACCOUNT=0X0X0X-0X0X0X-0X0X0X      # only if creating the project
#   bash deploy/00_bootstrap.sh
set -euo pipefail

PROJECT="${GCP_PROJECT:?set GCP_PROJECT}"
REGION="${GCP_REGION:-europe-west2}"
LOC="${BQ_LOCATION:-europe-west2}"
RAW_BUCKET="${RAW_BUCKET:-${PROJECT}-fareiq-raw}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# ---------------------------------------------------------------- project
say "Project"
if ! gcloud projects describe "$PROJECT" >/dev/null 2>&1; then
  if [[ -z "${BILLING_ACCOUNT:-}" ]]; then
    echo "Project $PROJECT does not exist and BILLING_ACCOUNT is not set." >&2
    echo "Either create the project first, or export BILLING_ACCOUNT and rerun." >&2
    exit 1
  fi
  gcloud projects create "$PROJECT" --name="TVD OTA FareIQ"
  gcloud billing projects link "$PROJECT" --billing-account="$BILLING_ACCOUNT"
fi
gcloud config set project "$PROJECT" >/dev/null

# ---------------------------------------------------------------- APIs
say "Enabling APIs (two to three minutes on a new project)"
gcloud services enable \
  bigquery.googleapis.com \
  bigquerystorage.googleapis.com \
  bigqueryconnection.googleapis.com \
  storage.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  cloudscheduler.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  logging.googleapis.com \
  monitoring.googleapis.com \
  script.googleapis.com \
  admin.googleapis.com \
  --project="$PROJECT"

# Cloud Scheduler needs an App Engine application in some project shapes.
if ! gcloud app describe --project="$PROJECT" >/dev/null 2>&1; then
  say "Creating the App Engine application Cloud Scheduler anchors to"
  gcloud app create --region="${REGION%-*}" --project="$PROJECT" 2>/dev/null \
    || echo "  (skipped: not required in this project, or already present)"
fi

# ---------------------------------------------------------------- storage
say "Raw landing bucket: gs://${RAW_BUCKET}"
if ! gcloud storage buckets describe "gs://${RAW_BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${RAW_BUCKET}" \
    --project="$PROJECT" --location="$LOC" \
    --uniform-bucket-level-access --public-access-prevention
fi

# Raw responses are the replay log, not an archive. Ninety days on standard,
# then cheaper storage, then gone, matching the raw dataset's partition expiry.
cat > /tmp/fareiq-lifecycle.json <<'JSON'
{
  "rule": [
    { "action": { "type": "SetStorageClass", "storageClass": "NEARLINE" },
      "condition": { "age": 30 } },
    { "action": { "type": "SetStorageClass", "storageClass": "COLDLINE" },
      "condition": { "age": 90 } },
    { "action": { "type": "Delete" },
      "condition": { "age": 400 } }
  ]
}
JSON
gcloud storage buckets update "gs://${RAW_BUCKET}" --lifecycle-file=/tmp/fareiq-lifecycle.json
rm -f /tmp/fareiq-lifecycle.json

# ---------------------------------------------------------------- registry
say "Artifact Registry"
if ! gcloud artifacts repositories describe tvd-ota-fareiq \
      --location="$REGION" --project="$PROJECT" >/dev/null 2>&1; then
  gcloud artifacts repositories create tvd-ota-fareiq \
    --repository-format=docker --location="$REGION" \
    --description="TVD OTA FareIQ service images" --project="$PROJECT"
fi

# ---------------------------------------------------------------- secrets
say "Secret shells (values are added separately, never from this script)"
for s in own_pss amadeus sabre verteil ndc_direct; do
  if ! gcloud secrets describe "tvd-ota-fareiq-${s}" --project="$PROJECT" >/dev/null 2>&1; then
    gcloud secrets create "tvd-ota-fareiq-${s}" \
      --replication-policy=user-managed --locations="$REGION" --project="$PROJECT"
    echo "  created tvd-ota-fareiq-${s} (no version yet)"
  fi
done

cat <<EOF

Bootstrap complete.

  Project        ${PROJECT}
  Region         ${REGION}
  BQ location    ${LOC}
  Raw bucket     gs://${RAW_BUCKET}
  Image repo     ${REGION}-docker.pkg.dev/${PROJECT}/tvd-ota-fareiq

Next, add a version to each secret. Never paste a credential into a shell
that records history; pipe a file instead:

  gcloud secrets versions add tvd-ota-fareiq-amadeus_sds \\
    --data-file=amadeus.json --project=${PROJECT}
  shred -u amadeus.json

Expected JSON shapes:
  own_pss     {"api_key":"..."}
  amadeus     {"client_id":"...","client_secret":"..."}
  sabre       {"client_id":"...","client_secret":"...","pcc":"...",
               "base_url":"https://api.sabre.com"}
  verteil     {"base_url":"...","shop_path":"/entrygate/rest/request:airShopping",
               "ndc_version":"17.2","username":"...","password":"...",
               "third_party_id":"...","corporate_code":"TVD"}
  ndc_direct  {"base_url":"...","default_carrier":"VS","username":"...","password":"..."}

The Verteil endpoint path and auth header vary by onboarding, which is why
they live in the secret rather than in code. Take them from the Verteil pack.

Then: bash deploy/iam.sh
EOF
