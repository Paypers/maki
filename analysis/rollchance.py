r"""The per-roll rule: make every roll whose chance of selling beats break-even.

THE RULE
--------
For roll k of an item -- the 1st, 2nd, 3rd ... made that day -- estimate

    S(k) = P(demand >= k)          the chance roll k sells

and make it exactly when

    S(k) >= break-even = (cost - salvage) / (price - salvage) = 1 - critical ratio

This is the newsvendor critical fractile (Arrow, Harris & Marschak 1951) read
one unit at a time. Roll k earns `price` if it sells and costs `cost` either
way, so its expected profit is price * S(k) - cost. S falls as k rises, so the
most profitable amount is the last roll for which that is still positive. With
no salvage, break-even is simply cost / price: a $2 roll that sells for $8 is
worth making if it sells one day in four.

ESTIMATING S(k) WHEN ITEMS SELL OUT
-----------------------------------
    S(k) = g(0) * g(1) * ... * g(k-1),    g(j) = P(demand >= j+1 | demand >= j)

g(j) is "the next roll sold, given the ones before it did". It is observed on
every day that made at least j+1 and sold at least j, whether or not the item
sold out. That is the Kaplan-Meier product-limit estimator (Kaplan & Meier
1958) on whole-unit demand, and it is what makes sell-out days usable: a
sell-out at 3 says rolls 1-3 sold and nothing about roll 4, and that is
exactly what it contributes. The old rule took a quantile of units SOLD, which
reads every sell-out as "demand was exactly this" and under-makes precisely
the items that sell out.

Days are weighted -- Beran's (1981) conditional Kaplan-Meier:

    same weekday 1.0, any other weekday 0.3      (the weekday, softly)
    half-life 3 weeks                            (recent weeks count most)

Each g(j) is pulled toward 0.5 -- hard where the operator's own choices skew
the record, lightly where they cannot:

    g(j) = (sold_j + m * 0.5) / (tried_j + m)

    m = 1   roll j+1 was made on nearly every day (90% of the weight or more)
    m = 5   roll j+1 was made only some days

Why two strengths. A roll made every day is tested every day, sold-out or not,
so its record is fair and needs little help. A roll made only SOMETIMES was
made on the days the operator expected to be busy, so its record is flattering
-- it was tested mostly when it was likely to sell. Pulling those toward 0.5
corrects for that; pulling every roll the same way would compound up the
ladder and starve an item made ten a day.

The 0.5 is anchored on a measurement: every time the operator made more of an
item than on its previous three same weekdays and the usual amount would have
sold out, the next roll sold 57-58% of the time -- in both halves of the record
separately. Those were the operator's own chosen days, so the rule assumes a
little less than it saw. A roll never tried at all gets half the chance the one
before it sold. `analysis/evidence.extra_roll_rate` re-measures the 57-58%.

TAKING THE RISK, ONE STEP AT A TIME
-----------------------------------
A roll above anything made recently is a test: if it sells, the record learns
demand that sell-outs can never show. The rule makes one only when

  * the item SOLD OUT on a recent day that made that most -- the ceiling was
    hit, so there is something to find out -- and
  * its estimated chance clears break-even,

and never more than ONE above the most made of that item in the last week or
on the last two same weekdays. Two results support it:

  * Ding, Puterman & Bisi (2002): when sales are censored, the best amount is
    HIGHER than the one that looks best today, because a roll that sells out
    teaches you nothing and a test roll does.
  * Huh & Rusmevichientong (2009) and Huh, Levi, Rusmevichientong & Orlin
    (2011): ordering rules that learn only from sales -- one by small steps,
    one from the Kaplan-Meier estimate -- provably converge to the amount you
    would choose if demand were known.

HOW THE SETTINGS WERE CHOSEN
----------------------------
On profit, scored honestly (analysis/evidence.py): exact wherever the rule
made no more than was actually made or the day had leftovers, and a range
elsewhere. About a hundred settings were scored on Jun 5 - Jul 31 under two
assumptions for the rolls nobody could observe (58% and a pessimistic 45%);
these were among the best under both, and were then checked on Aug 1 - Sep 21,
which they were not chosen on.

Calibration -- did rolls predicted at X% sell X% of the time -- is reported
too, but it did NOT choose anything: it can only check rolls the operator
decided to make, and the operator makes extra on days they expect to be busy.
A test that shares that blind spot cannot catch it. Profit on leftover days
can: a roll added on a day with leftovers is a known failure.

AMBITION: CLIMBING WHEN THE SELL-OUTS ARE REAL
----------------------------------------------
On its own the rule above is timid. When an item's demand doubles, following
it exactly still leaves it one or two rolls short after two months (85% of
the best profit, in simulation): every roll it has not seen sell starts at
50/50 and each sell-out is one day of proof against five of doubt.

So a climber sits on top, and it has an activation point:

  * Evidence: the item's last 8 days of the same kind (promo days apart
    from the rest) that made at least today's base amount. At least 3.
  * Popularity: how often an extra roll sold after the usual sold out,
    MEASURED on this kiosk by how much the item sells --
        under 1 a day 42%,   1-2 a day 62%,   2+ a day 70%.
  * Confidence: from how many of those days sold out (a Beta posterior on
    the sell-out rate, uniform prior), the probability that extra roll k
    sells at least break-even of the time:
        P( sell-out rate x continuation^k >= break-even )
  * It climbs k rolls when that probability clears the ambition level's
    bar -- and never more than the level's limit, and never more extra rolls
    across the whole case than the level's daily budget (the best bets first).

        level      sure it pays   up to   extra rolls a day
        1 careful      --           0          0       (the rule alone)
        2 cautious    90%          +1          4
        3 balanced    75%          +2          8       (default)
        4 bold        60%          +3         12
        5 max         50%          +3         16

One sell-out on a slow item cannot reach the bar; the same run of sell-outs
on a popular item can. In simulation, balanced lifts a doubling item from 85%
to 93% of the best profit and costs nothing when demand is steady; max
starts to cost on slow items -- which is what the app's ambition check is
there to catch. The climbing is sell-out driven, the one signal a sell-out
never hides (Huh & Rusmevichientong 2009 prove sell-out-driven ordering
converges to the profit-best amount).

This module is the reference implementation. `web/src/lib/model.ts` is a port
and must agree exactly; the shared cases in
`web/src/lib/fixtures/roll_chance_cases.json` are checked by both suites.
"""

from __future__ import annotations

import datetime
import math
from dataclasses import dataclass, field

from .data import History, Observation, isoweekday
from .policies import DayContext

#: Weight of a day on a different weekday from the one being planned.
OTHER_WEEKDAY = 0.3
#: A day this many weeks old counts half as much as yesterday.
HALF_LIFE_WEEKS = 3.0
#: Chance the next roll sells, given the ones before it did, where the record
#: has little or nothing on that roll. Measured at 57-58%; see the docstring.
PRIOR_CONTINUATION = 0.5
#: How many days of evidence that is worth for a roll made only some days...
PRIOR_STRENGTH = 5.0
#: ...and for a roll made on nearly every day, whose record is fair.
PRIOR_STRENGTH_DAILY = 1.0
#: "Nearly every day": this share of the weighted days made at least that many.
DAILY_SHARE = 0.9
#: Below a week of an item on record, the rule has no opinion and the
#: operator's own plan stands: a new item is theirs to judge.
MIN_DAYS = 7
#: At most this many rolls above the most made recently.
STEP = 1
#: "Recently": the item's last 7 recorded days and its last 2 same weekdays.
RECENT_DAYS = 7
RECENT_SAME_WEEKDAYS = 2
#: An item still on the menu is stocked, not delisted by a calculation.
FLOOR = 1

#: Ambition levels: (how sure extra rolls must be to pay, most rolls above
#: the base, most extra rolls across the case in a day). 1 never climbs.
AMBITION: dict[int, tuple[float, int, int] | None] = {
    1: None,
    2: (0.90, 1, 4),
    3: (0.75, 2, 8),
    4: (0.60, 3, 12),
    5: (0.50, 3, 16),
}
AMBITION_NAMES = {1: "careful", 2: "cautious", 3: "balanced", 4: "bold", 5: "max"}
DEFAULT_AMBITION = 3
#: The climber looks at this many recent days of the same kind...
CLIMB_WINDOW = 8
#: ...and needs at least this many of them to say anything.
CLIMB_MIN_DAYS = 3
#: Popularity: average sold per day over the item's last this-many days.
POPULARITY_DAYS = 28
#: Measured on this kiosk: after the usual amount sold out, how often the next
#: roll sold, by popularity. (upper bound of sold per day, chance)
CONTINUATION = ((1.0, 0.42), (2.0, 0.62), (math.inf, 0.70))

VERSION = (f"2.1.0-o{OTHER_WEEKDAY:g}-h{HALF_LIFE_WEEKS:g}-p{PRIOR_CONTINUATION:g}"
           f"-m{PRIOR_STRENGTH:g}/{PRIOR_STRENGTH_DAILY:g}@{DAILY_SHARE:g}-s{STEP}-f{FLOOR}"
           f"-c{CLIMB_WINDOW}/{CLIMB_MIN_DAYS}")


@dataclass(frozen=True)
class Climb:
    """Why the climber did, or did not, add rolls today."""

    #: Rolls added on top of the base amount, before the daily budget.
    steps: int
    #: Recent days of the same kind that made at least the base...
    days: int
    #: ...and how many of them sold out.
    sold_out: int
    #: Average sold per day lately, and the measured chance that goes with it.
    popularity: float
    continuation: float
    #: Probability the first extra roll pays (0 when there was no evidence).
    confidence: float
    #: The chance each added roll is expected to sell, best first.
    edges: tuple[float, ...] = field(default=())


@dataclass(frozen=True)
class Ladder:
    """Everything the rule knows about one item on one day."""

    #: chances[k-1] = estimated chance roll k sells, k = 1 .. len(chances)
    chances: tuple[float, ...]
    #: (weighted days roll k was tried given k-1 sold, of which it sold)
    evidence: tuple[tuple[float, float], ...]
    break_even: float | None
    quantity: int | None
    #: The most made of this item recently; above it is untested.
    recent_max: int
    #: True when `quantity` goes above `recent_max`: a deliberate test roll.
    testing: bool
    days: int
    #: What the rule alone says, before any climbing.
    base: int | None = None
    climb: Climb | None = None

    def chance(self, k: int) -> float:
        """Chance roll k sells. Roll 0 always "sells"; past the ladder, 0."""
        if k <= 0:
            return 1.0
        return self.chances[k - 1] if k <= len(self.chances) else 0.0


def _days_between(a: str, b: str) -> int:
    return (datetime.date.fromisoformat(b) - datetime.date.fromisoformat(a)).days


def weights(date: str, rows: list[Observation]) -> list[float]:
    """How much each past day counts toward `date`. Pure; the app matches it."""
    wd = isoweekday(date)
    out = []
    for o in rows:
        recency = 0.5 ** (_days_between(o.date, date) / (7.0 * HALF_LIFE_WEEKS))
        out.append(recency * (1.0 if isoweekday(o.date) == wd else OTHER_WEEKDAY))
    return out


def chances(rows: list[Observation], w: list[float], top: int
            ) -> tuple[list[float], list[tuple[float, float]]]:
    """S(1..top) by the shrunk, weighted product-limit estimator."""
    total = sum(w)
    s_k = 1.0
    out: list[float] = []
    evidence: list[tuple[float, float]] = []
    for j in range(top):
        made = tried = sold = 0.0
        for o, wt in zip(rows, w):
            if o.supply >= j + 1:
                made += wt
                # Roll j+1 existed and the j before it all sold: a real test.
                if o.sold >= j:
                    tried += wt
                    if o.sold >= j + 1:
                        sold += wt
        m = PRIOR_STRENGTH_DAILY if made >= DAILY_SHARE * total else PRIOR_STRENGTH
        g = (sold + m * PRIOR_CONTINUATION) / (tried + m)
        s_k *= g
        out.append(s_k)
        evidence.append((tried, sold))
    return out, evidence


def _recent(date: str, rows: list[Observation]) -> list[Observation]:
    wd = isoweekday(date)
    same = [o for o in rows if isoweekday(o.date) == wd][-RECENT_SAME_WEEKDAYS:]
    return rows[-RECENT_DAYS:] + same


def recent_max(date: str, rows: list[Observation]) -> int:
    return int(max((o.supply for o in _recent(date, rows)), default=0))


def hit_the_ceiling(date: str, rows: list[Observation], ceiling: int) -> bool:
    """Did the item sell out on a recent day that made the recent maximum?
    Only then is a roll above it a test worth paying for: if the most you made
    lately came back with leftovers, one more tells you nothing you need."""
    return any(o.censored and o.supply > 0 and o.supply >= ceiling
               for o in _recent(date, rows))


def beta_tail(a: int, b: int, x: float) -> float:
    """P(Beta(a, b) >= x) for whole a, b: exactly P(Binomial(a+b-1, x) <= a-1)."""
    if x <= 0:
        return 1.0
    if x >= 1:
        return 0.0
    n = a + b - 1
    return sum(math.comb(n, j) * x ** j * (1 - x) ** (n - j) for j in range(a))


def popularity(rows: list[Observation]) -> float:
    recent = rows[-POPULARITY_DAYS:]
    return sum(o.sold for o in recent) / len(recent) if recent else 0.0


def continuation_for(pop: float) -> float:
    for upper, chance in CONTINUATION:
        if pop < upper:
            return chance
    return CONTINUATION[-1][1]


def climb_for(date: str, rows: list[Observation], base: int, break_even: float,
              ambition: int, promo_weekdays: tuple[int, ...] = ()) -> Climb:
    """The activation point. See the module docstring."""
    pop = popularity(rows)
    cont = continuation_for(pop)
    promo = isoweekday(date) in promo_weekdays
    same_kind = [o for o in rows if (isoweekday(o.date) in promo_weekdays) == promo]
    ev = [o for o in same_kind[-CLIMB_WINDOW:] if o.supply >= max(1, base)]
    sold_out = sum(1 for o in ev if o.censored)
    level = AMBITION.get(ambition)
    if level is None or len(ev) < CLIMB_MIN_DAYS:
        return Climb(0, len(ev), sold_out, pop, cont, 0.0)
    sure, most, _budget = level
    a, b = 1 + sold_out, 1 + len(ev) - sold_out
    first = beta_tail(a, b, break_even / cont)
    steps = 0
    for k in range(1, most + 1):
        if beta_tail(a, b, break_even / cont ** k) >= sure:
            steps = k
        else:
            break
    mean = a / (a + b)
    return Climb(steps, len(ev), sold_out, pop, cont, first,
                 tuple(mean * cont ** k for k in range(1, steps + 1)))


def ladder_for(date: str, rows: list[Observation], break_even: float | None,
               ambition: int = DEFAULT_AMBITION,
               promo_weekdays: tuple[int, ...] = ()) -> Ladder:
    """The rule for one item. `rows` must be strictly before `date`, oldest first."""
    if len(rows) < MIN_DAYS:
        return Ladder((), (), break_even, None, 0, False, len(rows))
    w = weights(date, rows)
    cap = recent_max(date, rows)
    # Every roll the record has touched, plus the ones the cap could reach.
    # Past that nothing was ever made, so each further roll is exactly the
    # prior times the one before -- which is how the app extends the ladder
    # to quote the chance of any number typed into the box.
    top = max(cap + STEP + 1, max(int(o.supply) + 1 for o in rows))
    s, evidence = chances(rows, w, top)
    if break_even is None:
        return Ladder(tuple(s), tuple(evidence), None, None, cap, False, len(rows))
    q = sum(1 for p in s if p >= break_even)
    q = min(q, cap + (STEP if hit_the_ceiling(date, rows, cap) else 0))
    if q < FLOOR and any(o.supply > 0 for o in rows[-10:]):
        q = FLOOR
    climb = climb_for(date, rows, q, break_even, ambition, promo_weekdays)
    total = q + climb.steps
    return Ladder(tuple(s), tuple(evidence), break_even, total, cap, total > cap, len(rows),
                  base=q, climb=climb)


def apply_budget(ladders: dict[str, Ladder], ambition: int) -> dict[str, int]:
    """Climbing rolls across the whole case, best bets first, within the
    level's daily budget. Returns the quantity per item after the budget."""
    level = AMBITION.get(ambition)
    out = {k: lad.quantity for k, lad in ladders.items() if lad.quantity is not None}
    if level is None:
        return out
    budget = level[2]
    bets = []
    for key, lad in ladders.items():
        if lad.climb is None or lad.base is None or lad.break_even is None:
            continue
        for j, chance in enumerate(lad.climb.edges, start=1):
            bets.append((-(chance - lad.break_even), key, j))
    keep = {(key, j) for _, key, j in sorted(bets)[:budget]}
    for key, lad in ladders.items():
        if lad.climb is None or lad.base is None:
            continue
        allowed = 0
        while (key, allowed + 1) in keep:
            allowed += 1
        out[key] = lad.base + allowed
    return out


def break_even_for(ctx: DayContext, item: str) -> float | None:
    try:
        return 1.0 - ctx.costs.critical_ratio(item, ctx.date)
    except (KeyError, ValueError):
        return None


class RollChance:
    """The deployed rule. Same object the prep sheet and the backtest use."""

    name = "roll_chance"

    def __init__(self, ambition: int = DEFAULT_AMBITION):
        if ambition not in AMBITION:
            raise ValueError(f"ambition must be 1-5, not {ambition!r}")
        self.ambition = ambition
        self.version = f"{VERSION}-a{ambition}"

    def ladder(self, ctx: DayContext, item: str) -> Ladder:
        return ladder_for(ctx.date, ctx.history.for_item(item), break_even_for(ctx, item),
                          self.ambition, tuple(ctx.costs.promo_weekdays))

    def recommend(self, ctx: DayContext) -> dict[str, float]:
        ladders = {item: self.ladder(ctx, item) for item in ctx.items}
        budgeted = apply_budget(ladders, self.ambition)
        return {item: float(budgeted[item]) if item in budgeted else float("nan")
                for item in ctx.items}


def ordinal(n: int) -> str:
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def pct(p: float) -> str:
    return f"{round(100 * p)}%"


def history_for(observations: list[Observation], date: str) -> History:
    return History([o for o in observations if o.date < date])
