"""Canonical domain objects for TVD OTA FareIQ.

Every collector, regardless of source, must emit ``NormalisedOffer``.
Everything downstream, SQL included, is defined in terms of these fields.
Adding a source means writing one adapter, not touching the pipeline.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Any


class SourceTier(str, Enum):
    OWN = "OWN"
    GDS_NDC = "GDS_NDC"
    LICENSED_AGGREGATOR = "LICENSED_AGGREGATOR"
    PERMITTED_PUBLIC = "PERMITTED_PUBLIC"


class SellerType(str, Enum):
    """Who is offering the price, and what it therefore means.

    The distinction that matters commercially: GDS_CHANNEL and NDC_CHANNEL are
    SUPPLY, meaning what a flight costs us through that channel, while
    AIRLINE_DIRECT and COMPETITOR_OTA are DEMAND-side competitors, meaning
    what a customer could pay elsewhere. Mixing the two into one "market
    median" produces a number that means nothing. The market statistics in
    fact_market_snapshot use the competitor types only.
    """
    US = "US"                          # our own selling price
    GDS_CHANNEL = "GDS_CHANNEL"        # Amadeus, Sabre: our cost through a GDS
    NDC_CHANNEL = "NDC_CHANNEL"        # Verteil: our cost through an aggregator
    AIRLINE_DIRECT = "AIRLINE_DIRECT"  # what the carrier sells to the customer
    COMPETITOR_OTA = "COMPETITOR_OTA"  # what a rival OTA sells to the customer
    METASEARCH = "METASEARCH"


class LegalBasis(str, Enum):
    CONTRACT_API = "CONTRACT_API"
    LICENSED_FEED = "LICENSED_FEED"
    OWN_SYSTEM = "OWN_SYSTEM"
    PERMITTED_PUBLIC = "PERMITTED_PUBLIC"


class FeeType(str, Enum):
    BAG_1ST = "BAG_1ST"
    BAG_2ND = "BAG_2ND"
    BAG_EXCESS_KG = "BAG_EXCESS_KG"
    SEAT_STD = "SEAT_STD"
    SEAT_EXTRA_LEG = "SEAT_EXTRA_LEG"
    PAYMENT_CARD = "PAYMENT_CARD"
    PAYMENT_TRANSFER = "PAYMENT_TRANSFER"
    CHANGE = "CHANGE"
    CANCEL = "CANCEL"
    NO_SHOW = "NO_SHOW"
    INFANT = "INFANT"


class FeeBasis(str, Enum):
    PER_PAX_PER_SEGMENT = "PER_PAX_PER_SEGMENT"
    PER_PAX_PER_ITINERARY = "PER_PAX_PER_ITINERARY"
    PER_KG = "PER_KG"
    PERCENT_OF_TOTAL = "PERCENT_OF_TOTAL"
    FLAT = "FLAT"


class Classification(str, Enum):
    COMPETITIVE = "COMPETITIVE"
    WATCH = "WATCH"
    UNCOMPETITIVE = "UNCOMPETITIVE"
    MARGIN_OPPORTUNITY = "MARGIN_OPPORTUNITY"
    PROTECTED = "PROTECTED"          # floor binding, do not chase


class Action(str, Enum):
    HOLD = "HOLD"
    INCREASE = "INCREASE"
    DECREASE = "DECREASE"
    INVESTIGATE = "INVESTIGATE"      # data says something odd, do not act blind
    ESCALATE = "ESCALATE"            # needs a commercial decision above the analyst


@dataclass(frozen=True)
class ShopRequest:
    """One shopping query. The unit of collection work."""
    origin: str
    destination: str
    departure_date: date
    cabin: str
    pos_country: str
    currency: str
    trip_type: str = "ONE_WAY"
    return_date: date | None = None
    adults: int = 1
    children: int = 0
    infants: int = 0

    @property
    def route_key(self) -> str:
        return f"{self.origin}-{self.destination}"

    @property
    def paying_pax(self) -> int:
        return self.adults + self.children


@dataclass
class Segment:
    sequence: int
    marketing_carrier: str
    operating_carrier: str | None
    flight_number: str
    origin: str
    destination: str
    departure_local: datetime
    arrival_local: datetime
    aircraft: str | None = None
    booking_class: str | None = None
    cabin: str | None = None


@dataclass
class Ancillary:
    type: FeeType
    amount: Decimal
    currency: str
    basis: FeeBasis = FeeBasis.PER_PAX_PER_ITINERARY


@dataclass
class NormalisedOffer:
    """The contract every collector satisfies."""
    snapshot_id: str
    collection_run_id: str
    source_id: str
    source_tier: SourceTier
    collected_at: datetime
    legal_basis: LegalBasis

    request: ShopRequest
    seller_id: str
    seller_type: SellerType

    quote_currency: str
    displayed_total: Decimal

    offer_ref: str | None = None
    marketing_carrier: str | None = None
    operating_carrier: str | None = None
    fare_basis_code: str | None = None
    fare_family: str | None = None
    booking_class: str | None = None
    is_refundable: bool | None = None
    is_changeable: bool | None = None
    stops_count: int | None = None
    total_duration_minutes: int | None = None
    segments: list[Segment] = field(default_factory=list)

    base_fare: Decimal | None = None
    taxes_total: Decimal | None = None
    carrier_surcharges: Decimal | None = None
    tax_breakdown: list[dict[str, Any]] = field(default_factory=list)

    included_checked_bags: int | None = None
    included_cabin_bags: int | None = None
    quoted_ancillaries: list[Ancillary] = field(default_factory=list)

    seats_remaining: int | None = None
    availability_status: str = "AVAILABLE"
    gcs_uri: str | None = None
    raw_payload: dict[str, Any] | None = None
    parse_warnings: list[str] = field(default_factory=list)

    def to_bq_row(self) -> dict[str, Any]:
        """Flatten to the tvd_fareiq_raw.offer_snapshot schema."""
        r = self.request
        return {
            "snapshot_id": self.snapshot_id,
            "collection_run_id": self.collection_run_id,
            "source_id": self.source_id,
            "source_tier": self.source_tier.value,
            "collected_at": self.collected_at.isoformat(),
            "gcs_uri": self.gcs_uri,
            "request_origin": r.origin,
            "request_destination": r.destination,
            "request_departure_date": r.departure_date.isoformat(),
            "request_return_date": r.return_date.isoformat() if r.return_date else None,
            "request_trip_type": r.trip_type,
            "request_cabin": r.cabin,
            "request_pax_adults": r.adults,
            "request_pax_children": r.children,
            "request_pax_infants": r.infants,
            "request_pos_country": r.pos_country,
            "request_currency": r.currency,
            "seller_type": self.seller_type.value,
            "seller_id": self.seller_id,
            "offer_ref": self.offer_ref,
            "marketing_carrier": self.marketing_carrier,
            "operating_carrier": self.operating_carrier,
            "fare_basis_code": self.fare_basis_code,
            "fare_family": self.fare_family,
            "booking_class": self.booking_class,
            "is_refundable": self.is_refundable,
            "is_changeable": self.is_changeable,
            "stops_count": self.stops_count,
            "total_duration_minutes": self.total_duration_minutes,
            "segments": [asdict(s) | {
                "departure_local": s.departure_local.isoformat(),
                "arrival_local": s.arrival_local.isoformat(),
            } for s in self.segments],
            "quote_currency": self.quote_currency,
            "base_fare": str(self.base_fare) if self.base_fare is not None else None,
            "taxes_total": str(self.taxes_total) if self.taxes_total is not None else None,
            "carrier_surcharges": str(self.carrier_surcharges) if self.carrier_surcharges is not None else None,
            "displayed_total": str(self.displayed_total),
            "tax_breakdown": self.tax_breakdown,
            "included_checked_bags": self.included_checked_bags,
            "included_cabin_bags": self.included_cabin_bags,
            "quoted_ancillaries": [
                {"type": a.type.value, "amount": str(a.amount),
                 "currency": a.currency, "basis": a.basis.value}
                for a in self.quoted_ancillaries
            ],
            "seats_remaining": self.seats_remaining,
            "availability_status": self.availability_status,
            "legal_basis": self.legal_basis.value,
            "raw_payload": self.raw_payload,
            "parse_warnings": self.parse_warnings,
        }


@dataclass
class MarketCell:
    """A priced market cell: the input to the pricing engine."""
    market_sk: str
    route_key: str
    departure_date: date
    cabin: str
    trip_type: str
    pos_country: str
    days_to_departure: int
    marketing_carrier: str | None

    competitor_sellers: int
    coverage_score: float
    cheapest_competitor_id: str | None
    cheapest_competitor_price: float | None
    second_cheapest_price: float | None
    market_median: float | None
    market_p25: float | None
    market_weighted_mean: float | None
    market_dispersion: float | None

    our_price: float | None
    our_true_cost: float | None
    our_comparable_cost: float | None
    our_market_rank: int | None
    supplier_cost: float | None

    median_change_7d_pct: float | None = None
    cheapest_change_1d_pct: float | None = None
    fee_confidence: float = 1.0
    data_freshness_hours: float = 0.0
    our_bag_fee: float = 0.0
    cheapest_competitor_bag_fee: float = 0.0
