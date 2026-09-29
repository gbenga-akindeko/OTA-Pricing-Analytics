-- =====================================================================
-- MART :: DIMENSIONS
-- =====================================================================

CREATE TABLE IF NOT EXISTS `${PROJECT}.tvd_fareiq_mart.dim_route`
(
  route_key            STRING NOT NULL OPTIONS(description='ORIGIN-DESTINATION, directional. LOS-LHR is not LHR-LOS.'),
  origin               STRING NOT NULL,
  destination          STRING NOT NULL,
  origin_city          STRING,
  destination_city     STRING,
  origin_country       STRING,
  destination_country  STRING,
  region_pair          STRING OPTIONS(description='WAF_DOMESTIC | WAF_REGIONAL | AF_EUROPE | AF_MIDEAST | AF_NORTHAM | OTHER.'),
  haul_type            STRING OPTIONS(description='SHORT | MEDIUM | LONG.'),
  great_circle_km      INT64,
  is_monitored         BOOL   NOT NULL DEFAULT TRUE,
  monitoring_tier      STRING OPTIONS(description='T1 hourly, T2 four hourly, T3 daily. Drives collection cost.'),
  strategic_priority   INT64  OPTIONS(description='1 highest. Used to break ties in the daily action list.'),
  min_margin_pct_floor NUMERIC OPTIONS(description='Route level override of the global margin floor. Set in the config Sheet.'),
  max_discount_pct     NUMERIC OPTIONS(description='Hard ceiling on how far the engine may cut. Config Sheet.'),
  updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
)
CLUSTER BY route_key
OPTIONS (description = 'Route master. Synced from the Pricing Config Google Sheet by Apps Script.');


CREATE TABLE IF NOT EXISTS `${PROJECT}.tvd_fareiq_mart.dim_seller`
(
  seller_id          STRING NOT NULL,
  seller_name        STRING NOT NULL,
  seller_type        STRING NOT NULL OPTIONS(description='US | COMPETITOR_OTA | AIRLINE_DIRECT | METASEARCH.'),
  home_market        STRING,
  is_benchmark       BOOL   NOT NULL DEFAULT TRUE OPTIONS(description='FALSE excludes the seller from market statistics without deleting history. Use for sellers we consider non comparable.'),
  benchmark_weight   NUMERIC DEFAULT 1.0 OPTIONS(description='Weight in the weighted market average. A competitor with 2% share should not move our index like one with 30%.'),
  typical_pos        STRING,
  notes              STRING,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
)
CLUSTER BY seller_id;


CREATE TABLE IF NOT EXISTS `${PROJECT}.tvd_fareiq_mart.dim_source`
(
  source_id             STRING NOT NULL,
  source_name           STRING NOT NULL,
  source_tier           STRING NOT NULL OPTIONS(description='OWN | GDS_NDC | LICENSED_AGGREGATOR | PERMITTED_PUBLIC.'),
  trust_score           NUMERIC NOT NULL OPTIONS(description='0 to 1. Multiplies into recommendation confidence. OWN=1.0, GDS_NDC=0.95, LICENSED=0.85, PERMITTED_PUBLIC=0.6.'),
  legal_basis           STRING NOT NULL,
  contract_reference    STRING,
  rate_limit_per_minute INT64,
  cost_per_1k_calls_usd NUMERIC OPTIONS(description='Drives the collection budget optimiser.'),
  robots_reviewed_at    DATE   OPTIONS(description='For PERMITTED_PUBLIC sources only. Reviewed quarterly by legal.'),
  is_active             BOOL   NOT NULL DEFAULT TRUE,
  updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
)
CLUSTER BY source_id;


CREATE TABLE IF NOT EXISTS `${PROJECT}.tvd_fareiq_mart.dim_carrier`
(
  carrier_code       STRING NOT NULL,
  carrier_name       STRING,
  carrier_type       STRING OPTIONS(description='FSC | LCC | HYBRID | CHARTER.'),
  alliance           STRING,
  home_country       STRING,
  ndc_capable        BOOL,
  our_commission_pct NUMERIC OPTIONS(description='Standard front end commission. Overridden by contract table where applicable.'),
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
)
CLUSTER BY carrier_code;


-- ---------------------------------------------------------------------
-- Type 2 fee dimension. Every fee change is a new row. This is what makes
-- "airline fee changes" a first class report rather than a guess.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `${PROJECT}.tvd_fareiq_mart.dim_airline_fee`
(
  fee_sk           STRING  NOT NULL OPTIONS(description='Surrogate key. Hash of the natural key plus valid_from.'),
  carrier          STRING  NOT NULL,
  pos_country      STRING  NOT NULL,
  route_scope      STRING  NOT NULL,
  cabin            STRING,
  fare_family      STRING,
  fee_type         STRING  NOT NULL,
  amount           NUMERIC,
  percent_of_fare  NUMERIC,
  currency         STRING,
  basis            STRING,
  specificity_rank INT64   NOT NULL OPTIONS(description='Higher wins when several rows could apply. ROUTE=3, REGION=2, GLOBAL=1.'),
  valid_from       TIMESTAMP NOT NULL,
  valid_to         TIMESTAMP OPTIONS(description='NULL means current.'),
  is_current       BOOL    NOT NULL,
  source_id        STRING  NOT NULL,
  change_delta     NUMERIC OPTIONS(description='Amount minus the previous version amount. Feeds the fee movement alert.'),
  change_pct       NUMERIC
)
PARTITION BY DATE(valid_from)
CLUSTER BY carrier, fee_type, is_current
OPTIONS (description = 'Slowly changing fee catalogue, type 2. Never overwrite: the history is the product.');


-- ---------------------------------------------------------------------
-- Pricing rules resolved from the config Sheet. One row per active rule.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `${PROJECT}.tvd_fareiq_mart.dim_pricing_rule`
(
  rule_id             STRING NOT NULL,
  rule_name           STRING NOT NULL,
  scope_type          STRING NOT NULL OPTIONS(description='GLOBAL | REGION | ROUTE | CARRIER | ROUTE_CARRIER | CABIN.'),
  scope_value         STRING,
  cabin               STRING,
  min_margin_pct      NUMERIC OPTIONS(description='Absolute floor. The engine may never recommend below this.'),
  target_margin_pct   NUMERIC,
  max_markup_pct      NUMERIC,
  min_markup_abs      NUMERIC OPTIONS(description='Absolute floor in base currency. Protects low fare routes where a percentage floor yields pennies.'),
  target_price_index  NUMERIC OPTIONS(description='Desired position vs the market median. 0.98 means aim 2% below median.'),
  max_daily_move_pct  NUMERIC OPTIONS(description='Volatility guard. Caps how far a price may move in one approval cycle.'),
  priority            INT64  NOT NULL OPTIONS(description='Lower number wins on conflict.'),
  effective_from      DATE   NOT NULL,
  effective_to        DATE,
  is_active           BOOL   NOT NULL DEFAULT TRUE,
  created_by          STRING,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
)
CLUSTER BY scope_type, is_active
OPTIONS (description = 'Business rules owned by the pricing team in Google Sheets, versioned into BigQuery on every sync.');


CREATE TABLE IF NOT EXISTS `${PROJECT}.tvd_fareiq_mart.dim_fx_rate`
(
  rate_date      DATE    NOT NULL,
  from_currency  STRING  NOT NULL,
  to_currency    STRING  NOT NULL,
  rate           NUMERIC NOT NULL,
  source_id      STRING  NOT NULL,
  ingested_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP()
)
PARTITION BY rate_date
CLUSTER BY from_currency, to_currency
OPTIONS (description = 'Daily FX. NGN volatility means every historical comparison must use the rate of the observation date, never today rate.');
