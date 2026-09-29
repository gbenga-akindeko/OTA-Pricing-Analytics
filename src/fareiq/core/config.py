"""Pricing rules, loaded from the Google Sheet and cached in BigQuery.

The pricing team owns these numbers, not engineering. The Sheet is the
editing surface; ``dim_pricing_rule`` is the versioned record; this class is
the runtime resolver. Rule resolution is most-specific-wins, then lowest
priority number wins.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import date
from typing import Iterable


SCOPE_SPECIFICITY = {
    "GLOBAL": 0,
    "REGION": 1,
    "CABIN": 2,
    "CARRIER": 3,
    "ROUTE": 4,
    "ROUTE_CARRIER": 5,
}


@dataclass(frozen=True)
class PricingRule:
    rule_id: str
    rule_name: str
    scope_type: str
    scope_value: str | None
    cabin: str | None
    min_margin_pct: float | None
    target_margin_pct: float | None
    max_markup_pct: float | None
    min_markup_abs: float | None
    target_price_index: float | None
    max_daily_move_pct: float | None
    priority: int
    effective_from: date
    effective_to: date | None
    is_active: bool = True

    def matches(self, *, route_key: str, region_pair: str | None,
                carrier: str | None, cabin: str, on: date) -> bool:
        if not self.is_active:
            return False
        if on < self.effective_from:
            return False
        if self.effective_to and on > self.effective_to:
            return False
        if self.cabin and self.cabin != cabin:
            return False
        st, sv = self.scope_type, self.scope_value
        if st == "GLOBAL":
            return True
        if st == "REGION":
            return sv == region_pair
        if st == "CABIN":
            return sv == cabin
        if st == "CARRIER":
            return sv == carrier
        if st == "ROUTE":
            return sv == route_key
        if st == "ROUTE_CARRIER":
            return sv == f"{route_key}|{carrier}"
        return False


@dataclass(frozen=True)
class ResolvedPolicy:
    """The effective policy for one market cell after rule resolution."""
    min_margin_pct: float
    target_margin_pct: float
    max_markup_pct: float
    min_markup_abs: float
    target_price_index: float
    max_daily_move_pct: float
    applied_rule_ids: tuple[str, ...]


# Safe defaults. Every one of these is overridable in the Sheet; they exist
# so the engine can never run "unconfigured".
DEFAULT_POLICY = ResolvedPolicy(
    min_margin_pct=0.035,
    target_margin_pct=0.075,
    max_markup_pct=0.25,
    min_markup_abs=3500.0,      # NGN. A percentage floor alone yields pennies on cheap domestic fares.
    target_price_index=0.985,   # aim marginally below the market median
    max_daily_move_pct=0.08,
    applied_rule_ids=(),
)


class PolicyResolver:
    def __init__(self, rules: Iterable[PricingRule], default: ResolvedPolicy = DEFAULT_POLICY):
        self.rules = list(rules)
        self.default = default

    def resolve(self, *, route_key: str, region_pair: str | None,
                carrier: str | None, cabin: str, on: date) -> ResolvedPolicy:
        matching = [
            r for r in self.rules
            if r.matches(route_key=route_key, region_pair=region_pair,
                         carrier=carrier, cabin=cabin, on=on)
        ]
        # Least specific first, so more specific rules overwrite. Within the
        # same specificity, a lower priority number wins, so apply those last.
        matching.sort(key=lambda r: (SCOPE_SPECIFICITY.get(r.scope_type, 0), -r.priority))

        policy = self.default
        applied: list[str] = []
        for r in matching:
            updates = {
                k: v for k, v in {
                    "min_margin_pct": r.min_margin_pct,
                    "target_margin_pct": r.target_margin_pct,
                    "max_markup_pct": r.max_markup_pct,
                    "min_markup_abs": r.min_markup_abs,
                    "target_price_index": r.target_price_index,
                    "max_daily_move_pct": r.max_daily_move_pct,
                }.items() if v is not None
            }
            if updates:
                policy = replace(policy, **updates)
                applied.append(r.rule_id)

        # A target margin below the floor is a configuration error, not a
        # licence to price below the floor.
        if policy.target_margin_pct < policy.min_margin_pct:
            policy = replace(policy, target_margin_pct=policy.min_margin_pct)

        return replace(policy, applied_rule_ids=tuple(applied))


@dataclass(frozen=True)
class EngineConfig:
    """Non-rule tuning constants. Changed by engineering, reviewed by pricing."""
    base_currency: str = "NGN"

    # True-cost model
    change_probability: float = 0.08
    cancel_probability: float = 0.03
    baseline_stops: int = 0
    stop_penalty_base: float = 6000.0     # NGN a traveller implicitly pays for a connection

    # Market statistics
    expected_panel_size: int = 5
    min_panel_for_action: int = 3         # below this the engine may only INVESTIGATE
    max_data_age_hours: float = 12.0

    # Classification thresholds, on price index vs market median
    competitive_band: tuple[float, float] = (0.97, 1.03)
    watch_band: tuple[float, float] = (0.93, 1.08)
    margin_opportunity_index: float = 0.93   # we are this far below market: room to rise

    # Recommendation guards
    min_price_change_pct: float = 0.015   # do not churn prices for noise
    max_increase_pct: float = 0.12
    max_decrease_pct: float = 0.15
    rounding_step: float = 100.0          # NGN. Publishable price granularity.
    psychological_ending: float = 900.0   # ...900 endings, applied where step allows

    # The value gate. A recommended cut must pay for itself in margin.
    # Tolerance is expressed as a fraction of current margin the business is
    # willing to sacrifice for share. 0.0 means never knowingly cut margin;
    # raise it deliberately, per route, when defending share is the strategy.
    margin_sacrifice_tolerance: float = 0.0

    # Elasticity.
    #
    # A distinction that decides whether this platform works. There are two
    # elasticities and using the wrong one produces confidently wrong prices:
    #
    #   Market demand elasticity   (about -1.0 to -1.7)
    #     How total travel demand on a route responds to the price level.
    #     Relevant to an airline setting fares, irrelevant to us.
    #
    #   Competitive share elasticity  (typically -4 to -15)
    #     How OUR share of a fixed pool of shoppers responds to OUR position
    #     against the competitors on the same screen. Flights are a near
    #     commodity and metasearch sorts by price, so share moves violently.
    #     This is the number that governs an OTA pricing decision.
    #
    # Using -1.4 here makes the break-even test unreachable at OTA margins and
    # the engine would never recommend a cut. The value below is share
    # elasticity, and route_elasticity in BigQuery estimates the same quantity
    # by regressing log(pax) on log(price_index), not on log(price).
    default_elasticity: float = -6.0
    elasticity_floor: float = -18.0
    elasticity_ceiling: float = -0.5
    elasticity_shrink_k: float = 20.0

    # Confidence weights, must sum to 1
    w_data_quality: float = 0.20
    w_coverage: float = 0.25
    w_freshness: float = 0.15
    w_fee_certainty: float = 0.20
    w_model: float = 0.10
    w_stability: float = 0.10

    # Priority banding on opportunity value, base currency, and confidence
    p1_opportunity: float = 500_000.0
    p2_opportunity: float = 100_000.0
    p1_min_confidence: float = 0.65

    # Auto-apply. Phase 1 keeps this off: every change is human approved.
    auto_apply_enabled: bool = False
    auto_apply_max_change_pct: float = 0.02
    auto_apply_min_confidence: float = 0.85
