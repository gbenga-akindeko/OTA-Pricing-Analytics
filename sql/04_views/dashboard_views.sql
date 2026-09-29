-- =====================================================================
-- VIEWS :: the only surface Looker Studio / Power BI is allowed to touch.
-- Every view is narrow, pre-filtered and partition-pruned. BI tools do not
-- get direct access to fact_offer.
-- =====================================================================

-- 1. EXECUTIVE OVERVIEW ------------------------------------------------
CREATE OR REPLACE VIEW `${PROJECT}.tvd_fareiq_mart.v_exec_overview` AS
WITH latest AS (
  SELECT * FROM `${PROJECT}.tvd_fareiq_mart.fact_market_snapshot`
  WHERE snapshot_date = CURRENT_DATE()
    AND collection_window = (SELECT MAX(collection_window) FROM `${PROJECT}.tvd_fareiq_mart.fact_market_snapshot` WHERE snapshot_date = CURRENT_DATE())
),
recs AS (
  SELECT * FROM `${PROJECT}.tvd_fareiq_mart.fact_price_recommendation`
  WHERE review_date = CURRENT_DATE()
)
SELECT
  CURRENT_DATE()                                              AS review_date,
  COUNT(DISTINCT l.route_key)                                 AS routes_monitored,
  (SELECT COUNT(DISTINCT marketing_carrier) FROM `${PROJECT}.tvd_fareiq_mart.fact_offer`
    WHERE collected_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 24 HOUR)) AS airlines_monitored,
  (SELECT COUNT(*) FROM `${PROJECT}.tvd_fareiq_mart.dim_seller` WHERE seller_type = 'COMPETITOR_OTA' AND is_benchmark) AS competitors_tracked,
  COUNT(*)                                                    AS market_cells_priced,
  ROUND(AVG(l.price_index_vs_median), 4)                      AS avg_price_index,
  ROUND(AVG(l.coverage_score), 3)                             AS avg_coverage,
  COUNTIF(l.our_market_rank = 1)                              AS cells_where_we_are_cheapest,
  ROUND(SAFE_DIVIDE(COUNTIF(l.our_market_rank <= 3), COUNT(*)), 4) AS share_top3,
  (SELECT COUNTIF(action = 'DECREASE') FROM recs)             AS pricing_opportunities,
  (SELECT COUNTIF(action = 'INCREASE') FROM recs)             AS margin_opportunities,
  (SELECT COUNTIF(priority = 'P1')     FROM recs)             AS p1_actions,
  (SELECT ROUND(SUM(GREATEST(expected_margin_impact, 0)), 0) FROM recs WHERE action != 'HOLD') AS margin_upside_base_ccy,
  (SELECT ROUND(SUM(expected_revenue_impact), 0) FROM recs WHERE action != 'HOLD') AS revenue_impact_base_ccy
FROM latest l;


-- 2. DAILY PRICING REVIEW ---------------------------------------------
CREATE OR REPLACE VIEW `${PROJECT}.tvd_fareiq_mart.v_daily_pricing_review` AS
SELECT
  r.review_date,
  r.recommendation_id,
  r.route_key,
  dr.origin_city, dr.destination_city, dr.region_pair,
  r.marketing_carrier,
  dc.carrier_name,
  r.departure_date,
  r.cabin,
  r.trip_type,
  r.pos_country,
  ms.days_to_departure,
  ms.dtd_bucket,
  ROUND(r.current_price, 0)                 AS our_price,
  ROUND(ms.our_true_cost, 0)                AS our_true_customer_cost,
  ms.cheapest_competitor_id                 AS cheapest_competitor,
  ROUND(ms.cheapest_competitor_price, 0)    AS cheapest_competitor_price,
  ROUND(ms.market_median, 0)                AS market_median,
  ROUND(ms.price_gap_abs, 0)                AS price_gap,
  ROUND(ms.price_gap_pct * 100, 1)          AS price_gap_pct,
  ROUND(ms.price_index_vs_median, 3)        AS price_index,
  ms.our_market_rank,
  ms.competitor_sellers                     AS panel_size,
  ROUND(r.current_margin_pct * 100, 1)      AS current_margin_pct,
  ROUND(r.minimum_price, 0)                 AS minimum_price,
  ROUND(r.recommended_price, 0)             AS recommended_price,
  ROUND(r.price_change_pct * 100, 1)        AS price_change_pct,
  r.classification,
  r.action,
  r.priority,
  ROUND(r.confidence, 2)                    AS confidence,
  ROUND(r.expected_revenue_impact, 0)       AS expected_revenue_impact,
  ROUND(r.expected_margin_impact, 0)        AS expected_margin_impact,
  r.reason_codes,
  r.rationale,
  r.status
FROM `${PROJECT}.tvd_fareiq_mart.fact_price_recommendation` r
LEFT JOIN `${PROJECT}.tvd_fareiq_mart.fact_market_snapshot` ms ON ms.market_sk = r.market_sk
LEFT JOIN `${PROJECT}.tvd_fareiq_mart.dim_route` dr           ON dr.route_key = r.route_key
LEFT JOIN `${PROJECT}.tvd_fareiq_mart.dim_carrier` dc         ON dc.carrier_code = r.marketing_carrier
WHERE r.review_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY);


-- 3. COMPETITOR INTELLIGENCE ------------------------------------------
CREATE OR REPLACE VIEW `${PROJECT}.tvd_fareiq_mart.v_competitor_intelligence` AS
WITH per_cell AS (
  SELECT
    o.collection_window, DATE(o.collected_at) AS obs_date,
    o.route_key, o.departure_date, o.cabin, o.seller_id,
    MIN(o.comparable_cost_base) AS seller_best
  FROM `${PROJECT}.tvd_fareiq_mart.fact_offer` o
  WHERE o.collected_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
    AND NOT EXISTS (SELECT 1 FROM UNNEST(o.dq_flags) f WHERE f LIKE 'BLOCKING_%')
  GROUP BY 1,2,3,4,5,6
),
ranked AS (
  SELECT *, RANK() OVER (PARTITION BY collection_window, route_key, departure_date, cabin ORDER BY seller_best) AS rk
  FROM per_cell
)
SELECT
  obs_date,
  seller_id,
  ds.seller_name,
  ds.seller_type,
  COUNT(*)                                            AS cells_observed,
  COUNTIF(rk = 1)                                     AS times_cheapest,
  ROUND(SAFE_DIVIDE(COUNTIF(rk = 1), COUNT(*)), 4)    AS cheapest_win_rate,
  ROUND(AVG(rk), 2)                                   AS avg_rank,
  ROUND(AVG(seller_best), 0)                          AS avg_price,
  ROUND(APPROX_QUANTILES(seller_best, 100)[OFFSET(50)], 0) AS median_price,
  ARRAY_AGG(DISTINCT route_key IGNORE NULLS LIMIT 10) AS sample_routes
FROM ranked
LEFT JOIN `${PROJECT}.tvd_fareiq_mart.dim_seller` ds USING (seller_id)
GROUP BY obs_date, seller_id, ds.seller_name, ds.seller_type;


-- Competitor price movements, day over day, at seller x route level.
CREATE OR REPLACE VIEW `${PROJECT}.tvd_fareiq_mart.v_competitor_movements` AS
WITH daily AS (
  SELECT
    DATE(collected_at) AS obs_date, seller_id, route_key, cabin,
    APPROX_QUANTILES(comparable_cost_base, 100)[OFFSET(50)] AS median_price,
    COUNT(*) AS obs
  FROM `${PROJECT}.tvd_fareiq_mart.fact_offer`
  WHERE collected_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
    AND NOT is_our_offer
  GROUP BY 1,2,3,4
)
SELECT
  d.obs_date, d.seller_id, d.route_key, d.cabin,
  ROUND(d.median_price, 0) AS median_price,
  ROUND(p.median_price, 0) AS prev_median_price,
  ROUND(SAFE_DIVIDE(d.median_price - p.median_price, NULLIF(p.median_price, 0)) * 100, 1) AS change_pct,
  d.obs AS observations,
  CASE
    WHEN ABS(SAFE_DIVIDE(d.median_price - p.median_price, NULLIF(p.median_price, 0))) >= 0.15 THEN 'MAJOR'
    WHEN ABS(SAFE_DIVIDE(d.median_price - p.median_price, NULLIF(p.median_price, 0))) >= 0.07 THEN 'NOTABLE'
    ELSE 'MINOR'
  END AS movement_band
FROM daily d
LEFT JOIN daily p ON p.seller_id = d.seller_id AND p.route_key = d.route_key
                 AND p.cabin = d.cabin AND p.obs_date = DATE_SUB(d.obs_date, INTERVAL 1 DAY)
WHERE d.obs >= 3 AND p.obs >= 3;


-- 4. AIRLINE FEE INTELLIGENCE -----------------------------------------
CREATE OR REPLACE VIEW `${PROJECT}.tvd_fareiq_mart.v_airline_fee_current` AS
SELECT
  f.carrier, dc.carrier_name, dc.carrier_type,
  f.pos_country, f.route_scope, f.cabin, f.fare_family,
  f.fee_type, f.amount, f.currency, f.basis,
  f.valid_from AS effective_since,
  DATE_DIFF(CURRENT_DATE(), DATE(f.valid_from), DAY) AS days_in_effect,
  f.change_delta, ROUND(f.change_pct * 100, 1) AS change_pct,
  f.source_id
FROM `${PROJECT}.tvd_fareiq_mart.dim_airline_fee` f
LEFT JOIN `${PROJECT}.tvd_fareiq_mart.dim_carrier` dc ON dc.carrier_code = f.carrier
WHERE f.is_current;

CREATE OR REPLACE VIEW `${PROJECT}.tvd_fareiq_mart.v_airline_fee_changes` AS
SELECT
  DATE(valid_from) AS change_date,
  carrier, pos_country, route_scope, cabin, fee_type,
  amount AS new_amount,
  amount - COALESCE(change_delta, 0) AS previous_amount,
  change_delta, ROUND(change_pct * 100, 1) AS change_pct, currency,
  CASE WHEN ABS(COALESCE(change_pct, 0)) >= 0.20 THEN 'MAJOR'
       WHEN ABS(COALESCE(change_pct, 0)) >= 0.05 THEN 'NOTABLE'
       ELSE 'MINOR' END AS impact_band
FROM `${PROJECT}.tvd_fareiq_mart.dim_airline_fee`
WHERE valid_from >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 90 DAY)
  AND change_delta IS NOT NULL AND change_delta != 0;


-- 5. ROUTE ANALYSIS ----------------------------------------------------
CREATE OR REPLACE VIEW `${PROJECT}.tvd_fareiq_mart.v_route_analysis` AS
WITH price_hist AS (
  SELECT snapshot_date, route_key, cabin,
         AVG(market_median)         AS market_median,
         AVG(our_comparable_cost)   AS our_price,
         AVG(cheapest_competitor_price) AS cheapest_competitor,
         AVG(price_index_vs_median) AS price_index,
         AVG(coverage_score)        AS coverage
  FROM `${PROJECT}.tvd_fareiq_mart.fact_market_snapshot`
  WHERE snapshot_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 180 DAY)
  GROUP BY 1,2,3
),
bookings AS (
  SELECT booking_date AS snapshot_date, route_key, cabin,
         COUNT(*) AS bookings,
         SUM(pax_count) AS pax,
         SUM(selling_price_base) AS revenue,
         SUM(gross_margin_base)  AS margin,
         SAFE_DIVIDE(SUM(gross_margin_base), NULLIF(SUM(selling_price_base), 0)) AS margin_pct,
         AVG(booking_lead_days) AS avg_lead_days
  FROM `${PROJECT}.tvd_fareiq_mart.fact_booking`
  WHERE booking_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 180 DAY) AND status IN ('TICKETED','BOOKED')
  GROUP BY 1,2,3
),
funnel AS (
  SELECT DATE(event_ts) AS snapshot_date,
         CONCAT(origin, '-', destination) AS route_key, cabin,
         COUNTIF(event_type = 'SEARCH')   AS searches,
         COUNTIF(event_type = 'PURCHASE') AS purchases,
         SAFE_DIVIDE(COUNTIF(event_type = 'PURCHASE'), NULLIF(COUNTIF(event_type = 'SEARCH'), 0)) AS conversion
  FROM `${PROJECT}.tvd_fareiq_raw.own_search_event`
  WHERE event_ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 180 DAY)
  GROUP BY 1,2,3
)
SELECT
  ph.snapshot_date, ph.route_key, ph.cabin,
  dr.origin_city, dr.destination_city, dr.region_pair, dr.monitoring_tier,
  ROUND(ph.our_price, 0) AS our_price,
  ROUND(ph.market_median, 0) AS market_median,
  ROUND(ph.cheapest_competitor, 0) AS cheapest_competitor,
  ROUND(ph.price_index, 3) AS price_index,
  ROUND(ph.coverage, 2) AS coverage,
  COALESCE(b.bookings, 0) AS bookings,
  COALESCE(b.pax, 0) AS pax,
  ROUND(COALESCE(b.revenue, 0), 0) AS revenue,
  ROUND(COALESCE(b.margin, 0), 0) AS margin,
  ROUND(b.margin_pct * 100, 1) AS margin_pct,
  ROUND(b.avg_lead_days, 1) AS avg_booking_lead_days,
  f.searches, f.purchases, ROUND(f.conversion * 100, 2) AS conversion_pct
FROM price_hist ph
LEFT JOIN bookings b USING (snapshot_date, route_key, cabin)
LEFT JOIN funnel   f USING (snapshot_date, route_key, cabin)
LEFT JOIN `${PROJECT}.tvd_fareiq_mart.dim_route` dr ON dr.route_key = ph.route_key;


-- 6. PRICING OPPORTUNITIES --------------------------------------------
CREATE OR REPLACE VIEW `${PROJECT}.tvd_fareiq_mart.v_pricing_opportunities` AS
SELECT
  r.review_date, r.recommendation_id, r.route_key, r.departure_date, r.cabin,
  r.marketing_carrier, r.classification, r.action, r.priority,
  ROUND(r.current_price, 0)      AS current_price,
  ROUND(r.recommended_price, 0)  AS recommended_price,
  ROUND(r.minimum_price, 0)      AS minimum_price,
  ROUND(r.target_price, 0)       AS target_price,
  ROUND(r.price_change_pct * 100, 1) AS change_pct,
  ROUND(r.current_margin_pct * 100, 1) AS current_margin_pct,
  ROUND(r.expected_revenue_impact, 0)  AS potential_revenue,
  ROUND(r.expected_margin_impact, 0)   AS potential_margin,
  ROUND(r.opportunity_value, 0)        AS opportunity_value,
  ROUND(r.confidence, 2)               AS confidence,
  r.reason_codes, r.rationale, r.status
FROM `${PROJECT}.tvd_fareiq_mart.fact_price_recommendation` r
WHERE r.review_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
  AND r.action != 'HOLD';


-- 7. APPROVAL AUDIT AND ENGINE SCORECARD ------------------------------
CREATE OR REPLACE VIEW `${PROJECT}.tvd_fareiq_mart.v_decision_audit` AS
SELECT
  d.decision_id, d.decided_at, d.decided_by, d.decision, d.decision_channel,
  r.route_key, r.departure_date, r.cabin, r.marketing_carrier,
  ROUND(d.current_price, 0)     AS price_before,
  ROUND(d.recommended_price, 0) AS price_recommended,
  ROUND(d.approved_price, 0)    AS price_approved,
  d.override_reason,
  d.competitor_benchmark.cheapest_price   AS benchmark_cheapest,
  d.competitor_benchmark.market_median    AS benchmark_median,
  d.competitor_benchmark.sellers_observed AS benchmark_panel,
  ROUND(d.expected_margin_pct * 100, 1)   AS expected_margin_pct,
  ROUND(d.confidence, 2)                  AS confidence,
  d.apply_status, d.applied_at,
  d.actual_bookings_7d, ROUND(d.actual_revenue_7d, 0) AS actual_revenue_7d,
  ROUND(d.actual_margin_7d, 0) AS actual_margin_7d,
  ROUND(d.actual_vs_expected_margin_pct * 100, 1) AS actual_vs_expected_pct
FROM `${PROJECT}.tvd_fareiq_mart.fact_price_decision` d
LEFT JOIN `${PROJECT}.tvd_fareiq_mart.fact_price_recommendation` r USING (recommendation_id);

CREATE OR REPLACE VIEW `${PROJECT}.tvd_fareiq_mart.v_engine_scorecard` AS
SELECT
  DATE_TRUNC(DATE(d.decided_at), WEEK) AS week,
  COUNT(*)                                                          AS decisions,
  COUNTIF(d.decision = 'APPROVED')                                  AS approved,
  COUNTIF(d.decision = 'MODIFIED')                                  AS modified,
  COUNTIF(d.decision = 'REJECTED')                                  AS rejected,
  ROUND(SAFE_DIVIDE(COUNTIF(d.decision = 'APPROVED'), COUNT(*)), 3) AS acceptance_rate,
  ROUND(AVG(ABS(SAFE_DIVIDE(d.approved_price - d.recommended_price, NULLIF(d.recommended_price, 0)))), 4) AS avg_override_magnitude,
  ROUND(AVG(d.actual_vs_expected_margin_pct), 3)                    AS avg_forecast_error,
  ROUND(SUM(d.actual_margin_7d), 0)                                 AS realised_margin_7d
FROM `${PROJECT}.tvd_fareiq_mart.fact_price_decision` d
WHERE d.decided_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 180 DAY)
GROUP BY week;


-- 8. CHANNEL ARBITRAGE -------------------------------------------------
-- The same flight, priced through every channel we hold a contract with.
--
-- This is the view that pays for the platform fastest. Amadeus, Sabre and
-- Verteil carry different negotiated fares, different fare families and
-- different NDC content, so the spread between them on one flight is
-- routinely larger than any markup decision we make on top of it. Selling
-- through the wrong channel is a loss taken before pricing even begins.
--
-- Note what this view is NOT: it is not a competitor comparison. Every row
-- here is our own cost. The competitive view is v_daily_pricing_review.
CREATE OR REPLACE VIEW `${PROJECT}.tvd_fareiq_mart.v_channel_arbitrage` AS
WITH channel_prices AS (
  SELECT
    DATE(o.collected_at)      AS obs_date,
    o.route_key,
    o.departure_date,
    o.cabin,
    o.marketing_carrier,
    o.source_id               AS channel,
    MIN(o.comparable_cost_base) AS channel_cost,
    ANY_VALUE(o.fare_family)  AS fare_family,
    ANY_VALUE(o.included_checked_bags) AS included_bags
  FROM `${PROJECT}.tvd_fareiq_mart.fact_offer` o
  WHERE o.collected_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
    AND o.seller_type IN ('GDS_CHANNEL', 'NDC_CHANNEL')
    AND NOT EXISTS (SELECT 1 FROM UNNEST(o.dq_flags) f WHERE f LIKE 'BLOCKING_%')
  GROUP BY 1, 2, 3, 4, 5, 6
),
spread AS (
  SELECT
    obs_date, route_key, departure_date, cabin, marketing_carrier,
    COUNT(DISTINCT channel)                        AS channels_priced,
    MIN(channel_cost)                              AS cheapest_channel_cost,
    MAX(channel_cost)                              AS dearest_channel_cost,
    ARRAY_AGG(STRUCT(channel, ROUND(channel_cost) AS cost, fare_family, included_bags)
              ORDER BY channel_cost)               AS by_channel
  FROM channel_prices
  GROUP BY 1, 2, 3, 4, 5
)
SELECT
  s.obs_date,
  s.route_key,
  dr.origin_city, dr.destination_city,
  s.departure_date,
  s.cabin,
  s.marketing_carrier,
  s.channels_priced,
  ROUND(s.cheapest_channel_cost)                   AS cheapest_cost,
  ROUND(s.dearest_channel_cost)                    AS dearest_cost,
  ROUND(s.dearest_channel_cost - s.cheapest_channel_cost) AS spread_abs,
  ROUND(SAFE_DIVIDE(s.dearest_channel_cost - s.cheapest_channel_cost,
                    NULLIF(s.cheapest_channel_cost, 0)) * 100, 1) AS spread_pct,
  s.by_channel[OFFSET(0)].channel                  AS cheapest_channel,
  s.by_channel,
  CASE
    WHEN s.channels_priced < 2 THEN 'SINGLE_CHANNEL'
    WHEN SAFE_DIVIDE(s.dearest_channel_cost - s.cheapest_channel_cost,
                     NULLIF(s.cheapest_channel_cost, 0)) >= 0.08 THEN 'MATERIAL'
    WHEN SAFE_DIVIDE(s.dearest_channel_cost - s.cheapest_channel_cost,
                     NULLIF(s.cheapest_channel_cost, 0)) >= 0.03 THEN 'WORTH_WATCHING'
    ELSE 'ALIGNED'
  END AS spread_band
FROM spread s
LEFT JOIN `${PROJECT}.tvd_fareiq_mart.dim_route` dr ON dr.route_key = s.route_key
WHERE s.channels_priced >= 2
ORDER BY spread_pct DESC;


-- 9. SUPPLY COVERAGE ---------------------------------------------------
-- Which channels answered, on which routes, today. A channel that quietly
-- stops returning content is the failure most likely to go unnoticed,
-- because the pipeline keeps running and the numbers keep computing.
CREATE OR REPLACE VIEW `${PROJECT}.tvd_fareiq_mart.v_channel_health` AS
SELECT
  DATE(collected_at)                                   AS obs_date,
  source_id                                            AS channel,
  seller_type,
  COUNT(*)                                             AS offers,
  COUNT(DISTINCT route_key)                            AS routes,
  COUNT(DISTINCT marketing_carrier)                    AS carriers,
  ROUND(AVG(comparable_cost_base))                     AS avg_comparable_cost,
  ROUND(AVG(fee_confidence), 2)                        AS avg_fee_confidence,
  ROUND(SAFE_DIVIDE(COUNTIF(included_checked_bags IS NOT NULL), COUNT(*)), 3)
                                                       AS baggage_coverage,
  COUNTIF(EXISTS(SELECT 1 FROM UNNEST(dq_flags) f WHERE f LIKE 'BLOCKING_%'))
                                                       AS blocked_rows
FROM `${PROJECT}.tvd_fareiq_mart.fact_offer`
WHERE collected_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 14 DAY)
GROUP BY obs_date, source_id, seller_type
ORDER BY obs_date DESC, offers DESC;
