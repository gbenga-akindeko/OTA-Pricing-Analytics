-- =====================================================================
-- BIGQUERY ML
-- Three models, in the order you should build them. Do not start with
-- elasticity: you cannot estimate it before you have price variation and
-- clean conversion data.
-- =====================================================================

-- ---------------------------------------------------------------------
-- MODEL 1 :: Fair market price. "What should this cell cost, given the
-- route, carrier, cabin, days to departure and seasonality?"
-- Purpose: detect anomalous competitor prices and price cells where the
-- panel is thin. This is the model that lets you price a route/date with
-- only one observed competitor.
-- ---------------------------------------------------------------------
CREATE OR REPLACE MODEL `${PROJECT}.tvd_fareiq_ml.m_fair_price`
OPTIONS (
  model_type = 'BOOSTED_TREE_REGRESSOR',
  input_label_cols = ['comparable_cost_base'],
  max_iterations = 60,
  learn_rate = 0.1,
  subsample = 0.85,
  l2_reg = 1.0,
  early_stop = TRUE,
  data_split_method = 'CUSTOM',
  data_split_col = 'is_holdout'
) AS
SELECT
  o.route_key,
  o.marketing_carrier,
  o.cabin,
  o.trip_type,
  o.pos_country,
  o.days_to_departure,
  o.stops_count,
  o.total_duration_minutes,
  o.included_checked_bags,
  o.is_refundable,
  EXTRACT(DAYOFWEEK FROM o.departure_date) AS departure_dow,
  EXTRACT(MONTH     FROM o.departure_date) AS departure_month,
  FORMAT_DATE('%V', o.departure_date)      AS departure_week,
  dr.region_pair,
  dr.haul_type,
  dc.carrier_type,
  o.comparable_cost_base,
  (DATE(o.collected_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL 14 DAY)) AS is_holdout
FROM `${PROJECT}.tvd_fareiq_mart.fact_offer` o
LEFT JOIN `${PROJECT}.tvd_fareiq_mart.dim_route` dr   ON dr.route_key = o.route_key
LEFT JOIN `${PROJECT}.tvd_fareiq_mart.dim_carrier` dc ON dc.carrier_code = o.marketing_carrier
WHERE o.collected_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 365 DAY)
  AND NOT EXISTS (SELECT 1 FROM UNNEST(o.dq_flags) f WHERE f LIKE 'BLOCKING_%')
  AND o.comparable_cost_base BETWEEN 1000 AND 20000000;


-- ---------------------------------------------------------------------
-- MODEL 2 :: Demand forecast per route/cabin/departure week.
-- Feeds expected_revenue_impact. A recommendation without a volume
-- forecast cannot state a revenue impact honestly.
-- ---------------------------------------------------------------------
CREATE OR REPLACE MODEL `${PROJECT}.tvd_fareiq_ml.m_demand_forecast`
OPTIONS (
  model_type = 'ARIMA_PLUS_XREG',
  time_series_timestamp_col = 'booking_week',
  time_series_data_col      = 'pax',
  time_series_id_col        = 'series_id',
  horizon = 12,
  auto_arima = TRUE,
  data_frequency = 'WEEKLY',
  holiday_region = 'GLOBAL'
) AS
SELECT
  CONCAT(b.route_key, '|', b.cabin) AS series_id,
  TIMESTAMP(DATE_TRUNC(b.booking_date, WEEK)) AS booking_week,
  SUM(b.pax_count) AS pax,
  AVG(b.price_index_at_booking) AS avg_price_index,
  AVG(b.selling_price_base) AS avg_price
FROM `${PROJECT}.tvd_fareiq_mart.fact_booking` b
WHERE b.booking_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 730 DAY)
  AND b.status IN ('TICKETED', 'BOOKED')
GROUP BY series_id, booking_week
HAVING pax > 0;


-- ---------------------------------------------------------------------
-- MODEL 3 :: Conversion / price response. Logistic on the search funnel.
-- The coefficient on log(price_index) is the workhorse elasticity input.
-- Only train this once you have at least ~8 weeks of genuine price
-- variation, ideally from deliberate holdout tests, not passive drift.
-- ---------------------------------------------------------------------
CREATE OR REPLACE MODEL `${PROJECT}.tvd_fareiq_ml.m_conversion`
OPTIONS (
  model_type = 'LOGISTIC_REG',
  input_label_cols = ['converted'],
  auto_class_weights = TRUE,
  l2_reg = 0.1,
  data_split_method = 'AUTO_SPLIT'
) AS
WITH sessions AS (
  SELECT
    e.session_id,
    ANY_VALUE(CONCAT(e.origin, '-', e.destination)) AS route_key,
    ANY_VALUE(e.cabin)        AS cabin,
    ANY_VALUE(e.channel)      AS channel,
    ANY_VALUE(e.pos_country)  AS pos_country,
    ANY_VALUE(e.pax_count)    AS pax_count,
    MIN(e.displayed_price)    AS displayed_price,
    ANY_VALUE(DATE_DIFF(e.departure_date, DATE(e.event_ts), DAY)) AS days_to_departure,
    ANY_VALUE(e.offer_rank)   AS offer_rank,
    MAX(IF(e.event_type = 'PURCHASE', 1, 0)) AS converted,
    MIN(e.event_ts) AS session_start
  FROM `${PROJECT}.tvd_fareiq_raw.own_search_event` e
  WHERE e.event_ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 365 DAY)
  GROUP BY e.session_id
)
SELECT
  s.route_key, s.cabin, s.channel, s.pos_country,
  s.pax_count, s.days_to_departure, s.offer_rank,
  LOG(GREATEST(SAFE_DIVIDE(s.displayed_price, NULLIF(ms.market_median, 0)), 0.2)) AS log_price_index,
  SAFE_DIVIDE(s.displayed_price, NULLIF(ms.cheapest_competitor_price, 0)) AS index_vs_cheapest,
  ms.competitor_sellers,
  EXTRACT(DAYOFWEEK FROM DATE(s.session_start)) AS session_dow,
  s.converted
FROM sessions s
JOIN `${PROJECT}.tvd_fareiq_mart.fact_market_snapshot` ms
  ON ms.route_key = s.route_key AND ms.cabin = s.cabin
 AND ms.collection_window = TIMESTAMP_SECONDS(DIV(UNIX_SECONDS(s.session_start), 1800) * 1800)
WHERE ms.market_median > 0;


-- ---------------------------------------------------------------------
-- Elasticity extraction. Route level where data allows, region level as
-- the shrinkage prior. Never let a route with 6 bookings drive a price cut.
-- ---------------------------------------------------------------------
CREATE OR REPLACE TABLE `${PROJECT}.tvd_fareiq_ml.route_elasticity` AS
WITH obs AS (
  SELECT
    b.route_key, b.cabin, dr.region_pair,
    DATE_TRUNC(b.booking_date, WEEK) AS wk,
    SUM(b.pax_count) AS pax,
    AVG(b.price_index_at_booking) AS price_index
  FROM `${PROJECT}.tvd_fareiq_mart.fact_booking` b
  LEFT JOIN `${PROJECT}.tvd_fareiq_mart.dim_route` dr ON dr.route_key = b.route_key
  WHERE b.booking_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 365 DAY)
    AND b.price_index_at_booking BETWEEN 0.5 AND 2.0
  GROUP BY 1,2,3,4
  HAVING pax > 0
),
route_fit AS (
  SELECT
    route_key, cabin, ANY_VALUE(region_pair) AS region_pair,
    COUNT(*) AS weeks,
    SUM(pax) AS total_pax,
    -- OLS slope of log(pax) on log(price_index) = elasticity
    SAFE_DIVIDE(
      COVAR_SAMP(LOG(pax), LOG(price_index)),
      NULLIF(VAR_SAMP(LOG(price_index)), 0)
    ) AS raw_elasticity,
    CORR(LOG(pax), LOG(price_index)) AS fit_corr
  FROM obs
  GROUP BY route_key, cabin
),
region_fit AS (
  SELECT region_pair, cabin,
         SAFE_DIVIDE(COVAR_SAMP(LOG(pax), LOG(price_index)), NULLIF(VAR_SAMP(LOG(price_index)), 0)) AS region_elasticity
  FROM obs GROUP BY region_pair, cabin
)
SELECT
  rf.route_key, rf.cabin, rf.region_pair, rf.weeks, rf.total_pax,
  rf.raw_elasticity, rf.fit_corr, gf.region_elasticity,
  -- James-Stein style shrinkage toward the region estimate.
  CAST(
    GREATEST(LEAST(
      COALESCE(
        (rf.weeks / (rf.weeks + ${ELASTICITY_SHRINK_K})) * COALESCE(rf.raw_elasticity, gf.region_elasticity)
        + (${ELASTICITY_SHRINK_K} / (rf.weeks + ${ELASTICITY_SHRINK_K})) * COALESCE(gf.region_elasticity, ${DEFAULT_ELASTICITY}),
        ${DEFAULT_ELASTICITY}
      ), ${ELASTICITY_CEILING}), ${ELASTICITY_FLOOR})
  AS NUMERIC) AS elasticity,
  CASE WHEN rf.weeks >= 26 AND ABS(rf.fit_corr) >= 0.35 THEN 'ROUTE'
       WHEN rf.weeks >= 12 THEN 'BLENDED'
       ELSE 'REGION_PRIOR' END AS elasticity_source,
  CURRENT_TIMESTAMP() AS computed_at
FROM route_fit rf
LEFT JOIN region_fit gf ON gf.region_pair = rf.region_pair AND gf.cabin = rf.cabin;
