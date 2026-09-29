"""Tests for the service charge and price advantage engine.

These encode commercial rules rather than code paths. If one fails, a pricing
policy has changed and somebody should have to say so out loud.
"""
from __future__ import annotations

import pytest

from fareiq.engine.service_charge import (
    Channel, CostModel, FareOption, PaymentMethod, Reference, ReferenceKind,
    ServiceChargeEngine, binding_reference, build_reference_ladder,
    cheapest_payment_method, choose_cheapest_source, infer_competitor_price,
)

ENGINE = ServiceChargeEngine()


def option(**over) -> FareOption:
    base = dict(channel=Channel.AMADEUS, net_fare=700_000.0, taxes=250_000.0,
                segments=2, included_bags=1)
    base.update(over)
    return FareOption(**base)


# ------------------------------------------------------------ break-even
def test_break_even_covers_every_cost_line():
    o = option()
    be = ENGINE.break_even(o, PaymentMethod.CARD_LOCAL)
    q = ENGINE.quote(o, payment_method=PaymentMethod.CARD_LOCAL)
    # At break-even the charge must at least cover ops plus payment, net of
    # whatever the channel pays us back.
    assert be >= q.ops_cost + q.payment_cost + q.channel_cost - 1


def test_a_channel_that_pays_us_lowers_the_break_even():
    """A GDS segment incentive is income, not a cost. It must move the
    break-even down, and it must keep moving it down past zero, or two
    channels with very different economics compare as equal."""
    from fareiq.engine.service_charge import ChannelEconomics
    engine = ServiceChargeEngine(CostModel(channels={
        Channel.AMADEUS: ChannelEconomics(Channel.AMADEUS, segment_fee=-4_000.0,
                                          incentive_pct=0.01),
        Channel.NDC_DIRECT: ChannelEconomics(Channel.NDC_DIRECT, commission_pct=0.0),
    }))
    gds = engine.break_even(option(channel=Channel.AMADEUS), PaymentMethod.TRANSFER)
    ndc = engine.break_even(option(channel=Channel.NDC_DIRECT), PaymentMethod.TRANSFER)
    assert gds < ndc
    assert gds < 0          # this channel pays for the booking by itself


def test_a_negative_break_even_still_publishes_the_minimum_charge():
    """Knowing a channel pays for itself is not a reason to sell at cost."""
    from fareiq.engine.service_charge import ChannelEconomics
    engine = ServiceChargeEngine(CostModel(channels={
        Channel.AMADEUS: ChannelEconomics(Channel.AMADEUS, segment_fee=-9_000.0,
                                          incentive_pct=0.02),
    }))
    q = engine.quote(option(), payment_method=PaymentMethod.TRANSFER)
    assert q.break_even_charge < 0
    assert q.service_charge >= engine.min_service_charge - engine.rounding_step


def test_quote_never_sells_below_cost():
    q = ENGINE.quote(option(), payment_method=PaymentMethod.CARD_INTERNATIONAL)
    assert q.gross_margin > 0
    assert q.service_charge >= q.break_even_charge - ENGINE.rounding_step


def test_minimum_charge_protects_a_cheap_domestic_fare():
    """A percentage target on a small fare yields pennies. The absolute floor
    is what makes a Lagos to Abuja booking worth servicing."""
    q = ENGINE.quote(option(net_fare=90_000, taxes=35_000, segments=1),
                     payment_method=PaymentMethod.TRANSFER)
    assert q.service_charge >= ENGINE.min_service_charge - ENGINE.rounding_step
    assert q.binding_constraint in ("MINIMUM_CHARGE", "BREAK_EVEN", "TARGET_MARGIN")


# ------------------------------------------------------ reference ladder
def test_an_observed_competitor_outranks_an_inferred_one_even_when_dearer():
    """We do not chase a number nobody has seen."""
    observed = Reference(ReferenceKind.OBSERVED_COMPETITOR, 1_050_000, seller="competitor_a")
    inferred = Reference(ReferenceKind.GDS_LOWEST_PLUS_MARKUP, 980_000)
    assert binding_reference([observed, inferred]) is observed


def test_airline_direct_beats_an_inference():
    direct = Reference(ReferenceKind.AIRLINE_DIRECT, 1_040_000, seller="VS")
    inferred = Reference(ReferenceKind.GDS_LOWEST_PLUS_MARKUP, 990_000)
    assert binding_reference([direct, inferred]) is direct


def test_within_one_confidence_tier_the_cheapest_binds():
    a = Reference(ReferenceKind.OBSERVED_COMPETITOR, 1_050_000, seller="a")
    b = Reference(ReferenceKind.OBSERVED_COMPETITOR, 1_010_000, seller="b")
    assert binding_reference([a, b]) is b


def test_no_references_gives_no_binding_reference():
    assert binding_reference([]) is None
    assert binding_reference([Reference(ReferenceKind.AIRLINE_DIRECT, 0)]) is None


def test_inference_is_labelled_as_an_inference_and_carries_low_confidence():
    ref = infer_competitor_price(900_000)
    assert ref.kind is ReferenceKind.GDS_LOWEST_PLUS_MARKUP
    assert ref.confidence < 0.6
    assert "not an observed competitor price" in ref.note.lower()
    assert ref.all_in > 900_000          # grossed up by markup and payment


def test_ladder_orders_by_confidence_then_price():
    refs = build_reference_ladder([
        Reference(ReferenceKind.HISTORICAL_OWN, 900_000),
        Reference(ReferenceKind.OBSERVED_COMPETITOR, 1_100_000),
        Reference(ReferenceKind.AIRLINE_DIRECT, 1_000_000),
    ])
    assert [r.kind for r in refs] == [
        ReferenceKind.OBSERVED_COMPETITOR,
        ReferenceKind.AIRLINE_DIRECT,
        ReferenceKind.HISTORICAL_OWN,
    ]


# ------------------------------------------------------ beating the market
def test_we_price_visibly_under_the_reference_not_level_with_it():
    ref = Reference(ReferenceKind.OBSERVED_COMPETITOR, 1_100_000, seller="competitor_a")
    q = ENGINE.quote(option(), references=[ref])
    assert q.selling_price < ref.all_in
    assert q.advantage_abs > 0
    # A tie is not an advantage: a competitor repricing by one naira erases it.
    assert q.advantage_pct >= ENGINE.victory_margin_pct * 0.9


def test_the_ceiling_binds_when_the_market_is_tight():
    ref = Reference(ReferenceKind.OBSERVED_COMPETITOR, 985_000, seller="competitor_a")
    q = ENGINE.quote(option(), references=[ref])
    assert q.binding_constraint == "COMPETITIVE_CEILING"
    assert q.service_charge < q.target_charge


def test_a_generous_market_lets_the_target_margin_bind_instead():
    ref = Reference(ReferenceKind.OBSERVED_COMPETITOR, 1_400_000, seller="competitor_c")
    q = ENGINE.quote(option(), references=[ref])
    assert q.binding_constraint == "TARGET_MARGIN"
    assert q.selling_price < ref.all_in


def test_bundled_baggage_lets_us_hold_a_higher_shelf_price():
    """We include a bag the competitor charges 60,000 for. Part of the gap on
    the screen is not a real gap, and that difference is margin."""
    ref = Reference(ReferenceKind.OBSERVED_COMPETITOR, 1_000_000, seller="competitor_a")
    plain = ENGINE.quote(option(), references=[ref])
    bundled = ENGINE.quote(option(), references=[ref], fee_advantage=60_000)
    assert bundled.service_charge > plain.service_charge
    assert bundled.selling_price > plain.selling_price
    # Still cheaper all in, which is what the customer actually pays.
    assert bundled.selling_price - 60_000 < ref.all_in


def test_when_we_cannot_both_cover_cost_and_win_the_engine_says_so():
    """The honest failure mode. The answer is a better net fare, not a thinner
    markup, and the note must say that rather than quietly selling at a loss."""
    ref = Reference(ReferenceKind.OBSERVED_COMPETITOR, 900_000, seller="competitor_a")
    q = ENGINE.quote(option(net_fare=700_000, taxes=250_000), references=[ref])
    assert q.selling_price > ref.all_in            # we lose this one
    assert q.gross_margin > 0                      # but we did not sell below cost
    assert any("net fare" in n for n in q.notes)


def test_confidence_follows_the_reference_that_bound():
    strong = ENGINE.quote(option(), references=[
        Reference(ReferenceKind.OBSERVED_COMPETITOR, 1_200_000)])
    weak = ENGINE.quote(option(), references=[infer_competitor_price(900_000)])
    assert strong.confidence > weak.confidence
    assert weak.confidence < 0.6


def test_no_reference_at_all_gives_low_confidence():
    q = ENGINE.quote(option())
    assert q.reference is None
    assert q.confidence <= 0.25
    assert q.binding_constraint == "TARGET_MARGIN"


# ------------------------------------------------------ source arbitrage
def test_the_cheapest_landed_channel_wins_not_the_cheapest_headline():
    """NDC shows the lower net fare, but the GDS pays a segment incentive that
    more than closes the gap. Ranking on headline net alone would hand that
    income away on every booking."""
    from fareiq.engine.service_charge import ChannelEconomics
    engine = ServiceChargeEngine(CostModel(channels={
        Channel.AMADEUS: ChannelEconomics(Channel.AMADEUS, segment_fee=-4_000.0,
                                          incentive_pct=0.01),
        Channel.NDC_DIRECT: ChannelEconomics(Channel.NDC_DIRECT, commission_pct=0.0),
    }))
    options = [
        FareOption(Channel.AMADEUS, net_fare=700_000, taxes=250_000, segments=2),
        FareOption(Channel.NDC_DIRECT, net_fare=690_000, taxes=250_000, segments=2),
    ]
    result = choose_cheapest_source(engine, options)
    # NDC is 10,000 cheaper on net; Amadeus returns 8,000 in segment incentive
    # plus 7,000 in accrual, so it lands cheaper overall.
    assert result.best.option.channel is Channel.AMADEUS


def test_a_genuinely_cheaper_ndc_fare_is_taken():
    options = [
        FareOption(Channel.AMADEUS, net_fare=700_000, taxes=250_000, segments=2),
        FareOption(Channel.VERTEIL, net_fare=640_000, taxes=250_000, segments=2),
    ]
    result = choose_cheapest_source(ENGINE, options)
    assert result.best.option.channel is Channel.VERTEIL
    assert result.saving_against_worst > 50_000
    assert "no change to the price the customer sees" in result.rationale


def test_arbitrage_reports_every_channel_it_considered():
    options = [
        FareOption(Channel.AMADEUS, net_fare=700_000, taxes=250_000),
        FareOption(Channel.SABRE, net_fare=705_000, taxes=250_000),
        FareOption(Channel.NDC_DIRECT, net_fare=680_000, taxes=250_000),
        FareOption(Channel.VERTEIL, net_fare=690_000, taxes=250_000),
    ]
    result = choose_cheapest_source(ENGINE, options)
    assert len(result.all_quotes) == 4


def test_a_private_fare_is_flagged_as_a_real_advantage():
    q = ENGINE.quote(option(channel=Channel.CONSOLIDATOR, net_fare=640_000,
                            private_fare=True))
    assert any("not available to competitors" in n for n in q.notes)


def test_arbitrage_on_an_empty_list_returns_nothing():
    assert choose_cheapest_source(ENGINE, []) is None


# ------------------------------------------------------ payment steering
def test_transfer_beats_cards_and_the_spread_is_material():
    method, spread = cheapest_payment_method(ENGINE, option())
    assert method is PaymentMethod.TRANSFER
    # On a roughly one million naira ticket, an international card costs tens
    # of thousands more than a transfer. That exceeds the margin on many
    # bookings, which is why payment routing is a pricing decision.
    assert spread > 20_000


def test_payment_cost_is_charged_on_the_total_including_the_service_charge():
    q = ENGINE.quote(option(), payment_method=PaymentMethod.CARD_INTERNATIONAL)
    expected = q.selling_price * 0.039
    assert q.payment_cost == pytest.approx(expected, rel=0.02)


def test_an_expensive_payment_method_raises_the_break_even():
    cheap = ENGINE.break_even(option(), PaymentMethod.TRANSFER)
    dear = ENGINE.break_even(option(), PaymentMethod.CARD_INTERNATIONAL)
    assert dear > cheap * 3


# ------------------------------------------------------ configuration
def test_channel_economics_are_configurable_not_hardcoded():
    """Every number in the default model is a placeholder. Swapping in a real
    contract must change the answer."""
    from fareiq.engine.service_charge import ChannelEconomics
    custom = CostModel(channels={
        Channel.AMADEUS: ChannelEconomics(Channel.AMADEUS, segment_fee=2_000.0),
    }, ops_cost_per_booking=5_000.0)
    engine = ServiceChargeEngine(custom)
    assert engine.break_even(option(), PaymentMethod.TRANSFER) > \
           ENGINE.break_even(option(), PaymentMethod.TRANSFER)


def test_max_charge_cap_stops_runaway_markup_on_a_captive_route():
    engine = ServiceChargeEngine(max_service_charge_pct=0.05)
    q = engine.quote(option(), references=[
        Reference(ReferenceKind.OBSERVED_COMPETITOR, 3_000_000)])
    assert q.binding_constraint == "MAX_CHARGE_CAP"
    assert q.service_charge <= option().supplier_payable * 0.05 + engine.rounding_step
