#!/usr/bin/env bash
# TVD OTA FareIQ :: seed the configuration dimensions
#
# The platform cannot produce a single recommendation until four things exist:
# routes to monitor, sellers to compare against, pricing rules to price by, and
# an FX rate for the base currency. This script seeds a minimum viable set so
# the first end-to-end run has something to chew on. After go-live the pricing
# team owns all of it from the Google Sheet and this script is never run again.
set -euo pipefail

PROJECT="${GCP_PROJECT:?}"
LOC="${BQ_LOCATION:-europe-west2}"
Q() { bq query --use_legacy_sql=false --location="$LOC" --project_id="$PROJECT" "$1"; }

echo "==> Seeding dim_source"
Q "
MERGE \`${PROJECT}.tvd_fareiq_mart.dim_source\` T
USING (SELECT * FROM UNNEST([
  STRUCT('own_pss' AS source_id, 'Our booking engine' AS source_name, 'OWN' AS source_tier,
         1.00 AS trust_score, 'OWN_SYSTEM' AS legal_basis, 600 AS rate_limit_per_minute),
  ('amadeus','Amadeus Self-Service','GDS_NDC',0.95,'CONTRACT_API',40),
  ('sabre','Sabre Bargain Finder Max v5','GDS_NDC',0.95,'CONTRACT_API',30),
  ('verteil','Verteil NDC aggregator','GDS_NDC',0.93,'CONTRACT_API',30),
  ('ndc_direct','Airline NDC direct','GDS_NDC',0.97,'CONTRACT_API',20)
])) S
ON T.source_id = S.source_id
WHEN MATCHED THEN UPDATE SET source_name=S.source_name, source_tier=S.source_tier,
     trust_score=S.trust_score, legal_basis=S.legal_basis,
     rate_limit_per_minute=S.rate_limit_per_minute, is_active=TRUE,
     updated_at=CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT (source_id, source_name, source_tier, trust_score,
     legal_basis, rate_limit_per_minute, is_active, updated_at)
  VALUES (S.source_id, S.source_name, S.source_tier, S.trust_score, S.legal_basis,
          S.rate_limit_per_minute, TRUE, CURRENT_TIMESTAMP())"

echo "==> Seeding dim_seller"
Q "
MERGE \`${PROJECT}.tvd_fareiq_mart.dim_seller\` T
USING (SELECT * FROM UNNEST([
  -- is_benchmark FALSE means "never counted in a market statistic".
  -- Supply channels are our cost, not a competitor's price, so they are all
  -- FALSE. Only airline-direct is a real customer-facing competitor today.
  STRUCT('us' AS seller_id, 'TravelDen' AS seller_name, 'US' AS seller_type,
         FALSE AS is_benchmark, 1.0 AS benchmark_weight, 'NG' AS home_market),
  ('channel_amadeus','Amadeus (channel)','GDS_CHANNEL',FALSE,1.0,'NG'),
  ('channel_sabre','Sabre (channel)','GDS_CHANNEL',FALSE,1.0,'NG'),
  ('channel_verteil','Verteil NDC (channel)','NDC_CHANNEL',FALSE,1.0,'NG'),
  ('airline_direct','Airline direct NDC','AIRLINE_DIRECT',TRUE,1.4,'NG')
])) S
ON T.seller_id = S.seller_id
WHEN MATCHED THEN UPDATE SET seller_name=S.seller_name, seller_type=S.seller_type,
     is_benchmark=S.is_benchmark, benchmark_weight=S.benchmark_weight,
     home_market=S.home_market, updated_at=CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT (seller_id, seller_name, seller_type, is_benchmark,
     benchmark_weight, home_market, updated_at)
  VALUES (S.seller_id, S.seller_name, S.seller_type, S.is_benchmark,
          S.benchmark_weight, S.home_market, CURRENT_TIMESTAMP())"

echo "==> Seeding dim_route (tier 1 starter set, edit in the Sheet afterwards)"
Q "
MERGE \`${PROJECT}.tvd_fareiq_mart.dim_route\` T
USING (SELECT
  CONCAT(o, '-', d) AS route_key, o AS origin, d AS destination,
  oc AS origin_city, dc AS destination_city,
  'NG' AS origin_country, dcty AS destination_country,
  rp AS region_pair, ht AS haul_type, tier AS monitoring_tier, pri AS strategic_priority
FROM UNNEST([
  STRUCT('LOS' AS o,'LHR' AS d,'Lagos' AS oc,'London' AS dc,'GB' AS dcty,'AF_EUROPE' AS rp,'LONG' AS ht,'T1' AS tier,1 AS pri),
  ('LOS','DXB','Lagos','Dubai','AE','AF_MIDEAST','LONG','T1',2),
  ('LOS','JFK','Lagos','New York','US','AF_NORTHAM','LONG','T1',3),
  ('LOS','CDG','Lagos','Paris','FR','AF_EUROPE','LONG','T1',4),
  ('LOS','IST','Lagos','Istanbul','TR','AF_EUROPE','LONG','T1',5),
  ('LOS','ACC','Lagos','Accra','GH','WAF_REGIONAL','SHORT','T1',6),
  ('LOS','ABV','Lagos','Abuja','NG','WAF_DOMESTIC','SHORT','T1',7),
  ('ABV','LHR','Abuja','London','GB','AF_EUROPE','LONG','T1',8),
  ('ABV','DXB','Abuja','Dubai','AE','AF_MIDEAST','LONG','T2',9),
  ('LOS','JNB','Lagos','Johannesburg','ZA','AF_EUROPE','MEDIUM','T2',10)
])) S
ON T.route_key = S.route_key
WHEN MATCHED THEN UPDATE SET monitoring_tier=S.monitoring_tier,
     strategic_priority=S.strategic_priority, is_monitored=TRUE,
     updated_at=CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT (route_key, origin, destination, origin_city,
     destination_city, origin_country, destination_country, region_pair,
     haul_type, is_monitored, monitoring_tier, strategic_priority, updated_at)
  VALUES (S.route_key, S.origin, S.destination, S.origin_city, S.destination_city,
          S.origin_country, S.destination_country, S.region_pair, S.haul_type,
          TRUE, S.monitoring_tier, S.strategic_priority, CURRENT_TIMESTAMP())"

echo "==> Seeding dim_pricing_rule (global floor plus two overrides)"
Q "
MERGE \`${PROJECT}.tvd_fareiq_mart.dim_pricing_rule\` T
USING (SELECT * FROM UNNEST([
  STRUCT('GLOBAL_DEFAULT' AS rule_id, 'Global default' AS rule_name,
         'GLOBAL' AS scope_type, CAST(NULL AS STRING) AS scope_value,
         CAST(NULL AS STRING) AS cabin,
         0.035 AS min_margin_pct, 0.075 AS target_margin_pct, 0.25 AS max_markup_pct,
         3500.0 AS min_markup_abs, 0.985 AS target_price_index, 0.08 AS max_daily_move_pct,
         100 AS priority),
  ('DOMESTIC_FLOOR','West Africa domestic floor','REGION','WAF_DOMESTIC',NULL,
   0.04,0.09,0.30,2500.0,0.99,0.06,50),
  ('BUSINESS_CABIN','Business cabin','CABIN',NULL,'BUSINESS',
   0.05,0.11,0.30,15000.0,0.99,0.06,50)
])) S
ON T.rule_id = S.rule_id
WHEN MATCHED THEN UPDATE SET min_margin_pct=S.min_margin_pct,
     target_margin_pct=S.target_margin_pct, max_markup_pct=S.max_markup_pct,
     min_markup_abs=S.min_markup_abs, target_price_index=S.target_price_index,
     max_daily_move_pct=S.max_daily_move_pct, is_active=TRUE,
     updated_at=CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT (rule_id, rule_name, scope_type, scope_value, cabin,
     min_margin_pct, target_margin_pct, max_markup_pct, min_markup_abs,
     target_price_index, max_daily_move_pct, priority, effective_from,
     is_active, created_by, updated_at)
  VALUES (S.rule_id, S.rule_name, S.scope_type, S.scope_value, S.cabin,
          S.min_margin_pct, S.target_margin_pct, S.max_markup_pct, S.min_markup_abs,
          S.target_price_index, S.max_daily_move_pct, S.priority, CURRENT_DATE(),
          TRUE, 'seed', CURRENT_TIMESTAMP())"

echo "==> Seeding today's FX (NGN to NGN is 1; add real rates from your provider)"
Q "
MERGE \`${PROJECT}.tvd_fareiq_mart.dim_fx_rate\` T
USING (SELECT CURRENT_DATE() AS rate_date, c AS from_currency, 'NGN' AS to_currency,
              r AS rate, 'seed' AS source_id
       FROM UNNEST([STRUCT('NGN' AS c, 1.0 AS r)])) S
ON T.rate_date = S.rate_date AND T.from_currency = S.from_currency
   AND T.to_currency = S.to_currency
WHEN NOT MATCHED THEN INSERT (rate_date, from_currency, to_currency, rate, source_id)
  VALUES (S.rate_date, S.from_currency, S.to_currency, S.rate, S.source_id)"

cat <<'EOF'

Seed complete.

IMPORTANT: dim_fx_rate now holds only NGN to NGN. Any offer quoted in another
currency will carry a BLOCKING_NO_FX_RATE flag and be excluded from the market
panel until you load real rates. Wire a daily FX feed before the first
collection sweep, or restrict the first sweep to NGN-quoting sources.

Next: bash deploy/02_deploy_services.sh
EOF
