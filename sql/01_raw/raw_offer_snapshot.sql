-- =====================================================================
-- RAW LAYER
-- One row per priced offer returned by one source in one shopping call.
-- Immutable. Never updated, never deleted inside retention. This table is
-- the replay log: every downstream number can be rebuilt from it.
-- =====================================================================

CREATE TABLE IF NOT EXISTS `${PROJECT}.tvd_fareiq_raw.offer_snapshot`
(
  -- Identity and lineage
  snapshot_id            STRING    NOT NULL OPTIONS(description='UUIDv7. Unique per offer per collection run.'),
  collection_run_id      STRING    NOT NULL OPTIONS(description='FK to tvd_fareiq_ops.collection_run. One run = one scheduled sweep.'),
  source_id              STRING    NOT NULL OPTIONS(description='FK to dim_source. e.g. amadeus_sds, duffel_ndc, own_pss, provider_x.'),
  source_tier            STRING    NOT NULL OPTIONS(description='OWN | GDS_NDC | LICENSED_AGGREGATOR | PERMITTED_PUBLIC.'),
  collected_at           TIMESTAMP NOT NULL OPTIONS(description='UTC instant the response was received.'),
  ingested_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  gcs_uri                STRING             OPTIONS(description='gs:// path of the full raw response for this run. Audit anchor.'),

  -- The shopping request that produced this offer
  request_origin         STRING    NOT NULL,
  request_destination    STRING    NOT NULL,
  request_departure_date DATE      NOT NULL,
  request_return_date    DATE,
  request_trip_type      STRING    NOT NULL OPTIONS(description='ONE_WAY | ROUND_TRIP | MULTI_CITY.'),
  request_cabin          STRING    NOT NULL OPTIONS(description='ECONOMY | PREMIUM_ECONOMY | BUSINESS | FIRST.'),
  request_pax_adults     INT64     NOT NULL,
  request_pax_children   INT64     NOT NULL DEFAULT 0,
  request_pax_infants    INT64     NOT NULL DEFAULT 0,
  request_pos_country    STRING    NOT NULL OPTIONS(description='Point of sale. NG, GB, US. Fares are POS dependent.'),
  request_currency       STRING    NOT NULL,

  -- Who is selling
  seller_type            STRING    NOT NULL OPTIONS(description='US | COMPETITOR_OTA | AIRLINE_DIRECT | METASEARCH.'),
  seller_id              STRING    NOT NULL OPTIONS(description='FK to dim_seller.'),

  -- The offer
  offer_ref              STRING             OPTIONS(description='Provider offer id, for round tripping to booking.'),
  marketing_carrier      STRING,
  operating_carrier      STRING,
  fare_basis_code        STRING,
  fare_family            STRING             OPTIONS(description='Airline branded fare name, e.g. LIGHT, CLASSIC, FLEX.'),
  booking_class          STRING             OPTIONS(description='RBD single letter.'),
  is_refundable          BOOL,
  is_changeable          BOOL,
  stops_count            INT64,
  total_duration_minutes INT64,
  segments               ARRAY<STRUCT<
                            sequence          INT64,
                            marketing_carrier STRING,
                            operating_carrier STRING,
                            flight_number     STRING,
                            origin            STRING,
                            destination       STRING,
                            departure_local   DATETIME,
                            arrival_local     DATETIME,
                            aircraft          STRING,
                            booking_class     STRING,
                            cabin             STRING
                          >>,

  -- Money, as quoted by the source, in the source currency
  quote_currency         STRING    NOT NULL,
  base_fare              NUMERIC,
  taxes_total            NUMERIC,
  carrier_surcharges     NUMERIC,
  displayed_total        NUMERIC   NOT NULL OPTIONS(description='Headline price the shopper sees at this step.'),
  tax_breakdown          ARRAY<STRUCT<code STRING, amount NUMERIC, description STRING>>,

  -- Ancillaries as quoted at shop time. Frequently null and backfilled from the fee catalogue.
  included_checked_bags  INT64,
  included_cabin_bags    INT64,
  quoted_ancillaries     ARRAY<STRUCT<
                            type     STRING,   -- BAG_1ST | BAG_2ND | SEAT_STD | SEAT_EXTRA_LEG | PAYMENT | CHANGE | CANCEL
                            amount   NUMERIC,
                            currency STRING,
                            basis    STRING    -- PER_PAX_PER_SEGMENT | PER_PAX_PER_ITINERARY | PERCENT_OF_TOTAL
                          >>,

  -- Availability signal
  seats_remaining        INT64,
  availability_status    STRING OPTIONS(description='AVAILABLE | LIMITED | SOLD_OUT | ERROR.'),

  -- Compliance and quality
  legal_basis            STRING NOT NULL OPTIONS(description='CONTRACT_API | LICENSED_FEED | OWN_SYSTEM | PERMITTED_PUBLIC. Recorded per row so any figure can be traced to its right of use.'),
  raw_payload            JSON   OPTIONS(description='Verbatim normalised-to-JSON provider response fragment for this offer.'),
  parse_warnings         ARRAY<STRING>
)
PARTITION BY DATE(collected_at)
CLUSTER BY request_origin, request_destination, seller_id, request_departure_date
OPTIONS (
  description = 'Immutable landing table for every priced offer observed. Partition pruning on collected_at is mandatory in all downstream reads.',
  require_partition_filter = TRUE
);


-- ---------------------------------------------------------------------
-- Airline fee catalogue, raw. Slowly changing, sourced from the carrier
-- ancillary feed, ATPCO optional services where licensed, or manual entry
-- via the Google Sheet for the long tail of African carriers.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `${PROJECT}.tvd_fareiq_raw.fee_catalogue_snapshot`
(
  snapshot_id       STRING    NOT NULL,
  collection_run_id STRING    NOT NULL,
  source_id         STRING    NOT NULL,
  collected_at      TIMESTAMP NOT NULL,
  carrier           STRING    NOT NULL,
  pos_country       STRING    NOT NULL,
  route_scope       STRING             OPTIONS(description='GLOBAL | REGION:WAF | ROUTE:LOS-LHR. Most specific wins.'),
  cabin             STRING,
  fare_family       STRING,
  fee_type          STRING    NOT NULL OPTIONS(description='BAG_1ST | BAG_2ND | BAG_EXCESS_KG | SEAT_STD | SEAT_EXTRA_LEG | SEAT_FRONT | PAYMENT_CARD | PAYMENT_TRANSFER | CHANGE | CANCEL | NO_SHOW | INFANT.'),
  amount            NUMERIC,
  percent_of_fare   NUMERIC   OPTIONS(description='Used when the fee is proportional, e.g. some payment fees.'),
  currency          STRING,
  basis             STRING    OPTIONS(description='PER_PAX_PER_SEGMENT | PER_PAX_PER_ITINERARY | PER_KG | PERCENT_OF_TOTAL.'),
  conditions        JSON,
  effective_from    DATE,
  effective_to      DATE,
  legal_basis       STRING    NOT NULL,
  raw_payload       JSON
)
PARTITION BY DATE(collected_at)
CLUSTER BY carrier, fee_type, pos_country
OPTIONS (description = 'Raw ancillary fee observations. Converted to a type 2 dimension in the mart.');


-- ---------------------------------------------------------------------
-- Our own commercial data, landed from the booking engine / mid office.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `${PROJECT}.tvd_fareiq_raw.own_transaction`
(
  ingest_id            STRING    NOT NULL,
  ingested_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP(),
  booking_reference    STRING    NOT NULL,
  ticket_number        STRING,
  booked_at            TIMESTAMP NOT NULL,
  status               STRING    NOT NULL OPTIONS(description='BOOKED | TICKETED | VOIDED | REFUNDED | CANCELLED.'),
  channel              STRING             OPTIONS(description='WEB | MOBILE | CALL_CENTRE | CORPORATE_PORTAL | AGENT.'),
  customer_segment     STRING             OPTIONS(description='LEISURE | SME | CORPORATE_CONTRACT | GOVERNMENT.'),
  origin               STRING    NOT NULL,
  destination          STRING    NOT NULL,
  departure_date       DATE      NOT NULL,
  return_date          DATE,
  cabin                STRING    NOT NULL,
  marketing_carrier    STRING,
  fare_basis_code      STRING,
  fare_family          STRING,
  pax_count            INT64     NOT NULL,
  pos_country          STRING    NOT NULL,
  currency             STRING    NOT NULL,
  supplier_cost        NUMERIC   NOT NULL OPTIONS(description='What we pay the supplier: net fare plus taxes plus supplier fees.'),
  selling_price        NUMERIC   NOT NULL OPTIONS(description='What the customer paid, all in.'),
  markup_amount        NUMERIC,
  service_fee          NUMERIC,
  commission_earned    NUMERIC   OPTIONS(description='Back end commission and incentive accruals attributable to this sale.'),
  payment_cost         NUMERIC   OPTIONS(description='PSP and card scheme cost we absorb.'),
  ancillary_revenue    NUMERIC,
  refund_amount        NUMERIC,
  fx_rate_to_base      NUMERIC
)
PARTITION BY DATE(booked_at)
CLUSTER BY origin, destination, marketing_carrier
OPTIONS (description = 'Landed transactions from the booking engine. Source for margin, conversion and elasticity.');


-- ---------------------------------------------------------------------
-- Search/shop funnel events from our own site. Needed for conversion and
-- elasticity. Without this the pricing engine is blind to demand.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `${PROJECT}.tvd_fareiq_raw.own_search_event`
(
  event_id        STRING    NOT NULL,
  event_ts        TIMESTAMP NOT NULL,
  session_id      STRING,
  event_type      STRING    NOT NULL OPTIONS(description='SEARCH | RESULTS_VIEW | OFFER_SELECT | PAX_DETAILS | PAYMENT_START | PURCHASE | ABANDON.'),
  origin          STRING,
  destination     STRING,
  departure_date  DATE,
  cabin           STRING,
  pax_count       INT64,
  pos_country     STRING,
  channel         STRING,
  displayed_price NUMERIC,
  currency        STRING,
  offer_rank      INT64 OPTIONS(description='Position of our cheapest offer in our own results list.')
)
PARTITION BY DATE(event_ts)
CLUSTER BY origin, destination, event_type
OPTIONS (description = 'Funnel telemetry. Drives conversion rate and price elasticity estimation.');
