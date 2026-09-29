"""The pricing engine.

Design principle, stated once and enforced throughout: a competitor being
cheaper is evidence, not an instruction. The engine only recommends a cut
when the cut is (a) affordable against the margin floor, (b) justified on
true customer cost rather than headline price, (c) supported by a panel wide
enough to believe, and (d) expected to pay for itself through volume.

Order of operations:
    1. Guard      : is this cell safe to act on at all?
    2. Boundaries : minimum_price from cost and floors.
    3. Target     : what the market and our margin ambition jointly imply.
    4. Constrain  : movement caps, floors, ceilings, rounding.
    5. Classify   : COMPETITIVE / WATCH / UNCOMPETITIVE / MARGIN_OPPORTUNITY / PROTECTED.
    6. Quantify   : elasticity-based revenue and margin impact.
    7. Score      : confidence and priority.
    8. Explain    : reason codes and a sentence a human can argue with.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime, timezone

from fareiq.core.config import EngineConfig, ResolvedPolicy
from fareiq.core.models import Action, Classification, MarketCell


@dataclass
class Recommendation:
    route_key: str
    departure_date: date
    cabin: str
    trip_type: str
    pos_country: str
    marketing_carrier: str | None
    market_sk: str

    current_price: float
    supplier_cost: float
    current_margin_abs: float
    current_margin_pct: float

    minimum_price: float
    target_price: float
    recommended_price: float
    price_change_abs: float
    price_change_pct: float

    classification: Classification
    action: Action
    priority: str
    priority_score: float
    confidence: float
    confidence_components: dict[str, float]

    elasticity_used: float | None
    expected_demand_units: float | None
    expected_volume_delta_pct: float | None
    expected_revenue_impact: float | None
    expected_margin_impact: float | None
    opportunity_value: float

    reason_codes: list[str] = field(default_factory=list)
    guardrails_triggered: list[str] = field(default_factory=list)
    rationale: str = ""
    applied_rule_ids: tuple[str, ...] = ()


class PricingEngine:
    def __init__(self, config: EngineConfig):
        self.cfg = config

    # ---------------------------------------------------------------- 1
    def _guard(self, cell: MarketCell) -> tuple[bool, list[str]]:
        """Reasons the engine must not produce a price change for this cell."""
        blockers: list[str] = []
        if cell.our_price is None or cell.our_price <= 0:
            blockers.append("NO_OWN_PRICE")
        if cell.supplier_cost is None or cell.supplier_cost <= 0:
            blockers.append("NO_SUPPLIER_COST")
        if cell.competitor_sellers < self.cfg.min_panel_for_action:
            blockers.append("THIN_PANEL")
        if cell.market_median is None or cell.market_median <= 0:
            blockers.append("NO_MARKET_MEDIAN")
        if cell.data_freshness_hours > self.cfg.max_data_age_hours:
            blockers.append("STALE_DATA")
        if cell.market_dispersion is not None and cell.market_dispersion > 0.6:
            blockers.append("MARKET_TOO_DISPERSED")
        # A single competitor far below everyone else is usually an error,
        # a mistake fare, or a non comparable product. Do not chase it.
        if (cell.cheapest_competitor_price and cell.second_cheapest_price
                and cell.cheapest_competitor_price > 0):
            spread = (cell.second_cheapest_price - cell.cheapest_competitor_price) / cell.cheapest_competitor_price
            if spread > 0.30:
                blockers.append("OUTLIER_CHEAPEST_IGNORED")
        return (len(blockers) == 0), blockers

    # ---------------------------------------------------------------- 2
    def minimum_price(self, cell: MarketCell, policy: ResolvedPolicy) -> float:
        """Cost plus the binding floor. The engine may never go below this."""
        cost = cell.supplier_cost or 0.0
        by_pct = cost / (1.0 - policy.min_margin_pct) if policy.min_margin_pct < 1 else cost
        by_abs = cost + policy.min_markup_abs
        return max(by_pct, by_abs)

    # ---------------------------------------------------------------- 3
    def target_price(self, cell: MarketCell, policy: ResolvedPolicy) -> tuple[float, list[str]]:
        """Blend the market anchor with our margin ambition.

        The market anchor is deliberately not "the cheapest competitor". It is
        a weighted blend of the median and the cheapest, so a single aggressive
        competitor moves us part of the way, not all of it. How far depends on
        how tight the market is.
        """
        codes: list[str] = []
        median = cell.market_median or cell.our_comparable_cost or 0.0
        cheapest = cell.cheapest_competitor_price or median

        # In a tight market the cheapest price matters more (shoppers compare
        # like for like). In a dispersed market the median is the better anchor.
        dispersion = cell.market_dispersion if cell.market_dispersion is not None else 0.15
        w_cheapest = max(0.15, min(0.55, 0.55 - dispersion))
        anchor = w_cheapest * cheapest + (1 - w_cheapest) * median

        market_target = anchor * policy.target_price_index

        # Our own fee position adjusts what we can charge on the headline.
        # If we bundle a bag the cheapest competitor charges for, we may hold
        # a higher headline price and still be cheaper all in.
        fee_advantage = (cell.cheapest_competitor_bag_fee or 0.0) - (cell.our_bag_fee or 0.0)
        if fee_advantage > 0:
            market_target += fee_advantage * 0.8   # capture most, not all, of the advantage
            codes.append("FEE_ADVANTAGE")
        elif fee_advantage < 0:
            market_target += fee_advantage * 1.0   # a fee disadvantage must be fully absorbed
            codes.append("FEE_DISADVANTAGE")

        cost = cell.supplier_cost or 0.0
        margin_target = cost / (1.0 - policy.target_margin_pct) if policy.target_margin_pct < 1 else cost

        # We want the higher of the two only when the market allows it. Taking
        # the max unconditionally would price us out of every competitive route.
        if margin_target > market_target:
            headroom = (cell.market_p25 or median)
            target = min(margin_target, headroom)
            codes.append("MARGIN_TARGET_BINDING")
        else:
            target = market_target
            codes.append("MARKET_TARGET_BINDING")

        # Never exceed our own markup ceiling.
        ceiling = cost * (1.0 + policy.max_markup_pct)
        if target > ceiling:
            target = ceiling
            codes.append("MARKUP_CEILING_BINDING")

        return target, codes

    # ---------------------------------------------------------------- 4
    def _constrain(self, current: float, target: float, minimum: float,
                   policy: ResolvedPolicy) -> tuple[float, list[str]]:
        guards: list[str] = []
        price = target

        if price < minimum:
            price = minimum
            guards.append("FLOOR_BINDING")

        move_cap = policy.max_daily_move_pct
        up_cap = min(move_cap, self.cfg.max_increase_pct)
        down_cap = min(move_cap, self.cfg.max_decrease_pct)

        if price > current * (1 + up_cap):
            price = current * (1 + up_cap)
            guards.append("INCREASE_CAP")
        if price < current * (1 - down_cap):
            price = current * (1 - down_cap)
            guards.append("DECREASE_CAP")

        # The cap must never push us under the floor.
        if price < minimum:
            price = minimum
            guards.append("FLOOR_BINDING")

        price = self._round_price(price)

        if abs(price - current) / current < self.cfg.min_price_change_pct:
            price = current
            guards.append("BELOW_MIN_MOVE")

        return price, guards

    def _round_price(self, price: float) -> float:
        step = self.cfg.rounding_step
        if step <= 0:
            return round(price, 2)
        rounded = math.floor(price / step) * step
        ending = self.cfg.psychological_ending
        # Apply a .900 style ending where the step is coarse enough to hide it.
        if ending and step >= 100:
            candidate = math.floor(price / 1000) * 1000 + ending
            if candidate <= price and price - candidate < step:
                rounded = candidate
        return float(max(rounded, step))

    # ---------------------------------------------------------------- 5
    def classify(self, cell: MarketCell, minimum: float, policy: ResolvedPolicy) -> tuple[Classification, list[str]]:
        codes: list[str] = []
        idx = (cell.our_comparable_cost / cell.market_median) if (cell.our_comparable_cost and cell.market_median) else None
        if idx is None:
            return Classification.WATCH, ["NO_INDEX"]

        lo_c, hi_c = self.cfg.competitive_band
        lo_w, hi_w = self.cfg.watch_band

        # If we are already at the floor, no amount of competitor pressure
        # changes what we can do. Say so plainly rather than issuing a cut we
        # cannot honour.
        if cell.our_price is not None and cell.our_price <= minimum * 1.005 and idx > hi_w:
            codes.append("AT_FLOOR_UNCOMPETITIVE")
            return Classification.PROTECTED, codes

        if idx < self.cfg.margin_opportunity_index:
            codes.append("BELOW_MARKET_MARGIN_ROOM")
            return Classification.MARGIN_OPPORTUNITY, codes
        if lo_c <= idx <= hi_c:
            codes.append("AT_MARKET")
            return Classification.COMPETITIVE, codes
        if lo_w <= idx <= hi_w:
            codes.append("DRIFTING")
            return Classification.WATCH, codes
        codes.append("GAP_ABOVE_MARKET" if idx > hi_w else "GAP_BELOW_MARKET")
        return Classification.UNCOMPETITIVE, codes

    # ---------------------------------------------------------------- 6
    def _impact(self, cell: MarketCell, current: float, recommended: float,
                elasticity: float, expected_units: float) -> dict[str, float]:
        """Constant-elasticity volume response, then revenue and margin.

        Deliberately simple and deliberately conservative: the elasticity is
        shrunk toward a regional prior upstream, and the volume response is
        damped so a large modelled elasticity cannot manufacture a large
        claimed benefit from a small price move.
        """
        if current <= 0:
            return {"volume_delta_pct": 0.0, "revenue_impact": 0.0, "margin_impact": 0.0}

        price_ratio = recommended / current
        volume_ratio = price_ratio ** elasticity
        # Damping: trust 70% of the modelled response.
        volume_ratio = 1.0 + (volume_ratio - 1.0) * 0.7

        cost = cell.supplier_cost or 0.0
        base_units = max(expected_units, 0.0)
        new_units = base_units * volume_ratio

        rev_now = current * base_units
        rev_new = recommended * new_units
        mar_now = (current - cost) * base_units
        mar_new = (recommended - cost) * new_units

        return {
            "volume_delta_pct": volume_ratio - 1.0,
            "revenue_impact": rev_new - rev_now,
            "margin_impact": mar_new - mar_now,
        }

    @staticmethod
    def break_even_elasticity(price: float, cost: float) -> float:
        """The elasticity at which a marginal price cut leaves margin unchanged.

        For a constant elasticity demand curve, margin is flat when
        |e| = price / (price - cost). A thin margin needs enormous elasticity
        to justify a cut, which is why discounting a low margin route almost
        never works and why this number belongs in the analyst's hands.
        """
        margin = price - cost
        if margin <= 0:
            return float("-inf")
        return -(price / margin)

    # ---------------------------------------------------------------- 7
    def confidence(self, cell: MarketCell, dq_score: float, model_score: float) -> tuple[float, dict[str, float]]:
        c = self.cfg
        coverage = min(cell.coverage_score, 1.0)
        freshness = max(0.0, 1.0 - cell.data_freshness_hours / max(c.max_data_age_hours, 1e-9))
        fee = min(max(cell.fee_confidence, 0.0), 1.0)
        # Stability: a market that moved 30% yesterday is a market we should
        # be less sure about today.
        move = abs(cell.cheapest_change_1d_pct or 0.0)
        stability = max(0.0, 1.0 - min(move / 0.30, 1.0))

        comps = {
            "data_quality": dq_score,
            "coverage": coverage,
            "freshness": freshness,
            "fee_certainty": fee,
            "model": model_score,
            "stability": stability,
        }
        score = (c.w_data_quality * dq_score + c.w_coverage * coverage
                 + c.w_freshness * freshness + c.w_fee_certainty * fee
                 + c.w_model * model_score + c.w_stability * stability)
        return round(min(max(score, 0.0), 1.0), 4), comps

    def _priority(self, opportunity: float, confidence: float, action: Action) -> tuple[str, float]:
        c = self.cfg
        score = opportunity * confidence
        if action in (Action.HOLD,):
            return "P3", score
        if action in (Action.ESCALATE, Action.INVESTIGATE):
            return ("P1" if opportunity >= c.p2_opportunity else "P2"), score
        if opportunity >= c.p1_opportunity and confidence >= c.p1_min_confidence:
            return "P1", score
        if opportunity >= c.p2_opportunity:
            return "P2", score
        return "P3", score

    # ---------------------------------------------------------------- 8
    def _rationale(self, cell: MarketCell, rec_price: float, cls: Classification,
                   action: Action, codes: list[str], guards: list[str]) -> str:
        idx = (cell.our_comparable_cost / cell.market_median) if (cell.our_comparable_cost and cell.market_median) else None
        bits: list[str] = []
        bits.append(
            f"{cell.route_key} {cell.cabin.lower()} departing {cell.departure_date} "
            f"({cell.days_to_departure} days out), {cell.competitor_sellers} competitors observed."
        )
        if idx is not None:
            pos = "at market" if 0.97 <= idx <= 1.03 else ("above market" if idx > 1.03 else "below market")
            bits.append(f"Our all in cost to the customer is {idx:.2f}x the market median, {pos}.")
        if cell.cheapest_competitor_id and cell.cheapest_competitor_price:
            bits.append(
                f"Cheapest comparable is {cell.cheapest_competitor_id} at "
                f"{cell.cheapest_competitor_price:,.0f}, we rank {cell.our_market_rank}."
            )
        if "FEE_ADVANTAGE" in codes:
            bits.append("We include baggage the cheapest competitor charges for, so part of the headline gap is not a real gap.")
        if "FEE_DISADVANTAGE" in codes:
            bits.append("Our fee load is heavier than the cheapest competitor, so the headline understates our true position.")
        if "FLOOR_BINDING" in guards:
            bits.append("The margin floor binds: we cannot match the market without selling below policy.")
        if "CUT_NOT_MARGIN_ACCRETIVE" in guards:
            be = self.break_even_elasticity(cell.our_price or 0.0, cell.supplier_cost or 0.0)
            bits.append(
                f"A cut only pays here if share elasticity is beyond {be:.1f}, and the estimate for "
                f"this route does not reach that, so discounting would buy volume at a loss. "
                f"The gap is in the supplier cost, not the price: renegotiate, switch carrier, "
                f"or accept the share position."
            )
        if "OUTLIER_CHEAPEST_IGNORED" in guards:
            bits.append("The cheapest observed price is a far outlier and has been excluded as non comparable.")
        if action == Action.HOLD:
            bits.append("No change recommended.")
        else:
            verb = {"INCREASE": "Raise", "DECREASE": "Reduce", "INVESTIGATE": "Review", "ESCALATE": "Escalate"}[action.value]
            bits.append(f"{verb} to {rec_price:,.0f}.")
        return " ".join(bits)

    # ---------------------------------------------------------------- run
    def recommend(self, cell: MarketCell, policy: ResolvedPolicy, *,
                  expected_units: float = 0.0, elasticity: float | None = None,
                  dq_score: float = 1.0, model_score: float = 0.7) -> Recommendation:
        cfg = self.cfg
        elasticity = elasticity if elasticity is not None else cfg.default_elasticity

        current = float(cell.our_price or 0.0)
        cost = float(cell.supplier_cost or 0.0)
        minimum = self.minimum_price(cell, policy)

        ok, blockers = self._guard(cell)
        conf, comps = self.confidence(cell, dq_score, model_score)

        if not ok:
            # Still report the cell. A blocked cell that is badly mispriced is
            # exactly the thing a human should look at.
            action = Action.INVESTIGATE if current > 0 else Action.HOLD
            impact = {"volume_delta_pct": 0.0, "revenue_impact": 0.0, "margin_impact": 0.0}
            opportunity = 0.0
            priority, pscore = self._priority(opportunity, conf, action)
            return Recommendation(
                route_key=cell.route_key, departure_date=cell.departure_date, cabin=cell.cabin,
                trip_type=cell.trip_type, pos_country=cell.pos_country,
                marketing_carrier=cell.marketing_carrier, market_sk=cell.market_sk,
                current_price=current, supplier_cost=cost,
                current_margin_abs=current - cost,
                current_margin_pct=(current - cost) / current if current else 0.0,
                minimum_price=minimum, target_price=current, recommended_price=current,
                price_change_abs=0.0, price_change_pct=0.0,
                classification=Classification.WATCH, action=action,
                priority=priority, priority_score=pscore,
                confidence=conf, confidence_components=comps,
                elasticity_used=None, expected_demand_units=expected_units,
                expected_volume_delta_pct=0.0,
                expected_revenue_impact=0.0, expected_margin_impact=0.0,
                opportunity_value=0.0,
                reason_codes=blockers, guardrails_triggered=blockers,
                rationale=("Not actionable: " + ", ".join(blockers).replace("_", " ").lower()
                           + ". Collected evidence is retained for review."),
                applied_rule_ids=policy.applied_rule_ids,
            )

        target, target_codes = self.target_price(cell, policy)
        recommended, guards = self._constrain(current, target, minimum, policy)
        classification, class_codes = self.classify(cell, minimum, policy)

        change_abs = recommended - current
        change_pct = change_abs / current if current else 0.0

        if abs(change_pct) < cfg.min_price_change_pct:
            action = Action.HOLD
        elif change_abs > 0:
            action = Action.INCREASE
        else:
            action = Action.DECREASE

        # A protected cell is one where we are uncompetitive AND already at
        # the margin floor. There is no mechanical answer: the fix is a better
        # supplier deal, a different carrier, or accepting the loss of share.
        # It never gets a silent HOLD, because a human needs to see it.
        if classification is Classification.PROTECTED and action is not Action.INCREASE:
            recommended, change_abs, change_pct = current, 0.0, 0.0
            action = Action.ESCALATE
            guards.append("PROTECTED_NO_CUT")

        impact = self._impact(cell, current, recommended, elasticity, expected_units)

        # ---- the value gate -------------------------------------------
        # A competitor being cheaper is not a reason to cut. A cut is only a
        # recommendation if it pays for itself. Below the break-even
        # elasticity it never does, and the honest answer is that the gap is a
        # cost problem, not a price problem: escalate it to someone who can
        # renegotiate the supplier deal or accept the loss of share.
        if action is Action.DECREASE and impact["margin_impact"] < -self.cfg.margin_sacrifice_tolerance * max(current - cost, 1.0) * max(expected_units, 1.0):
            be = self.break_even_elasticity(current, cost)
            recommended, change_abs, change_pct = current, 0.0, 0.0
            action = Action.ESCALATE
            classification = Classification.PROTECTED
            guards.append("CUT_NOT_MARGIN_ACCRETIVE")
            target_codes.append(f"BREAK_EVEN_ELASTICITY_{be:.1f}")
            impact = {"volume_delta_pct": 0.0, "revenue_impact": 0.0,
                      "margin_impact": 0.0}

        # The mirror case: an increase the demand model says we would pay for
        # in lost volume.
        if action is Action.INCREASE and impact["margin_impact"] < 0:
            recommended, change_abs, change_pct = current, 0.0, 0.0
            action = Action.HOLD
            guards.append("INCREASE_NOT_MARGIN_ACCRETIVE")
            impact = {"volume_delta_pct": 0.0, "revenue_impact": 0.0,
                      "margin_impact": 0.0}

        opportunity = abs(impact["margin_impact"])
        priority, pscore = self._priority(opportunity, conf, action)

        codes = target_codes + class_codes
        if cell.our_market_rank == 1:
            codes.append("ALREADY_CHEAPEST")
        if (cell.median_change_7d_pct or 0) > 0.05:
            codes.append("MARKET_RISING")
        if (cell.median_change_7d_pct or 0) < -0.05:
            codes.append("MARKET_FALLING")

        return Recommendation(
            route_key=cell.route_key, departure_date=cell.departure_date, cabin=cell.cabin,
            trip_type=cell.trip_type, pos_country=cell.pos_country,
            marketing_carrier=cell.marketing_carrier, market_sk=cell.market_sk,
            current_price=current, supplier_cost=cost,
            current_margin_abs=current - cost,
            current_margin_pct=(current - cost) / current if current else 0.0,
            minimum_price=round(minimum, 2), target_price=round(target, 2),
            recommended_price=recommended,
            price_change_abs=round(change_abs, 2), price_change_pct=round(change_pct, 6),
            classification=classification, action=action,
            priority=priority, priority_score=round(pscore, 2),
            confidence=conf, confidence_components=comps,
            elasticity_used=elasticity, expected_demand_units=expected_units,
            expected_volume_delta_pct=round(impact["volume_delta_pct"], 6),
            expected_revenue_impact=round(impact["revenue_impact"], 2),
            expected_margin_impact=round(impact["margin_impact"], 2),
            opportunity_value=round(opportunity, 2),
            reason_codes=sorted(set(codes)), guardrails_triggered=sorted(set(guards)),
            rationale=self._rationale(cell, recommended, classification, action, codes, guards),
            applied_rule_ids=policy.applied_rule_ids,
        )

    def eligible_for_auto_apply(self, rec: Recommendation) -> bool:
        c = self.cfg
        return (
            c.auto_apply_enabled
            and rec.action in (Action.INCREASE, Action.DECREASE)
            and abs(rec.price_change_pct) <= c.auto_apply_max_change_pct
            and rec.confidence >= c.auto_apply_min_confidence
            and not rec.guardrails_triggered
            and rec.classification is not Classification.PROTECTED
        )
