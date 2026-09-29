"""Cloud Run job :: nightly mining.

Reads the last 90 days from the mart, runs every detector, and writes the
signals back to ``fact_mining_signal`` where the Apps Script dashboard picks
them up. Scheduled at 05:45, between the transform and the recommendation run,
so the engine can read today's signals when it scores confidence.

Deliberately a separate entry point from the pricing service: mining is
analytical and can fail without stopping the morning review, and it wants
pandas and scikit-learn that the pricing path does not need.
"""
from __future__ import annotations

import logging
import os
from datetime import date

import pandas as pd
from google.cloud import bigquery

from fareiq.mining.signals import run_all

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger("mining")

PROJECT = os.environ["GCP_PROJECT"]
BQ_LOCATION = os.environ.get("BQ_LOCATION", "europe-west2")
bq = bigquery.Client(project=PROJECT)


def _read(sql: str, days: int) -> pd.DataFrame:
    job = bq.query(
        sql.format(p=PROJECT),
        job_config=bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("d", "INT64", days)]
        ),
        location=BQ_LOCATION,
    )
    return job.to_dataframe()


OFFERS_SQL = """
SELECT route_key, seller_id, cabin, DATE(collected_at) AS obs_date,
       departure_date,
       APPROX_QUANTILES(comparable_cost_base, 100)[OFFSET(50)] AS comparable_cost
FROM `{p}.tvd_fareiq_mart.fact_offer`
WHERE collected_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @d DAY)
  AND NOT EXISTS (SELECT 1 FROM UNNEST(dq_flags) f WHERE f LIKE 'BLOCKING_%')
GROUP BY route_key, seller_id, cabin, obs_date, departure_date
"""

COMPETITOR_SQL = """
WITH per_day AS (
  SELECT o.seller_id, o.route_key, DATE(o.collected_at) AS obs_date,
         APPROX_QUANTILES(o.comparable_cost_base, 100)[OFFSET(50)] AS median_price
  FROM `{p}.tvd_fareiq_mart.fact_offer` o
  WHERE o.collected_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @d DAY)
    AND NOT o.is_our_offer
  GROUP BY 1, 2, 3
),
market AS (
  SELECT route_key, snapshot_date AS obs_date,
         AVG(market_median) AS market_median
  FROM `{p}.tvd_fareiq_mart.fact_market_snapshot`
  WHERE snapshot_date >= DATE_SUB(CURRENT_DATE(), INTERVAL @d DAY)
  GROUP BY 1, 2
),
wins AS (
  SELECT seller_id, obs_date, AVG(cheapest_win_rate) AS win_rate
  FROM `{p}.tvd_fareiq_mart.v_competitor_intelligence`
  WHERE obs_date >= DATE_SUB(CURRENT_DATE(), INTERVAL @d DAY)
  GROUP BY 1, 2
)
SELECT p.seller_id, p.route_key, p.obs_date, p.median_price,
       m.market_median, COALESCE(w.win_rate, 0) AS win_rate
FROM per_day p
LEFT JOIN market m USING (route_key, obs_date)
LEFT JOIN wins w ON w.seller_id = p.seller_id AND w.obs_date = p.obs_date
WHERE m.market_median IS NOT NULL
"""

FEES_SQL = """
SELECT carrier, fee_type, pos_country, DATE(collected_at) AS obs_date,
       APPROX_QUANTILES(amount, 100)[OFFSET(50)] AS amount
FROM `{p}.tvd_fareiq_raw.fee_catalogue_snapshot`
WHERE collected_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @d DAY)
  AND amount IS NOT NULL
GROUP BY carrier, fee_type, pos_country, obs_date
"""


def main(lookback_days: int = 90, as_of: date | None = None, dry_run: bool = False) -> dict:
    frames: dict[str, pd.DataFrame] = {}
    for name, sql in (("offers", OFFERS_SQL),
                      ("competitor_daily", COMPETITOR_SQL),
                      ("fees", FEES_SQL)):
        try:
            frames[name] = _read(sql, lookback_days)
            log.info("%s: %d rows", name, len(frames[name]))
        except Exception as exc:
            log.warning("could not read %s: %s", name, exc)
            frames[name] = pd.DataFrame()

    signals = run_all(
        offers=frames["offers"],
        competitor_daily=frames["competitor_daily"],
        fees=frames["fees"],
        as_of=as_of or date.today(),
    )

    by_severity: dict[str, int] = {}
    for s in signals:
        by_severity[s.severity] = by_severity.get(s.severity, 0) + 1

    if dry_run:
        return {"signals": len(signals), "by_severity": by_severity, "dry_run": True,
                "sample": [s.detail for s in signals[:5]]}

    if signals:
        # Replace today's partition rather than appending, so a rerun after a
        # fix does not leave the analyst reading each finding twice.
        target = date.isoformat(as_of or date.today())
        bq.query(
            f"DELETE FROM `{PROJECT}.tvd_fareiq_mart.fact_mining_signal` "
            f"WHERE signal_date = DATE('{target}')",
            location=BQ_LOCATION,
        ).result()
        errors = bq.insert_rows_json(
            f"{PROJECT}.tvd_fareiq_mart.fact_mining_signal",
            [s.to_bq_row() for s in signals],
        )
        if errors:
            log.error("signal insert errors: %s", errors[:3])
            raise RuntimeError("mining signal write failed")

    return {"signals": len(signals), "by_severity": by_severity,
            "high": [s.detail for s in signals if s.severity == "HIGH"][:10]}


if __name__ == "__main__":
    import json
    print(json.dumps(main(dry_run=os.environ.get("DRY_RUN") == "1"), indent=2, default=str))
