"""Run the repository's .sql files from inside the service.

The staging transforms and the ML definitions live in `sql/` and are the same
files CI dry-runs on every pull request. Executing those exact files at
runtime, rather than a second copy embedded in Python, is what keeps the
pipeline and its tests from drifting apart.

Placeholders are substituted from the environment with the same defaults
`deploy/apply_sql.sh` uses, so a statement behaves identically whether it is
applied at deploy time or called by the scheduler.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime
from pathlib import Path

from google.cloud import bigquery

log = logging.getLogger("sql")

# sql/ is copied into the image next to the service package.
SQL_ROOT = Path(os.environ.get("SQL_ROOT", "/app/sql"))

DEFAULTS = {
    "PROJECT": lambda: os.environ["GCP_PROJECT"],
    "BQ_LOCATION": lambda: os.environ.get("BQ_LOCATION", "europe-west2"),
    "CHANGE_PROBABILITY": lambda: os.environ.get("CHANGE_PROBABILITY", "0.08"),
    "CANCEL_PROBABILITY": lambda: os.environ.get("CANCEL_PROBABILITY", "0.03"),
    "BASELINE_STOPS": lambda: os.environ.get("BASELINE_STOPS", "0"),
    "STOP_PENALTY_BASE": lambda: os.environ.get("STOP_PENALTY_BASE", "6000"),
    "OUTLIER_ABS_CEILING": lambda: os.environ.get("OUTLIER_ABS_CEILING", "20000000"),
    "EXPECTED_PANEL_SIZE": lambda: os.environ.get("EXPECTED_PANEL_SIZE", "5"),
    "ELASTICITY_SHRINK_K": lambda: os.environ.get("ELASTICITY_SHRINK_K", "20"),
    "DEFAULT_ELASTICITY": lambda: os.environ.get("DEFAULT_ELASTICITY", "-6.0"),
    "ELASTICITY_CEILING": lambda: os.environ.get("ELASTICITY_CEILING", "-0.5"),
    "ELASTICITY_FLOOR": lambda: os.environ.get("ELASTICITY_FLOOR", "-18.0"),
}


def render(relative_path: str) -> str:
    path = SQL_ROOT / relative_path
    if not path.exists():
        raise FileNotFoundError(
            f"{path} not found. The pricing image must COPY the sql/ directory; "
            f"see services/pricing_svc/Dockerfile."
        )
    sql = path.read_text(encoding="utf-8")
    for key, getter in DEFAULTS.items():
        sql = sql.replace("${" + key + "}", str(getter()))
    if "${" in sql:
        leftover = sql[sql.index("${"): sql.index("${") + 40]
        raise ValueError(f"Unsubstituted placeholder in {relative_path}: {leftover!r}")
    return sql


def run_file(
    client: bigquery.Client,
    relative_path: str,
    *,
    params: list | None = None,
    location: str | None = None,
    max_bytes: int | None = None,
) -> dict:
    """Execute one .sql file as a single BigQuery script."""
    sql = render(relative_path)
    started = datetime.utcnow()
    cfg = bigquery.QueryJobConfig(query_parameters=params or [])
    if max_bytes:
        cfg.maximum_bytes_billed = max_bytes

    job = client.query(sql, job_config=cfg,
                       location=location or os.environ.get("BQ_LOCATION", "europe-west2"))
    job.result()
    return {
        "file": relative_path,
        "job_id": job.job_id,
        "bytes_processed": job.total_bytes_processed,
        "seconds": (datetime.utcnow() - started).total_seconds(),
    }


def ts_param(name: str, value: datetime) -> bigquery.ScalarQueryParameter:
    return bigquery.ScalarQueryParameter(name, "TIMESTAMP", value)
