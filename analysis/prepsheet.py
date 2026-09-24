"""The morning prep sheet.

One line per item: what to make, why, how much to trust it, and what the naive
baseline would have said.

Two rules govern this module.

FIRST: the recommendation must come from the SAME policy object the backtest
scored. Not a reimplementation, not a tuned variant -- the same class. A prep
sheet built from an unvalidated rule is a number with no provenance, and the
whole point of Phase 3 was to stop producing those.

SECOND: nothing here invents confidence. The indicator is computed from things
that are actually observable -- how many same-weekday observations back the
estimate, and how often that item sold out. An item that sells out most days has
demand we have never seen, so its recommendation is a lower bound and the sheet
says so rather than dressing it up.

`recommended` comes from the per-roll rule (analysis/rollchance.py): each roll
is made when its estimated chance of selling beats break-even, cost / price.
The reason on each line quotes exactly that, so the sheet can be argued with:
"3rd sells ~45%, 4th ~20% - needs 25%" says why the rule stopped at three.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .sheet_order import load_sheet_order, sort_key
from .costs import CostConfig
from .data import History, Observation, add_days, isoweekday
from .policies import DayContext, SameWeekdayMean
from .rollchance import Ladder, RollChance, ordinal, pct

CONFIDENCE_ORDER = ("low", "medium", "high")


@dataclass(frozen=True)
class PrepLine:
    item_key: str
    recommended: float | None
    baseline: float | None          # always shown, per the Phase 5 brief
    your_plan: float | None         # the operator's own template, if set
    reason: str
    confidence: str
    caveat: str | None
    n_weekday_observations: int
    sellout_rate: float
    critical_ratio: float | None
    is_fallback: bool

    @property
    def delta_vs_plan(self) -> float | None:
        if self.recommended is None or self.your_plan is None:
            return None
        return self.recommended - self.your_plan


@dataclass(frozen=True)
class PrepSheet:
    date: str
    weekday: str
    lines: tuple[PrepLine, ...]
    model_name: str
    model_version: str
    degraded: bool
    degraded_reason: str | None
    generated_at: str
    notes: tuple[str, ...] = field(default_factory=tuple)

    @property
    def total_recommended(self) -> float:
        return sum(line.recommended or 0 for line in self.lines)

    @property
    def total_baseline(self) -> float:
        return sum(line.baseline or 0 for line in self.lines)

    @property
    def total_plan(self) -> float | None:
        if all(line.your_plan is None for line in self.lines):
            return None
        return sum(line.your_plan or 0 for line in self.lines)

    def low_confidence(self) -> tuple[PrepLine, ...]:
        return tuple(line for line in self.lines if line.confidence == "low")


WEEKDAY_NAMES = ("Monday", "Tuesday", "Wednesday", "Thursday",
                 "Friday", "Saturday", "Sunday")


def _recent(history: History, item: str, n: int = 10) -> list[Observation]:
    return history.for_item(item)[-n:]


def _sellout_rate(observations: list[Observation]) -> float:
    if not observations:
        return 0.0
    return sum(1 for o in observations if o.censored) / len(observations)


def _confidence(n_weekday: int, sellout_rate: float, is_fallback: bool) -> str:
    """Three levels, from things we can actually count.

    Heavy sell-out is the dominant signal: if an item hit its ceiling most days,
    the history says almost nothing about how much would have sold, and no
    amount of it adds confidence.
    """
    if is_fallback or n_weekday < 3:
        return "low"
    if sellout_rate >= 0.6:
        return "low"
    if n_weekday >= 6 and sellout_rate < 0.4:
        return "high"
    return "medium"


def _reason(
    item: str,
    date: str,
    recent: list[Observation],
    ladder: Ladder,
    costs: CostConfig,
    is_fallback: bool,
) -> tuple[str, str | None]:
    """A short human reason, plus a caveat when the number is a deliberate test
    or cannot be trusted. The reason quotes the chance behind the number."""
    weekday = WEEKDAY_NAMES[isoweekday(date) - 1]
    sellouts = sum(1 for o in recent if o.censored)
    leftovers = sum(1 for o in recent if not o.censored)

    # Item-specific facts first. The promotion applies to every line equally, so
    # repeating it on all thirty of them says nothing about any one item -- it
    # belongs in the sheet-level notes, and it is there.
    if is_fallback or ladder.quantity is None or ladder.break_even is None:
        return (f"too little {weekday} history yet - using your own recent level",
                "fewer than 3 days of this item on record")

    q, be = ladder.quantity, ladder.break_even
    needs = f"needs {pct(be)}"
    climb = ladder.climb
    if climb is not None and climb.steps > 0:
        return (f"sold out {climb.sold_out} of last {climb.days} - climbing +{climb.steps}",
                f"ambition: {pct(climb.confidence)} sure the next roll sells at least "
                f"{pct(be)} of days (sells ~{climb.popularity:.1f} a day)")
    if ladder.testing:
        return (f"sold out {sellouts} of last {len(recent)} - testing a {ordinal(q)} "
                f"(~{pct(ladder.chance(q))}, {needs})",
                f"one more than the most you made lately; if it sells, the record "
                f"learns demand it could not see")

    if recent and leftovers >= max(3, int(0.7 * len(recent))):
        wasted = sum(o.wasted for o in recent)
        return (f"left over {wasted:.0f} across last {len(recent)} - "
                f"a {ordinal(q + 1)} sells ~{pct(ladder.chance(q + 1))}, {needs}", None)

    suffix = " (promo day)" if costs.is_promo(date) else ""
    return (f"{ordinal(q)} sells ~{pct(ladder.chance(q))}, {ordinal(q + 1)} "
            f"~{pct(ladder.chance(q + 1))} - {needs}{suffix}", None)


def build_prep_sheet(
    date: str,
    observations: list[Observation],
    costs: CostConfig,
    *,
    template: dict[str, float] | None = None,
    items: list[str] | None = None,
    active_within_days: int = 21,
    health: object | None = None,
    generated_at: str | None = None,
) -> PrepSheet:
    """Build the sheet for `date` using only observations strictly before it.

    The cutoff is enforced here rather than assumed: a prep sheet accidentally
    built with same-day data would look excellent and be worthless.
    """
    import datetime

    history = History([o for o in observations if o.date < date])
    if items:
        item_keys = sorted(items)
    else:
        # Only items still on the menu. The roster churned six times in 117 days
        # -- sashimi split in two on 2 August, rainbow roll likewise -- and
        # listing a discontinued item is worse than useless on a prep sheet.
        cutoff = add_days(date, -active_within_days)
        item_keys = sorted(
            k for k in history.items
            if any(o.date >= cutoff for o in history.for_item(k)))
    ctx = DayContext(date=date, items=tuple(item_keys), history=history, costs=costs)

    # The exact policies the evidence report scored. Same classes, same settings.
    recommender = RollChance()
    baseline = SameWeekdayMean(window=4, min_observations=2)
    base_q = baseline.recommend(ctx)

    weekday = isoweekday(date)
    lines: list[PrepLine] = []
    for item in item_keys:
        weekday_obs = history.for_item_weekday(item, weekday)
        recent = _recent(history, item, 10)
        ladder = recommender.ladder(ctx, item)
        rec = None if ladder.quantity is None else float(ladder.quantity)
        base = base_q.get(item)
        base = None if base is None or base != base else base
        is_fallback = rec is None

        try:
            cr = costs.critical_ratio(item, date)
        except (KeyError, ValueError):
            cr = None

        sellout = _sellout_rate(recent)
        reason, caveat = _reason(item, date, recent, ladder, costs, is_fallback)

        plan = template.get(item) if template else None
        # With no usable history the operator's own plan is the best number
        # available -- better than a rule fitted to almost nothing.
        if rec is None and plan is not None:
            rec = plan

        lines.append(PrepLine(
            item_key=item, recommended=rec, baseline=base, your_plan=plan,
            reason=reason, confidence=_confidence(len(weekday_obs), sellout, is_fallback),
            caveat=caveat, n_weekday_observations=len(weekday_obs),
            sellout_rate=sellout, critical_ratio=cr, is_fallback=is_fallback,
        ))

    notes = []
    if costs.is_promo(date):
        notes.append("Buy-2-get-1 today: the margin per unit is lower, so the "
                     "target quantile drops even though volume rises.")
    heavy = [ln.item_key for ln in lines if ln.sellout_rate >= 0.6]
    if heavy:
        notes.append(
            f"{len(heavy)} item(s) sell out most days ({', '.join(heavy[:4])}"
            f"{'...' if len(heavy) > 4 else ''}). Their real demand is higher than "
            "the record shows; the rule estimates it and tests one extra roll at a time.")

    # The sheet always prints. What changes is what it admits to: if ingest is
    # stale or a component failed overnight, the banner says which -- yesterday's
    # answer must never be presented as today's without saying so.
    if health is not None and getattr(health, "degraded", False):
        for finding in getattr(health, "findings", ()):
            notes.insert(0, f"PIPELINE: {finding.message}")

    return PrepSheet(
        date=date,
        weekday=WEEKDAY_NAMES[weekday - 1],
        lines=tuple(lines),
        model_name=recommender.name,
        model_version=recommender.version,
        degraded=False,
        degraded_reason=None,
        generated_at=generated_at or datetime.datetime.now().isoformat(timespec="seconds"),
        notes=tuple(notes),
    )


def render_text(sheet: PrepSheet, width: int = 96) -> str:
    """Plain-text prep sheet -- printable, and what the alerting path sends."""
    mark = {"high": "***", "medium": "** ", "low": "*  "}
    out = [
        "=" * width,
        f"PREP SHEET  {sheet.weekday} {sheet.date}",
        "=" * width,
        f"generated {sheet.generated_at}   rule: {sheet.model_name} {sheet.model_version}",
    ]
    if sheet.degraded:
        out += ["", "! " + sheet.degraded_reason]
    for note in sheet.notes:
        out += ["", "! " + note]

    out += ["", "%-28s %5s %5s %5s  %-4s %s"
            % ("item", "make", "plan", "base", "conf", "why")]
    out.append("-" * width)
    # Sheet order, not quantity order. The operator reads down a case that is
    # arranged this way; sorting by quantity makes them hunt for every line.
    # Falls back to largest-first when the order file is absent.
    order = load_sheet_order()
    if order:
        key = sort_key(order)
        lines = sorted(sheet.lines, key=lambda x: key(x.item_key))
    else:
        lines = sorted(sheet.lines, key=lambda x: -(x.recommended or 0))
    for ln in lines:
        out.append("%-28s %5s %5s %5s  %-4s %s" % (
            ln.item_key,
            "-" if ln.recommended is None else "%.0f" % ln.recommended,
            "-" if ln.your_plan is None else "%.0f" % ln.your_plan,
            "-" if ln.baseline is None else "%.0f" % ln.baseline,
            mark[ln.confidence],
            ln.reason,
        ))
        if ln.caveat:
            out.append("%-28s %17s  %s" % ("", "", "^ " + ln.caveat))

    out += ["-" * width,
            "%-28s %5.0f %5s %5.0f" % (
                "TOTAL", sheet.total_recommended,
                "-" if sheet.total_plan is None else "%.0f" % sheet.total_plan,
                sheet.total_baseline),
            "",
            "confidence: *** many comparable days, rarely sells out",
            "            **  some history",
            "            *   thin history, or sells out most days"]
    return "\n".join(out)
