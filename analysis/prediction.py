"""Write a prediction down before the day, then score it against the day.

The point of this module is discipline, not cleverness. A model that is only
ever compared with what happened after the fact drifts into looking right. So
the prediction is committed to a file before the shift starts, with its
interval, and the comparison is a separate step that reads that file back.

WHAT IS PREDICTED
-----------------
Given the plan the operator is about to make, every quantity here is "what
this plan would sell". Not "what demand will be" -- demand above the plan is
invisible, so a prediction of it could never be checked. The method is the
plainest one that respects that:

    for each of the last N same-weekday days, apply TODAY'S plan item by item
    against what that day actually sold, take min(plan, sold), and sum.

That yields N numbers for "this plan, on a day like that". Their mean is the
point prediction and their spread is the interval. It is a floor, and it is
stated as one: on any historical day an item sold out, its true demand was
higher than the figure used here.

THE INTERVAL
------------
A t-based prediction interval: mean +/- t(n-1) * s * sqrt(1 + 1/n). The
sqrt(1 + 1/n) matters -- it is the difference between "where is the mean" and
"where will the next day land", and at n=8 forgetting it makes every interval
about 6% too narrow. Two bands are recorded, 68% and 95%, because one day
either lands inside or it does not, and the only honest verdict from a single
day is a tally entry: over many days, about 68% should fall in the first band
and 95% in the second. That tally is the accuracy claim. Nothing else is.

WHAT ONE DAY CAN SAY
--------------------
Landing outside the 95% band is a 1-in-20 event and worth a look. Landing
inside proves nothing on its own. Both are true, and the scoring output says
which happened without pretending either is a verdict.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import math
import statistics as st
from typing import Iterable

from .costs import CostConfig
from .data import Observation, isoweekday

WINDOW = 8
MIN_DAYS = 4

# t critical values, two-sided, indexed by degrees of freedom. Only the sizes
# this module can produce (n = 4..8 -> df = 3..7). Hard-coded rather than
# pulling in scipy for five numbers.
_T68 = {3: 1.197, 4: 1.142, 5: 1.111, 6: 1.091, 7: 1.077}
_T95 = {3: 3.182, 4: 2.776, 5: 2.571, 6: 2.447, 7: 2.365}


@dataclasses.dataclass
class Interval:
    point: float
    lo68: float
    hi68: float
    lo95: float
    hi95: float
    n: int
    sd: float

    def contains68(self, x: float) -> bool:
        return self.lo68 <= x <= self.hi68

    def contains95(self, x: float) -> bool:
        return self.lo95 <= x <= self.hi95


def interval(values: list[float], lo_cap: float = 0.0,
             hi_cap: float | None = None) -> Interval:
    """A t prediction interval for the next draw, clamped to what is possible."""
    n = len(values)
    if n < 2:
        v = values[0] if values else 0.0
        return Interval(v, v, v, v, v, n, 0.0)
    m = st.mean(values)
    s = st.stdev(values)
    df = min(max(n - 1, 3), 7)
    w68 = _T68[df] * s * math.sqrt(1 + 1 / n)
    w95 = _T95[df] * s * math.sqrt(1 + 1 / n)

    def clamp(x: float) -> float:
        x = max(lo_cap, x)
        return min(hi_cap, x) if hi_cap is not None else x

    return Interval(m, clamp(m - w68), clamp(m + w68),
                    clamp(m - w95), clamp(m + w95), n, s)


@dataclasses.dataclass
class ItemPrediction:
    item: str
    plan: float
    sold: Interval
    # Share of comparable days on which this plan would have run out.
    sellout_share: float


@dataclasses.dataclass
class DayPrediction:
    date: str
    weekday: str
    plan_name: str
    made_at: str
    # Days the prediction rests on, oldest first.
    basis_dates: list[str]
    plan: dict[str, float]
    total_made: float
    sold: Interval
    wasted: Interval
    waste_pct: Interval
    revenue: Interval
    sellouts: Interval
    items: list[ItemPrediction]
    notes: list[str]

    def to_json(self) -> dict:
        return dataclasses.asdict(self)


def predict_day(date: str, plan: dict[str, float], observations: Iterable[Observation],
                costs: CostConfig, *, plan_name: str = "profit",
                window: int = WINDOW, now: str | None = None) -> DayPrediction:
    """What `plan` would sell on `date`, from same-weekday days before it."""
    wd = isoweekday(date)
    before = [o for o in observations if o.date < date]
    plan = {k: float(v) for k, v in plan.items() if v}

    # Comparable days: same weekday, strictly before, and counted (the loader
    # already drops uncounted days). Oldest first, capped to the window.
    basis = sorted({o.date for o in before if isoweekday(o.date) == wd})[-window:]
    if len(basis) < MIN_DAYS:
        raise ValueError(f"only {len(basis)} comparable {date} weekdays on record; "
                         f"need {MIN_DAYS}")

    by_day = {d: {o.item_key: o for o in before if o.date == d} for d in basis}

    per_day_sold, per_day_rev, per_day_sellouts = [], [], []
    per_item: dict[str, list[float]] = {k: [] for k in plan}
    per_item_sellout: dict[str, int] = {k: 0 for k in plan}
    for d in basis:
        day = by_day[d]
        sold_total = rev = 0.0
        sellouts = 0
        for item, n in plan.items():
            o = day.get(item)
            if o is None:
                # Not made that day: no information. Treated as zero sold,
                # which understates -- consistent with everything else here
                # being a floor.
                per_item[item].append(0.0)
                continue
            s = min(n, o.sold)
            per_item[item].append(s)
            sold_total += s
            rev += s * costs.price(item, date)
            if o.sold >= n:
                sellouts += 1
                per_item_sellout[item] += 1
        per_day_sold.append(sold_total)
        per_day_rev.append(rev)
        per_day_sellouts.append(float(sellouts))

    total = sum(plan.values())
    sold = interval(per_day_sold, 0, total)
    wasted = Interval(total - sold.point, total - sold.hi68, total - sold.lo68,
                      total - sold.hi95, total - sold.lo95, sold.n, sold.sd)
    waste_pct = Interval(*(100 * x / total for x in (
        wasted.point, wasted.lo68, wasted.hi68, wasted.lo95, wasted.hi95)),
        sold.n, 100 * sold.sd / total)

    items = [ItemPrediction(item=k, plan=n,
                            sold=interval(per_item[k], 0, n),
                            sellout_share=per_item_sellout[k] / len(basis))
             for k, n in plan.items()]

    notes = [
        "Every figure is a FLOOR: on any basis day an item sold out, its true "
        "demand was above what is used here.",
        "Per-item predictions on one-to-four-unit items are mostly noise; the "
        "day totals are the testable claims.",
    ]
    censored = sum(1 for d in basis for o in by_day[d].values() if o.censored and o.supply > 0)
    total_obs = sum(len(by_day[d]) for d in basis)
    if total_obs:
        notes.append(f"{100 * censored / total_obs:.0f}% of basis item-days sold out.")

    return DayPrediction(
        date=date, weekday=dt.date.fromisoformat(date).strftime("%A"),
        plan_name=plan_name,
        made_at=now or dt.datetime.now().replace(microsecond=0).isoformat(),
        basis_dates=basis, plan=plan, total_made=total,
        sold=sold, wasted=wasted, waste_pct=waste_pct,
        revenue=interval(per_day_rev, 0),
        sellouts=interval(per_day_sellouts, 0, len(plan)),
        items=items, notes=notes,
    )


# ------------------------------------------------------------------ scoring --

@dataclasses.dataclass
class Scored:
    name: str
    predicted: float
    actual: float
    in68: bool
    in95: bool
    # (actual - point) / sd; NaN when the interval has no width.
    z: float


@dataclasses.dataclass
class DayScore:
    date: str
    made_matches_plan: bool
    actual_made: float
    quantities: list[Scored]
    items_in_range: int
    items_total: int
    item_misses: list[tuple[str, float, float, float]]   # item, plan, predicted, actual

    def tally(self) -> tuple[int, int, int]:
        """(scored, inside 68, inside 95) over the day-level quantities."""
        return (len(self.quantities),
                sum(1 for q in self.quantities if q.in68),
                sum(1 for q in self.quantities if q.in95))


def _score_one(name: str, iv: Interval, actual: float) -> Scored:
    z = (actual - iv.point) / iv.sd if iv.sd > 0 else float("nan")
    return Scored(name, iv.point, actual, iv.contains68(actual), iv.contains95(actual), z)


def score_day(pred: DayPrediction, actual: list[Observation],
              costs: CostConfig) -> DayScore:
    """Compare a stored prediction with the day as recorded."""
    day = {o.item_key: o for o in actual if o.date == pred.date}
    if not day:
        raise ValueError(f"no counted observations for {pred.date}")

    made = sum(o.supply for o in day.values())
    sold = sum(o.sold for o in day.values())
    wasted = made - sold
    rev = sum(o.sold * costs.price(k, pred.date) for k, o in day.items())
    sellouts = sum(1 for o in day.values() if o.censored and o.supply > 0)

    quantities = [
        _score_one("sold", pred.sold, sold),
        _score_one("wasted", pred.wasted, wasted),
        _score_one("waste_pct", pred.waste_pct, 100 * wasted / made if made else 0.0),
        _score_one("revenue", pred.revenue, rev),
        _score_one("sellouts", pred.sellouts, float(sellouts)),
    ]

    in_range = 0
    misses = []
    for ip in pred.items:
        o = day.get(ip.item)
        a = o.sold if o else 0.0
        if ip.sold.contains95(a):
            in_range += 1
        else:
            misses.append((ip.item, ip.plan, ip.sold.point, a))

    plan_made = pred.total_made
    return DayScore(date=pred.date,
                    made_matches_plan=abs(made - plan_made) < 0.5,
                    actual_made=made, quantities=quantities,
                    items_in_range=in_range, items_total=len(pred.items),
                    item_misses=misses)


# ------------------------------------------------------------- rendering ----

def render_prediction(p: DayPrediction, order: list[str] | None = None) -> str:
    def band(iv: Interval, unit: str = "", dp: int = 0) -> str:
        f = lambda x: f"{x:.{dp}f}"
        return (f"{f(iv.point)}{unit}   68%: {f(iv.lo68)}–{f(iv.hi68)}{unit}"
                f"   95%: {f(iv.lo95)}–{f(iv.hi95)}{unit}")

    L = []
    L.append(f"# Prediction — {p.weekday} {p.date}")
    L.append("")
    L.append(f"Plan: **{p.plan_name}**, {p.total_made:.0f} units. "
             f"Written {p.made_at}, before the day.")
    L.append(f"Basis: the last {len(p.basis_dates)} counted {p.weekday}s "
             f"({p.basis_dates[0]} … {p.basis_dates[-1]}), with today's plan "
             f"applied to each.")
    L.append("")
    L.append("## Day totals (the testable claims)")
    L.append("")
    L.append("| quantity | prediction | 68% band | 95% band |")
    L.append("|---|---|---|---|")
    rows = [("sold", p.sold, "", 0), ("wasted", p.wasted, "", 0),
            ("waste %", p.waste_pct, "%", 0), ("revenue", p.revenue, "", 0),
            ("items that sell out", p.sellouts, "", 0)]
    for name, iv, unit, dp in rows:
        pre = "$" if name == "revenue" else ""
        L.append(f"| {name} | {pre}{iv.point:.{dp}f}{unit} "
                 f"| {pre}{iv.lo68:.{dp}f}–{pre}{iv.hi68:.{dp}f}{unit} "
                 f"| {pre}{iv.lo95:.{dp}f}–{pre}{iv.hi95:.{dp}f}{unit} |")
    L.append("")
    L.append("## Per item")
    L.append("")
    L.append("| item | make | sold (expected) | 95% range | runs out |")
    L.append("|---|---|---|---|---|")
    by = {ip.item: ip for ip in p.items}
    for k in (order or [ip.item for ip in p.items]):
        ip = by.get(k)
        if not ip:
            continue
        L.append(f"| {k} | {ip.plan:.0f} | {ip.sold.point:.1f} "
                 f"| {ip.sold.lo95:.0f}–{ip.sold.hi95:.0f} "
                 f"| {100 * ip.sellout_share:.0f}% of days |")
    L.append("")
    L.append("## Read this first")
    L.append("")
    for n in p.notes:
        L.append(f"- {n}")
    L.append("- One day is one tally entry. Over many days about 68% of actuals "
             "should land in the 68% band and 95% in the 95% band. That tally "
             "is the accuracy claim; a single hit or miss is not.")
    L.append("")
    return "\n".join(L)


def render_score(s: DayScore, p: DayPrediction) -> str:
    L = []
    L.append(f"## Scored — {s.date}")
    L.append("")
    if not s.made_matches_plan:
        L.append(f"> Made {s.actual_made:.0f}, plan was {p.total_made:.0f}. "
                 f"The prediction was for the plan; read the comparison with that in mind.")
        L.append("")
    L.append("| quantity | predicted | actual | in 68% | in 95% | z |")
    L.append("|---|---|---|---|---|---|")
    for q in s.quantities:
        pre = "$" if q.name == "revenue" else ""
        unit = "%" if q.name == "waste_pct" else ""
        z = "—" if math.isnan(q.z) else f"{q.z:+.2f}"
        L.append(f"| {q.name} | {pre}{q.predicted:.0f}{unit} | {pre}{q.actual:.0f}{unit} "
                 f"| {'yes' if q.in68 else 'no'} | {'yes' if q.in95 else 'NO'} | {z} |")
    n, a, b = s.tally()
    L.append("")
    L.append(f"Day totals: {a}/{n} inside the 68% band, {b}/{n} inside the 95% band.")
    L.append(f"Items: {s.items_in_range}/{s.items_total} inside their 95% range.")
    if s.item_misses:
        L.append("")
        L.append("Item misses (plan → predicted → actual):")
        for item, plan, pred, act in s.item_misses:
            L.append(f"- {item}: {plan:.0f} → {pred:.1f} → {act:.0f}")
    L.append("")
    return "\n".join(L)
