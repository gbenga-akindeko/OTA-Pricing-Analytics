"""Tests for the pricing engine.

These encode the commercial rules, not just the code paths. If a test here
fails, a business rule has changed and someone should have to say so out loud.
"""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from fareiq.core.config import DEFAULT_POLICY, EngineConfig, PolicyResolver, PricingRule
from fareiq.core.models import Action, Classification, MarketCell
from fareiq.engine.pricing import PricingEngine

CFG = EngineConfig()
ENGINE = PricingEngine(CFG)
DEP = date.today() + timedelta(days=30)


def cell(**over) -> MarketCell:
    base = dict(
        market_sk="sk1", route_key="LOS-LHR", departure_date=DEP, cabin="ECONOMY",
        trip_type="ONE_WAY", pos_country="NG", days_to_departure=30,
        marketing_carrier="VS",
        competitor_sellers=5, coverage_score=1.0,
        cheapest_competitor_id="competitor_a", cheapest_competitor_price=900_000.0,
        second_cheapest_price=950_000.0,
        market_median=1_000_000.0, market_p25=940_000.0,
        market_weighted_mean=1_010_000.0, market_dispersion=0.10,
        our_price=1_050_000.0, our_true_cost=1_050_000.0, our_comparable_cost=1_050_000.0,
        our_market_rank=4, supplier_cost=900_000.0,
        median_change_7d_pct=0.0, cheapest_change_1d_pct=0.0,
        fee_confidence=0.9, data_freshness_hours=1.0,
    )
    base.update(over)
    return MarketCell(**base)


# ------------------------------------------------------------------ floors
def test_minimum_price_takes_the_higher_of_the_two_floors():
    c = cell(supplier_cost=100_000.0)
    minimum = ENGINE.minimum_price(c, DEFAULT_POLICY)
    by_pct = 100_000 / (1 - DEFAULT_POLICY.min_margin_pct)
    by_abs = 100_000 + DEFAULT_POLICY.min_markup_abs
    assert minimum == pytest.approx(max(by_pct, by_abs))


def test_absolute_floor_binds_on_a_cheap_domestic_fare():
    """3.5% of a 30,000 naira net fare is about 1,090 naira, which does not
    cover the cost of servicing the booking. The absolute floor must win."""
    c = cell(supplier_cost=30_000.0)
    minimum = ENGINE.minimum_price(c, DEFAULT_POLICY)
    assert minimum == pytest.approx(30_000 + DEFAULT_POLICY.min_markup_abs)
    assert minimum > 30_000 / (1 - DEFAULT_POLICY.min_margin_pct)


def test_engine_never_recommends_below_the_floor():
    """The scenario that matters: a competitor priced under our cost."""
    c = cell(cheapest_competitor_price=880_000.0, second_cheapest_price=890_000.0,
             market_median=890_000.0, market_p25=885_000.0, supplier_cost=900_000.0)
    rec = ENGINE.recommend(c, DEFAULT_POLICY, expected_units=10)
    assert rec.recommended_price >= rec.minimum_price
    assert rec.recommended_price > c.supplier_cost
    assert "FLOOR_BINDING" in rec.guardrails_triggered


def test_at_floor_and_uncompetitive_is_protected_and_escalates_not_cut():
    c = cell(our_price=935_000.0, our_comparable_cost=935_000.0,
             supplier_cost=900_000.0, market_median=820_000.0,
             cheapest_competitor_price=800_000.0, second_cheapest_price=810_000.0,
             market_p25=805_000.0)
    rec = ENGINE.recommend(c, DEFAULT_POLICY, expected_units=10)
    assert rec.classification is Classification.PROTECTED
    assert rec.action is Action.ESCALATE
    assert rec.recommended_price == c.our_price


# ------------------------------------------------- do not chase blindly
def test_thin_panel_blocks_action():
    c = cell(competitor_sellers=1, coverage_score=0.2)
    rec = ENGINE.recommend(c, DEFAULT_POLICY, expected_units=10)
    assert rec.action is Action.INVESTIGATE
    assert "THIN_PANEL" in rec.reason_codes
    assert rec.recommended_price == c.our_price


def test_outlier_cheapest_competitor_is_ignored():
    """One competitor 40% below the rest is an error or a different product."""
    c = cell(cheapest_competitor_price=600_000.0, second_cheapest_price=980_000.0)
    rec = ENGINE.recommend(c, DEFAULT_POLICY, expected_units=10)
    assert "OUTLIER_CHEAPEST_IGNORED" in rec.reason_codes
    assert rec.action is Action.INVESTIGATE


def test_stale_data_blocks_action():
    c = cell(data_freshness_hours=CFG.max_data_age_hours + 1)
    rec = ENGINE.recommend(c, DEFAULT_POLICY, expected_units=10)
    assert "STALE_DATA" in rec.reason_codes


# ------------------------------------------------------------- fee logic
def test_our_bag_inclusion_lets_us_hold_a_higher_headline_price():
    """We include a bag; the cheapest competitor charges 60,000 for one.
    Part of the headline gap is not a real gap, and the engine must see that."""
    without = ENGINE.recommend(cell(), DEFAULT_POLICY, expected_units=10)
    with_adv = ENGINE.recommend(
        cell(our_bag_fee=0.0, cheapest_competitor_bag_fee=60_000.0),
        DEFAULT_POLICY, expected_units=10)
    assert with_adv.target_price > without.target_price
    assert "FEE_ADVANTAGE" in with_adv.reason_codes


def test_fee_disadvantage_is_fully_absorbed():
    rec = ENGINE.recommend(
        cell(our_bag_fee=50_000.0, cheapest_competitor_bag_fee=0.0),
        DEFAULT_POLICY, expected_units=10)
    assert "FEE_DISADVANTAGE" in rec.reason_codes


# --------------------------------------------------------- classification
@pytest.mark.parametrize("our_cost,expected", [
    (1_000_000.0, Classification.COMPETITIVE),      # index 1.00
    (1_060_000.0, Classification.WATCH),            # index 1.06
    (1_150_000.0, Classification.UNCOMPETITIVE),    # index 1.15
    (900_000.0,   Classification.MARGIN_OPPORTUNITY),  # index 0.90
])
def test_classification_bands(our_cost, expected):
    c = cell(our_price=our_cost, our_comparable_cost=our_cost, supplier_cost=700_000.0)
    cls, _ = ENGINE.classify(c, ENGINE.minimum_price(c, DEFAULT_POLICY), DEFAULT_POLICY)
    assert cls is expected


def test_margin_opportunity_produces_an_increase():
    c = cell(our_price=880_000.0, our_comparable_cost=880_000.0, supplier_cost=780_000.0)
    rec = ENGINE.recommend(c, DEFAULT_POLICY, expected_units=20)
    assert rec.classification is Classification.MARGIN_OPPORTUNITY
    assert rec.action is Action.INCREASE
    assert rec.recommended_price > c.our_price
    assert rec.expected_margin_impact > 0


def test_markup_ceiling_blocks_an_increase_we_are_not_entitled_to():
    """We are 12% below market, but already at a 25.7% markup. The ceiling
    binds, and the engine holds rather than pushing markup further."""
    c = cell(our_price=880_000.0, our_comparable_cost=880_000.0, supplier_cost=700_000.0)
    rec = ENGINE.recommend(c, DEFAULT_POLICY, expected_units=20)
    assert rec.classification is Classification.MARGIN_OPPORTUNITY
    assert "MARKUP_CEILING_BINDING" in rec.reason_codes
    assert rec.action is Action.HOLD


# ------------------------------------------------------------ constraints
def test_daily_move_cap_binds():
    c = cell(our_price=2_000_000.0, our_comparable_cost=2_000_000.0,
             supplier_cost=700_000.0, market_median=900_000.0,
             cheapest_competitor_price=880_000.0, second_cheapest_price=890_000.0,
             market_p25=885_000.0)
    rec = ENGINE.recommend(c, DEFAULT_POLICY, expected_units=10)
    assert rec.price_change_pct >= -(DEFAULT_POLICY.max_daily_move_pct + 1e-9)
    assert "DECREASE_CAP" in rec.guardrails_triggered


def test_tiny_moves_are_suppressed():
    c = cell(our_price=1_000_000.0, our_comparable_cost=1_000_000.0,
             market_median=1_002_000.0, cheapest_competitor_price=995_000.0,
             second_cheapest_price=1_000_000.0, market_p25=998_000.0,
             supplier_cost=850_000.0)
    rec = ENGINE.recommend(c, DEFAULT_POLICY, expected_units=10)
    if abs(rec.target_price - c.our_price) / c.our_price < CFG.min_price_change_pct:
        assert rec.action is Action.HOLD


def test_recommended_price_is_publishable():
    rec = ENGINE.recommend(cell(), DEFAULT_POLICY, expected_units=10)
    assert rec.recommended_price % CFG.rounding_step in (0.0, CFG.psychological_ending % CFG.rounding_step)


# -------------------------------------------------------------- impact
def _overpriced(**over):
    base = dict(our_price=1_100_000.0, our_comparable_cost=1_100_000.0,
                market_median=1_000_000.0, cheapest_competitor_price=980_000.0,
                second_cheapest_price=1_000_000.0, market_p25=990_000.0)
    base.update(over)
    return cell(**base)


def test_break_even_elasticity_maths():
    # Margin 300k on a 1.1m price: a cut only pays if demand is more elastic
    # than -3.67. Margin 700k: the bar drops to -1.57.
    assert ENGINE.break_even_elasticity(1_100_000, 800_000) == pytest.approx(-3.6667, rel=1e-3)
    assert ENGINE.break_even_elasticity(1_100_000, 400_000) == pytest.approx(-1.5714, rel=1e-3)


def test_price_cut_is_recommended_when_it_actually_pays():
    """Fat margin, elastic demand: elasticity -2.5 clears the -1.57 bar."""
    rec = ENGINE.recommend(_overpriced(supplier_cost=400_000.0), DEFAULT_POLICY,
                           expected_units=100, elasticity=-2.5)
    assert rec.action is Action.DECREASE
    assert rec.expected_volume_delta_pct > 0
    assert rec.expected_margin_impact > 0


def test_the_value_gate_refuses_a_cut_that_buys_volume_at_a_loss():
    """Thin margin, elasticity -2.5 but the bar is -3.67. This is the rule the
    brief asked for: do not cut just because a competitor is cheaper."""
    rec = ENGINE.recommend(_overpriced(supplier_cost=800_000.0), DEFAULT_POLICY,
                           expected_units=100, elasticity=-2.5)
    assert rec.action is Action.ESCALATE
    assert rec.recommended_price == 1_100_000.0
    assert "CUT_NOT_MARGIN_ACCRETIVE" in rec.guardrails_triggered
    assert "supplier cost" in rec.rationale


def test_inelastic_demand_never_justifies_a_cut():
    rec = ENGINE.recommend(_overpriced(supplier_cost=800_000.0), DEFAULT_POLICY,
                           expected_units=100, elasticity=-0.4)
    assert rec.action is Action.ESCALATE
    assert "CUT_NOT_MARGIN_ACCRETIVE" in rec.guardrails_triggered


def test_share_defence_tolerance_can_be_opened_deliberately():
    """The gate is policy, not physics. A route where share matters more than
    margin can be allowed to sacrifice some, but only by explicit config."""
    permissive = PricingEngine(EngineConfig(margin_sacrifice_tolerance=0.5))
    rec = permissive.recommend(_overpriced(supplier_cost=800_000.0), DEFAULT_POLICY,
                               expected_units=100, elasticity=-2.5)
    assert rec.action is Action.DECREASE
    assert rec.expected_margin_impact < 0     # knowingly, and it says so


# ---------------------------------------------------------- confidence
def test_confidence_falls_with_coverage_and_freshness():
    good, _ = ENGINE.confidence(cell(), dq_score=1.0, model_score=0.9)
    poor, _ = ENGINE.confidence(
        cell(coverage_score=0.2, data_freshness_hours=10.0, fee_confidence=0.3,
             cheapest_change_1d_pct=0.25),
        dq_score=0.5, model_score=0.3)
    assert good > poor
    assert 0.0 <= poor <= 1.0 and 0.0 <= good <= 1.0


def test_confidence_weights_sum_to_one():
    c = CFG
    total = (c.w_data_quality + c.w_coverage + c.w_freshness
             + c.w_fee_certainty + c.w_model + c.w_stability)
    assert total == pytest.approx(1.0)


# ------------------------------------------------------------- policy
def test_more_specific_rule_wins():
    rules = [
        PricingRule("g", "global", "GLOBAL", None, None, 0.03, 0.07, 0.25, 3000, 0.99, 0.08, 100, date(2026, 1, 1), None),
        PricingRule("r", "route", "ROUTE", "LOS-LHR", None, 0.06, 0.10, 0.25, 3000, 0.99, 0.08, 100, date(2026, 1, 1), None),
    ]
    policy = PolicyResolver(rules).resolve(
        route_key="LOS-LHR", region_pair="AF_EUROPE", carrier="VS",
        cabin="ECONOMY", on=date.today())
    assert policy.min_margin_pct == 0.06
    assert policy.target_margin_pct == 0.10
    assert set(policy.applied_rule_ids) == {"g", "r"}


def test_target_margin_cannot_sit_below_the_floor():
    rules = [PricingRule("bad", "misconfigured", "GLOBAL", None, None,
                         0.10, 0.04, 0.25, 3000, 0.99, 0.08, 100, date(2026, 1, 1), None)]
    policy = PolicyResolver(rules).resolve(
        route_key="LOS-ABV", region_pair="WAF_DOMESTIC", carrier="P4",
        cabin="ECONOMY", on=date.today())
    assert policy.target_margin_pct >= policy.min_margin_pct


# ----------------------------------------------------------- auto apply
def test_auto_apply_is_off_by_default():
    rec = ENGINE.recommend(cell(), DEFAULT_POLICY, expected_units=10)
    assert ENGINE.eligible_for_auto_apply(rec) is False


def test_auto_apply_when_enabled_still_refuses_large_or_uncertain_moves():
    eng = PricingEngine(EngineConfig(auto_apply_enabled=True))
    big = eng.recommend(
        cell(our_price=1_400_000.0, our_comparable_cost=1_400_000.0, supplier_cost=800_000.0),
        DEFAULT_POLICY, expected_units=10)
    assert eng.eligible_for_auto_apply(big) is False
