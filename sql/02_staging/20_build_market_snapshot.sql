-- =====================================================================
-- Build fact_market_snapshot for one collection window.
-- Parameters: @window_start, @window_end
--
-- Rules that matter:
--  * Market statistics use COMPETITOR offers only, and "competitor" means a
--    price a CUSTOMER could pay elsewhere: an airline selling direct, a rival
--    OTA, a metasearch listing. It explicitly does NOT mean a GDS or NDC
--    channel. Amadeus, Sabre and Verteil tell us what a flight COSTS us
--    through that channel; folding those into the market median would be
--    comparing our own cost against itself and the index would be
--    meaningless. Channel prices get their own view, v_channel_arbitrage.
--  * Including our own price in the median we then compare ourselves to is
--    circular and will make the index drift toward 1.0 as our panel share
--    grows.
--  * Blocking DQ flags are excluded, warnings are kept.
--  * We take the CHEAPEST comparable offer per seller per cell, because a
--    seller showing 40 offers should not dominate the distribution.
-- =====================================================================

DECLARE window_start TIMESTAMP DEFAULT @window_start;
DECLARE window_end   TIMESTAMP DEFAULT @window_end;

-- Manual prices (the daily competitor and Skyscanner checks, source_id
-- 'manual_*') are typed once a day, while windows are 30 minutes. They are
-- carried into every later window for 24 hours, so a price checked at 9am
-- still counts in the 4pm snapshot. A fresher observation of the same seller
-- in the window itself always wins over a carried one. Only competitor
-- prices are carried; our own price always comes from the current window.
CREATE TEMP TABLE cell_offers AS
WITH clean AS (
  SELECT o.*
  FROM `${PROJECT}.tvd_fareiq_mart.fact_offer` o
  WHERE o.collected_at >= TIMESTAMP_SUB(window_start, INTERVAL 24 HOUR)
    AND o.collected_at < window_end
    AND NOT EXISTS (SELECT 1 FROM UNNEST(o.dq_flags) f WHERE f LIKE 'BLOCKING_%')
),
in_window AS (
  SELECT c.*, 0 AS carried FROM clean c
  WHERE c.collected_at >= window_start
),
windows AS (
  SELECT DISTINCT collection_window FROM in_window
),
carried AS (
  SELECT c.* REPLACE (w.collection_window AS collection_window), 1 AS carried
  FROM windows w
  JOIN clean c
    ON STARTS_WITH(c.source_id, 'manual_')
   AND c.seller_type != 'US'          -- our own price is never carried stale
   AND c.collection_window < w.collection_window
   AND c.collected_at >= TIMESTAMP_SUB(w.collection_window, INTERVAL 24 HOUR)
)
SELECT * EXCEPT(rn, carried) FROM (
  SELECT
    o.*,
    -- A price a customer could actually pay somewhere else. Supply channels
    -- (GDS_CHANNEL, NDC_CHANNEL) are deliberately excluded: they are our cost.
    (o.seller_type IN ('COMPETITOR_OTA', 'AIRLINE_DIRECT', 'METASEARCH')) AS is_competitor,
    ROW_NUMBER() OVER (
      PARTITION BY o.collection_window, o.route_key, o.departure_date, o.cabin,
                   o.trip_type, o.pos_country, o.seller_id
      ORDER BY o.carried ASC,
               IF(o.carried = 1, UNIX_SECONDS(o.collected_at), 0) DESC,
               o.comparable_cost_base ASC
    ) AS rn
  FROM (SELECT * FROM in_window UNION ALL SELECT * FROM carried) o
) WHERE rn = 1;


CREATE TEMP TABLE market_stats AS
SELECT
  collection_window,
  DATE(collection_window) AS snapshot_date,
  route_key, departure_date, cabin, trip_type, pos_country,
  ANY_VALUE(days_to_departure) AS days_to_departure,
  ANY_VALUE(dtd_bucket)        AS dtd_bucket,

  COUNT(DISTINCT seller_id)                                    AS sellers_observed,
  COUNT(DISTINCT IF(is_competitor, seller_id, NULL))           AS competitor_sellers,
  COUNT(*)                                                     AS offers_observed,
  COUNT(DISTINCT marketing_carrier)                            AS carriers_observed,

  MIN(IF(is_competitor, comparable_cost_base, NULL))        AS market_min,
  APPROX_QUANTILES(IF(is_competitor, comparable_cost_base, NULL), 100)[OFFSET(25)] AS market_p25,
  APPROX_QUANTILES(IF(is_competitor, comparable_cost_base, NULL), 100)[OFFSET(50)] AS market_median,
  AVG(IF(is_competitor, comparable_cost_base, NULL))        AS market_mean,
  SAFE_DIVIDE(
    SUM(IF(is_competitor, comparable_cost_base * COALESCE(ds.benchmark_weight, 1.0), 0)),
    SUM(IF(is_competitor, COALESCE(ds.benchmark_weight, 1.0), 0))
  )                                                            AS market_weighted_mean,
  APPROX_QUANTILES(IF(is_competitor, comparable_cost_base, NULL), 100)[OFFSET(75)] AS market_p75,
  MAX(IF(is_competitor, comparable_cost_base, NULL))        AS market_max,
  STDDEV(IF(is_competitor, comparable_cost_base, NULL))     AS market_stddev,

  MIN(IF(is_our_offer, displayed_total_base, NULL))            AS our_displayed_total,
  MIN(IF(is_our_offer, true_customer_cost_base, NULL))         AS our_true_cost,
  MIN(IF(is_our_offer, comparable_cost_base, NULL))            AS our_comparable_cost,
  ANY_VALUE(IF(is_our_offer, seller_id, NULL))                 AS our_seller_id
FROM cell_offers co
LEFT JOIN `${PROJECT}.tvd_fareiq_mart.dim_seller` ds USING (seller_id)
GROUP BY collection_window, route_key, departure_date, cabin, trip_type, pos_country;


CREATE TEMP TABLE cheapest AS
SELECT * EXCEPT(rn, price_rank) FROM (
  SELECT
    collection_window, route_key, departure_date, cabin, trip_type, pos_country,
    seller_id AS cheapest_competitor_id,
    comparable_cost_base AS cheapest_competitor_price,
    ROW_NUMBER() OVER (PARTITION BY collection_window, route_key, departure_date, cabin, trip_type, pos_country
                       ORDER BY comparable_cost_base) AS rn,
    ROW_NUMBER() OVER (PARTITION BY collection_window, route_key, departure_date, cabin, trip_type, pos_country
                       ORDER BY comparable_cost_base) AS price_rank
  FROM cell_offers WHERE is_competitor
) WHERE rn = 1;

CREATE TEMP TABLE second_cheapest AS
SELECT collection_window, route_key, departure_date, cabin, trip_type, pos_country,
       comparable_cost_base AS second_cheapest_price
FROM (
  SELECT co.*, ROW_NUMBER() OVER (PARTITION BY collection_window, route_key, departure_date, cabin, trip_type, pos_country
                                  ORDER BY comparable_cost_base) AS rn
  FROM cell_offers co WHERE is_competitor
) WHERE rn = 2;

-- Our rank inside the full panel including ourselves.
CREATE TEMP TABLE our_rank AS
SELECT collection_window, route_key, departure_date, cabin, trip_type, pos_country, our_market_rank
FROM (
  SELECT collection_window, route_key, departure_date, cabin, trip_type, pos_country, is_our_offer,
         RANK() OVER (PARTITION BY collection_window, route_key, departure_date, cabin, trip_type, pos_country
                      ORDER BY comparable_cost_base) AS our_market_rank
  FROM cell_offers
  WHERE is_our_offer OR is_competitor
) WHERE is_our_offer;

-- Our unit economics for the cell, from the most recent supplier cost we hold.
CREATE TEMP TABLE our_cost AS
SELECT route_key, departure_date, cabin, pos_country,
       APPROX_QUANTILES(supplier_cost_base / NULLIF(pax_count, 0), 100)[OFFSET(50)] AS our_supplier_cost
FROM `${PROJECT}.tvd_fareiq_mart.fact_booking`
WHERE booking_date >= DATE_SUB(DATE(window_start), INTERVAL 30 DAY)
GROUP BY route_key, departure_date, cabin, pos_country;

-- Our cost as a share of our selling price, from real tickets. The sales
-- register records the issue date but not the departure date, so its tickets
-- cannot be matched to a cell by date. Instead, where no exact booking exists
-- for the cell, supplier cost is estimated as our price times the cost ratio
-- we actually achieved on that route and cabin over the last 180 days. That
-- makes the engine's margin the margin TravelDen really earns there.
-- Falls back from route and cabin, to route, to cabin across all routes.
-- Synthetic MOCK bookings are excluded so they cannot dilute real ratios.
CREATE TEMP TABLE cost_ratio_route_cabin AS
SELECT route_key, cabin,
       SAFE_DIVIDE(SUM(supplier_cost_base), SUM(selling_price_base)) AS cost_ratio
FROM `${PROJECT}.tvd_fareiq_mart.fact_booking`
WHERE booking_date >= DATE_SUB(DATE(window_start), INTERVAL 180 DAY)
  AND status IN ('TICKETED', 'BOOKED') AND COALESCE(channel, '') != 'MOCK'
  AND selling_price_base > 0 AND supplier_cost_base > 0
GROUP BY route_key, cabin
HAVING COUNT(*) >= 5;

CREATE TEMP TABLE cost_ratio_route AS
SELECT route_key,
       SAFE_DIVIDE(SUM(supplier_cost_base), SUM(selling_price_base)) AS cost_ratio
FROM `${PROJECT}.tvd_fareiq_mart.fact_booking`
WHERE booking_date >= DATE_SUB(DATE(window_start), INTERVAL 180 DAY)
  AND status IN ('TICKETED', 'BOOKED') AND COALESCE(channel, '') != 'MOCK'
  AND selling_price_base > 0 AND supplier_cost_base > 0
GROUP BY route_key
HAVING COUNT(*) >= 5;

CREATE TEMP TABLE cost_ratio_cabin AS
SELECT cabin,
       SAFE_DIVIDE(SUM(supplier_cost_base), SUM(selling_price_base)) AS cost_ratio
FROM `${PROJECT}.tvd_fareiq_mart.fact_booking`
WHERE booking_date >= DATE_SUB(DATE(window_start), INTERVAL 180 DAY)
  AND status IN ('TICKETED', 'BOOKED') AND COALESCE(channel, '') != 'MOCK'
  AND selling_price_base > 0 AND supplier_cost_base > 0
GROUP BY cabin
HAVING COUNT(*) >= 20;


MERGE `${PROJECT}.tvd_fareiq_mart.fact_market_snapshot` T
USING (
  SELECT
    TO_HEX(SHA256(CONCAT(CAST(m.collection_window AS STRING), m.route_key, CAST(m.departure_date AS STRING),
                         m.cabin, m.trip_type, m.pos_country))) AS market_sk,
    m.collection_window, m.snapshot_date, m.route_key, m.departure_date,
    m.cabin, m.trip_type, m.pos_country, m.days_to_departure, m.dtd_bucket,
    m.sellers_observed, m.competitor_sellers, m.offers_observed, m.carriers_observed,
    -- The target columns are NUMERIC. INT64/INT64 division and STDDEV both
    -- return FLOAT64, which BigQuery will not assign implicitly, so cast here.
    CAST(LEAST(SAFE_DIVIDE(m.competitor_sellers, ${EXPECTED_PANEL_SIZE}), 1.0) AS NUMERIC) AS coverage_score,

    c.cheapest_competitor_id,
    c.cheapest_competitor_price,
    sc.second_cheapest_price,
    m.market_min, m.market_p25, m.market_median, m.market_mean,
    CAST(m.market_weighted_mean AS NUMERIC) AS market_weighted_mean,
    m.market_p75, m.market_max,
    CAST(m.market_stddev AS NUMERIC) AS market_stddev,
    CAST(SAFE_DIVIDE(m.market_stddev, NULLIF(m.market_median, 0)) AS NUMERIC) AS market_dispersion,

    m.our_seller_id, m.our_displayed_total, m.our_true_cost, m.our_comparable_cost,
    r.our_market_rank,
    m.our_comparable_cost - c.cheapest_competitor_price AS price_gap_abs,
    SAFE_DIVIDE(m.our_comparable_cost - c.cheapest_competitor_price, NULLIF(c.cheapest_competitor_price, 0)) AS price_gap_pct,
    SAFE_DIVIDE(m.our_comparable_cost, NULLIF(m.market_median, 0))              AS price_index_vs_median,
    SAFE_DIVIDE(m.our_comparable_cost, NULLIF(c.cheapest_competitor_price, 0))  AS price_index_vs_cheapest,

    CAST(COALESCE(oc.our_supplier_cost, m.our_displayed_total * COALESCE(crc.cost_ratio, crr.cost_ratio, crb.cost_ratio)) AS NUMERIC) AS our_supplier_cost,
    CAST(m.our_comparable_cost - COALESCE(oc.our_supplier_cost, m.our_displayed_total * COALESCE(crc.cost_ratio, crr.cost_ratio, crb.cost_ratio)) AS NUMERIC) AS our_gross_margin_abs,
    CAST(SAFE_DIVIDE(m.our_comparable_cost - COALESCE(oc.our_supplier_cost, m.our_displayed_total * COALESCE(crc.cost_ratio, crr.cost_ratio, crb.cost_ratio)), NULLIF(m.our_comparable_cost, 0)) AS NUMERIC) AS our_gross_margin_pct,

    SAFE_DIVIDE(m.market_median - h1.market_median, NULLIF(h1.market_median, 0)) AS median_change_1d_pct,
    SAFE_DIVIDE(m.market_median - h7.market_median, NULLIF(h7.market_median, 0)) AS median_change_7d_pct,
    SAFE_DIVIDE(c.cheapest_competitor_price - h1.cheapest_competitor_price, NULLIF(h1.cheapest_competitor_price, 0)) AS cheapest_change_1d_pct,
    SAFE_DIVIDE(m.our_comparable_cost, NULLIF(m.market_median, 0)) - h7.price_index_vs_median AS our_index_change_7d,
    CURRENT_TIMESTAMP() AS computed_at
  FROM market_stats m
  LEFT JOIN cheapest c        USING (collection_window, route_key, departure_date, cabin, trip_type, pos_country)
  LEFT JOIN second_cheapest sc USING (collection_window, route_key, departure_date, cabin, trip_type, pos_country)
  LEFT JOIN our_rank r        USING (collection_window, route_key, departure_date, cabin, trip_type, pos_country)
  LEFT JOIN our_cost oc       USING (route_key, departure_date, cabin, pos_country)
  LEFT JOIN cost_ratio_route_cabin crc ON crc.route_key = m.route_key AND crc.cabin = m.cabin
  LEFT JOIN cost_ratio_route crr       ON crr.route_key = m.route_key
  LEFT JOIN cost_ratio_cabin crb       ON crb.cabin = m.cabin
  LEFT JOIN `${PROJECT}.tvd_fareiq_mart.fact_market_snapshot` h1
         ON h1.route_key = m.route_key AND h1.departure_date = m.departure_date
        AND h1.cabin = m.cabin AND h1.pos_country = m.pos_country
        AND h1.collection_window = TIMESTAMP_SUB(m.collection_window, INTERVAL 24 HOUR)
  LEFT JOIN `${PROJECT}.tvd_fareiq_mart.fact_market_snapshot` h7
         ON h7.route_key = m.route_key AND h7.departure_date = m.departure_date
        AND h7.cabin = m.cabin AND h7.pos_country = m.pos_country
        AND h7.collection_window = TIMESTAMP_SUB(m.collection_window, INTERVAL 168 HOUR)
) S
ON T.market_sk = S.market_sk AND T.snapshot_date = S.snapshot_date
-- A rerun refreshes every computed column. Late-arriving inputs (a booking
-- that supplies our supplier cost, a corrected fee) must reach cells that
-- already exist, not only new ones.
WHEN MATCHED THEN UPDATE SET
  days_to_departure = S.days_to_departure,
  dtd_bucket = S.dtd_bucket,
  sellers_observed = S.sellers_observed,
  competitor_sellers = S.competitor_sellers,
  offers_observed = S.offers_observed,
  carriers_observed = S.carriers_observed,
  coverage_score = S.coverage_score,
  cheapest_competitor_id = S.cheapest_competitor_id,
  cheapest_competitor_price = S.cheapest_competitor_price,
  second_cheapest_price = S.second_cheapest_price,
  market_min = S.market_min,
  market_p25 = S.market_p25,
  market_median = S.market_median,
  market_mean = S.market_mean,
  market_weighted_mean = S.market_weighted_mean,
  market_p75 = S.market_p75,
  market_max = S.market_max,
  market_stddev = S.market_stddev,
  market_dispersion = S.market_dispersion,
  our_seller_id = S.our_seller_id,
  our_displayed_total = S.our_displayed_total,
  our_true_cost = S.our_true_cost,
  our_comparable_cost = S.our_comparable_cost,
  our_market_rank = S.our_market_rank,
  price_gap_abs = S.price_gap_abs,
  price_gap_pct = S.price_gap_pct,
  price_index_vs_median = S.price_index_vs_median,
  price_index_vs_cheapest = S.price_index_vs_cheapest,
  our_supplier_cost = S.our_supplier_cost,
  our_gross_margin_abs = S.our_gross_margin_abs,
  our_gross_margin_pct = S.our_gross_margin_pct,
  median_change_1d_pct = S.median_change_1d_pct,
  median_change_7d_pct = S.median_change_7d_pct,
  cheapest_change_1d_pct = S.cheapest_change_1d_pct,
  our_index_change_7d = S.our_index_change_7d,
  computed_at = S.computed_at
WHEN NOT MATCHED THEN INSERT ROW;
