-- Keep the trip type and the full itinerary on each booking, so round trips,
-- one ways and multi-city journeys (LOS-MED-JED-LOS) can be told apart.
-- Safe to run more than once.
ALTER TABLE `${PROJECT}.tvd_fareiq_mart.fact_booking` ADD COLUMN IF NOT EXISTS trip_type STRING;
ALTER TABLE `${PROJECT}.tvd_fareiq_mart.fact_booking` ADD COLUMN IF NOT EXISTS itinerary STRING;
