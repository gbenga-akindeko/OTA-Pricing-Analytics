-- =====================================================================
-- MART :: FACTS
-- Grain discipline. Get this wrong and every number downstream lies.
--   fact_offer            : one row per offer per seller per collection
--   fact_market_snapshot  : one row per route/date/cabin/collection window
--   fact_price_recommendation : one row per recommendation
--   fact_price_decision   : one row per human decision (the audit trail)
--   fact_booking          : one row per ticketed booking
-- =====================================================================

CREATE TABLE IF NOT EXISTS `${PROJECT}.tvd_fareiq_mart.fact_offer`
(
  offer_sk                STRING    NOT NULL,
  snapshot_id             STRING    NOT NULL OPTIONS(description='Lineage back to tvd_fareiq_raw.offer_snapshot.'),
  collection_run_id       STRING    NOT NULL,
  collected_at            TIMESTAMP NOT NULL,
  collection_window       TIMESTAMP NOT NULL OPTIONS(description='collected_at rounded down to the half hour. Makes like for like comparison possible across sellers polled minutes apart.'),

  route_key               STRING    NOT NULL,
  origin                  STRING    NOT NULL,
  destination             STRING    NOT NULL,
  departure_date          DATE      NOT NULL,
  return_date             DATE,
  trip_type               STRING    NOT NULL,
  cabin                   STRING    NOT NULL,
  days_to_departure       INT64     NOT NULL OPTIONS(description='departure_date minus DATE(collected_at). The single strongest price driver.'),
  dtd_bucket              STRING    NOT NULL OPTIONS(description='0-1 | 2-3 | 4-7 | 8-14 | 15-21 | 22-30 | 31-60 | 61-90 | 90+.'),
  is_weekend_departure    BOOL,
  pos_country             STRING    NOT NULL,

  seller_id               STRING    NOT NULL,
  seller_type             STRING    NOT NULL,
  source_id               STRING    NOT NULL,
  source_tier             STRING    NOT NULL,
  trust_score             NUMERIC   NOT NULL,

  marketing_carrier       STRING,
  operating_carrier       STRING,
  fare_basis_code         STRING,
  fare_family             STRING,
  booking_class           STRING,
  stops_count             INT64,
  total_duration_minutes  INT64,
  is_refundable           BOOL,
  is_changeable           BOOL,
  included_checked_bags   INT64,

  -- Money in the quote currency and in base currency (NGN) at the observation date rate
  quote_currency          STRING    NOT NULL,
  base_fare               NUMERIC,
  taxes_total             NUMERIC,
  displayed_total         NUMERIC   NOT NULL,
  fx_rate_to_base         NUMERIC   NOT NULL,
  displayed_total_base    NUMERIC   NOT NULL OPTIONS(description='displayed_total * fx_rate_to_base. All cross seller maths uses this.'),

  -- True cost to the customer. The number the shopper actually pays for a
  -- comparable trip. This, not displayed_total, is the comparison currency
  -- of the whole platform.
  bag_fee_base            NUMERIC   NOT NULL DEFAULT 0,
  seat_fee_base           NUMERIC   NOT NULL DEFAULT 0,
  payment_fee_base        NUMERIC   NOT NULL DEFAULT 0,
  other_fee_base          NUMERIC   NOT NULL DEFAULT 0,
  flexibility_value_base  NUMERIC   NOT NULL DEFAULT 0 OPTIONS(description='Monetised value of change/refund rights, positive = the offer is worth more than its price suggests. Subtracted when comparing.'),
  true_customer_cost_base NUMERIC   NOT NULL OPTIONS(description='displayed_total_base + bag + seat + payment + other. The comparable total.'),
  comparable_cost_base    NUMERIC   NOT NULL OPTIONS(description='true_customer_cost_base minus flexibility_value_base minus convenience adjustments. Used for ranking.'),
  fee_confidence          NUMERIC   NOT NULL OPTIONS(description='0 to 1. Falls when ancillaries were imputed from the catalogue rather than quoted live.'),

  availability_status     STRING,
  seats_remaining         INT64,
  is_our_offer            BOOL      NOT NULL,
  legal_basis             STRING    NOT NULL,
  dq_flags                ARRAY<STRING> OPTIONS(description='Populated by the data quality suite. Rows with BLOCKING flags are excluded from market stats.')
)
PARTITION BY DATE(collected_at)
CLUSTER BY route_key, departure_date, cabin, seller_id
OPTIONS (
  description = 'Conformed offer fact. One row per priced offer observed. Every pricing number in the platform resolves to this table.',
  require_partition_filter = TRUE
);


-- ---------------------------------------------------------------------
-- Market snapshot. Pre-aggregated per route/date/cabin/window so the
-- dashboard never scans fact_offer. This is the cost control that keeps
-- Looker Studio bills flat as route count grows.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `${PROJECT}.tvd_fareiq_mart.fact_market_snapshot`
(
  market_sk                STRING    NOT NULL,
  collection_window        TIMESTAMP NOT NULL,
  snapshot_date            DATE      NOT NULL,
  route_key                STRING    NOT NULL,
  departure_date           DATE      NOT NULL,
  cabin                    STRING    NOT NULL,
  trip_type                STRING    NOT NULL,
  pos_country              STRING    NOT NULL,
  days_to_departure        INT64     NOT NULL,
  dtd_bucket               STRING    NOT NULL,

  -- Coverage. A market stat computed on two sellers is not a market stat.
  sellers_observed         INT64     NOT NULL,
  competitor_sellers       INT64     NOT NULL,
  offers_observed          INT64     NOT NULL,
  carriers_observed        INT64     NOT NULL,
  coverage_score           NUMERIC   NOT NULL OPTIONS(description='0 to 1. competitor_sellers over expected panel size for the route, capped at 1.'),

  -- Market statistics on comparable_cost_base, competitors only
  cheapest_competitor_id       STRING,
  cheapest_competitor_price    NUMERIC,
  second_cheapest_price        NUMERIC,
  market_min                   NUMERIC,
  market_p25                   NUMERIC,
  market_median                NUMERIC,
  market_mean                  NUMERIC,
  market_weighted_mean         NUMERIC OPTIONS(description='Weighted by dim_seller.benchmark_weight.'),
  market_p75                   NUMERIC,
  market_max                   NUMERIC,
  market_stddev                NUMERIC,
  market_dispersion            NUMERIC OPTIONS(description='stddev over median. High dispersion means the median is a weak anchor: confidence drops.'),

  -- Our position
  our_seller_id            STRING,
  our_displayed_total      NUMERIC,
  our_true_cost            NUMERIC,
  our_comparable_cost      NUMERIC,
  our_market_rank          INT64   OPTIONS(description='1 = cheapest comparable cost in the observed panel.'),
  price_gap_abs            NUMERIC OPTIONS(description='our_comparable_cost minus cheapest_competitor_price. Positive = we are dearer.'),
  price_gap_pct            NUMERIC,
  price_index_vs_median    NUMERIC OPTIONS(description='our_comparable_cost / market_median. 1.0 = at market.'),
  price_index_vs_cheapest  NUMERIC,

  -- Our economics on this cell
  our_supplier_cost        NUMERIC,
  our_gross_margin_abs     NUMERIC,
  our_gross_margin_pct     NUMERIC,

  -- Movement
  median_change_1d_pct     NUMERIC,
  median_change_7d_pct     NUMERIC,
  cheapest_change_1d_pct   NUMERIC,
  our_index_change_7d      NUMERIC,

  computed_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
)
PARTITION BY snapshot_date
CLUSTER BY route_key, departure_date, cabin
OPTIONS (description = 'One row per priced market cell per collection window. The dashboard and the pricing engine both read this, not fact_offer.');


-- ---------------------------------------------------------------------
-- Recommendations produced by the engine.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `${PROJECT}.tvd_fareiq_mart.fact_price_recommendation`
(
  recommendation_id        STRING    NOT NULL,
  generated_at             TIMESTAMP NOT NULL,
  review_date              DATE      NOT NULL OPTIONS(description='The pricing day this recommendation belongs to.'),
  engine_version           STRING    NOT NULL OPTIONS(description='Git SHA of the pricing engine. Non negotiable for reproducibility.'),
  ruleset_version          STRING    NOT NULL OPTIONS(description='Hash of the active dim_pricing_rule set.'),

  route_key                STRING    NOT NULL,
  departure_date           DATE      NOT NULL,
  cabin                    STRING    NOT NULL,
  trip_type                STRING    NOT NULL,
  pos_country              STRING    NOT NULL,
  marketing_carrier        STRING,
  fare_family              STRING,
  market_sk                STRING    NOT NULL OPTIONS(description='The market snapshot this recommendation was computed from.'),

  current_price            NUMERIC   NOT NULL,
  supplier_cost            NUMERIC   NOT NULL,
  current_margin_abs       NUMERIC   NOT NULL,
  current_margin_pct       NUMERIC   NOT NULL,

  minimum_price            NUMERIC   NOT NULL OPTIONS(description='Cost plus the binding margin floor plus fees. Hard boundary.'),
  target_price             NUMERIC   NOT NULL OPTIONS(description='Price implied by target margin and target index, before constraints.'),
  recommended_price        NUMERIC   NOT NULL OPTIONS(description='Constrained, rounded, publishable price.'),
  price_change_abs         NUMERIC   NOT NULL,
  price_change_pct         NUMERIC   NOT NULL,

  classification           STRING    NOT NULL OPTIONS(description='COMPETITIVE | WATCH | UNCOMPETITIVE | MARGIN_OPPORTUNITY | PROTECTED.'),
  action                   STRING    NOT NULL OPTIONS(description='HOLD | INCREASE | DECREASE | INVESTIGATE | ESCALATE.'),
  priority                 STRING    NOT NULL OPTIONS(description='P1 | P2 | P3.'),
  priority_score           NUMERIC   NOT NULL OPTIONS(description='Continuous score behind the band. Used for ranking within a band.'),

  confidence               NUMERIC   NOT NULL OPTIONS(description='0 to 1. Product of data, coverage, freshness, fee, model and stability components.'),
  confidence_components    STRUCT<
                             data_quality NUMERIC,
                             coverage     NUMERIC,
                             freshness    NUMERIC,
                             fee_certainty NUMERIC,
                             model        NUMERIC,
                             stability    NUMERIC
                           >,

  expected_demand_units    NUMERIC   OPTIONS(description='Forecast bookings for this cell over the remaining selling window at current price.'),
  elasticity_used          NUMERIC,
  expected_volume_delta_pct NUMERIC,
  expected_revenue_impact  NUMERIC   OPTIONS(description='Over the remaining selling window, in base currency.'),
  expected_margin_impact   NUMERIC,
  opportunity_value        NUMERIC   OPTIONS(description='Absolute expected margin impact. The ranking currency of the daily review.'),

  reason_codes             ARRAY<STRING> OPTIONS(description='Machine readable drivers, e.g. GAP_ABOVE_CHEAPEST, FLOOR_BINDING, FEE_ADVANTAGE, THIN_PANEL.'),
  rationale                STRING    OPTIONS(description='Human readable one paragraph explanation rendered into the email and dashboard.'),
  guardrails_triggered     ARRAY<STRING>,

  status                   STRING    NOT NULL DEFAULT 'PENDING' OPTIONS(description='PENDING | APPROVED | REJECTED | MODIFIED | EXPIRED | AUTO_APPLIED.')
)
PARTITION BY review_date
CLUSTER BY route_key, priority, classification
OPTIONS (description = 'Every recommendation the engine has ever produced, whether or not a human acted on it. Never delete: this is the evidence base for measuring the engine.');


-- ---------------------------------------------------------------------
-- The audit trail. This table is why the platform can be trusted.
-- Append only, enforced by IAM: the service account has no UPDATE grant.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `${PROJECT}.tvd_fareiq_mart.fact_price_decision`
(
  decision_id           STRING    NOT NULL,
  recommendation_id     STRING    NOT NULL,
  decided_at            TIMESTAMP NOT NULL,
  decided_by            STRING    NOT NULL OPTIONS(description='Google Workspace identity of the approver. Never a service account for a human decision.'),
  decision              STRING    NOT NULL OPTIONS(description='APPROVED | REJECTED | MODIFIED | DEFERRED.'),
  decision_channel      STRING    NOT NULL OPTIONS(description='SHEET | DASHBOARD | API. Where the click happened.'),

  current_price         NUMERIC   NOT NULL OPTIONS(description='Price at the moment of decision, restated so the record stands alone.'),
  recommended_price     NUMERIC   NOT NULL,
  approved_price        NUMERIC             OPTIONS(description='Null when rejected. Differs from recommended when MODIFIED.'),
  override_reason       STRING              OPTIONS(description='Mandatory when decision is MODIFIED or REJECTED. Enforced in the UI.'),

  competitor_benchmark  STRUCT<
                          cheapest_competitor_id STRING,
                          cheapest_price         NUMERIC,
                          market_median          NUMERIC,
                          our_rank               INT64,
                          sellers_observed       INT64
                        > OPTIONS(description='Frozen copy of the market at decision time. Do not join to live data to reconstruct this.'),
  expected_margin_pct   NUMERIC,
  expected_margin_abs   NUMERIC,
  expected_revenue_impact NUMERIC,
  confidence            NUMERIC,

  applied_at            TIMESTAMP OPTIONS(description='When the approved price actually reached the booking engine.'),
  apply_status          STRING    OPTIONS(description='PENDING | APPLIED | FAILED | ROLLED_BACK.'),
  apply_error           STRING,

  -- Outcome, backfilled by the measurement job at T+7 and T+30
  outcome_measured_at   TIMESTAMP,
  actual_bookings_7d    INT64,
  actual_revenue_7d     NUMERIC,
  actual_margin_7d      NUMERIC,
  actual_conversion_7d  NUMERIC,
  actual_vs_expected_margin_pct NUMERIC OPTIONS(description='The scorecard. Drives engine calibration.')
)
PARTITION BY DATE(decided_at)
CLUSTER BY decided_by, decision
OPTIONS (description = 'Immutable human decision log. Append only by IAM. The regulatory and commercial record of who priced what, when, on what evidence.');


CREATE TABLE IF NOT EXISTS `${PROJECT}.tvd_fareiq_mart.fact_booking`
(
  booking_sk         STRING    NOT NULL,
  booking_reference  STRING    NOT NULL,
  booked_at          TIMESTAMP NOT NULL,
  booking_date       DATE      NOT NULL,
  route_key          STRING    NOT NULL,
  trip_type          STRING             OPTIONS(description='ONE_WAY | ROUND_TRIP | MULTI_CITY, from the sold itinerary.'),
  itinerary          STRING             OPTIONS(description='Every airport as sold, e.g. LOS-MED-JED-LOS.'),
  departure_date     DATE               OPTIONS(description='NULL when the source records only the issue date, as the TVD sales register does.'),
  booking_lead_days  INT64,
  cabin              STRING    NOT NULL,
  marketing_carrier  STRING,
  fare_family        STRING,
  channel            STRING,
  customer_segment   STRING,
  pos_country        STRING,
  pax_count          INT64     NOT NULL,
  supplier_cost_base NUMERIC   NOT NULL,
  selling_price_base NUMERIC   NOT NULL,
  markup_base        NUMERIC,
  service_fee_base   NUMERIC,
  commission_base    NUMERIC,
  payment_cost_base  NUMERIC,
  ancillary_rev_base NUMERIC,
  gross_margin_base  NUMERIC   NOT NULL OPTIONS(description='selling + commission + ancillary - supplier - payment cost. The margin definition used everywhere.'),
  gross_margin_pct   NUMERIC   NOT NULL,
  status             STRING    NOT NULL,
  price_index_at_booking NUMERIC OPTIONS(description='Backfilled from the nearest market snapshot. Enables elasticity estimation.')
)
PARTITION BY booking_date
CLUSTER BY route_key, marketing_carrier, cabin
OPTIONS (description = 'Ticketed bookings with a single agreed margin definition. Joined to market snapshots to estimate elasticity.');


-- ---------------------------------------------------------------------
-- Mining signals. Written by the Python mining job, read by the Apps Script
-- dashboard. A signal is never a price change: it is a reason for a human to
-- look, and an input that lowers the engine's confidence on affected cells.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `${PROJECT}.tvd_fareiq_mart.fact_mining_signal`
(
  signal_date     DATE      NOT NULL,
  detected_at     TIMESTAMP NOT NULL,
  signal_type     STRING    NOT NULL OPTIONS(description='PRICE_ANOMALY | COMPETITOR_ANOMALY | COMPETITOR_REGIME_SHIFT | FEE_CHANGE | COVERAGE_DROP | PRICE_PATTERN | SUSPECTED_MISTAKE_FARE.'),
  severity        STRING    NOT NULL OPTIONS(description='LOW | MEDIUM | HIGH.'),
  metric          STRING    NOT NULL,
  observed_value  NUMERIC,
  expected_value  NUMERIC,
  deviation_score NUMERIC   OPTIONS(description='Robust z score, or a percentage change where that reads better.'),
  route_key       STRING,
  seller_id       STRING,
  carrier         STRING,
  detail          STRING    OPTIONS(description='One paragraph a pricing analyst can act on without reading the code.'),
  evidence        JSON
)
PARTITION BY signal_date
CLUSTER BY signal_type, severity, route_key
OPTIONS (description = 'Output of the Python mining jobs: anomalies, regime shifts, coverage gaps, fee moves and recurring price patterns.');
