"""Rolling scorecard, computed from recommendations that were actually issued.

The rule this module exists to enforce: scoring reads the quantity that was
STORED at issue time and never asks a policy what it would recommend now.

That distinction is the whole difference between an honest scorecard and a
flattering one. If the score were recomputed from the current model, every
improvement to the model would retroactively improve its own track record, and
a model that had been quietly failing for a month would look like it had always
been fine. Refitting after the fact is how a system convinces itself it works.

So `score_stored` takes recommendations as data. It imports no policy, and there
is no code path by which a quantity can be regenerated. A test asserts that
scoring a stored set whose numbers no current policy would produce still returns
those numbers' cost.

Scoring itself reuses `backtest.score_decision`, so a dollar on the scorecard
means exactly what a dollar in the backtest meant -- including the censoring
treatment and the `unidentified` flag for decisions above what was supplied.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

from .backtest import score_decision
from .costs import CostConfig
from .data import Observation, add_days


@dataclass(frozen=True)
class IssuedRecommendation:
    """One recommendation as it was issued and stored. Immutable history.

    `baseline_qty` is what the naive baseline said on that morning, captured at
    the same moment. Storing it is what makes a later comparison possible
    without recomputing anything.
    """

    business_date: str
    item_key: str
    recommended_qty: float
    baseline_qty: float | None
    model_name: str
    model_version: str
    generated_at: str
    is_fallback: bool = False
    inputs: dict = field(default_factory=dict)


@dataclass(frozen=True)
class PolicyScore:
    label: str
    n_scored: int
    total_cost: float
    waste_cost: float
    stockout_cost: float
    unidentified_cost: float
    units: float

    @property
    def unidentified_share(self) -> float:
        return self.unidentified_cost / self.total_cost if self.total_cost else 0.0

    def per_day(self, days: int) -> float:
        return self.total_cost / days if days else 0.0


@dataclass(frozen=True)
class Scorecard:
    window_start: str
    window_end: str
    days: int
    model_name: str
    model_versions: tuple[str, ...]
    model: PolicyScore
    baseline: PolicyScore
    operator: PolicyScore
    issued: int
    scored: int
    missing_actuals: int
    fallback_share: float
    adherence: float
    per_item: dict[str, float]

    @property
    def vs_baseline(self) -> float:
        """Negative means the model would have cost less than the baseline."""
        return self.model.total_cost - self.baseline.total_cost

    @property
    def vs_baseline_pct(self) -> float:
        b = self.baseline.total_cost
        return (self.vs_baseline / b * 100.0) if b else float("nan")

    @property
    def vs_operator(self) -> float:
        return self.model.total_cost - self.operator.total_cost

    @property
    def coverage(self) -> float:
        return self.scored / self.issued if self.issued else 0.0


def _empty(label: str) -> PolicyScore:
    return PolicyScore(label, 0, 0.0, 0.0, 0.0, 0.0, 0.0)


def score_stored(
    recommendations: list[IssuedRecommendation],
    observations: list[Observation],
    costs: CostConfig,
    *,
    as_of: str,
    window_days: int = 30,
    model_name: str | None = None,
) -> Scorecard:
    """Score the last `window_days` of issued recommendations against outcomes.

    Only recommendations that have a matching actual observation are scored;
    the rest are reported as `missing_actuals` rather than dropped silently,
    because a scorecard that quietly ignores days is how a gap in the pipeline
    stays invisible.
    """
    start = add_days(as_of, -window_days + 1)
    in_window = [r for r in recommendations
                 if start <= r.business_date <= as_of
                 and (model_name is None or r.model_name == model_name)]

    actual = {(o.date, o.item_key): o for o in observations}

    acc: dict[str, dict[str, float]] = {
        k: defaultdict(float) for k in ("model", "baseline", "operator")
    }
    counts = {k: 0 for k in acc}
    per_item: dict[str, float] = defaultdict(float)
    followed = 0
    scored = 0
    missing = 0
    versions: set[str] = set()
    fallbacks = 0

    for rec in in_window:
        versions.add(rec.model_version)
        if rec.is_fallback:
            fallbacks += 1
        obs = actual.get((rec.business_date, rec.item_key))
        if obs is None:
            missing += 1
            continue
        try:
            cu = costs.cu(rec.item_key, rec.business_date)
            co = costs.co(rec.item_key, rec.business_date)
        except KeyError:
            missing += 1
            continue

        scored += 1
        # The stored quantity, exactly as issued. Nothing is regenerated here.
        candidates = [("model", rec.recommended_qty),
                      ("operator", obs.supply)]
        if rec.baseline_qty is not None:
            candidates.append(("baseline", rec.baseline_qty))

        for label, qty in candidates:
            cost, waste, stockout, unid = score_decision(qty, obs, cu, co)
            a = acc[label]
            a["total"] += cost
            a["waste"] += waste
            a["stockout"] += stockout
            a["unidentified"] += cost if unid else 0.0
            a["units"] += qty
            counts[label] += 1
            if label == "model":
                per_item[rec.item_key] += cost

        if abs(obs.supply - rec.recommended_qty) < 0.5:
            followed += 1

    def build(label: str) -> PolicyScore:
        if not counts[label]:
            return _empty(label)
        a = acc[label]
        return PolicyScore(label, counts[label], a["total"], a["waste"],
                           a["stockout"], a["unidentified"], a["units"])

    days = len({r.business_date for r in in_window})
    return Scorecard(
        window_start=start, window_end=as_of, days=days,
        model_name=model_name or (in_window[0].model_name if in_window else "none"),
        model_versions=tuple(sorted(versions)),
        model=build("model"), baseline=build("baseline"), operator=build("operator"),
        issued=len(in_window), scored=scored, missing_actuals=missing,
        fallback_share=fallbacks / len(in_window) if in_window else 0.0,
        adherence=followed / scored if scored else 0.0,
        per_item=dict(per_item),
    )


def render_text(card: Scorecard, width: int = 78) -> str:
    out = [
        "=" * width,
        f"ROLLING SCORECARD  {card.window_start} .. {card.window_end}"
        f"  ({card.days} days)",
        "=" * width,
        f"rule       : {card.model_name} {', '.join(card.model_versions) or '-'}",
        f"issued     : {card.issued}   scored: {card.scored}"
        f"   awaiting actuals: {card.missing_actuals}",
        f"coverage   : {card.coverage * 100:.0f}%"
        f"   fallback: {card.fallback_share * 100:.0f}%"
        f"   you followed it: {card.adherence * 100:.0f}% of the time",
        "",
        "%-12s %9s %9s %10s %9s %7s" % (
            "", "total $", "waste $", "stockout $", "$/day", "unid."),
    ]
    for score in (card.model, card.baseline, card.operator):
        out.append("%-12s %9.2f %9.2f %10.2f %9.2f %6.0f%%" % (
            score.label, score.total_cost, score.waste_cost, score.stockout_cost,
            score.per_day(card.days), score.unidentified_share * 100))

    out += ["",
            "rule vs baseline : %+9.2f  (%+.1f%%)" % (card.vs_baseline,
                                                      card.vs_baseline_pct),
            "rule vs you      : %+9.2f" % card.vs_operator]

    if card.missing_actuals:
        out.append("")
        out.append("NOTE: %d issued recommendation(s) have no recorded outcome yet."
                   % card.missing_actuals)
    if card.per_item:
        worst = sorted(card.per_item.items(), key=lambda kv: -kv[1])[:5]
        out += ["", "costliest items under the rule:"]
        out += ["  %-28s %8.2f" % (k, v) for k, v in worst]
    return "\n".join(out)
