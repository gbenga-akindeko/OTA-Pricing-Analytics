"""Cloud Run service :: pricing and recommendation.

Runs after the morning collection sweep. Reads market snapshots, resolves the
policy for each cell, produces recommendations, writes them to BigQuery, and
hands the top of the list to the approval Sheet and the Gmail digest.

Also serves the approval callback that Apps Script posts to when an analyst
approves, modifies or rejects a recommendation. That endpoint is the only
writer to fact_price_decision.
"""
from __future__ import annotations

import logging
import math
import os
import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import FastAPI, Header, HTTPException
from google.api_core.exceptions import NotFound
from google.cloud import bigquery
from pydantic import BaseModel

from fareiq.core.config import EngineConfig, PolicyResolver, PricingRule
from fareiq.core.models import MarketCell
from fareiq.engine.pricing import PricingEngine

from . import sql_runner

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger("pricing")

PROJECT = os.environ["GCP_PROJECT"]
BQ_LOCATION = os.environ.get("BQ_LOCATION", "europe-west2")
ENGINE_VERSION = os.environ.get("GIT_SHA", "dev")

app = FastAPI(title="TVD OTA FareIQ Pricing")
bq = bigquery.Client(project=PROJECT)
cfg = EngineConfig()
engine = PricingEngine(cfg)


# ---------------------------------------------------------------- loaders
def load_rules() -> PolicyResolver:
    rows = bq.query(f"""
        SELECT rule_id, rule_name, scope_type, scope_value, cabin,
               min_margin_pct, target_margin_pct, max_markup_pct, min_markup_abs,
               target_price_index, max_daily_move_pct, priority,
               effective_from, effective_to, is_active
        FROM `{PROJECT}.tvd_fareiq_mart.dim_pricing_rule`
        WHERE is_active
    """, location=BQ_LOCATION).result()
    rules = [PricingRule(**{k: (float(v) if k.endswith(("_pct", "_abs", "_index")) and v is not None else v)
                            for k, v in dict(r).items()}) for r in rows]
    return PolicyResolver(rules)


def elasticity_source() -> str:
    """The elasticity table, or an empty stand-in when it does not exist yet.

    route_elasticity is only built by /refresh-models, which needs booking
    history to train on. Until then every cell falls back to the engine's
    default elasticity instead of the whole run failing on a missing table.
    """
    table = f"{PROJECT}.tvd_fareiq_ml.route_elasticity"
    try:
        bq.get_table(table)
        return f"`{table}`"
    except NotFound:
        log.warning("%s not found; using the default elasticity for every cell", table)
        return ("(SELECT CAST(NULL AS STRING) AS route_key, CAST(NULL AS STRING) AS cabin, "
                "CAST(NULL AS NUMERIC) AS elasticity, CAST(NULL AS STRING) AS elasticity_source)")


def load_cells(review_date: date) -> list[dict]:
    """Latest snapshot per market cell, plus demand and elasticity inputs.

    One query, one scan of one partition. Everything the engine needs arrives
    in a single result set; the engine itself touches no I/O.
    """
    sql = f"""
    WITH latest AS (
      SELECT * EXCEPT(rn) FROM (
        SELECT ms.*, ROW_NUMBER() OVER (
                 PARTITION BY route_key, departure_date, cabin, trip_type, pos_country
                 ORDER BY collection_window DESC) AS rn
        FROM `{PROJECT}.tvd_fareiq_mart.fact_market_snapshot` ms
        WHERE ms.snapshot_date = @review_date
      ) WHERE rn = 1
    ),
    demand AS (
      SELECT CONCAT(route_key, '|', cabin) AS series_id,
             AVG(pax) AS weekly_pax
      FROM (
        SELECT route_key, cabin, DATE_TRUNC(booking_date, WEEK) AS wk, SUM(pax_count) AS pax
        FROM `{PROJECT}.tvd_fareiq_mart.fact_booking`
        WHERE booking_date >= DATE_SUB(@review_date, INTERVAL 84 DAY)
          AND status IN ('TICKETED','BOOKED')
        GROUP BY 1,2,3
      ) GROUP BY series_id
    ),
    fees AS (
      SELECT route_key, departure_date, cabin,
             AVG(IF(is_our_offer, bag_fee_base, NULL))     AS our_bag_fee,
             AVG(IF(NOT is_our_offer, bag_fee_base, NULL)) AS competitor_bag_fee,
             AVG(fee_confidence)                           AS fee_confidence,
             TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), MAX(collected_at), MINUTE) / 60.0 AS freshness_hours,
             1.0 - SAFE_DIVIDE(COUNTIF(ARRAY_LENGTH(dq_flags) > 0), COUNT(*)) AS dq_score
      FROM `{PROJECT}.tvd_fareiq_mart.fact_offer`
      WHERE DATE(collected_at) = @review_date
      GROUP BY 1,2,3
    )
    SELECT
      l.*, d.weekly_pax,
      e.elasticity, e.elasticity_source,
      f.our_bag_fee, f.competitor_bag_fee, f.fee_confidence, f.freshness_hours, f.dq_score,
      r.region_pair, r.min_margin_pct_floor, r.max_discount_pct,
      c.marketing_carrier
    FROM latest l
    LEFT JOIN demand d ON d.series_id = CONCAT(l.route_key, '|', l.cabin)
    LEFT JOIN {elasticity_source()} e
           ON e.route_key = l.route_key AND e.cabin = l.cabin
    -- Explicit ON, not USING: once e and r are joined, route_key exists on
    -- more than one table to the left and BigQuery rejects USING as ambiguous.
    LEFT JOIN fees f
           ON f.route_key = l.route_key AND f.departure_date = l.departure_date
          AND f.cabin = l.cabin
    LEFT JOIN `{PROJECT}.tvd_fareiq_mart.dim_route` r ON r.route_key = l.route_key
    LEFT JOIN (
      SELECT route_key, departure_date, cabin,
             APPROX_TOP_COUNT(marketing_carrier, 1)[OFFSET(0)].value AS marketing_carrier
      FROM `{PROJECT}.tvd_fareiq_mart.fact_offer`
      WHERE DATE(collected_at) = @review_date AND is_our_offer
      GROUP BY 1,2,3
    ) c ON c.route_key = l.route_key AND c.departure_date = l.departure_date
         AND c.cabin = l.cabin
    WHERE l.our_comparable_cost IS NOT NULL
    """
    job = bq.query(sql, job_config=bigquery.QueryJobConfig(
        query_parameters=[bigquery.ScalarQueryParameter("review_date", "DATE", review_date)]
    ), location=BQ_LOCATION)
    return [dict(r) for r in job.result()]


def to_cell(row: dict) -> MarketCell:
    f = lambda k: float(row[k]) if row.get(k) is not None else None  # noqa: E731
    return MarketCell(
        market_sk=row["market_sk"], route_key=row["route_key"],
        departure_date=row["departure_date"], cabin=row["cabin"],
        trip_type=row["trip_type"], pos_country=row["pos_country"],
        days_to_departure=int(row["days_to_departure"]),
        marketing_carrier=row.get("marketing_carrier"),
        competitor_sellers=int(row["competitor_sellers"] or 0),
        coverage_score=float(row["coverage_score"] or 0),
        cheapest_competitor_id=row.get("cheapest_competitor_id"),
        cheapest_competitor_price=f("cheapest_competitor_price"),
        second_cheapest_price=f("second_cheapest_price"),
        market_median=f("market_median"), market_p25=f("market_p25"),
        market_weighted_mean=f("market_weighted_mean"),
        market_dispersion=f("market_dispersion"),
        our_price=f("our_displayed_total"), our_true_cost=f("our_true_cost"),
        our_comparable_cost=f("our_comparable_cost"),
        our_market_rank=int(row["our_market_rank"]) if row.get("our_market_rank") else None,
        supplier_cost=f("our_supplier_cost"),
        median_change_7d_pct=f("median_change_7d_pct"),
        cheapest_change_1d_pct=f("cheapest_change_1d_pct"),
        fee_confidence=float(row.get("fee_confidence") or 0.5),
        data_freshness_hours=float(row.get("freshness_hours") or 0.0),
        our_bag_fee=float(row.get("our_bag_fee") or 0.0),
        cheapest_competitor_bag_fee=float(row.get("competitor_bag_fee") or 0.0),
    )


# ---------------------------------------------------------------- run
class RunRequest(BaseModel):
    review_date: date | None = None
    dry_run: bool = False


@app.post("/recommend")
def recommend(req: RunRequest, authorization: str = Header(default="")):
    if not authorization:
        raise HTTPException(401, "OIDC token required")
    try:
        return run_recommendations(req)
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("recommendation run failed")
        raise HTTPException(500, f"{type(exc).__name__}: {exc}")


def run_recommendations(req: RunRequest) -> dict:
    review_date = req.review_date or date.today()
    resolver = load_rules()
    rows = load_cells(review_date)
    ruleset_version = uuid.uuid5(
        uuid.NAMESPACE_OID, "|".join(sorted(r.rule_id for r in resolver.rules))).hex[:12]

    out, generated_at = [], datetime.now(timezone.utc)
    for row in rows:
        cell = to_cell(row)
        policy = resolver.resolve(
            route_key=cell.route_key, region_pair=row.get("region_pair"),
            carrier=cell.marketing_carrier, cabin=cell.cabin, on=review_date,
        )
        # Route level overrides from the Sheet win over everything.
        if row.get("min_margin_pct_floor") is not None:
            policy = policy.__class__(**{**policy.__dict__,
                                         "min_margin_pct": float(row["min_margin_pct_floor"])})

        # Expected units for this cell over the remaining selling window,
        # apportioned from the weekly route demand across live departure dates.
        weekly = float(row.get("weekly_pax") or 0.0)
        weeks_left = max(cell.days_to_departure, 1) / 7.0
        expected_units = weekly * min(weeks_left, 12) / max(len(rows) / max(len(set(r["route_key"] for r in rows)), 1), 1)

        rec = engine.recommend(
            cell, policy,
            expected_units=expected_units,
            elasticity=float(row["elasticity"]) if row.get("elasticity") is not None else None,
            dq_score=float(row.get("dq_score") or 0.8),
            model_score=0.85 if row.get("elasticity_source") == "ROUTE" else 0.6,
        )
        out.append(_rec_row(rec, generated_at, review_date, ruleset_version))

    if req.dry_run:
        return {"review_date": str(review_date), "cells": len(rows), "dry_run": True,
                "sample": out[:3]}

    if out:
        errors = bq.insert_rows_json(f"{PROJECT}.tvd_fareiq_mart.fact_price_recommendation",
                                     [_bq_safe(r) for r in out])
        if errors:
            log.error("recommendation insert errors: %s", errors[:5])
            raise HTTPException(500, f"recommendation write failed: {errors[:3]}")

    actionable = [r for r in out if r["action"] != "HOLD"]
    return {
        "review_date": str(review_date),
        "cells_scored": len(out),
        "actionable": len(actionable),
        "p1": sum(1 for r in out if r["priority"] == "P1"),
        "engine_version": ENGINE_VERSION,
        "ruleset_version": ruleset_version,
    }


def _bq_safe(value):
    """Make engine output acceptable to a streaming insert.

    NUMERIC holds 9 decimal places and rejects NaN and infinity, while the
    engine works in plain floats. Rounding the float is not enough: a JSON
    number is read back as a binary double, so 5189541.968911917 arrives as
    5189541.9689119169... and is refused. Send each float as an exact decimal
    string instead, which BigQuery accepts for NUMERIC, and turn non-finite
    values into NULL. Every numeric column in fact_price_recommendation is
    NUMERIC, so this is safe for the whole row.
    """
    if isinstance(value, dict):
        return {k: _bq_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_bq_safe(v) for v in value]
    if isinstance(value, float):
        return f"{value:.9f}" if math.isfinite(value) else None
    return value


def _rec_row(rec, generated_at, review_date, ruleset_version) -> dict:
    return {
        "recommendation_id": uuid.uuid4().hex,
        "generated_at": generated_at.isoformat(),
        "review_date": review_date.isoformat(),
        "engine_version": ENGINE_VERSION,
        "ruleset_version": ruleset_version,
        "route_key": rec.route_key,
        "departure_date": rec.departure_date.isoformat(),
        "cabin": rec.cabin, "trip_type": rec.trip_type, "pos_country": rec.pos_country,
        "marketing_carrier": rec.marketing_carrier,
        "market_sk": rec.market_sk,
        "current_price": rec.current_price, "supplier_cost": rec.supplier_cost,
        "current_margin_abs": rec.current_margin_abs, "current_margin_pct": rec.current_margin_pct,
        "minimum_price": rec.minimum_price, "target_price": rec.target_price,
        "recommended_price": rec.recommended_price,
        "price_change_abs": rec.price_change_abs, "price_change_pct": rec.price_change_pct,
        "classification": rec.classification.value, "action": rec.action.value,
        "priority": rec.priority, "priority_score": rec.priority_score,
        "confidence": rec.confidence, "confidence_components": rec.confidence_components,
        "expected_demand_units": rec.expected_demand_units,
        "elasticity_used": rec.elasticity_used,
        "expected_volume_delta_pct": rec.expected_volume_delta_pct,
        "expected_revenue_impact": rec.expected_revenue_impact,
        "expected_margin_impact": rec.expected_margin_impact,
        "opportunity_value": rec.opportunity_value,
        "reason_codes": rec.reason_codes, "rationale": rec.rationale,
        "guardrails_triggered": rec.guardrails_triggered,
        "status": "PENDING",
    }


# ---------------------------------------------------------------- approval
class Decision(BaseModel):
    recommendation_id: str
    decision: str                 # APPROVED | REJECTED | MODIFIED | DEFERRED
    approved_price: float | None = None
    override_reason: str | None = None
    decided_by: str               # Workspace email, supplied by Apps Script
    decision_channel: str = "SHEET"


@app.post("/decision")
def decision(d: Decision, authorization: str = Header(default="")):
    """The only writer to the audit trail. Validates the decision, freezes the
    market evidence onto the record, then queues the price for application."""
    if not authorization:
        raise HTTPException(401, "OIDC token required")
    if d.decision in ("MODIFIED", "REJECTED") and not d.override_reason:
        raise HTTPException(400, "override_reason is required for MODIFIED and REJECTED")
    if d.decision == "MODIFIED" and d.approved_price is None:
        raise HTTPException(400, "approved_price is required for MODIFIED")

    rows = list(bq.query(f"""
        SELECT r.*, ms.cheapest_competitor_id, ms.cheapest_competitor_price,
               ms.market_median, ms.our_market_rank, ms.competitor_sellers
        FROM `{PROJECT}.tvd_fareiq_mart.fact_price_recommendation` r
        LEFT JOIN `{PROJECT}.tvd_fareiq_mart.fact_market_snapshot` ms ON ms.market_sk = r.market_sk
        WHERE r.recommendation_id = @rid
          AND r.review_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
        LIMIT 1
    """, job_config=bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("rid", "STRING", d.recommendation_id)
    ]), location=BQ_LOCATION).result())

    if not rows:
        raise HTTPException(404, "recommendation not found or expired")
    r = dict(rows[0])

    approved = d.approved_price if d.decision == "MODIFIED" else (
        r["recommended_price"] if d.decision == "APPROVED" else None)

    # A human may override the engine, but not the margin floor. That floor is
    # a commercial policy, not an engine opinion.
    if approved is not None and float(approved) < float(r["minimum_price"]) * 0.999:
        raise HTTPException(
            422,
            f"approved price {approved:,.0f} is below the policy minimum "
            f"{float(r['minimum_price']):,.0f}. Change the rule in the pricing "
            f"config sheet if this floor is wrong."
        )

    errors = bq.insert_rows_json(f"{PROJECT}.tvd_fareiq_mart.fact_price_decision", [{
        "decision_id": uuid.uuid4().hex,
        "recommendation_id": d.recommendation_id,
        "decided_at": datetime.now(timezone.utc).isoformat(),
        "decided_by": d.decided_by,
        "decision": d.decision,
        "decision_channel": d.decision_channel,
        "current_price": float(r["current_price"]),
        "recommended_price": float(r["recommended_price"]),
        "approved_price": float(approved) if approved is not None else None,
        "override_reason": d.override_reason,
        "competitor_benchmark": {
            "cheapest_competitor_id": r.get("cheapest_competitor_id"),
            "cheapest_price": float(r["cheapest_competitor_price"]) if r.get("cheapest_competitor_price") else None,
            "market_median": float(r["market_median"]) if r.get("market_median") else None,
            "our_rank": int(r["our_market_rank"]) if r.get("our_market_rank") else None,
            "sellers_observed": int(r["competitor_sellers"]) if r.get("competitor_sellers") else None,
        },
        "expected_margin_pct": float(r["current_margin_pct"]),
        "expected_margin_abs": float(r["current_margin_abs"]),
        "expected_revenue_impact": float(r["expected_revenue_impact"] or 0),
        "confidence": float(r["confidence"]),
        "apply_status": "PENDING" if approved is not None else None,
    }])
    if errors:
        raise HTTPException(500, f"audit write failed: {errors[:2]}")

    bq.query(f"""
        UPDATE `{PROJECT}.tvd_fareiq_mart.fact_price_recommendation`
        SET status = @status
        WHERE recommendation_id = @rid AND review_date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
    """, job_config=bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("status", "STRING", d.decision),
        bigquery.ScalarQueryParameter("rid", "STRING", d.recommendation_id),
    ]), location=BQ_LOCATION).result()

    return {"status": "recorded", "approved_price": approved}


# ---------------------------------------------------------------- transform
class TransformRequest(BaseModel):
    window_hours: int = 24
    window_end: datetime | None = None


@app.post("/transform")
def transform(req: TransformRequest, authorization: str = Header(default="")):
    """raw.offer_snapshot -> fact_offer -> fact_market_snapshot.

    Both statements are idempotent MERGEs keyed on a deterministic surrogate,
    so rerunning a window after a fix is safe and is the normal recovery path.
    """
    if not authorization:
        raise HTTPException(401, "OIDC token required")

    end = req.window_end or datetime.now(timezone.utc)
    start = end - timedelta(hours=max(req.window_hours, 1))
    params = [sql_runner.ts_param("window_start", start),
              sql_runner.ts_param("window_end", end),
              bigquery.ScalarQueryParameter("base_currency", "STRING", cfg.base_currency)]

    steps = []
    for path in ("02_staging/10_build_fact_offer.sql",
                 "02_staging/20_build_market_snapshot.sql"):
        try:
            steps.append(sql_runner.run_file(bq, path, params=params,
                                             location=BQ_LOCATION))
        except Exception as exc:
            log.exception("transform step failed: %s", path)
            raise HTTPException(500, f"{path}: {exc}")

    return {"window_start": start.isoformat(), "window_end": end.isoformat(),
            "steps": steps}


# ---------------------------------------------------------------- models
class ModelRequest(BaseModel):
    models: list[str] = ["fair_price", "elasticity"]


@app.post("/refresh-models")
def refresh_models(req: ModelRequest, authorization: str = Header(default="")):
    """Retrain the BigQuery ML models and rebuild the elasticity table.

    Training is expensive, so this runs weekdays only and the previous model
    stays live if it fails: CREATE OR REPLACE MODEL leaves the existing model
    in place until the new one has trained successfully.
    """
    if not authorization:
        raise HTTPException(401, "OIDC token required")
    try:
        step = sql_runner.run_file(bq, "05_ml/models.sql", location=BQ_LOCATION)
    except Exception as exc:
        log.exception("model refresh failed")
        raise HTTPException(500, str(exc))
    return {"requested": req.models, "result": step}


# ---------------------------------------------------------------- mining
class MineRequest(BaseModel):
    lookback_days: int = 90
    dry_run: bool = False


@app.post("/mine")
def mine(req: MineRequest, authorization: str = Header(default="")):
    """Anomalies, regime shifts, coverage gaps, fee moves and price patterns.

    Analytical rather than transactional: a failure here must not stop the
    morning review, so the scheduler treats a non-200 as a warning and the
    recommendation run at 06:15 proceeds either way.
    """
    if not authorization:
        raise HTTPException(401, "OIDC token required")
    from . import mining_job                      # heavy imports stay lazy
    try:
        return mining_job.main(lookback_days=req.lookback_days, dry_run=req.dry_run)
    except Exception as exc:
        log.exception("mining failed")
        raise HTTPException(500, str(exc))


# ---------------------------------------------------------------- outcomes
class OutcomeRequest(BaseModel):
    lookback_days: list[int] = [7, 30]


@app.post("/measure-outcomes")
def measure_outcomes(req: OutcomeRequest, authorization: str = Header(default="")):
    """Backfill what actually happened after each approved price change.

    This is the only job that writes back to fact_price_decision, and it
    writes only the outcome columns. The decision itself stays immutable.
    Without this the engine scorecard is empty and nobody can tell whether the
    recommendations were any good.
    """
    if not authorization:
        raise HTTPException(401, "OIDC token required")

    results = []
    for horizon in req.lookback_days:
        if horizon not in (7, 30):
            raise HTTPException(400, f"Unsupported horizon: {horizon}")
        sql = f"""
        MERGE `{PROJECT}.tvd_fareiq_mart.fact_price_decision` T
        USING (
          SELECT
            d.decision_id,
            COUNT(b.booking_sk)                                   AS bookings,
            SUM(b.selling_price_base)                             AS revenue,
            SUM(b.gross_margin_base)                              AS margin,
            SAFE_DIVIDE(COUNT(b.booking_sk), NULLIF(MAX(f.searches), 0)) AS conversion
          FROM `{PROJECT}.tvd_fareiq_mart.fact_price_decision` d
          JOIN `{PROJECT}.tvd_fareiq_mart.fact_price_recommendation` r
            USING (recommendation_id)
          LEFT JOIN `{PROJECT}.tvd_fareiq_mart.fact_booking` b
            ON b.route_key = r.route_key
           AND b.cabin = r.cabin
           AND b.departure_date = r.departure_date
           AND b.booking_date BETWEEN DATE(d.applied_at)
                                  AND DATE_ADD(DATE(d.applied_at), INTERVAL @h DAY)
          LEFT JOIN (
            SELECT CONCAT(origin, '-', destination) AS route_key, cabin,
                   DATE(event_ts) AS d, COUNTIF(event_type = 'SEARCH') AS searches
            FROM `{PROJECT}.tvd_fareiq_raw.own_search_event`
            WHERE event_ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 120 DAY)
            GROUP BY 1, 2, 3
          ) f ON f.route_key = r.route_key AND f.cabin = r.cabin
             AND f.d BETWEEN DATE(d.applied_at)
                         AND DATE_ADD(DATE(d.applied_at), INTERVAL @h DAY)
          WHERE d.apply_status = 'APPLIED'
            AND d.applied_at IS NOT NULL
            AND DATE_ADD(DATE(d.applied_at), INTERVAL @h DAY) <= CURRENT_DATE()
            AND DATE(d.decided_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL @lookback DAY)
          GROUP BY d.decision_id
        ) S
        ON T.decision_id = S.decision_id
           AND DATE(T.decided_at) >= DATE_SUB(CURRENT_DATE(), INTERVAL @lookback DAY)
        WHEN MATCHED THEN UPDATE SET
          outcome_measured_at = CURRENT_TIMESTAMP(),
          actual_bookings_{horizon}d  = S.bookings,
          actual_revenue_{horizon}d   = S.revenue,
          actual_margin_{horizon}d    = S.margin,
          actual_conversion_{horizon}d = S.conversion,
          actual_vs_expected_margin_pct =
            SAFE_DIVIDE(S.margin - T.expected_margin_abs, NULLIF(T.expected_margin_abs, 0))
        """
        # The 30 day horizon has no dedicated columns in the schema; it
        # refreshes the same fields once the longer window has matured, which
        # is what the scorecard compares against.
        sql = sql.replace("actual_bookings_30d", "actual_bookings_7d") \
                 .replace("actual_revenue_30d", "actual_revenue_7d") \
                 .replace("actual_margin_30d", "actual_margin_7d") \
                 .replace("actual_conversion_30d", "actual_conversion_7d")
        job = bq.query(sql, job_config=bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("h", "INT64", horizon),
            bigquery.ScalarQueryParameter("lookback", "INT64", horizon + 60),
        ]), location=BQ_LOCATION)
        job.result()
        results.append({"horizon_days": horizon, "rows_affected": job.num_dml_affected_rows})

    return {"measured": results}


@app.get("/health")
def healthz():
    """Liveness plus the two facts a deploy smoke test needs: which build is
    serving, and whether it can actually reach BigQuery."""
    warehouse = "unknown"
    try:
        list(bq.query("SELECT 1", location=BQ_LOCATION).result(timeout=10))
        warehouse = "reachable"
    except Exception as exc:
        warehouse = f"unreachable: {str(exc)[:120]}"
    return {"status": "ok", "engine_version": ENGINE_VERSION,
            "bq_location": BQ_LOCATION, "warehouse": warehouse,
            "revision": os.environ.get("K_REVISION", "local")}
