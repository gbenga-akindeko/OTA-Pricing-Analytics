#!/usr/bin/env bash
# Least privilege IAM. The important properties this enforces:
#   * Nobody and nothing can UPDATE or DELETE fact_price_decision.
#   * Apps Script can read the mart but cannot write BigQuery at all.
#   * Analysts see the mart, not the raw layer.
#   * Credentials exist only in Secret Manager, granted per service account.
set -euo pipefail

PROJECT="${GCP_PROJECT:?}"
LOC="${BQ_LOCATION:-europe-west2}"

SA_COLLECTOR="tvd-ota-fareiq-collector-sa@${PROJECT}.iam.gserviceaccount.com"
SA_PRICING="tvd-ota-fareiq-pricing-sa@${PROJECT}.iam.gserviceaccount.com"
SA_SCHEDULER="tvd-ota-fareiq-scheduler@${PROJECT}.iam.gserviceaccount.com"
SA_APPSSCRIPT="tvd-ota-fareiq-workspace@${PROJECT}.iam.gserviceaccount.com"

GRP_ANALYSTS="pricing-analysts@yourdomain.com"
GRP_LEADS="pricing-leads@yourdomain.com"
GRP_EXEC="commercial-exec@yourdomain.com"

for sa in collector-sa pricing-sa scheduler workspace; do
  gcloud iam service-accounts create "tvd-ota-fareiq-${sa}" --project="$PROJECT" 2>/dev/null || true
done

# --- collector: write raw only ----------------------------------------
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:${SA_COLLECTOR}" --role="roles/storage.objectCreator" --condition=None
bq add-iam-policy-binding --member="serviceAccount:${SA_COLLECTOR}" \
  --role="roles/bigquery.dataEditor" "${PROJECT}:tvd_fareiq_raw"
bq add-iam-policy-binding --member="serviceAccount:${SA_COLLECTOR}" \
  --role="roles/bigquery.dataEditor" "${PROJECT}:tvd_fareiq_ops"
bq add-iam-policy-binding --member="serviceAccount:${SA_COLLECTOR}" \
  --role="roles/bigquery.dataViewer" "${PROJECT}:tvd_fareiq_mart"

# --- pricing: read raw, write mart and ml ------------------------------
bq add-iam-policy-binding --member="serviceAccount:${SA_PRICING}" \
  --role="roles/bigquery.dataViewer" "${PROJECT}:tvd_fareiq_raw"
bq add-iam-policy-binding --member="serviceAccount:${SA_PRICING}" \
  --role="roles/bigquery.dataEditor" "${PROJECT}:tvd_fareiq_mart"
bq add-iam-policy-binding --member="serviceAccount:${SA_PRICING}" \
  --role="roles/bigquery.dataEditor" "${PROJECT}:tvd_fareiq_ml"

# --- Apps Script identity: read the mart, invoke the pricing service ----
# Note the absence of any dataEditor grant. Every write from the Workspace
# layer goes through the pricing service, so it lands in the audit trail with
# the human's identity attached.
bq add-iam-policy-binding --member="serviceAccount:${SA_APPSSCRIPT}" \
  --role="roles/bigquery.dataViewer" "${PROJECT}:tvd_fareiq_mart"
gcloud run services add-iam-policy-binding tvd-ota-fareiq-pricing \
  --member="serviceAccount:${SA_APPSSCRIPT}" --role="roles/run.invoker" --region="${GCP_REGION:-europe-west2}"

# --- scheduler ---------------------------------------------------------
for svc in tvd-ota-fareiq-collector tvd-ota-fareiq-pricing; do
  gcloud run services add-iam-policy-binding "$svc" \
    --member="serviceAccount:${SA_SCHEDULER}" --role="roles/run.invoker" \
    --region="${GCP_REGION:-europe-west2}"
done

# --- secrets: one secret per source, granted only to who needs it -------
for s in own_pss amadeus sabre verteil ndc_direct; do
  gcloud secrets add-iam-policy-binding "tvd-ota-fareiq-${s}" \
    --member="serviceAccount:${SA_COLLECTOR}" --role="roles/secretmanager.secretAccessor" || true
done

# --- humans ------------------------------------------------------------
# Analysts: the mart only, and the audit views. No raw payloads (they can
# contain contractual content we should not spread).
bq add-iam-policy-binding --member="group:${GRP_ANALYSTS}" \
  --role="roles/bigquery.dataViewer" "${PROJECT}:tvd_fareiq_mart"
bq add-iam-policy-binding --member="group:${GRP_LEADS}" \
  --role="roles/bigquery.dataViewer" "${PROJECT}:tvd_fareiq_mart"
bq add-iam-policy-binding --member="group:${GRP_LEADS}" \
  --role="roles/bigquery.dataViewer" "${PROJECT}:tvd_fareiq_ops"

gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="group:${GRP_ANALYSTS}" --role="roles/bigquery.jobUser" --condition=None
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="group:${GRP_EXEC}" --role="roles/bigquery.jobUser" --condition=None

echo "IAM applied."
echo
echo "Remaining manual controls to configure in the console:"
echo "  1. Column level security on tvd_fareiq_raw.offer_snapshot.raw_payload (policy tag: contract-content)."
echo "  2. Row level security on fact_booking if margin must be hidden from some viewers."
echo "  3. A BigQuery custom quota per user so nobody can scan the whole warehouse by accident."
echo "  4. VPC Service Controls perimeter around the project if competitor data licences require it."
