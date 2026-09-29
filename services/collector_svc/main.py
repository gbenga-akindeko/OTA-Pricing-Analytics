"""Cloud Run service :: collection.

Invoked by Cloud Scheduler through a Pub/Sub push or a direct OIDC call.
One invocation collects one work batch, writes raw JSONL to GCS, loads it to
tvd_fareiq_raw.offer_snapshot, and records telemetry.

Why GCS then BigQuery, rather than streaming inserts:
  * a load job costs nothing, streaming inserts do,
  * GCS is the replay log if a parser bug is found later,
  * a failed load leaves the raw file intact for a rerun.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import FastAPI, HTTPException, Request
from google.cloud import bigquery, secretmanager, storage
from pydantic import BaseModel, Field

from fareiq.collectors.implementations import COLLECTOR_REGISTRY, PRODUCTION_SOURCES
from fareiq.core.models import ShopRequest

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger("collector")

PROJECT = os.environ["GCP_PROJECT"]
RAW_BUCKET = os.environ["RAW_BUCKET"]
BQ_LOCATION = os.environ.get("BQ_LOCATION", "europe-west2")

app = FastAPI(title="TVD OTA FareIQ Collector")
bq = bigquery.Client(project=PROJECT)
gcs = storage.Client(project=PROJECT)
sm = secretmanager.SecretManagerServiceClient()

_secret_cache: dict[str, dict] = {}


# Sources that legitimately have no credential. Everything else must have a
# secret, and failing to find one is an error rather than an empty dict.
CREDENTIAL_FREE_SOURCES = {"mock_market"}


def get_credentials(source_id: str) -> dict:
    """Credentials never live in env vars or code. Secret Manager only,
    fetched at runtime, cached per instance."""
    if source_id in CREDENTIAL_FREE_SOURCES:
        return {}
    if source_id in _secret_cache:
        return _secret_cache[source_id]
    name = f"projects/{PROJECT}/secrets/tvd-ota-fareiq-{source_id}/versions/latest"
    payload = sm.access_secret_version(request={"name": name}).payload.data.decode()
    creds = json.loads(payload)
    _secret_cache[source_id] = creds
    return creds


class CollectRequest(BaseModel):
    tier: str = Field(description="T1 | T2 | T3. Which monitoring tier to sweep.")
    source_ids: list[str] | None = None
    horizon_days: list[int] = Field(default_factory=lambda: [1, 3, 7, 14, 21, 30, 45, 60, 90])
    cabins: list[str] = Field(default_factory=lambda: ["ECONOMY"])
    pos_countries: list[str] = Field(default_factory=lambda: ["NG"])
    # TravelDen sells mostly round trips (85 to 97% of tickets on the top
    # routes), and a return fare is not twice a one way fare, so both are
    # shopped. The return leg is priced stay_days after departure.
    trip_types: list[str] = Field(default_factory=lambda: ["ONE_WAY", "ROUND_TRIP"])
    stay_days: int = 14
    max_requests: int = 5000
    dry_run: bool = False


def build_work_queue(req: CollectRequest) -> list[ShopRequest]:
    """The collection plan is data, not code. Routes and their tier come from
    dim_route, which is synced from the pricing team's Google Sheet."""
    rows = bq.query(
        """
        SELECT route_key, origin, destination
        FROM `{p}.tvd_fareiq_mart.dim_route`
        WHERE is_monitored AND monitoring_tier = @tier
        ORDER BY strategic_priority, route_key
        """.format(p=PROJECT),
        job_config=bigquery.QueryJobConfig(
            query_parameters=[bigquery.ScalarQueryParameter("tier", "STRING", req.tier)]
        ),
        location=BQ_LOCATION,
    ).result()

    today = date.today()
    queue: list[ShopRequest] = []
    for row in rows:
        for horizon in req.horizon_days:
            for cabin in req.cabins:
                for pos in req.pos_countries:
                    for trip in req.trip_types:
                        dep = today + timedelta(days=horizon)
                        round_trip = trip.upper() == "ROUND_TRIP"
                        queue.append(ShopRequest(
                            origin=row.origin, destination=row.destination,
                            departure_date=dep,
                            return_date=dep + timedelta(days=req.stay_days) if round_trip else None,
                            trip_type="ROUND_TRIP" if round_trip else "ONE_WAY",
                            cabin=cabin, pos_country=pos, currency="NGN",
                        ))
                        if len(queue) >= req.max_requests:
                            return queue
    return queue


async def run_collection(req: CollectRequest) -> dict:
    run_id = uuid.uuid4().hex
    started = datetime.now(timezone.utc)
    queue = build_work_queue(req)
    source_ids = req.source_ids or PRODUCTION_SOURCES

    # Errors are collected from the very first step. A collector that cannot
    # even start up is the single most likely failure on a new deployment
    # (usually a missing secret), and if that is only written to the log the
    # run reports "0 calls, 0 errors" and looks like an empty market rather
    # than a broken one.
    collectors, errors = [], []
    for sid in source_ids:
        cls = COLLECTOR_REGISTRY.get(sid)
        if not cls:
            errors.append({"source_id": sid, "error_type": "UNKNOWN_SOURCE",
                           "message": f"{sid} is not in COLLECTOR_REGISTRY"})
            continue
        try:
            collectors.append(cls(collection_run_id=run_id, credentials=get_credentials(sid)))
        except Exception as exc:
            log.error("cannot init %s: %s", sid, exc)
            errors.append({"source_id": sid, "error_type": "COLLECTOR_INIT",
                           "message": str(exc)[:500]})

    if req.dry_run:
        return {"run_id": run_id,
                "planned_requests": len(queue),
                "collectors_ready": [c.source_id for c in collectors],
                "collectors_failed": [e["source_id"] for e in errors],
                "planned_calls": len(queue) * len(collectors),
                "errors": errors,
                "dry_run": True}

    if not collectors:
        # Nothing could start. Record it and say so, rather than writing an
        # empty run that reads as a quiet market.
        write_run_telemetry(run_id, started, req, len(queue), 0, 0, errors)
        raise HTTPException(
            503,
            "No collector could be initialised: "
            + "; ".join(f"{e['source_id']}: {e['message'][:120]}" for e in errors))

    # Bounded concurrency. Each collector still enforces its own rate limit;
    # this cap stops us opening thousands of sockets on one instance.
    sem = asyncio.Semaphore(int(os.environ.get("MAX_CONCURRENCY", "24")))

    async def one(collector, shop_request):
        async with sem:
            return await collector.collect(shop_request)

    tasks = [one(c, r) for c in collectors for r in queue]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    offers, calls = [], 0
    for r in results:
        if isinstance(r, Exception):
            errors.append({"error_type": "TASK_EXCEPTION", "message": repr(r)})
            continue
        offers.extend(r.offers)
        calls += r.calls_made
        errors.extend([{"source_id": e.source_id, "error_type": e.error_type,
                        "message": e.message[:500]} for e in r.errors])

    gcs_uri = write_raw_to_gcs(run_id, offers) if offers else None
    loaded = load_to_bigquery(gcs_uri) if gcs_uri else 0
    write_run_telemetry(run_id, started, req, len(queue), calls, len(offers), errors)

    return {
        "run_id": run_id, "requests": len(queue), "calls": calls,
        "offers": len(offers), "rows_loaded": loaded,
        "errors": len(errors), "gcs_uri": gcs_uri,
        "duration_s": (datetime.now(timezone.utc) - started).total_seconds(),
    }


def write_raw_to_gcs(run_id: str, offers: list) -> str:
    ts = datetime.now(timezone.utc)
    path = (f"offers/dt={ts:%Y-%m-%d}/hour={ts:%H}/run_{run_id}.jsonl")
    blob = gcs.bucket(RAW_BUCKET).blob(path)
    uri = f"gs://{RAW_BUCKET}/{path}"
    body = "\n".join(json.dumps(o.to_bq_row() | {"gcs_uri": uri}, default=str) for o in offers)
    blob.upload_from_string(body, content_type="application/x-ndjson")
    return uri


def load_to_bigquery(gcs_uri: str) -> int:
    job = bq.load_table_from_uri(
        gcs_uri,
        f"{PROJECT}.tvd_fareiq_raw.offer_snapshot",
        job_config=bigquery.LoadJobConfig(
            source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
            write_disposition=bigquery.WriteDisposition.WRITE_APPEND,
            schema_update_options=[],           # schema drift must be a deliberate migration
            ignore_unknown_values=False,        # a new provider field should fail loudly
            max_bad_records=0,
        ),
        location=BQ_LOCATION,
    )
    job.result()
    return job.output_rows or 0


def write_run_telemetry(run_id, started, req, planned, calls, offers, errors) -> None:
    bq.insert_rows_json(
        f"{PROJECT}.tvd_fareiq_ops.collection_run",
        [{
            "collection_run_id": run_id,
            "started_at": started.isoformat(),
            "finished_at": datetime.now(timezone.utc).isoformat(),
            "tier": req.tier,
            "planned_requests": planned,
            "calls_made": calls,
            "offers_collected": offers,
            "error_count": len(errors),
            "error_sample": json.dumps(errors[:20]),
            "service_revision": os.environ.get("K_REVISION", "local"),
        }],
    )


@app.post("/collect")
async def collect(req: CollectRequest, request: Request):
    if not request.headers.get("Authorization"):
        raise HTTPException(401, "OIDC token required")
    try:
        return await run_collection(req)
    except Exception as exc:
        log.exception("collection failed")
        raise HTTPException(500, str(exc))


@app.get("/health")
def healthz():
    return {"status": "ok", "revision": os.environ.get("K_REVISION", "local")}
