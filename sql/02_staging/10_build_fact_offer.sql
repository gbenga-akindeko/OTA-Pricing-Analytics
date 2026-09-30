-- =====================================================================
-- Build fact_offer for one collection window.
-- Parameters: @window_start, @window_end (TIMESTAMP), @base_currency
-- Idempotent: MERGE on offer_sk, so a rerun of a window is safe.
--
-- The interesting work is here: resolving ancillary fees onto every offer,
-- because a headline price without baggage is not a price.
-- =====================================================================

DECLARE base_ccy STRING DEFAULT @base_currency;

CREATE TEMP TABLE candidate_offers AS
SELECT
  r.snapshot_id,
  r.collection_run_id,
  r.source_id,
  r.source_tier,
  r.collected_at,
  TIMESTAMP_SECONDS(DIV(UNIX_SECONDS(r.collected_at), 1800) * 1800) AS collection_window,  -- 30 minute buckets
  CONCAT(r.request_origin, '-', r.request_destination)        AS route_key,
  dr.region_pair                                              AS region_pair,
  r.request_origin                                            AS origin,
  r.request_destination                                       AS destination,
  r.request_departure_date                                    AS departure_date,
  r.request_return_date                                       AS return_date,
  r.request_trip_type                                         AS trip_type,
  r.request_cabin                                             AS cabin,
  r.request_pos_country                                       AS pos_country,
  r.request_pax_adults + r.request_pax_children               AS paying_pax,
  DATE_DIFF(r.request_departure_date, DATE(r.collected_at), DAY) AS days_to_departure,
  r.seller_id,
  r.seller_type,
  r.marketing_carrier,
  r.operating_carrier,
  r.fare_basis_code,
  r.fare_family,
  r.booking_class,
  r.stops_count,
  r.total_duration_minutes,
  r.is_refundable,
  r.is_changeable,
  COALESCE(r.included_checked_bags, 0)                        AS included_checked_bags,
  r.quote_currency,
  r.base_fare,
  r.taxes_total,
  r.displayed_total,
  r.quoted_ancillaries,
  r.availability_status,
  r.seats_remaining,
  r.legal_basis,
  ARRAY_LENGTH(COALESCE(r.segments, [])) AS segment_count,
  r.parse_warnings
FROM `${PROJECT}.tvd_fareiq_raw.offer_snapshot` r
-- region_pair is carried here because BigQuery rejects a correlated
-- subquery inside the fee catalogue join predicate further down.
LEFT JOIN `${PROJECT}.tvd_fareiq_mart.dim_route` dr
  ON dr.route_key = CONCAT(r.request_origin, '-', r.request_destination)
WHERE r.collected_at >= @window_start
  AND r.collected_at <  @window_end
  AND r.displayed_total IS NOT NULL
  AND r.displayed_total > 0
  AND COALESCE(r.availability_status, 'AVAILABLE') != 'ERROR';


-- ---------------------------------------------------------------------
-- Fee resolution. For each offer, take the quoted ancillary if the source
-- gave one; otherwise fall back to the fee catalogue, most specific rule
-- wins, and mark the confidence down.
-- ---------------------------------------------------------------------
CREATE TEMP TABLE resolved_fees AS
WITH quoted AS (
  SELECT
    c.snapshot_id,
    a.type   AS fee_type,
    a.amount AS amount,
    a.currency,
    a.basis,
    TRUE     AS was_quoted
  FROM candidate_offers c, UNNEST(c.quoted_ancillaries) a
),
catalogue AS (
  SELECT
    c.snapshot_id,
    f.fee_type,
    f.amount,
    f.percent_of_fare,
    f.currency,
    f.basis,
    f.specificity_rank,
    FALSE AS was_quoted,
    ROW_NUMBER() OVER (
      PARTITION BY c.snapshot_id, f.fee_type
      ORDER BY f.specificity_rank DESC, f.valid_from DESC
    ) AS rn
  FROM candidate_offers c
  JOIN `${PROJECT}.tvd_fareiq_mart.dim_airline_fee` f
    ON f.carrier = c.marketing_carrier
   AND f.is_current
   AND f.pos_country IN (c.pos_country, 'ANY')
   AND (f.cabin IS NULL OR f.cabin = c.cabin)
   AND (f.fare_family IS NULL OR f.fare_family = c.fare_family)
   AND (
        f.route_scope = 'GLOBAL'
     OR f.route_scope = CONCAT('ROUTE:', c.route_key)
     OR f.route_scope = CONCAT('REGION:', c.region_pair)
   )
  -- Do not charge for a bag the fare already includes.
  WHERE NOT (f.fee_type = 'BAG_1ST' AND c.included_checked_bags >= 1)
),
unioned AS (
  SELECT snapshot_id, fee_type, amount, CAST(NULL AS NUMERIC) AS percent_of_fare, currency, basis, was_quoted
  FROM quoted
  UNION ALL
  SELECT snapshot_id, fee_type, amount, percent_of_fare, currency, basis, was_quoted
  FROM catalogue WHERE rn = 1
),
-- A quoted fee always beats a catalogue fee for the same type.
deduped AS (
  SELECT * EXCEPT(pick) FROM (
    SELECT u.*, ROW_NUMBER() OVER (PARTITION BY snapshot_id, fee_type ORDER BY was_quoted DESC) AS pick
    FROM unioned u
  ) WHERE pick = 1
)
SELECT
  d.snapshot_id,
  d.fee_type,
  d.was_quoted,
  -- Scale by basis and convert to base currency.
  CAST(
    COALESCE(
      d.amount * COALESCE(fx.rate, 1.0),
      d.percent_of_fare / 100 * c.displayed_total * COALESCE(fxq.rate, 1.0),
      0
    ) *
    CASE d.basis
      WHEN 'PER_PAX_PER_SEGMENT'   THEN c.paying_pax * GREATEST(c.segment_count, 1)
      WHEN 'PER_PAX_PER_ITINERARY' THEN c.paying_pax
      ELSE 1
    END
  AS NUMERIC) AS amount_base
FROM deduped d
JOIN candidate_offers c USING (snapshot_id)
LEFT JOIN `${PROJECT}.tvd_fareiq_mart.dim_fx_rate` fx
       ON fx.from_currency = d.currency AND fx.to_currency = base_ccy AND fx.rate_date = DATE(c.collected_at)
LEFT JOIN `${PROJECT}.tvd_fareiq_mart.dim_fx_rate` fxq
       ON fxq.from_currency = c.quote_currency AND fxq.to_currency = base_ccy AND fxq.rate_date = DATE(c.collected_at);


CREATE TEMP TABLE fee_rollup AS
SELECT
  snapshot_id,
  SUM(IF(fee_type LIKE 'BAG_%',     amount_base, 0)) AS bag_fee_base,
  SUM(IF(fee_type LIKE 'SEAT_%',    amount_base, 0)) AS seat_fee_base,
  SUM(IF(fee_type LIKE 'PAYMENT_%', amount_base, 0)) AS payment_fee_base,
  SUM(IF(fee_type NOT LIKE 'BAG_%' AND fee_type NOT LIKE 'SEAT_%' AND fee_type NOT LIKE 'PAYMENT_%'
         AND fee_type NOT IN ('CHANGE','CANCEL'), amount_base, 0)) AS other_fee_base,
  -- Change and cancel fees are not paid up front. They are priced as an
  -- expected cost using an assumed change probability from the config.
  SUM(IF(fee_type = 'CHANGE', amount_base, 0)) AS change_fee_base,
  SUM(IF(fee_type = 'CANCEL', amount_base, 0)) AS cancel_fee_base,
  SAFE_DIVIDE(COUNTIF(was_quoted), COUNT(*))   AS quoted_share
FROM resolved_fees
GROUP BY snapshot_id;


MERGE `${PROJECT}.tvd_fareiq_mart.fact_offer` T
USING (
  SELECT
    TO_HEX(SHA256(CONCAT(c.snapshot_id))) AS offer_sk,
    c.snapshot_id,
    c.collection_run_id,
    c.collected_at,
    c.collection_window,
    c.route_key, c.origin, c.destination,
    c.departure_date, c.return_date, c.trip_type, c.cabin,
    c.days_to_departure,
    CASE
      WHEN c.days_to_departure <= 1  THEN '0-1'
      WHEN c.days_to_departure <= 3  THEN '2-3'
      WHEN c.days_to_departure <= 7  THEN '4-7'
      WHEN c.days_to_departure <= 14 THEN '8-14'
      WHEN c.days_to_departure <= 21 THEN '15-21'
      WHEN c.days_to_departure <= 30 THEN '22-30'
      WHEN c.days_to_departure <= 60 THEN '31-60'
      WHEN c.days_to_departure <= 90 THEN '61-90'
      ELSE '90+'
    END AS dtd_bucket,
    EXTRACT(DAYOFWEEK FROM c.departure_date) IN (1, 6, 7) AS is_weekend_departure,
    c.pos_country,
    c.seller_id, c.seller_type, c.source_id, c.source_tier,
    COALESCE(s.trust_score, 0.5) AS trust_score,
    c.marketing_carrier, c.operating_carrier, c.fare_basis_code, c.fare_family,
    c.booking_class, c.stops_count, c.total_duration_minutes,
    c.is_refundable, c.is_changeable, c.included_checked_bags,
    c.quote_currency, c.base_fare, c.taxes_total, c.displayed_total,
    COALESCE(fx.rate, 1.0) AS fx_rate_to_base,
    CAST(c.displayed_total * COALESCE(fx.rate, 1.0) AS NUMERIC) AS displayed_total_base,

    COALESCE(f.bag_fee_base, 0)     AS bag_fee_base,
    COALESCE(f.seat_fee_base, 0)    AS seat_fee_base,
    COALESCE(f.payment_fee_base, 0) AS payment_fee_base,
    COALESCE(f.other_fee_base, 0)   AS other_fee_base,

    -- Flexibility is monetised as the expected saving from not paying a
    -- change fee, weighted by the configured probability of change.
    CAST(
      COALESCE(f.change_fee_base, 0) * ${CHANGE_PROBABILITY}
      + IF(c.is_refundable, COALESCE(f.cancel_fee_base, 0) * ${CANCEL_PROBABILITY}, 0)
    AS NUMERIC) AS flexibility_value_base,

    CAST(
      c.displayed_total * COALESCE(fx.rate, 1.0)
      + COALESCE(f.bag_fee_base, 0) + COALESCE(f.seat_fee_base, 0)
      + COALESCE(f.payment_fee_base, 0) + COALESCE(f.other_fee_base, 0)
    AS NUMERIC) AS true_customer_cost_base,

    CAST(
      c.displayed_total * COALESCE(fx.rate, 1.0)
      + COALESCE(f.bag_fee_base, 0) + COALESCE(f.seat_fee_base, 0)
      + COALESCE(f.payment_fee_base, 0) + COALESCE(f.other_fee_base, 0)
      - (COALESCE(f.change_fee_base, 0) * ${CHANGE_PROBABILITY}
         + IF(c.is_refundable, COALESCE(f.cancel_fee_base, 0) * ${CANCEL_PROBABILITY}, 0))
      -- Journey quality adjustment: a connection costs the traveller time.
      + (GREATEST(COALESCE(c.stops_count, 0) - ${BASELINE_STOPS}, 0) * ${STOP_PENALTY_BASE})
    AS NUMERIC) AS comparable_cost_base,

    CAST(
      0.4 * COALESCE(f.quoted_share, 0)
      + 0.4 * IF(c.included_checked_bags IS NOT NULL, 1, 0.4)
      + 0.2 * IF(c.fare_family IS NOT NULL, 1, 0.5)
    AS NUMERIC) AS fee_confidence,

    c.availability_status,
    c.seats_remaining,
    (c.seller_type = 'US') AS is_our_offer,
    c.legal_basis,
    ARRAY(
      SELECT flag FROM UNNEST([
        -- An offer already quoted in the base currency needs no rate. Without
        -- this, every NGN offer on a day with no NGN->NGN row was blocked.
        IF(fx.rate IS NULL AND c.quote_currency != base_ccy, 'BLOCKING_NO_FX_RATE', NULL),
        IF(c.marketing_carrier IS NULL, 'WARN_NO_CARRIER', NULL),
        IF(ARRAY_LENGTH(COALESCE(c.parse_warnings, [])) > 0, 'WARN_PARSE', NULL),
        IF(c.displayed_total > ${OUTLIER_ABS_CEILING}, 'BLOCKING_PRICE_OUTLIER_HIGH', NULL),
        IF(c.days_to_departure < 0, 'BLOCKING_NEGATIVE_DTD', NULL)
      ]) AS flag WHERE flag IS NOT NULL
    ) AS dq_flags
  FROM candidate_offers c
  LEFT JOIN fee_rollup f USING (snapshot_id)
  LEFT JOIN `${PROJECT}.tvd_fareiq_mart.dim_source` s ON s.source_id = c.source_id
  LEFT JOIN `${PROJECT}.tvd_fareiq_mart.dim_fx_rate` fx
         ON fx.from_currency = c.quote_currency AND fx.to_currency = base_ccy AND fx.rate_date = DATE(c.collected_at)
) S
ON T.offer_sk = S.offer_sk
   AND T.collected_at >= @window_start AND T.collected_at < @window_end
WHEN MATCHED THEN UPDATE SET
  comparable_cost_base = S.comparable_cost_base,
  true_customer_cost_base = S.true_customer_cost_base,
  bag_fee_base = S.bag_fee_base,
  seat_fee_base = S.seat_fee_base,
  payment_fee_base = S.payment_fee_base,
  other_fee_base = S.other_fee_base,
  fee_confidence = S.fee_confidence,
  dq_flags = S.dq_flags
WHEN NOT MATCHED THEN INSERT ROW;
