"""True customer cost.

The single most commercially valuable idea in the platform: headline price
is not what the customer pays, and comparing headline prices produces
systematically wrong pricing decisions on routes where fee structures differ.

The Python implementation mirrors the SQL in 02_staging/10_build_fact_offer.sql
exactly. It exists so the logic can be unit tested and so the recommendation
service can recompute a cost without a round trip to BigQuery. The tests in
tests/test_true_cost.py pin the two implementations to the same answers.
"""
from __future__ import annotations

from dataclasses import dataclass

from fareiq.core.config import EngineConfig
from fareiq.core.models import Ancillary, FeeBasis, FeeType


@dataclass
class FeeRule:
    """A resolved catalogue fee, most specific match already chosen."""
    fee_type: FeeType
    amount: float | None
    percent_of_fare: float | None
    basis: FeeBasis
    specificity_rank: int
    was_quoted: bool = False


@dataclass
class CostBreakdown:
    displayed_total: float
    bag_fee: float
    seat_fee: float
    payment_fee: float
    other_fee: float
    change_fee: float
    cancel_fee: float
    flexibility_value: float
    stop_penalty: float
    true_customer_cost: float
    comparable_cost: float
    fee_confidence: float

    def as_dict(self) -> dict[str, float]:
        return self.__dict__.copy()


BAG_TYPES = {FeeType.BAG_1ST, FeeType.BAG_2ND, FeeType.BAG_EXCESS_KG}
SEAT_TYPES = {FeeType.SEAT_STD, FeeType.SEAT_EXTRA_LEG}
PAYMENT_TYPES = {FeeType.PAYMENT_CARD, FeeType.PAYMENT_TRANSFER}


def resolve_fees(
    quoted: list[Ancillary],
    catalogue: list[FeeRule],
    *,
    included_checked_bags: int = 0,
) -> list[FeeRule]:
    """A quoted fee always beats a catalogue fee for the same type.
    A bag the fare already includes is never charged for."""
    resolved: dict[FeeType, FeeRule] = {}

    for rule in sorted(catalogue, key=lambda r: -r.specificity_rank):
        if rule.fee_type is FeeType.BAG_1ST and included_checked_bags >= 1:
            continue
        if rule.fee_type is FeeType.BAG_2ND and included_checked_bags >= 2:
            continue
        resolved.setdefault(rule.fee_type, rule)

    for a in quoted:
        resolved[a.type] = FeeRule(
            fee_type=a.type, amount=float(a.amount), percent_of_fare=None,
            basis=a.basis, specificity_rank=99, was_quoted=True,
        )
    return list(resolved.values())


def _scale(rule: FeeRule, *, pax: int, segments: int) -> float:
    if rule.basis is FeeBasis.PER_PAX_PER_SEGMENT:
        return pax * max(segments, 1)
    if rule.basis is FeeBasis.PER_PAX_PER_ITINERARY:
        return pax
    return 1.0


def compute_true_cost(
    *,
    displayed_total: float,
    fees: list[FeeRule],
    pax: int,
    segments: int,
    stops: int,
    is_refundable: bool,
    config: EngineConfig,
    fare_family_known: bool = True,
    baggage_known: bool = True,
) -> CostBreakdown:
    buckets = {"bag": 0.0, "seat": 0.0, "payment": 0.0, "other": 0.0,
               "change": 0.0, "cancel": 0.0}
    quoted_count = 0

    for rule in fees:
        if rule.amount is not None:
            amount = rule.amount
        elif rule.percent_of_fare is not None:
            amount = rule.percent_of_fare / 100.0 * displayed_total
        else:
            continue
        amount *= _scale(rule, pax=pax, segments=segments)

        if rule.was_quoted:
            quoted_count += 1

        if rule.fee_type in BAG_TYPES:
            buckets["bag"] += amount
        elif rule.fee_type in SEAT_TYPES:
            buckets["seat"] += amount
        elif rule.fee_type in PAYMENT_TYPES:
            buckets["payment"] += amount
        elif rule.fee_type is FeeType.CHANGE:
            buckets["change"] += amount
        elif rule.fee_type is FeeType.CANCEL:
            buckets["cancel"] += amount
        else:
            buckets["other"] += amount

    # Paid up front by the customer.
    true_cost = (displayed_total + buckets["bag"] + buckets["seat"]
                 + buckets["payment"] + buckets["other"])

    # Not paid up front. Valued at the probability of incurring it, so a
    # flexible fare is correctly recognised as worth more than a rigid one.
    flexibility = buckets["change"] * config.change_probability
    if is_refundable:
        flexibility += buckets["cancel"] * config.cancel_probability

    stop_penalty = max(stops - config.baseline_stops, 0) * config.stop_penalty_base
    comparable = true_cost - flexibility + stop_penalty

    total_fee_slots = max(len(fees), 1)
    fee_confidence = (
        0.4 * (quoted_count / total_fee_slots)
        + 0.4 * (1.0 if baggage_known else 0.4)
        + 0.2 * (1.0 if fare_family_known else 0.5)
    )

    return CostBreakdown(
        displayed_total=round(displayed_total, 2),
        bag_fee=round(buckets["bag"], 2),
        seat_fee=round(buckets["seat"], 2),
        payment_fee=round(buckets["payment"], 2),
        other_fee=round(buckets["other"], 2),
        change_fee=round(buckets["change"], 2),
        cancel_fee=round(buckets["cancel"], 2),
        flexibility_value=round(flexibility, 2),
        stop_penalty=round(stop_penalty, 2),
        true_customer_cost=round(true_cost, 2),
        comparable_cost=round(comparable, 2),
        fee_confidence=round(min(max(fee_confidence, 0.0), 1.0), 4),
    )
