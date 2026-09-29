-- FareIQ :: BigQuery bootstrap
-- Region: europe-west2 (or africa-south1 if latency to Lagos matters more than service breadth).
-- Keep every dataset in ONE region. Cross-region joins are not allowed in BigQuery.

CREATE SCHEMA IF NOT EXISTS `${PROJECT}.tvd_fareiq_raw`
OPTIONS (
  location = '${BQ_LOCATION}',
  description = 'Landing zone. Append only. Payloads stored as JSON exactly as received. 90 day partition expiry.',
  default_partition_expiration_days = 90
);

CREATE SCHEMA IF NOT EXISTS `${PROJECT}.tvd_fareiq_stg`
OPTIONS (
  location = '${BQ_LOCATION}',
  description = 'Typed, deduplicated, currency normalised offers. Rebuilt incrementally.',
  default_partition_expiration_days = 400
);

CREATE SCHEMA IF NOT EXISTS `${PROJECT}.tvd_fareiq_mart`
OPTIONS (
  location = '${BQ_LOCATION}',
  description = 'Analytical source of truth. Facts, dimensions, pricing outputs, audit trail. No expiry.'
);

CREATE SCHEMA IF NOT EXISTS `${PROJECT}.tvd_fareiq_ml`
OPTIONS (
  location = '${BQ_LOCATION}',
  description = 'BigQuery ML models, training views, evaluation logs.'
);

CREATE SCHEMA IF NOT EXISTS `${PROJECT}.tvd_fareiq_ops`
OPTIONS (
  location = '${BQ_LOCATION}',
  description = 'Pipeline telemetry, data quality results, collection cost, source SLA tracking.'
);
