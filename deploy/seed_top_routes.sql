-- Monitored routes, from TravelDen's issued tickets (1 Jan to 28 Sep 2026),
-- ranked by naira net fare. The top eight go on T1 (every 30 minutes), the
-- next four on T2. Six new routes are added on T1 by request. Revenue
-- figures stay in the transactions database; only the route list lives here.
--
-- Apply with:
--   sed 's/\${PROJECT}/tvd-fareiq-prod/g' deploy/seed_top_routes.sql \
--     | bq query --use_legacy_sql=false --location=europe-west2
--
-- Routes already in dim_route keep their margin overrides; tier, priority
-- and names are refreshed. Routes not listed here are left as they are.
MERGE `${PROJECT}.tvd_fareiq_mart.dim_route` T
USING (
  SELECT CONCAT(o, '-', d) AS route_key, o AS origin, d AS destination,
         oc AS origin_city, dc AS destination_city,
         octy AS origin_country, dcty AS destination_country,
         rp AS region_pair, ht AS haul_type, tier AS monitoring_tier, pri AS strategic_priority
  FROM UNNEST([
    STRUCT('LOS' AS o, 'LHR' AS d, 'Lagos' AS oc, 'London' AS dc, 'NG' AS octy, 'GB' AS dcty,
           'AF_EUROPE' AS rp, 'LONG' AS ht, 'T1' AS tier, 1 AS pri),
    ('ABV', 'LHR', 'Abuja', 'London',    'NG', 'GB', 'AF_EUROPE',    'LONG',   'T1', 2),
    ('LOS', 'YYZ', 'Lagos', 'Toronto',   'NG', 'CA', 'AF_NORTHAM',   'LONG',   'T1', 3),
    ('LOS', 'CDG', 'Lagos', 'Paris',     'NG', 'FR', 'AF_EUROPE',    'LONG',   'T1', 4),
    ('LOS', 'CAN', 'Lagos', 'Guangzhou', 'NG', 'CN', 'AF_ASIA',      'LONG',   'T1', 5),
    ('LOS', 'DOH', 'Lagos', 'Doha',      'NG', 'QA', 'AF_MIDEAST',   'LONG',   'T1', 6),
    ('LOS', 'NBO', 'Lagos', 'Nairobi',   'NG', 'KE', 'AF_AFRICA',    'MEDIUM', 'T1', 7),
    ('LOS', 'ATL', 'Lagos', 'Atlanta',   'NG', 'US', 'AF_NORTHAM',   'LONG',   'T1', 8),
    ('LOS', 'JFK', 'Lagos', 'New York',  'NG', 'US', 'AF_NORTHAM',   'LONG',   'T2', 9),
    ('LOS', 'IAH', 'Lagos', 'Houston',   'NG', 'US', 'AF_NORTHAM',   'LONG',   'T2', 10),
    ('LOS', 'DXB', 'Lagos', 'Dubai',     'NG', 'AE', 'AF_MIDEAST',   'LONG',   'T2', 11),
    ('LOS', 'ABV', 'Lagos', 'Abuja',     'NG', 'NG', 'WAF_DOMESTIC', 'SHORT',  'T2', 12),
    -- New routes management asked for. Too new to rank on sales, so they go
    -- straight onto T1 and are watched every 30 minutes like the top eight.
    ('LOS', 'LGW', 'Lagos', 'London Gatwick', 'NG', 'GB', 'AF_EUROPE', 'LONG',   'T1', 13),
    ('LOS', 'IAD', 'Lagos', 'Washington',     'NG', 'US', 'AF_NORTHAM', 'LONG',  'T1', 14),
    ('LOS', 'ADD', 'Lagos', 'Addis Ababa',    'NG', 'ET', 'AF_AFRICA', 'MEDIUM', 'T1', 15),
    ('PHC', 'LHR', 'Port Harcourt', 'London', 'NG', 'GB', 'AF_EUROPE', 'LONG',   'T1', 16),
    ('LOS', 'KGL', 'Lagos', 'Kigali',         'NG', 'RW', 'AF_AFRICA', 'MEDIUM', 'T1', 17),
    ('PHC', 'LGW', 'Port Harcourt', 'London Gatwick', 'NG', 'GB', 'AF_EUROPE', 'LONG', 'T1', 18)
  ])
) S
ON T.route_key = S.route_key
WHEN MATCHED THEN UPDATE SET
  origin_city = S.origin_city, destination_city = S.destination_city,
  origin_country = S.origin_country, destination_country = S.destination_country,
  region_pair = S.region_pair, haul_type = S.haul_type,
  monitoring_tier = S.monitoring_tier, strategic_priority = S.strategic_priority,
  is_monitored = TRUE, updated_at = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN INSERT (route_key, origin, destination, origin_city, destination_city,
     origin_country, destination_country, region_pair, haul_type, is_monitored,
     monitoring_tier, strategic_priority, updated_at)
  VALUES (S.route_key, S.origin, S.destination, S.origin_city, S.destination_city,
          S.origin_country, S.destination_country, S.region_pair, S.haul_type, TRUE,
          S.monitoring_tier, S.strategic_priority, CURRENT_TIMESTAMP());
