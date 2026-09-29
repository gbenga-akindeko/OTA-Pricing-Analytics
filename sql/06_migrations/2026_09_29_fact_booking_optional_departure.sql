-- The TVD sales register records when a ticket was issued, not when it flies.
-- Let fact_booking hold those tickets with an unknown departure date.
-- Safe to run more than once.
ALTER TABLE `${PROJECT}.tvd_fareiq_mart.fact_booking` ALTER COLUMN departure_date DROP NOT NULL;
ALTER TABLE `${PROJECT}.tvd_fareiq_mart.fact_booking` ALTER COLUMN booking_lead_days DROP NOT NULL;
