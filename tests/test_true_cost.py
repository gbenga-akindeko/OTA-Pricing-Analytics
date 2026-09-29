"""True customer cost tests.

The worked example in the design document is pinned here. If the numbers in
the document and the numbers in the code ever disagree, this test fails.
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from fareiq.core.config import EngineConfig
from fareiq.core.models import Ancillary, FeeBasis, FeeType
from fareiq.engine.true_cost import FeeRule, compute_true_cost, resolve_fees

CFG = EngineConfig()


def test_included_bag_is_not_charged_for():
    catalogue = [FeeRule(FeeType.BAG_1ST, 60_000.0, None, FeeBasis.PER_PAX_PER_ITINERARY, 1)]
    fees = resolve_fees([], catalogue, included_checked_bags=1)
    assert all(f.fee_type is not FeeType.BAG_1ST for f in fees)


def test_quoted_fee_beats_catalogue_fee():
    catalogue = [FeeRule(FeeType.BAG_1ST, 60_000.0, None, FeeBasis.PER_PAX_PER_ITINERARY, 3)]
    quoted = [Ancillary(FeeType.BAG_1ST, Decimal("45000"), "NGN", FeeBasis.PER_PAX_PER_ITINERARY)]
    fees = resolve_fees(quoted, catalogue, included_checked_bags=0)
    bag = next(f for f in fees if f.fee_type is FeeType.BAG_1ST)
    assert bag.amount == 45_000.0
    assert bag.was_quoted is True


def test_more_specific_catalogue_rule_wins():
    catalogue = [
        FeeRule(FeeType.SEAT_STD, 10_000.0, None, FeeBasis.PER_PAX_PER_SEGMENT, 1),   # GLOBAL
        FeeRule(FeeType.SEAT_STD, 4_000.0, None, FeeBasis.PER_PAX_PER_SEGMENT, 3),    # ROUTE
    ]
    fees = resolve_fees([], catalogue)
    assert next(f for f in fees if f.fee_type is FeeType.SEAT_STD).amount == 4_000.0


def test_per_segment_basis_scales_by_pax_and_segments():
    fees = [FeeRule(FeeType.SEAT_STD, 5_000.0, None, FeeBasis.PER_PAX_PER_SEGMENT, 1)]
    out = compute_true_cost(displayed_total=500_000, fees=fees, pax=2, segments=3,
                            stops=0, is_refundable=False, config=CFG)
    assert out.seat_fee == 30_000.0        # 5,000 x 2 pax x 3 segments


def test_percent_of_fare_payment_fee():
    fees = [FeeRule(FeeType.PAYMENT_CARD, None, 1.5, FeeBasis.FLAT, 1)]
    out = compute_true_cost(displayed_total=1_000_000, fees=fees, pax=1, segments=1,
                            stops=0, is_refundable=False, config=CFG)
    assert out.payment_fee == 15_000.0


def test_the_headline_cheaper_offer_is_not_actually_cheaper():
    """The scenario the whole platform exists to catch.

    Competitor: headline 950,000, charges 60,000 for a bag and 12,000 seat.
    Us:         headline 1,000,000, bag and seat included.
    On headline we look 50,000 dearer. All in, we are 22,000 cheaper.
    """
    competitor = compute_true_cost(
        displayed_total=950_000,
        fees=[
            FeeRule(FeeType.BAG_1ST, 60_000.0, None, FeeBasis.PER_PAX_PER_ITINERARY, 1),
            FeeRule(FeeType.SEAT_STD, 12_000.0, None, FeeBasis.PER_PAX_PER_ITINERARY, 1),
        ],
        pax=1, segments=1, stops=0, is_refundable=False, config=CFG)

    ours = compute_true_cost(
        displayed_total=1_000_000, fees=[], pax=1, segments=1, stops=0,
        is_refundable=False, config=CFG)

    assert competitor.displayed_total < ours.displayed_total          # headline says they win
    assert competitor.true_customer_cost == 1_022_000
    assert ours.true_customer_cost == 1_000_000
    assert ours.true_customer_cost < competitor.true_customer_cost    # all in, we win
    assert competitor.true_customer_cost - ours.true_customer_cost == 22_000


def test_flexibility_is_valued_not_ignored():
    rigid = compute_true_cost(
        displayed_total=1_000_000,
        fees=[FeeRule(FeeType.CHANGE, 100_000.0, None, FeeBasis.PER_PAX_PER_ITINERARY, 1)],
        pax=1, segments=1, stops=0, is_refundable=False, config=CFG)
    # A change fee is not paid up front, so it does not raise true cost,
    # but it does raise the comparable cost by its expected value.
    assert rigid.true_customer_cost == 1_000_000
    assert rigid.flexibility_value == pytest.approx(100_000 * CFG.change_probability)
    assert rigid.comparable_cost == pytest.approx(1_000_000 - 8_000)


def test_a_connection_costs_the_traveller_something():
    direct = compute_true_cost(displayed_total=1_000_000, fees=[], pax=1, segments=1,
                               stops=0, is_refundable=False, config=CFG)
    one_stop = compute_true_cost(displayed_total=1_000_000, fees=[], pax=1, segments=2,
                                 stops=1, is_refundable=False, config=CFG)
    assert one_stop.comparable_cost > direct.comparable_cost
    assert one_stop.comparable_cost - direct.comparable_cost == CFG.stop_penalty_base


def test_fee_confidence_drops_when_nothing_was_quoted():
    quoted_all = compute_true_cost(
        displayed_total=1_000_000,
        fees=[FeeRule(FeeType.BAG_1ST, 50_000.0, None, FeeBasis.PER_PAX_PER_ITINERARY, 9, was_quoted=True)],
        pax=1, segments=1, stops=0, is_refundable=False, config=CFG,
        fare_family_known=True, baggage_known=True)
    imputed = compute_true_cost(
        displayed_total=1_000_000,
        fees=[FeeRule(FeeType.BAG_1ST, 50_000.0, None, FeeBasis.PER_PAX_PER_ITINERARY, 1, was_quoted=False)],
        pax=1, segments=1, stops=0, is_refundable=False, config=CFG,
        fare_family_known=False, baggage_known=False)
    assert quoted_all.fee_confidence > imputed.fee_confidence
