-- TravelDen prices on a flat margin of about 10,000 naira per ticket, not a
-- percentage. The engine's floor is cost plus the larger of min_margin_pct
-- and min_markup_abs, so the percentages go to zero and the naira floor to
-- 10,000 on every seeded rule. target_margin_pct is zero too: above the floor
-- the market decides the price, which is how the team prices today.
--
-- Airlines differ. Add CARRIER rules in the Pricing Rules tab (or here) with
-- their own min_markup_abs; the most specific rule wins.
--
-- Apply with:
--   sed 's/\${PROJECT}/tvd-fareiq-prod/g' deploy/pricing_rules_flat_markup.sql \
--     | bq query --use_legacy_sql=false --location=europe-west2
UPDATE `${PROJECT}.tvd_fareiq_mart.dim_pricing_rule`
SET min_margin_pct = 0,
    target_margin_pct = 0,
    min_markup_abs = 10000,
    updated_at = CURRENT_TIMESTAMP()
WHERE rule_id IN ('GLOBAL_DEFAULT', 'DOMESTIC_FLOOR', 'BUSINESS_CABIN');
