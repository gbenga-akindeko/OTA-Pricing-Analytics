"""Collector abstraction.

One class per source. The pipeline never knows which source it is talking to.
Every collector is responsible for four things and nothing else:
    1. declaring its legal basis and tier,
    2. respecting its own rate limit and budget,
    3. calling the source,
    4. returning ``NormalisedOffer`` objects.

Parsing failures never raise into the pipeline: they are recorded on the
offer as ``parse_warnings`` or returned as a ``CollectionError``, so one bad
source cannot take down the morning run.
"""
from __future__ import annotations

import abc
import asyncio
import logging
import random
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from fareiq.core.models import LegalBasis, NormalisedOffer, ShopRequest, SourceTier

log = logging.getLogger(__name__)


@dataclass
class CollectionError:
    source_id: str
    request: ShopRequest
    error_type: str
    message: str
    occurred_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    retryable: bool = True


@dataclass
class CollectionResult:
    source_id: str
    offers: list[NormalisedOffer] = field(default_factory=list)
    errors: list[CollectionError] = field(default_factory=list)
    calls_made: int = 0
    latency_ms: float = 0.0


class RateLimiter:
    """Token bucket. Per source, because every contract has its own ceiling
    and breaching it is both a technical and a commercial problem."""

    def __init__(self, per_minute: int, burst: int | None = None):
        self.rate = per_minute / 60.0
        self.capacity = burst or max(per_minute // 4, 1)
        self._tokens = float(self.capacity)
        self._last = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            while True:
                now = time.monotonic()
                self._tokens = min(self.capacity, self._tokens + (now - self._last) * self.rate)
                self._last = now
                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    return
                await asyncio.sleep((1.0 - self._tokens) / self.rate)


class BaseCollector(abc.ABC):
    source_id: str
    source_tier: SourceTier
    legal_basis: LegalBasis
    seller_id: str
    rate_limit_per_minute: int = 60
    max_retries: int = 3

    def __init__(self, collection_run_id: str, credentials: dict | None = None):
        self.collection_run_id = collection_run_id
        self.credentials = credentials or {}
        self.limiter = RateLimiter(self.rate_limit_per_minute)

    # ------------------------------------------------------------------
    @abc.abstractmethod
    async def _shop(self, request: ShopRequest) -> list[dict]:
        """Call the source and return raw offer dicts. Implemented per source."""

    @abc.abstractmethod
    def _parse(self, raw: dict, request: ShopRequest, collected_at: datetime) -> NormalisedOffer:
        """Map one raw offer to the canonical shape."""

    # ------------------------------------------------------------------
    def preflight(self, request: ShopRequest) -> bool:
        """Last gate before a call. Override for source specific compliance
        checks, for example a robots.txt or terms review for a permitted
        public source, or a POS restriction in a contract."""
        return True

    async def collect(self, request: ShopRequest) -> CollectionResult:
        result = CollectionResult(source_id=self.source_id)
        if not self.preflight(request):
            result.errors.append(CollectionError(
                self.source_id, request, "PREFLIGHT_BLOCKED",
                "Request blocked by source compliance preflight", retryable=False))
            return result

        started = time.perf_counter()
        for attempt in range(1, self.max_retries + 1):
            try:
                await self.limiter.acquire()
                collected_at = datetime.now(timezone.utc)
                raws = await self._shop(request)
                result.calls_made += 1
                for raw in raws:
                    try:
                        result.offers.append(self._parse(raw, request, collected_at))
                    except Exception as exc:  # one bad offer must not lose the rest
                        log.warning("parse failure on %s: %s", self.source_id, exc)
                        result.errors.append(CollectionError(
                            self.source_id, request, "PARSE_ERROR", str(exc), retryable=False))
                break
            except TransientSourceError as exc:
                if attempt == self.max_retries:
                    result.errors.append(CollectionError(
                        self.source_id, request, "TRANSIENT_EXHAUSTED", str(exc)))
                else:
                    backoff = min(2 ** attempt + random.random(), 30)
                    log.info("%s transient error, retry %s in %.1fs", self.source_id, attempt, backoff)
                    await asyncio.sleep(backoff)
            except PermanentSourceError as exc:
                result.errors.append(CollectionError(
                    self.source_id, request, "PERMANENT", str(exc), retryable=False))
                break
            except Exception as exc:
                result.errors.append(CollectionError(
                    self.source_id, request, "UNEXPECTED", repr(exc), retryable=False))
                break

        result.latency_ms = (time.perf_counter() - started) * 1000
        return result

    # ------------------------------------------------------------------
    def _new_snapshot_id(self) -> str:
        return uuid.uuid4().hex


class TransientSourceError(Exception):
    """Rate limited, timed out, 5xx. Retry with backoff."""


class PermanentSourceError(Exception):
    """Auth failure, bad request, contract violation. Do not retry."""
