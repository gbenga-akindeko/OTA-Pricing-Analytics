#!/usr/bin/env bash
# Applies DDL, views and models in dependency order. Idempotent: every
# statement is CREATE ... IF NOT EXISTS or CREATE OR REPLACE, so this is safe
# to run on every deploy.
set -euo pipefail

PROJECT="${GCP_PROJECT:?}"
LOC="${BQ_LOCATION:-europe-west2}"

render () {
  sed -e "s|\${PROJECT}|${PROJECT}|g" \
      -e "s|\${BQ_LOCATION}|${LOC}|g" \
      -e "s|\${CHANGE_PROBABILITY}|${CHANGE_PROBABILITY:-0.08}|g" \
      -e "s|\${CANCEL_PROBABILITY}|${CANCEL_PROBABILITY:-0.03}|g" \
      -e "s|\${BASELINE_STOPS}|${BASELINE_STOPS:-0}|g" \
      -e "s|\${STOP_PENALTY_BASE}|${STOP_PENALTY_BASE:-6000}|g" \
      -e "s|\${OUTLIER_ABS_CEILING}|${OUTLIER_ABS_CEILING:-20000000}|g" \
      -e "s|\${EXPECTED_PANEL_SIZE}|${EXPECTED_PANEL_SIZE:-5}|g" \
      -e "s|\${ELASTICITY_SHRINK_K}|${ELASTICITY_SHRINK_K:-20}|g" \
      -e "s|\${DEFAULT_ELASTICITY}|${DEFAULT_ELASTICITY:--6.0}|g" \
      -e "s|\${ELASTICITY_CEILING}|${ELASTICITY_CEILING:--0.5}|g" \
      -e "s|\${ELASTICITY_FLOOR}|${ELASTICITY_FLOOR:--18.0}|g" "$1"
}

# Order matters: datasets, then tables, then views, then models.
for dir in sql/00_bootstrap sql/01_raw sql/03_marts sql/04_views; do
  for f in $(find "$dir" -name '*.sql' | sort); do
    echo ">> $f"
    render "$f" | bq query --use_legacy_sql=false --location="$LOC" --project_id="$PROJECT"
  done
done

# Models are retrained on a schedule, not on every deploy. Apply only when
# APPLY_MODELS is set, so a routine code deploy does not trigger training cost.
if [[ "${APPLY_MODELS:-0}" == "1" ]]; then
  render sql/05_ml/models.sql | bq query --use_legacy_sql=false --location="$LOC" --project_id="$PROJECT"
fi
echo "SQL applied."
