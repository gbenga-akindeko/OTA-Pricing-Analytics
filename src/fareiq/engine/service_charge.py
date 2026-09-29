"""Service charge and price advantage.

The question this module answers: given what a ticket actually costs us, and
the best competitive reference we can obtain, what service charge can we add
and still be the cheapest credible option on the screen?

Three ideas run through it.

**One. Amadeus, Sabre, NDC and Verteil are supply, not competitive
intelligence.** They tell us what a ticket costs us and what the airline
retails it for. They cannot tell us what another OTA is displaying, because
that displayed price is their private markup on the same content. So the
platform builds a *reference ladder* from what it can see, and is explicit
about how much of the ladder is observed and how much is inferred.

**Two. Source arbitrage is worth more than markup discipline.** The same
flight reaches us through four channels at four different net costs, and
airlines routinely price NDC below GDS to push distribution there. Selling
from the cheapest source is pure margin at an unchanged shelf price. A markup
argument is worth a few percent; picking the right source can be worth more,
and it costs the customer nothing.

**Three. Payment method is a pricing lever, not an afterthought.** On a
₦1,000,000 ticket, a 1.5% card fee is ₦15,000 and a bank transfer is about
₦100. That difference is larger than the margin on many bookings.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Iterable


class Channel(str, Enum):
    """Where a fare reached us. Each has its own economics."""
    AMADEUS = "AMADEUS"
    SABRE = "SABRE"
    NDC_DIRECT = "NDC_DIRECT"
    VERTEIL = "VERTEIL"
    CONSOLIDATOR = "CONSOLIDATOR"


class PaymentMethod(str, Enum):
    TRANSFER = "TRANSFER"
    CARD_LOCAL = "CARD_LOCAL"
    CARD_INTERNATIONAL = "CARD_INTERNATIONAL"
    CORPORATE_CREDIT = "CORPORATE_CREDIT"


class ReferenceKind(str, Enum):
    """How a competitive reference was obtained, best first.

    The ranking is not cosmetic: it decides which reference binds, and it
    decides how much confidence the recommendation carries.
    """
    OBSERVED_COMPETITOR = "OBSERVED_COMPETITOR"   # licensed feed or metasearch report
    AIRLINE_DIRECT = "AIRLINE_DIRECT"             # NDC or Verteil: a real competitor
    METASEARCH_WINNER = "METASEARCH_WINNER"       # the winning price a channel reported
    GDS_LOWEST_PLUS_MARKUP = "GDS_LOWEST_PLUS_MARKUP"   # inferred, not seen
    HISTORICAL_OWN = "HISTORICAL_OWN"             # our own past price, weakest of all


REFERENCE_CONFIDENCE = {
    ReferenceKind.OBSERVED_COMPETITOR: 1.00,
    ReferenceKind.AIRLINE_DIRECT: 0.90,
    ReferenceKind.METASEARCH_WINNER: 0.85,
    ReferenceKind.GDS_LOWEST_PLUS_MARKUP: 0.55,
    ReferenceKind.HISTORICAL_OWN: 0.25,
}


# ======================================================================
# What a booking actually costs us
# ======================================================================
@dataclass(frozen=True)
class ChannelEconomics:
    """Per-booking cost and income for one distribution channel.

    ``segment_fee`` is signed. In many markets a GDS pays the agency a
    segment incentive rather than charging for it, so a negative value here is
    income, and modelling it as a cost would quietly understate GDS channels
    against NDC.
    """
    channel: Channel
    segment_fee: float = 0.0            # negative means we are paid
    booking_fee: float = 0.0            # flat per PNR
    commission_pct: float = 0.0         # front end, on base fare
    incentive_pct: float = 0.0          # back end accrual, on base fare
    notes: str = ""

    def channel_cost(self, base_fare: float, segments: int) -> float:
        """Net cost of using this channel. Negative means it earns us money."""
        fees = self.segment_fee * max(segments, 1) + self.booking_fee
        earned = base_fare * (self.commission_pct + self.incentive_pct)
        return fees - earned


# Placeholder economics. Replace each line with your own contracted numbers
# before a single price is published: these decide every margin figure.
DEFAULT_CHANNELS: dict[Channel, ChannelEconomics] = {
    Channel.AMADEUS: ChannelEconomics(
        Channel.AMADEUS, segment_fee=-450.0, commission_pct=0.0, incentive_pct=0.005,
        notes="Segment incentive received. Confirm against the Amadeus agreement."),
    Channel.SABRE: ChannelEconomics(
        Channel.SABRE, segment_fee=-420.0, commission_pct=0.0, incentive_pct=0.005,
        notes="As Amadeus. Bargain Finder Max returns the lowest bookable fares."),
    Channel.NDC_DIRECT: ChannelEconomics(
        Channel.NDC_DIRECT, segment_fee=0.0, booking_fee=0.0, commission_pct=0.01,
        notes="No GDS incentive, but carriers often file NDC net below GDS."),
    Channel.VERTEIL: ChannelEconomics(
        Channel.VERTEIL, segment_fee=0.0, booking_fee=350.0, commission_pct=0.01,
        notes="Aggregator transaction fee. Confirm the Verteil pricing schedule."),
    Channel.CONSOLIDATOR: ChannelEconomics(
        Channel.CONSOLIDATOR, segment_fee=0.0, commission_pct=0.0, incentive_pct=0.03,
        notes="Private fare access. The single largest genuine price lever."),
}


@dataclass(frozen=True)
class PaymentEconomics:
    method: PaymentMethod
    pct: float = 0.0
    flat: float = 0.0
    cap: float | None = None

    def cost(self, amount: float) -> float:
        c = amount * self.pct + self.flat
        return min(c, self.cap) if self.cap is not None else c


# Nigerian market placeholders. Confirm with your PSP before go-live.
DEFAULT_PAYMENTS: dict[PaymentMethod, PaymentEconomics] = {
    PaymentMethod.TRANSFER:           PaymentEconomics(PaymentMethod.TRANSFER, flat=100.0),
    PaymentMethod.CARD_LOCAL:         PaymentEconomics(PaymentMethod.CARD_LOCAL, pct=0.015, cap=2000.0),
    PaymentMethod.CARD_INTERNATIONAL: PaymentEconomics(PaymentMethod.CARD_INTERNATIONAL, pct=0.039),
    PaymentMethod.CORPORATE_CREDIT:   PaymentEconomics(PaymentMethod.CORPORATE_CREDIT, pct=0.008,
                                                       flat=0.0),
}


@dataclass(frozen=True)
class CostModel:
    """Everything that turns a net fare into what the booking costs us."""
    ops_cost_per_booking: float = 1_200.0   # ticketing, servicing, refunds, support
    channels: dict[Channel, ChannelEconomics] = field(default_factory=lambda: dict(DEFAULT_CHANNELS))
    payments: dict[PaymentMethod, PaymentEconomics] = field(default_factory=lambda: dict(DEFAULT_PAYMENTS))

    def channel_economics(self, channel: Channel) -> ChannelEconomics:
        return self.channels.get(channel, ChannelEconomics(channel))

    def payment_economics(self, method: PaymentMethod) -> PaymentEconomics:
        return self.payments.get(method, PaymentEconomics(method))


@dataclass(frozen=True)
class FareOption:
    """One bookable way to sell the same flight."""
    channel: Channel
    net_fare: float           # base fare payable to the supplier
    taxes: float              # pass-through, never marked up
    segments: int = 1
    included_bags: int = 0
    is_refundable: bool = False
    fare_family: str | None = None
    private_fare: bool = False

    @property
    def supplier_payable(self) -> float:
        return self.net_fare + self.taxes


# ======================================================================
# The competitive reference ladder
# ======================================================================
@dataclass(frozen=True)
class Reference:
    """One estimate of what the customer can pay elsewhere, all in."""
    kind: ReferenceKind
    all_in: float
    seller: str | None = None
    note: str = ""

    @property
    def confidence(self) -> float:
        return REFERENCE_CONFIDENCE[self.kind]


def infer_competitor_price(
    gds_lowest_all_in: float,
    *,
    typical_markup_pct: float = 0.075,
    typical_payment_pct: float = 0.015,
) -> Reference:
    """Estimate a competitor's shelf price from the content we both buy.

    Every OTA selling published fares on the same route is buying from roughly
    the same filed fare. What separates their screen price from ours is their
    markup and their payment cost. So the lowest bookable GDS fare, grossed up
    by the market's typical markup, brackets where competitors will land.

    This is an inference, not an observation, and it is labelled as one. It
    carries a confidence of 0.55, which is deliberately low enough that a
    recommendation resting on it alone will not reach the P1 band.
    """
    return Reference(
        kind=ReferenceKind.GDS_LOWEST_PLUS_MARKUP,
        all_in=gds_lowest_all_in * (1 + typical_markup_pct + typical_payment_pct),
        note=(f"Inferred from the lowest bookable GDS fare plus a "
              f"{typical_markup_pct * 100:.1f}% market markup assumption. "
              f"Not an observed competitor price."),
    )


def build_reference_ladder(references: Iterable[Reference]) -> list[Reference]:
    """Order the references by how much they should be trusted, then by price.

    The binding reference is the cheapest one we actually believe, not simply
    the cheapest number we hold. An inferred price 5% below an observed
    airline-direct price should not send us chasing a figure nobody has seen.
    """
    refs = [r for r in references if r.all_in and r.all_in > 0]
    return sorted(refs, key=lambda r: (-r.confidence, r.all_in))


def binding_reference(references: Iterable[Reference]) -> Reference | None:
    """The reference a price must beat.

    Among references of the highest available confidence tier, the cheapest
    one binds: that is the offer the shopper will actually compare us with.
    """
    ladder = build_reference_ladder(references)
    if not ladder:
        return None
    best_conf = ladder[0].confidence
    tier = [r for r in ladder if r.confidence == best_conf]
    return min(tier, key=lambda r: r.all_in)


# ======================================================================
# The service charge
# ======================================================================
@dataclass
class PriceQuote:
    option: FareOption
    payment_method: PaymentMethod

    supplier_payable: float
    channel_cost: float
    ops_cost: float
    payment_cost: float

    break_even_charge: float
    target_charge: float
    competitive_ceiling: float | None
    service_charge: float

    selling_price: float
    gross_margin: float
    gross_margin_pct: float

    reference: Reference | None
    advantage_abs: float | None
    advantage_pct: float | None
    binding_constraint: str
    confidence: float
    notes: list[str] = field(default_factory=list)


class ServiceChargeEngine:
    """Turns a net fare plus a competitive reference into a shelf price."""

    def __init__(
        self,
        cost_model: CostModel | None = None,
        *,
        target_margin_pct: float = 0.075,
        min_service_charge: float = 3_500.0,
        max_service_charge_pct: float = 0.25,
        victory_margin_pct: float = 0.015,
        rounding_step: float = 100.0,
    ):
        self.costs = cost_model or CostModel()
        self.target_margin_pct = target_margin_pct
        self.min_service_charge = min_service_charge
        self.max_service_charge_pct = max_service_charge_pct
        # How far below the reference we aim to land. Matching exactly is not
        # an advantage: a shopper scanning a list needs a visible gap, and a
        # competitor repricing by a naira erases a tie.
        self.victory_margin_pct = victory_margin_pct
        self.rounding_step = rounding_step

    # ---------------------------------------------------------------- costs
    def _costs(self, option: FareOption, payment_method: PaymentMethod,
               estimated_total: float) -> tuple[float, float, float]:
        channel_cost = self.costs.channel_economics(option.channel).channel_cost(
            option.net_fare, option.segments)
        ops = self.costs.ops_cost_per_booking
        payment = self.costs.payment_economics(payment_method).cost(estimated_total)
        return channel_cost, ops, payment

    def break_even(self, option: FareOption, payment_method: PaymentMethod) -> float:
        """The service charge below which the booking loses money.

        Solved rather than assumed, because the payment fee is charged on the
        total, which itself contains the service charge. Four passes converge
        to well under a naira at these magnitudes.

        The result is deliberately **not** clamped at zero. A channel whose
        incentive exceeds our servicing cost has a negative break-even, and
        that is real information: it says this channel pays for the booking by
        itself. Clamping it here would make two channels with very different
        economics look identical, which is exactly the comparison that source
        arbitrage depends on. The charge actually published is floored in
        ``quote``, where the minimum service charge applies.
        """
        charge = 0.0
        for _ in range(4):
            total = option.supplier_payable + max(charge, 0.0)
            channel_cost, ops, payment = self._costs(option, payment_method, total)
            charge = channel_cost + ops + payment
        return charge

    def target(self, option: FareOption, payment_method: PaymentMethod) -> float:
        """The service charge that delivers the target margin."""
        charge = self.break_even(option, payment_method)
        for _ in range(4):
            total = option.supplier_payable + charge
            channel_cost, ops, payment = self._costs(option, payment_method, total)
            costs = option.supplier_payable + channel_cost + ops + payment
            if self.target_margin_pct >= 1:
                break
            total_target = costs / (1 - self.target_margin_pct)
            charge = max(total_target - option.supplier_payable, 0.0)
        return charge

    def ceiling_to_beat(
        self,
        option: FareOption,
        reference: Reference,
        *,
        fee_advantage: float = 0.0,
    ) -> float:
        """The largest service charge that still leaves us visibly cheaper.

        ``fee_advantage`` is what the reference charges for things we include,
        typically baggage and seats. It is added back, because being cheaper
        all in is what the customer experiences, and holding a higher shelf
        price while still being cheaper is exactly where margin lives.
        """
        target_all_in = reference.all_in * (1 - self.victory_margin_pct) + fee_advantage
        return max(target_all_in - option.supplier_payable, 0.0)

    # ---------------------------------------------------------------- quote
    def quote(
        self,
        option: FareOption,
        *,
        payment_method: PaymentMethod = PaymentMethod.TRANSFER,
        references: Iterable[Reference] = (),
        fee_advantage: float = 0.0,
    ) -> PriceQuote:
        break_even = self.break_even(option, payment_method)
        target = self.target(option, payment_method)
        ref = binding_reference(references)
        notes: list[str] = []

        ceiling = None
        if ref is not None:
            ceiling = self.ceiling_to_beat(option, ref, fee_advantage=fee_advantage)

        # Start from the target, then let each constraint bite in turn.
        charge = target
        constraint = "TARGET_MARGIN"

        if ceiling is not None and ceiling < charge:
            charge = ceiling
            constraint = "COMPETITIVE_CEILING"
            notes.append(
                f"Held down to stay under {ref.kind.value.lower().replace('_', ' ')}"
                + (f" ({ref.seller})" if ref.seller else "")
                + f" at {ref.all_in:,.0f}."
            )

        floor = max(break_even, self.min_service_charge)
        if charge < floor:
            charge = floor
            constraint = ("BREAK_EVEN" if break_even >= self.min_service_charge
                          else "MINIMUM_CHARGE")
            if ceiling is not None and floor > ceiling:
                notes.append(
                    "Cannot beat the reference and cover cost at the same time. "
                    "The gap is in the net fare, not the markup: look for a private "
                    "fare, a cheaper channel, or accept the loss of this booking."
                )

        cap = option.supplier_payable * self.max_service_charge_pct
        if charge > cap:
            charge = cap
            constraint = "MAX_CHARGE_CAP"

        charge = self._round(charge)
        selling = option.supplier_payable + charge
        channel_cost, ops, payment = self._costs(option, payment_method, selling)
        margin = selling - (option.supplier_payable + channel_cost + ops + payment)

        advantage_abs = advantage_pct = None
        if ref is not None:
            our_all_in = selling - fee_advantage
            advantage_abs = ref.all_in - our_all_in
            advantage_pct = advantage_abs / ref.all_in if ref.all_in else None

        confidence = ref.confidence if ref else 0.2
        if option.private_fare:
            notes.append("Private fare: this net is not available to competitors buying published content.")
        if option.channel in (Channel.NDC_DIRECT, Channel.VERTEIL) and option.included_bags:
            notes.append("NDC bundle includes baggage, which raises what we can charge on the shelf.")

        return PriceQuote(
            option=option, payment_method=payment_method,
            supplier_payable=round(option.supplier_payable, 2),
            channel_cost=round(channel_cost, 2),
            ops_cost=round(ops, 2),
            payment_cost=round(payment, 2),
            break_even_charge=round(break_even, 2),
            target_charge=round(target, 2),
            competitive_ceiling=round(ceiling, 2) if ceiling is not None else None,
            service_charge=round(charge, 2),
            selling_price=round(selling, 2),
            gross_margin=round(margin, 2),
            gross_margin_pct=round(margin / selling, 6) if selling else 0.0,
            reference=ref,
            advantage_abs=round(advantage_abs, 2) if advantage_abs is not None else None,
            advantage_pct=round(advantage_pct, 6) if advantage_pct is not None else None,
            binding_constraint=constraint,
            confidence=round(confidence, 3),
            notes=notes,
        )

    def _round(self, value: float) -> float:
        step = self.rounding_step
        return float(int(value / step) * step) if step > 0 else round(value, 2)


# ======================================================================
# Source arbitrage
# ======================================================================
@dataclass
class ArbitrageResult:
    best: PriceQuote
    all_quotes: list[PriceQuote]
    saving_against_worst: float
    saving_pct: float
    rationale: str


def choose_cheapest_source(
    engine: ServiceChargeEngine,
    options: list[FareOption],
    *,
    payment_method: PaymentMethod = PaymentMethod.TRANSFER,
    references: Iterable[Reference] = (),
    fee_advantage: float = 0.0,
) -> ArbitrageResult | None:
    """Pick the channel that leaves the most margin at the same shelf price.

    The same flight arrives through Amadeus, Sabre, direct NDC and Verteil at
    four different net costs, and carriers commonly file NDC below GDS to push
    volume there. Selling from the cheapest source is margin gained at an
    unchanged price to the customer, which makes it the one pricing decision
    with no downside.

    Ranking is on landed cost rather than on headline net, so a GDS segment
    incentive is not thrown away for a nominally cheaper NDC fare.
    """
    if not options:
        return None

    refs = list(references)
    quotes = [engine.quote(o, payment_method=payment_method,
                           references=refs, fee_advantage=fee_advantage)
              for o in options]

    def landed(q: PriceQuote) -> float:
        return q.supplier_payable + q.channel_cost + q.ops_cost

    best = min(quotes, key=landed)
    worst = max(quotes, key=landed)
    saving = landed(worst) - landed(best)

    if len(options) == 1:
        rationale = f"Only {best.option.channel.value} available for this flight."
    elif saving <= 0:
        rationale = "All channels land at the same cost; channel choice is not a lever here."
    else:
        rationale = (
            f"{best.option.channel.value} lands {saving:,.0f} cheaper than "
            f"{worst.option.channel.value} on the same flight "
            f"({saving / landed(worst) * 100:.1f}%). Taking it is margin gained "
            f"with no change to the price the customer sees."
        )

    return ArbitrageResult(
        best=best, all_quotes=quotes,
        saving_against_worst=round(saving, 2),
        saving_pct=round(saving / landed(worst), 6) if landed(worst) else 0.0,
        rationale=rationale,
    )


def cheapest_payment_method(
    engine: ServiceChargeEngine,
    option: FareOption,
    *,
    methods: Iterable[PaymentMethod] = tuple(PaymentMethod),
    references: Iterable[Reference] = (),
) -> tuple[PaymentMethod, float]:
    """Which payment route costs us least, and what the spread is worth.

    On a large ticket the spread between a bank transfer and an international
    card exceeds the margin on the booking, which is why steering payment is a
    pricing decision rather than a finance one.
    """
    refs = list(references)
    costed = [(m, engine.quote(option, payment_method=m, references=refs).payment_cost)
              for m in methods]
    best = min(costed, key=lambda x: x[1])
    worst = max(costed, key=lambda x: x[1])
    return best[0], round(worst[1] - best[1], 2)
