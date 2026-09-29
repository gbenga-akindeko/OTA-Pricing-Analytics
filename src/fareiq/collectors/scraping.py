"""Compliant web collection for the permitted-public tier.

This module exists because the brief asks for scraping and because doing it
badly is how an OTA ends up in a commercial dispute. Every control below is
enforced in code rather than described in a policy document:

  * A source is collected only if ``config/sources.yaml`` lists it, its terms
    have been reviewed as permitting collection, and that review is under 90
    days old. Absence from the register means no collection, full stop.
  * ``robots.txt`` is fetched, parsed and obeyed per path, and its
    ``Crawl-delay`` overrides our own rate limit when it is slower.
  * The user agent identifies us honestly and carries a contact address.
  * A conditional GET and an on-disk cache mean we never re-fetch a page the
    source says has not changed.
  * 429 and 503 escalate the backoff and can trip a circuit breaker that
    stops the source for the rest of the run.
  * Personal data is never extracted. The parsers below read prices,
    carriers, times and fee lines; nothing else.

What this module deliberately cannot do: solve a CAPTCHA, log in, replay a
session cookie, rotate an IP or spoof a browser fingerprint. Those are how
you defeat an access control, and an access control is a "no".
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import random
import re
import time
import urllib.robotparser
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urljoin, urlparse

import httpx

from fareiq.collectors.base import (
    BaseCollector, PermanentSourceError, TransientSourceError,
)
from fareiq.core.models import (
    Ancillary, FeeBasis, FeeType, LegalBasis, NormalisedOffer, SellerType,
    ShopRequest, SourceTier,
)

log = logging.getLogger(__name__)

CONTACT = "data-team@travelden.example"
USER_AGENT = (
    f"TVD-OTA-FareIQ/1.0 (+https://travelden.example/bot; {CONTACT}) "
    "price-research; respects robots.txt"
)
MAX_REVIEW_AGE_DAYS = 90


# ======================================================================
# Compliance gate
# ======================================================================
@dataclass(frozen=True)
class SourceRegistration:
    """One entry from the source register. The scraper reads this, not a flag."""
    source_id: str
    base_url: str
    enabled: bool
    terms_permit_collection: bool
    robots_allows_path: bool
    legal_review_date: date | None
    permitted_pos: tuple[str, ...]
    rate_limit_per_minute: int
    contact: str = CONTACT
    notes: str = ""

    @property
    def review_age_days(self) -> int:
        if self.legal_review_date is None:
            return 10_000
        return (date.today() - self.legal_review_date).days

    def blocking_reasons(self, pos_country: str | None = None) -> list[str]:
        """Every reason this source may not be collected right now."""
        reasons: list[str] = []
        if not self.enabled:
            reasons.append("SOURCE_DISABLED")
        if not self.terms_permit_collection:
            reasons.append("TERMS_DO_NOT_PERMIT")
        if not self.robots_allows_path:
            reasons.append("ROBOTS_DISALLOWS")
        if self.review_age_days > MAX_REVIEW_AGE_DAYS:
            reasons.append(f"LEGAL_REVIEW_STALE_{self.review_age_days}D")
        if pos_country and pos_country not in self.permitted_pos:
            reasons.append(f"POS_NOT_PERMITTED_{pos_country}")
        return reasons

    def is_collectable(self, pos_country: str | None = None) -> bool:
        return not self.blocking_reasons(pos_country)

    @classmethod
    def from_yaml(cls, source_id: str, entry: dict) -> SourceRegistration:
        review = entry.get("legal_review_date")
        if isinstance(review, str):
            review = date.fromisoformat(review)
        elif isinstance(review, datetime):
            review = review.date()
        return cls(
            source_id=source_id,
            base_url=entry.get("base_url", ""),
            enabled=bool(entry.get("enabled", False)),
            terms_permit_collection=bool(entry.get("terms_permit_collection", False)),
            robots_allows_path=bool(entry.get("robots_allows_path", False)),
            legal_review_date=review if isinstance(review, date) else None,
            permitted_pos=tuple(entry.get("permitted_pos", []) or []),
            rate_limit_per_minute=int(entry.get("rate_limit_per_minute", 6)),
            contact=entry.get("contact", CONTACT),
            notes=entry.get("notes", ""),
        )


def load_registrations(path: str | Path) -> dict[str, SourceRegistration]:
    import yaml  # imported lazily so the engine has no YAML dependency
    with open(path, encoding="utf-8") as fh:
        doc = yaml.safe_load(fh) or {}
    out: dict[str, SourceRegistration] = {}
    for sid, entry in (doc.get("sources") or {}).items():
        if str(entry.get("tier", "")).upper() != "PERMITTED_PUBLIC":
            continue
        out[sid] = SourceRegistration.from_yaml(sid, entry)
    return out


# ======================================================================
# robots.txt
# ======================================================================
class RobotsPolicy:
    """Fetches and caches robots.txt per origin, and obeys Crawl-delay.

    Fails closed: if robots.txt cannot be read, nothing is fetched from that
    origin. A source that will not tell us its rules does not get crawled.
    """

    def __init__(self, user_agent: str = USER_AGENT, ttl_seconds: int = 86400):
        self.user_agent = user_agent
        self.ttl = ttl_seconds
        self._cache: dict[str, tuple[float, urllib.robotparser.RobotFileParser | None]] = {}

    async def _load(self, origin: str) -> urllib.robotparser.RobotFileParser | None:
        now = time.time()
        hit = self._cache.get(origin)
        if hit and now - hit[0] < self.ttl:
            return hit[1]

        parser = urllib.robotparser.RobotFileParser()
        parser.set_url(urljoin(origin, "/robots.txt"))
        try:
            async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
                resp = await client.get(urljoin(origin, "/robots.txt"),
                                        headers={"User-Agent": self.user_agent})
            if resp.status_code == 404:
                # No robots.txt is not permission. Our register still has to
                # say the terms permit collection, and it governs either way.
                parser.parse([])
            elif resp.status_code >= 400:
                self._cache[origin] = (now, None)
                return None
            else:
                parser.parse(resp.text.splitlines())
        except Exception as exc:
            log.warning("robots.txt unreadable for %s: %s", origin, exc)
            self._cache[origin] = (now, None)
            return None

        self._cache[origin] = (now, parser)
        return parser

    async def can_fetch(self, url: str) -> bool:
        origin = origin_of(url)
        parser = await self._load(origin)
        if parser is None:
            return False                      # fail closed
        return parser.can_fetch(self.user_agent, url)

    async def crawl_delay(self, url: str) -> float | None:
        parser = await self._load(origin_of(url))
        if parser is None:
            return None
        try:
            delay = parser.crawl_delay(self.user_agent)
        except Exception:
            return None
        return float(delay) if delay else None


def origin_of(url: str) -> str:
    parts = urlparse(url)
    return f"{parts.scheme}://{parts.netloc}"


# ======================================================================
# Polite fetching
# ======================================================================
@dataclass
class FetchStats:
    requests: int = 0
    cache_hits: int = 0
    not_modified: int = 0
    blocked: int = 0
    errors: int = 0
    total_wait_s: float = 0.0


class PoliteFetcher:
    """One fetcher per source. Serialises requests to an origin, honours the
    slower of our rate limit and the site's Crawl-delay, and backs off hard on
    429 or 503."""

    def __init__(
        self,
        registration: SourceRegistration,
        robots: RobotsPolicy | None = None,
        cache_dir: str | Path | None = None,
        jitter: float = 0.35,
    ):
        self.reg = registration
        self.robots = robots or RobotsPolicy()
        self.cache_dir = Path(cache_dir) if cache_dir else None
        if self.cache_dir:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.jitter = jitter
        self.stats = FetchStats()
        self._min_interval = 60.0 / max(registration.rate_limit_per_minute, 1)
        self._last_request = 0.0
        self._lock = asyncio.Lock()
        self._breaker_open_until = 0.0
        self._consecutive_429 = 0

    async def get(self, url: str, params: dict | None = None) -> str | None:
        """Returns page text, or None when the fetch was refused or unchanged."""
        blockers = self.reg.blocking_reasons()
        if blockers:
            self.stats.blocked += 1
            raise PermanentSourceError(
                f"{self.reg.source_id} not collectable: {', '.join(blockers)}")

        if time.monotonic() < self._breaker_open_until:
            raise TransientSourceError(
                f"{self.reg.source_id} circuit breaker open after repeated rate limiting")

        if not await self.robots.can_fetch(url):
            self.stats.blocked += 1
            log.info("robots.txt disallows %s", url)
            return None

        async with self._lock:
            await self._wait_turn(url)
            headers = {"User-Agent": USER_AGENT, "Accept": "text/html,application/json"}
            cached = self._read_cache(url, params)
            if cached and cached.get("etag"):
                headers["If-None-Match"] = cached["etag"]
            if cached and cached.get("last_modified"):
                headers["If-Modified-Since"] = cached["last_modified"]

            try:
                async with httpx.AsyncClient(timeout=25.0, follow_redirects=True) as client:
                    resp = await client.get(url, params=params, headers=headers)
            except httpx.HTTPError as exc:
                self.stats.errors += 1
                raise TransientSourceError(f"{self.reg.source_id}: {exc}") from exc

            self.stats.requests += 1
            self._last_request = time.monotonic()

            if resp.status_code == 304 and cached:
                self.stats.not_modified += 1
                return cached["body"]

            if resp.status_code == 429:
                self._consecutive_429 += 1
                retry_after = float(resp.headers.get("Retry-After", 60))
                if self._consecutive_429 >= 3:
                    self._breaker_open_until = time.monotonic() + max(retry_after, 900)
                    log.warning("%s rate limited three times; pausing the source",
                                self.reg.source_id)
                raise TransientSourceError(
                    f"{self.reg.source_id} rate limited, retry after {retry_after}s")

            if resp.status_code in (403, 401):
                # An access control. We do not work around one.
                raise PermanentSourceError(
                    f"{self.reg.source_id} returned {resp.status_code}: access is "
                    "controlled, so this source is out of scope for collection")

            if resp.status_code in (500, 502, 503, 504):
                raise TransientSourceError(f"{self.reg.source_id} HTTP {resp.status_code}")

            if resp.status_code >= 400:
                raise PermanentSourceError(
                    f"{self.reg.source_id} HTTP {resp.status_code}: {resp.text[:200]}")

            self._consecutive_429 = 0
            self._write_cache(url, params, resp)
            return resp.text

    async def _wait_turn(self, url: str) -> None:
        site_delay = await self.robots.crawl_delay(url)
        interval = max(self._min_interval, site_delay or 0.0)
        elapsed = time.monotonic() - self._last_request
        wait = interval - elapsed
        if wait > 0:
            wait += random.uniform(0, self.jitter)
            self.stats.total_wait_s += wait
            await asyncio.sleep(wait)

    # -- conditional-GET cache ------------------------------------------
    def _cache_path(self, url: str, params: dict | None) -> Path | None:
        if not self.cache_dir:
            return None
        key = hashlib.sha256(
            (url + "|" + json.dumps(params or {}, sort_keys=True)).encode()
        ).hexdigest()[:32]
        return self.cache_dir / f"{key}.json"

    def _read_cache(self, url: str, params: dict | None) -> dict | None:
        path = self._cache_path(url, params)
        if not path or not path.exists():
            return None
        try:
            entry = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
        self.stats.cache_hits += 1
        return entry

    def _write_cache(self, url: str, params: dict | None, resp: httpx.Response) -> None:
        path = self._cache_path(url, params)
        if not path:
            return
        try:
            path.write_text(json.dumps({
                "url": url,
                "fetched_at": datetime.now(timezone.utc).isoformat(),
                "etag": resp.headers.get("ETag"),
                "last_modified": resp.headers.get("Last-Modified"),
                "body": resp.text,
            }), encoding="utf-8")
        except Exception as exc:
            log.debug("cache write failed: %s", exc)


# ======================================================================
# Parsing
# ======================================================================
MONEY_RE = re.compile(
    r"(?:(?P<sym>[₦$£€]|NGN|USD|GBP|EUR)\s*)?"
    r"(?P<num>\d{1,3}(?:[,\s]\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)"
    r"\s*(?P<sym2>NGN|USD|GBP|EUR)?",
    re.IGNORECASE,
)
SYMBOL_TO_CCY = {"₦": "NGN", "$": "USD", "£": "GBP", "€": "EUR"}
DURATION_RE = re.compile(r"(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?", re.IGNORECASE)
STOPS_RE = re.compile(r"(non[\s-]?stop|direct|(\d+)\s*stop)", re.IGNORECASE)


def parse_money(text: str, default_currency: str = "NGN") -> tuple[Decimal, str] | None:
    """Pull an amount and a currency out of a price string.

    Handles the shapes that actually appear on fare pages: ``₦1,022,000``,
    ``NGN 1 022 000``, ``1,022,000 NGN``, ``£612.40``.
    """
    if not text:
        return None
    m = MONEY_RE.search(text.replace("\xa0", " "))
    if not m:
        return None
    raw = m.group("num").replace(",", "").replace(" ", "")
    try:
        amount = Decimal(raw)
    except InvalidOperation:
        return None
    sym = (m.group("sym") or m.group("sym2") or "").strip().upper()
    currency = SYMBOL_TO_CCY.get(sym, sym if len(sym) == 3 else default_currency)
    return amount, currency


def parse_duration_minutes(text: str) -> int | None:
    """``12h 35m`` or ``12 h 35 m`` to 755."""
    if not text:
        return None
    m = DURATION_RE.search(text.replace("\xa0", " "))
    if not m or not any(m.groups()):
        return None
    hours = int(m.group(1) or 0)
    minutes = int(m.group(2) or 0)
    total = hours * 60 + minutes
    return total or None


def parse_stops(text: str) -> int | None:
    if not text:
        return None
    m = STOPS_RE.search(text)
    if not m:
        return None
    if m.group(2):
        return int(m.group(2))
    return 0


def extract_jsonld_offers(html: str) -> list[dict[str, Any]]:
    """Read schema.org Flight/Offer blocks, which many fare pages publish.

    Structured data a site chooses to publish for search engines is by far the
    cleanest thing to read, and reading it is far more stable than scraping
    rendered markup.
    """
    out: list[dict[str, Any]] = []
    for block in re.findall(
        r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html, re.DOTALL | re.IGNORECASE,
    ):
        try:
            payload = json.loads(block.strip())
        except (json.JSONDecodeError, ValueError):
            continue
        for node in _walk_jsonld(payload):
            node_type = node.get("@type")
            types = node_type if isinstance(node_type, list) else [node_type]
            if any(t in ("Flight", "Offer", "AggregateOffer") for t in types if t):
                out.append(node)
    return out


def _walk_jsonld(node: Any) -> Iterable[dict]:
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from _walk_jsonld(value)
    elif isinstance(node, list):
        for item in node:
            yield from _walk_jsonld(item)


# ======================================================================
# The collector
# ======================================================================
class PublicFareCollector(BaseCollector):
    """Permitted-public collector. Registered in COLLECTOR_REGISTRY under its
    own ``source_id``, so the pipeline treats it like any other source and its
    trust score keeps it from ever being the sole basis for a price change."""

    source_tier = SourceTier.PERMITTED_PUBLIC
    legal_basis = LegalBasis.PERMITTED_PUBLIC
    rate_limit_per_minute = 6

    def __init__(
        self,
        collection_run_id: str,
        registration: SourceRegistration,
        seller_id: str,
        credentials: dict | None = None,
        cache_dir: str | Path | None = None,
        robots: RobotsPolicy | None = None,
    ):
        self.source_id = registration.source_id
        self.seller_id = seller_id
        self.reg = registration
        super().__init__(collection_run_id, credentials)
        self.rate_limit_per_minute = registration.rate_limit_per_minute
        self.fetcher = PoliteFetcher(registration, robots=robots, cache_dir=cache_dir)

    def preflight(self, request: ShopRequest) -> bool:
        blockers = self.reg.blocking_reasons(request.pos_country)
        if blockers:
            log.info("preflight blocked %s: %s", self.source_id, ", ".join(blockers))
            return False
        return True

    def build_url(self, request: ShopRequest) -> str:
        """Override per source. The default assumes the site publishes a
        conventional search path; most do not, which is the point of keeping
        this a per-source decision rather than a guess."""
        return (
            f"{self.reg.base_url.rstrip('/')}/flights/"
            f"{request.origin}-{request.destination}/"
            f"{request.departure_date.isoformat()}"
        )

    async def _shop(self, request: ShopRequest) -> list[dict]:
        html = await self.fetcher.get(self.build_url(request))
        if html is None:
            return []
        offers = extract_jsonld_offers(html)
        if offers:
            return [{"_kind": "jsonld", **o} for o in offers]
        return [{"_kind": "html", "html": html}]

    def _parse(self, raw: dict, request: ShopRequest, collected_at: datetime) -> NormalisedOffer:
        if raw.get("_kind") != "jsonld":
            raise PermanentSourceError(
                "No structured data on the page. Write a source-specific parser "
                "rather than guessing at rendered markup."
            )

        price_node = raw.get("offers") or raw
        if isinstance(price_node, list):
            price_node = price_node[0] if price_node else {}

        price_text = str(
            price_node.get("price")
            or price_node.get("lowPrice")
            or raw.get("price")
            or ""
        )
        currency = (price_node.get("priceCurrency")
                    or raw.get("priceCurrency")
                    or request.currency)
        parsed = parse_money(price_text, default_currency=currency)
        if not parsed:
            raise PermanentSourceError(f"No price in structured data: {price_text!r}")
        amount, currency = parsed

        warnings: list[str] = ["PERMITTED_PUBLIC_SOURCE"]
        if not raw.get("provider") and not raw.get("airline"):
            warnings.append("NO_CARRIER_IN_STRUCTURED_DATA")

        carrier = None
        for key in ("airline", "provider", "seller"):
            node = raw.get(key)
            if isinstance(node, dict):
                carrier = node.get("iataCode") or node.get("name")
            elif isinstance(node, str):
                carrier = node
            if carrier:
                break

        ancillaries: list[Ancillary] = []
        for add in raw.get("addOn", []) if isinstance(raw.get("addOn"), list) else []:
            if not isinstance(add, dict):
                continue
            name = str(add.get("name", "")).lower()
            fee_type = (FeeType.BAG_1ST if "bag" in name
                        else FeeType.SEAT_STD if "seat" in name else None)
            got = parse_money(str(add.get("price", "")), default_currency=currency)
            if fee_type and got:
                ancillaries.append(Ancillary(
                    type=fee_type, amount=got[0], currency=got[1],
                    basis=FeeBasis.PER_PAX_PER_ITINERARY,
                ))

        return NormalisedOffer(
            snapshot_id=self._new_snapshot_id(),
            collection_run_id=self.collection_run_id,
            source_id=self.source_id,
            source_tier=self.source_tier,
            collected_at=collected_at,
            legal_basis=self.legal_basis,
            request=request,
            seller_id=self.seller_id,
            seller_type=SellerType.COMPETITOR_OTA,
            quote_currency=currency,
            displayed_total=amount,
            marketing_carrier=carrier,
            stops_count=parse_stops(str(raw.get("description", ""))),
            total_duration_minutes=parse_duration_minutes(str(raw.get("duration", ""))),
            quoted_ancillaries=ancillaries,
            availability_status="AVAILABLE",
            raw_payload={k: v for k, v in raw.items() if k != "html"},
            parse_warnings=warnings,
        )
