r"""The evidence behind the per-roll rule, recomputable on any record.

Three measurements, each chosen because it can be made honestly on censored
data.

1. EXTRA-ROLL RATE -- the rule's one borrowed number.
   Every time the operator made more of an item than on any of its previous
   three same weekdays, and the usual amount would have sold out anyway, did
   the next roll sell? Model-free: it only counts what happened. It anchors
   `rollchance.PRIOR_CONTINUATION`, and re-running it is how to tell whether
   that number has gone stale.

2. CALIBRATION -- are the predicted chances right?
   For every roll the operator actually made, "did roll k sell" is observed
   with no assumption: sold >= k. So each predicted chance can be checked
   against what happened, walk-forward, sold-out days included. A rule whose
   chances are right makes the most money on average by construction -- that
   is the newsvendor theorem.

   Its blind spot: it only sees rolls the operator chose to make, and the
   operator makes extra on days they expect to be busy. So it cannot show
   whether an EXTRA roll on an ordinary day would sell. That is why it is a
   check here and not what the settings were chosen on.

3. PROFIT, WITH THE UNKNOWN SHOWN AS A RANGE.
   Profit is exact wherever a rule makes no more than was actually made, or
   the day had leftovers. Only rolls ABOVE supply on a sold-out day are
   unknown, and those get three numbers: none sold (low), all sold (high), and
   an estimate that each sells with the measured extra-roll rate given the one
   before it did. The estimate is labelled as one everywhere it is printed.
   A roll added on a day that had leftovers is a KNOWN failure, which is what
   lets this catch a rule that adds rolls where they do not sell.

Nothing here is used to make a recommendation. It is how a recommendation
earns trust, and how a change to the rule is accepted or refused.
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict
from dataclasses import dataclass, field

from .costs import CostConfig
from .data import History, Observation, isoweekday
from .policies import DayContext, Policy
from .rollchance import MIN_DAYS, chances, weights


# ------------------------------------------------------------- extra rolls --

@dataclass(frozen=True)
class ExtraRollRate:
    sold: int
    tried: int

    @property
    def rate(self) -> float:
        return self.sold / self.tried if self.tried else float("nan")


def extra_roll_rate(observations: list[Observation], *, start: str | None = None,
                    end: str | None = None, lookback: int = 3) -> ExtraRollRate:
    """How often the first roll above the recent maximum sold, given the
    usual amount would have sold out. See the module docstring."""
    by_item: dict[str, list[Observation]] = defaultdict(list)
    for o in sorted(observations, key=lambda o: o.date):
        by_item[o.item_key].append(o)
    sold = tried = 0
    for rows in by_item.values():
        for i, o in enumerate(rows):
            if (start and o.date < start) or (end and o.date > end):
                continue
            prev = [r for r in rows[:i] if isoweekday(r.date) == isoweekday(o.date)][-lookback:]
            if len(prev) < lookback:
                continue
            usual = max(r.supply for r in prev)
            if o.supply <= usual or o.sold < usual:
                continue
            tried += 1
            sold += o.sold >= usual + 1
    return ExtraRollRate(sold, tried)


# ------------------------------------------------------------- calibration --

@dataclass
class Calibration:
    #: (predicted chance, 1.0 if that roll sold else 0.0), one per roll made
    pairs: list[tuple[float, float]] = field(default_factory=list)

    @property
    def n(self) -> int:
        return len(self.pairs)

    def zone(self, lo: float = 0.1, hi: float = 0.4) -> tuple[float, float, int]:
        """Mean predicted vs actual for rolls predicted in [lo, hi) -- the
        band where break-even sits, so the band where errors cost money."""
        z = [(p, y) for p, y in self.pairs if lo <= p < hi]
        if not z:
            return float("nan"), float("nan"), 0
        return sum(p for p, _ in z) / len(z), sum(y for _, y in z) / len(z), len(z)

    @property
    def log_loss(self) -> float:
        if not self.pairs:
            return float("nan")
        eps = 1e-4
        return -sum(y * math.log(min(max(p, eps), 1 - eps))
                    + (1 - y) * math.log(min(max(1 - p, eps), 1 - eps))
                    for p, y in self.pairs) / len(self.pairs)

    def bins(self, width: float = 0.1) -> list[tuple[float, float, float, int]]:
        """(bin low, mean predicted, actual, n) per chance band."""
        acc: dict[int, list[tuple[float, float]]] = defaultdict(list)
        top = int(round(1 / width)) - 1
        for p, y in self.pairs:
            acc[min(top, int(p / width))].append((p, y))
        return [(b * width, sum(p for p, _ in v) / len(v), sum(y for _, y in v) / len(v), len(v))
                for b, v in sorted(acc.items())]


def calibration(observations: list[Observation], *, start: str, end: str) -> Calibration:
    """Walk-forward: predict every roll the operator made, from prior days only."""
    by_item: dict[str, list[Observation]] = defaultdict(list)
    for o in sorted(observations, key=lambda o: o.date):
        by_item[o.item_key].append(o)
    out = Calibration()
    for rows in by_item.values():
        for i, o in enumerate(rows):
            if not (start <= o.date <= end):
                continue
            prior = [r for r in rows[:i] if r.date < o.date]
            if len(prior) < MIN_DAYS:
                continue
            # The same estimator the rule uses, carried as high as this day went.
            s, _ = chances(prior, weights(o.date, prior), int(o.supply))
            for k in range(1, int(o.supply) + 1):
                out.pairs.append((s[k - 1], 1.0 if o.sold >= k else 0.0))
    return out


# ----------------------------------------------------------------- profit --

@dataclass(frozen=True)
class Outcome:
    made: float
    sold_low: float
    sold_est: float
    sold_high: float
    #: rolls above supply on a sold-out day: nobody knows if they would sell
    unseen: float


def outcome(q: float, obs: Observation, continuation: float) -> Outcome:
    s, y = obs.supply, obs.sold
    if not obs.censored:
        sold = min(q, y)
        return Outcome(q, sold, sold, sold, 0.0)
    if q <= s:
        return Outcome(q, q, q, q, 0.0)
    extra = int(round(q - s))
    est, run = s, 1.0
    for _ in range(extra):
        run *= continuation
        est += run
    return Outcome(q, s, est, q, float(extra))


@dataclass
class Tally:
    days: set = field(default_factory=set)
    made: float = 0.0
    left_low: float = 0.0      # fewest left over (all unseen rolls sold)
    left_est: float = 0.0
    left_high: float = 0.0
    profit_low: float = 0.0
    profit_est: float = 0.0
    profit_high: float = 0.0
    unseen: float = 0.0
    no_opinion: int = 0

    def per_day(self, attr: str) -> float:
        return getattr(self, attr) / len(self.days) if self.days else 0.0


@dataclass
class Comparison:
    rules: dict[str, Tally]
    you: Tally
    by_item: dict[str, dict[str, Counter]]


def compare(observations: list[Observation], rules: list[Policy], costs: CostConfig, *,
            start: str, end: str, continuation: float) -> Comparison:
    """Every rule against the same days, and against what was really made.

    Where a rule has no opinion the operator's own number stands in -- which is
    what the app does -- and the count of such item-days is reported.
    """
    by_date: dict[str, list[Observation]] = defaultdict(list)
    for o in observations:
        by_date[o.date].append(o)
    tallies = {r.name: Tally() for r in rules}
    you = Tally()
    by_item: dict[str, dict[str, Counter]] = defaultdict(lambda: defaultdict(Counter))
    for date in sorted(by_date):
        if not (start <= date <= end):
            continue
        history = History([o for o in observations if o.date < date])
        today = {o.item_key: o for o in by_date[date]}
        ctx = DayContext(date=date, items=tuple(sorted(today)), history=history, costs=costs)
        for o in today.values():
            try:
                p, c = costs.price(o.item_key, date), costs.unit_cost(o.item_key)
            except KeyError:
                continue
            you.days.add(date)
            _add(you, Outcome(o.supply, o.sold, o.sold, o.sold, 0.0), p, c)
            by_item[o.item_key]["you"].update(profit=p * o.sold - c * o.supply,
                                              made=o.supply, left=o.supply - o.sold)
        for rule in rules:
            recs = rule.recommend(ctx)
            t = tallies[rule.name]
            for item, o in today.items():
                try:
                    p, c = costs.price(item, date), costs.unit_cost(item)
                except KeyError:
                    continue
                q = recs.get(item, float("nan"))
                if q is None or q != q:
                    q = o.supply
                    t.no_opinion += 1
                t.days.add(date)
                out = outcome(q, o, continuation)
                _add(t, out, p, c)
                by_item[item][rule.name].update(
                    profit_low=p * out.sold_low - c * q, profit_est=p * out.sold_est - c * q,
                    profit_high=p * out.sold_high - c * q, made=q, left_est=q - out.sold_est)
    return Comparison(tallies, you, by_item)


def _add(t: Tally, out: Outcome, price: float, cost: float) -> None:
    t.made += out.made
    t.left_low += out.made - out.sold_high
    t.left_est += out.made - out.sold_est
    t.left_high += out.made - out.sold_low
    t.profit_low += price * out.sold_low - cost * out.made
    t.profit_est += price * out.sold_est - cost * out.made
    t.profit_high += price * out.sold_high - cost * out.made
    t.unseen += out.unseen
