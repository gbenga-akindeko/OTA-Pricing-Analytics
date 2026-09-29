# Competitor pricing and the service charge

How to get competitor prices with Amadeus, Sabre, NDC and Verteil, and how to
set a service charge that wins on price without giving away margin.

---

## 1. The thing to understand first

**Your four platforms are supply. They are not competitive intelligence.**

Amadeus, Sabre, direct NDC and Verteil all answer the same question: *what
does this ticket cost me, and what is bookable right now?* Not one of them can
answer *what is Wakanow showing on their website this morning?*

The reason is structural, not technical. Every OTA in Lagos selling a
published fare on LOS to LHR is buying from the same ATPCO-filed fare. The
number on their screen is that fare plus their private markup and their
payment cost. Their markup is a commercial decision held inside their own
system. No GDS will ever hand it to you, because no GDS has it.

So stop waiting for the GDS to tell you. What you do instead is build a
**reference ladder**: several estimates of what the customer can pay
elsewhere, each labelled with how much it deserves to be trusted.

---

## 2. What each platform actually gives you

| Platform | What it gives | Competitive value |
|---|---|---|
| **Amadeus** | Published and negotiated fares, availability, your net cost | The floor every competitor also buys from |
| **Sabre** | Same, and Bargain Finder Max returns the lowest bookable options per itinerary | Best single view of "the cheapest anyone can sell this for" |
| **NDC direct** | The airline's own retail offer: price, bundles, ancillaries | **A real competitor price.** The airline sells to your customer too |
| **Verteil** | NDC content aggregated across many carriers, one integration | The same competitor signal, at scale, without per-airline builds |

The fourth row is the one people miss. When you call Verteil or a direct NDC
connection, the offer that comes back is **what the airline itself would
charge that passenger**. That is not a proxy for a competitor. It *is* a
competitor, and on Nigerian long haul it is frequently the one that matters
most, because a shopper who finds you dearer than britishairways.com simply
books there.

---

## 3. The five ways to get a competitive reference

Ranked by how much you should trust each. The platform holds this ranking in
code, in `ReferenceKind`.

### Tier 1. Observed competitor price, confidence 1.00

An actual displayed price from an actual competitor. Two legitimate ways to
get it:

- **A licensed rate-shopping feed.** You pay, you get contractual rights to
  use it, and no argument follows. Budget USD 400 to 1,500 a month.
- **Metasearch partner reporting.** If you distribute on Wego, Skyscanner or
  Kayak, those channels report your position and often the winning price.
  That is competitor data handed to you under an existing contract, and most
  Nigerian OTAs on metasearch are already entitled to it and not collecting
  it. **Check what your metasearch partners already owe you before you buy
  anything.** This is the cheapest tier-1 data available to you.

### Tier 2. Airline direct, confidence 0.90

You already have this through NDC and Verteil. It costs you nothing extra and
it is a hard ceiling: price above the airline's own site and you lose the
booking to the airline.

### Tier 3. Metasearch winning price, confidence 0.85

The price that beat you, reported by the channel.

### Tier 4. GDS lowest plus an inferred markup, confidence 0.55

You know the lowest bookable fare from Bargain Finder Max or Amadeus Flight
Offers. Competitors are buying the same content. So:

```
estimated competitor price ≈ GDS lowest × (1 + typical markup + payment cost)
```

This is an inference and the platform labels it as one. Confidence 0.55 is
deliberately low enough that a recommendation resting on it alone will not
reach the P1 band. Calibrate the markup assumption by manually checking three
or four competitor sites once a fortnight and comparing.

### Tier 5. Your own conversion data, confidence varies

The most honest competitive signal there is, and it needs no competitor data
at all. If you raise price 3% and conversion falls 20%, you were at the edge.
Your own funnel tells you where the market is, and nobody can dispute it.

---

## 4. Where price advantage actually comes from

This is the part that matters commercially, and the order is not what most
people assume.

| Lever | Typical swing | Why |
|---|---|---|
| **1. Net fare** | 3 to 8% | Private fares, consolidator deals, NDC-only fares |
| **2. Source arbitrage** | 1 to 4% | Same flight, four channels, different landed cost |
| **3. Payment steering** | up to 3.9% | Transfer versus international card |
| **4. Ancillary bundling** | 2 to 6% | Include the bag they charge for |
| **5. Markup discipline** | 1 to 3% | The lever everyone reaches for first |

**You cannot win on markup alone.** Your whole markup is perhaps 7%. A
private fare can be worth more than that on its own. If you are losing on
price, the answer is almost never "cut the markup"; it is "get a better net"
or "stop paying 3.9% to a card processor".

### Source arbitrage is the free one

Same flight, four channels, four different landed costs. Here is the engine's
output on a real-shaped LOS to LHR economy fare:

```
CHANNEL          NET+TAX  CHAN COST     LANDED    CHARGE       SELL    MARGIN   MGN%
NDC_DIRECT       929,000     -6,810    923,390    69,300    998,300    74,810   7.5%
VERTEIL          937,000     -6,540    931,660    70,300  1,007,300    75,540   7.5%
AMADEUS          960,000     -4,460    956,740    74,400  1,034,400    77,560   7.5%
SABRE            963,000     -4,415    959,785    74,700  1,037,700    77,815   7.5%
```

NDC lands ₦36,395 cheaper than Sabre on the same flight. Selling from NDC
lets you show ₦998,300 instead of ₦1,037,700, a 3.8% price advantage, and
your margin percentage does not move at all.

**That is margin and price advantage at the same time, at no cost to
anybody.** Airlines price NDC below GDS deliberately, to push distribution
there. Take the offer.

One caution the engine handles for you: rank on **landed** cost, not headline
net. A GDS segment incentive is income. If Amadeus pays you ₦4,000 a segment
and NDC pays nothing, a fare ₦10,000 cheaper on NDC may still land dearer.
The code models the incentive as a negative cost for exactly this reason, and
there is a test pinning it.

### Payment steering is the overlooked one

On a ₦1,000,000 ticket:

| Method | Cost to you |
|---|---|
| Bank transfer | ₦100 |
| Local card | ₦2,000 (1.5%, capped) |
| International card | ₦39,000 (3.9%, uncapped) |

The spread between transfer and international card is **₦40,546** on the
worked example above. Your entire margin on that booking is ₦74,810. Payment
routing is therefore a pricing decision, not a finance one. Discounting for
transfer payment is often cheaper than discounting the fare.

---

## 5. The service charge formula

```
selling price = net fare + taxes + service charge
```

Taxes pass through untouched. The service charge carries everything else.

### The three boundaries

**Break-even.** Below this you lose money.

```
break-even = channel cost + ops cost + payment cost
```

Channel cost is signed. Where a GDS incentive exceeds your servicing cost,
break-even is negative, meaning the channel pays for the booking by itself.
The platform keeps that negative number rather than clamping it at zero,
because clamping makes two very different channels compare as equal and
destroys the arbitrage comparison.

**Target.** The charge that delivers your target margin, 7.5% by default.

**Competitive ceiling.** The largest charge that still leaves you visibly
cheaper than the binding reference:

```
ceiling = reference all-in × (1 − victory margin) + fee advantage − supplier payable
```

Two things in there earn their place:

- **Victory margin, 1.5% by default.** Matching exactly is not an advantage.
  A shopper scanning a list needs a visible gap, and a competitor repricing by
  one naira erases a tie.
- **Fee advantage.** What the competitor charges for things you include. If
  they charge ₦60,000 for a bag you bundle, you can hold ₦60,000 more on the
  shelf and still be cheaper all in. This is where true customer cost turns
  directly into margin.

### Which one binds

The engine starts at the target and lets each constraint bite:

```
target → capped by the competitive ceiling → floored at break-even and the
minimum charge → capped at the maximum markup
```

Every quote reports which constraint bound it. That one field tells you what
to do next:

| Binding constraint | What it means | What to do |
|---|---|---|
| `TARGET_MARGIN` | The market is generous here | Nothing. Consider testing higher |
| `COMPETITIVE_CEILING` | The market is tight | Look at a cheaper channel or a private fare |
| `BREAK_EVEN` | You are selling at cost | Stop selling this, or renegotiate the net |
| `MINIMUM_CHARGE` | A small fare | Correct. Servicing has a fixed cost |
| `MAX_CHARGE_CAP` | A captive route | Deliberate restraint. Review the cap |

### When you cannot both win and cover cost

The engine says so plainly rather than quietly selling at a loss:

> Cannot beat the reference and cover cost at the same time. The gap is in the
> net fare, not the markup: look for a private fare, a cheaper channel, or
> accept the loss of this booking.

That is the honest answer. A route where a competitor consistently beats you
below your own cost is a supplier problem, and the fix is in the contract, not
the pricing screen.

---

## 6. What to do on Monday

1. **Call your metasearch partners.** Ask what competitive position data your
   contract already entitles you to. This is the cheapest tier-1 competitor
   data available and most agencies never collect it.
2. **Start logging airline-direct prices from Verteil and NDC on every
   shop.** You already pay for these calls. Store the offer, not just the one
   you book. That is a free tier-2 reference building from today.
3. **Run the source arbitrage comparison on your last month of bookings.**
   For each ticket sold, what would the other three channels have cost? If the
   answer averages 2% or more, you have found money with no price change and
   no negotiation.
4. **Get your real numbers into the cost model.** Every figure in
   `DEFAULT_CHANNELS` and `DEFAULT_PAYMENTS` is a placeholder. Your Amadeus
   and Sabre segment incentives, your Verteil transaction fee, your PSP rates
   and your true ops cost per booking. Until those are right, every margin
   figure the platform produces is decorative.
5. **Price one route with the engine for two weeks** and compare against what
   the team would have done. Disagreements are how you calibrate.
6. **Then, and only then, buy a licensed competitor feed.** By that point you
   will know exactly which routes justify it, rather than paying for coverage
   of routes where airline-direct was sufficient.

---

## 7. Using it in code

```python
from fareiq.engine.service_charge import (
    Channel, FareOption, PaymentMethod, Reference, ReferenceKind,
    ServiceChargeEngine, choose_cheapest_source, infer_competitor_price,
)

engine = ServiceChargeEngine(target_margin_pct=0.075)

# The same flight, as it reaches you through each platform
options = [
    FareOption(Channel.AMADEUS,    net_fare=712_000, taxes=248_000, segments=2),
    FareOption(Channel.SABRE,      net_fare=715_000, taxes=248_000, segments=2),
    FareOption(Channel.NDC_DIRECT, net_fare=681_000, taxes=248_000, segments=2, included_bags=2),
    FareOption(Channel.VERTEIL,    net_fare=689_000, taxes=248_000, segments=2, included_bags=2),
]

references = [
    Reference(ReferenceKind.AIRLINE_DIRECT, 1_062_000, seller="VS"),  # from NDC
    infer_competitor_price(960_000),                                   # from Bargain Finder Max
]

result = choose_cheapest_source(
    engine, options,
    payment_method=PaymentMethod.TRANSFER,
    references=references,
    fee_advantage=60_000,      # the bag the competitor charges for
)

q = result.best
print(result.rationale)
print(f"Sell at {q.selling_price:,.0f} on {q.option.channel.value}")
print(f"Service charge {q.service_charge:,.0f}, margin {q.gross_margin_pct:.1%}")
print(f"Cheaper than {q.reference.seller} by {q.advantage_abs:,.0f}")
print(f"Bound by: {q.binding_constraint}")
```

Thirty tests cover this in `tests/test_service_charge.py`, including the cases
that matter commercially: never selling below cost, never matching a
competitor exactly instead of beating them, never chasing a price nobody has
observed, and never letting a headline net fare override a landed cost.

---

## 8. The compliance line

Everything above stays on the right side of it.

Using **your own GDS and NDC content** to understand the market is what that
content is for. Using **airline-direct offers you legitimately retrieved** as
a competitive reference is likewise ordinary commercial practice. Buying a
**licensed feed** is contractual. Reading **your own metasearch performance
reports** is your data.

What the platform will not do is scrape a competitor's site in breach of its
terms, circumvent any access control, or present inferred competitor prices as
observed ones. The confidence score on every reference exists precisely so
that an inference is never mistaken for a fact, including by your own team six
months from now.
