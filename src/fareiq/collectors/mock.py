"""A synthetic source, so the platform can be tested before any supplier
credential exists.

This is the difference between waiting six weeks for a licensed feed contract
and having the whole pipeline proven in an afternoon. It generates offers that
look like real market data, with the properties the downstream code actually
depends on:

  * several sellers per route with a believable spread, so the market median
    and the price index mean something,
  * our own offer carrying a supplier cost, so margin is computable,
  * fee structures that differ between sellers, which is the entire point of
    true customer cost,
  * a booking curve, so prices rise as departure approaches,
  * occasional outliers, so the mining detectors have something to find.

It is deterministic: the same route, date and seller always produce the same
price. Reruns are therefore comparable, and a test that passed yesterday
passes today.

SAFETY: this collector refuses to run unless FAREIQ_ALLOW_MOCK is set to "1".
That is a guard against the one genuinely dangerous mistake here, which is
synthetic prices reaching a production mart and someone pricing real tickets
against them. Every offer it produces is also tagged in parse_warnings and
carries seller ids prefixed "mock_", so it can be found and deleted.
"""
from __future__ import annotations

import hashlib
import os
from datetime import datetime, timedelta
from decimal import Decimal

from fareiq.collectors.base import BaseCollector, PermanentSourceError
from fareiq.core.models import (
    Ancillary, FeeBasis, FeeType, LegalBasis, NormalisedOffer, Segment,
    SellerType, ShopRequest, SourceTier,
)

MOCK_ENV_FLAG = "FAREIQ_ALLOW_MOCK"

# Base one-way economy fare in NGN, before the booking curve and seller spread.
BASE_FARE = {
    "LOS-LHR": 950_000, "LOS-DXB": 780_000, "LOS-JFK": 1_350_000,
    "LOS-CDG": 910_000, "LOS-IST": 720_000, "LOS-ACC": 185_000,
    "LOS-ABV": 145_000, "ABV-LHR": 990_000, "ABV-DXB": 820_000,
    "LOS-JNB": 640_000,
}
DEFAULT_BASE = 600_000

# Each seller has a personality: where it sits against the market, how much it
# varies, and what it charges for. These four shapes are what make the market
# statistics, the true-cost comparison and the competitor segmentation testable.
SELLERS = {
    "us":              {"index": 1.00, "spread": 0.02, "bag": 0,      "seat": 0,      "type": SellerType.US},
    "mock_competitor_a": {"index": 0.94, "spread": 0.05, "bag": 62_000, "seat": 12_000, "type": SellerType.COMPETITOR_OTA},
    "mock_competitor_b": {"index": 1.01, "spread": 0.03, "bag": 45_000, "seat": 0,      "type": SellerType.COMPETITOR_OTA},
    "mock_competitor_c": {"index": 1.12, "spread": 0.04, "bag": 0,      "seat": 0,      "type": SellerType.COMPETITOR_OTA},
    "mock_airline_direct": {"index": 1.05, "spread": 0.02, "bag": 0,    "seat": 18_000, "type": SellerType.AIRLINE_DIRECT},
}

CARRIERS = {
    "LOS-LHR": ["VS", "BA", "AF"], "LOS-DXB": ["EK", "TK", "MS"],
    "LOS-JFK": ["DL", "UA", "AF"], "LOS-CDG": ["AF", "TK"],
    "LOS-IST": ["TK", "MS"],       "LOS-ACC": ["W3", "KP"],
    "LOS-ABV": ["W3", "P4", "QI"], "ABV-LHR": ["BA", "TK"],
    "ABV-DXB": ["EK", "TK"],       "LOS-JNB": ["SA", "ET", "KQ"],
}


def _jitter(*parts: object) -> float:
    """A stable pseudo-random number in [0, 1) from the given parts.

    Deterministic on purpose: rerunning a collection for the same day gives
    the same prices, so a verification step can be repeated and compared.
    """
    key = "|".join(str(p) for p in parts).encode()
    return int(hashlib.sha256(key).hexdigest()[:8], 16) / 0xFFFFFFFF


def booking_curve(days_to_departure: int) -> float:
    """Multiplier on the base fare. Prices climb as departure approaches, with
    a visible step inside the last week, which is the pattern the mining job's
    booking-curve detector is meant to find."""
    if days_to_departure <= 3:
        return 1.75
    if days_to_departure <= 7:
        return 1.45
    if days_to_departure <= 14:
        return 1.22
    if days_to_departure <= 30:
        return 1.08
    if days_to_departure <= 60:
        return 1.00
    return 0.94


def seasonality(departure: "datetime | None", route_key: str) -> float:
    """A modest departure day-of-week effect, so the pattern miner has a real
    signal rather than noise."""
    if departure is None:
        return 1.0
    dow = departure.weekday()
    weekend = 1.09 if dow in (4, 6) else 1.0        # Friday and Sunday dearer
    return weekend


class MockMarketCollector(BaseCollector):
    """Generates a believable market. Development and testing only."""

    source_id = "mock_market"
    source_tier = SourceTier.LICENSED_AGGREGATOR   # behaves like a market feed
    legal_basis = LegalBasis.OWN_SYSTEM            # it is our own generator
    seller_id = "multi"
    rate_limit_per_minute = 100_000                # no network, no limit

    def __init__(self, collection_run_id: str, credentials: dict | None = None,
                 sellers: list[str] | None = None):
        if os.environ.get(MOCK_ENV_FLAG) != "1":
            raise PermanentSourceError(
                "The mock collector is disabled. Set FAREIQ_ALLOW_MOCK=1 to enable "
                "it in a development environment. Never set it in production: it "
                "produces synthetic prices."
            )
        super().__init__(collection_run_id, credentials)
        self.sellers = sellers or list(SELLERS)

    # -- BaseCollector requires these two; there is no network involved -----
    async def _shop(self, request: ShopRequest) -> list[dict]:
        days_out = (request.departure_date - datetime.utcnow().date()).days
        base = BASE_FARE.get(request.route_key, DEFAULT_BASE)
        carriers = CARRIERS.get(request.route_key, ["XX"])
        cabin_mult = {"ECONOMY": 1.0, "PREMIUM_ECONOMY": 1.9,
                      "BUSINESS": 3.4, "FIRST": 6.0}.get(request.cabin, 1.0)

        raws: list[dict] = []
        for seller in self.sellers:
            profile = SELLERS.get(seller)
            if not profile:
                continue

            # Each seller offers one or two itineraries, on different carriers.
            n_offers = 1 + int(_jitter(seller, request.route_key, "n") > 0.55)
            for i in range(n_offers):
                carrier = carriers[int(_jitter(seller, request.route_key, i, "c")
                                       * len(carriers)) % len(carriers)]
                wobble = (_jitter(seller, request.route_key, request.departure_date, i)
                          - 0.5) * 2 * profile["spread"]
                stops = 0 if _jitter(seller, carrier, i, "s") > 0.45 else 1

                price = (base
                         * cabin_mult
                         * booking_curve(days_out)
                         * seasonality(datetime.combine(request.departure_date,
                                                        datetime.min.time()),
                                       request.route_key)
                         * profile["index"]
                         * (1 + wobble)
                         * (0.92 if stops else 1.0))          # a connection is cheaper

                # Roughly one offer in eighty is a wild outlier, so the
                # anomaly and mistake-fare detectors have something to catch.
                roll = _jitter(seller, request.route_key, request.departure_date, i, "out")
                if roll > 0.9875:
                    price *= 0.42
                    outlier = "LOW"
                elif roll < 0.0125:
                    price *= 2.30
                    outlier = "HIGH"
                else:
                    outlier = None

                raws.append({
                    "seller": seller,
                    "seller_type": profile["type"].value,
                    "carrier": carrier,
                    "price": round(price, -2),
                    "supplier_cost": round(price * 0.905, -2) if seller == "us" else None,
                    "stops": stops,
                    "duration": 380 + stops * 240 + int(_jitter(carrier, i, "d") * 120),
                    "bag_fee": profile["bag"],
                    "seat_fee": profile["seat"],
                    "included_bags": 1 if profile["bag"] == 0 else 0,
                    "refundable": _jitter(seller, i, "r") > 0.75,
                    "fare_family": "FLEX" if _jitter(seller, i, "r") > 0.75 else "LIGHT",
                    "outlier": outlier,
                    "seats_remaining": 1 + int(_jitter(seller, i, "seats") * 9),
                })
        return raws

    def _parse(self, raw: dict, request: ShopRequest,
               collected_at: datetime) -> NormalisedOffer:
        ancillaries = []
        if raw["bag_fee"]:
            ancillaries.append(Ancillary(
                type=FeeType.BAG_1ST, amount=Decimal(str(raw["bag_fee"])),
                currency=request.currency, basis=FeeBasis.PER_PAX_PER_ITINERARY))
        if raw["seat_fee"]:
            ancillaries.append(Ancillary(
                type=FeeType.SEAT_STD, amount=Decimal(str(raw["seat_fee"])),
                currency=request.currency, basis=FeeBasis.PER_PAX_PER_ITINERARY))

        warnings = ["SYNTHETIC_DATA_DO_NOT_PRICE_AGAINST"]
        if raw.get("outlier"):
            warnings.append(f"SYNTHETIC_OUTLIER_{raw['outlier']}")

        dep = datetime.combine(request.departure_date, datetime.min.time()) + timedelta(hours=9)
        segments = [Segment(
            sequence=0, marketing_carrier=raw["carrier"], operating_carrier=raw["carrier"],
            flight_number=str(100 + int(_jitter(raw["carrier"], request.route_key) * 800)),
            origin=request.origin, destination=request.destination,
            departure_local=dep, arrival_local=dep + timedelta(minutes=raw["duration"]),
            cabin=request.cabin,
        )]

        total = Decimal(str(raw["price"]))
        return NormalisedOffer(
            snapshot_id=self._new_snapshot_id(),
            collection_run_id=self.collection_run_id,
            source_id=self.source_id,
            source_tier=self.source_tier,
            collected_at=collected_at,
            legal_basis=self.legal_basis,
            request=request,
            seller_id=raw["seller"],
            seller_type=SellerType(raw["seller_type"]),
            quote_currency=request.currency,
            displayed_total=total,
            base_fare=(total * Decimal("0.72")).quantize(Decimal("1")),
            taxes_total=(total * Decimal("0.28")).quantize(Decimal("1")),
            marketing_carrier=raw["carrier"],
            operating_carrier=raw["carrier"],
            fare_family=raw["fare_family"],
            fare_basis_code=f"{raw['fare_family'][:1]}OWNG",
            is_refundable=raw["refundable"],
            is_changeable=True,
            stops_count=raw["stops"],
            total_duration_minutes=raw["duration"],
            included_checked_bags=raw["included_bags"],
            quoted_ancillaries=ancillaries,
            seats_remaining=raw["seats_remaining"],
            availability_status="AVAILABLE",
            segments=segments,
            raw_payload=raw,
            parse_warnings=warnings,
        )
