r"""Walk-forward backtest, scored in dollars.

For each evaluation day, in order:

  1. Build a History containing ONLY observations strictly before that day.
  2. Ask each policy for a quantity.
  3. Score it against what actually happened that day.

Nothing is refit after the fact and no policy can see its own evaluation day.

WHAT CENSORING DOES TO SCORING -- the part that has to be right
--------------------------------------------------------------
Realised cost needs true demand D. D is observed exactly only when there was
waste. On a sold-out day all we know is D >= supply.

A harness that quietly substitutes D = sold makes under-production look free on
precisely those days, and so systematically prefers policies that make less.
That bias points straight at the question being asked, which is why this is
handled explicitly instead of being papered over.

The structural fact that makes an honest comparison possible: on a sold-out
day, for two quantities q1, q2 that are BOTH <= supply, the unknown demand
above supply adds the SAME constant to both costs, so the difference between
them is exactly identified with no assumption at all.

    q <= supply <= D  =>  cost(q) = c_u * (D - q) = c_u*(D - supply) + c_u*(supply - q)
                                                    \_ unknown, but identical _/

It is only when a policy recommends ABOVE supply on a sold-out day that the
outcome is genuinely unknown -- would those extra units have sold, or not?

So every result carries `unidentified_share`: the fraction of the scored cost
that sits in that unknowable region. Small, and the comparison is sound. Large,
and the harness says so rather than printing a confident dollar figure.
"""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field

from .costs import CostConfig, cost_parts, realised_cost
from .data import History, Observation
from .policies import DayContext, Policy


@dataclass(frozen=True)
class Scored:
    """One policy's decision for one item on one day, and what it cost."""

    date: str
    item_key: str
    policy: str
    quantity: float
    supply: float
    sold: float
    censored: bool
    cost: float
    waste_cost: float
    stockout_cost: float
    #: True when the cost above depends on demand we cannot observe: the item
    #: sold out and this policy asked for more than was actually made.
    unidentified: bool


@dataclass
class PolicyResult:
    policy: str
    version: str
    scored: list[Scored] = field(default_factory=list)

    @property
    def n(self) -> int:
        return len(self.scored)

    @property
    def total_cost(self) -> float:
        return sum(s.cost for s in self.scored)

    @property
    def waste_cost(self) -> float:
        return sum(s.waste_cost for s in self.scored)

    @property
    def stockout_cost(self) -> float:
        return sum(s.stockout_cost for s in self.scored)

    @property
    def days(self) -> int:
        return len({s.date for s in self.scored})

    @property
    def cost_per_day(self) -> float:
        return self.total_cost / self.days if self.days else 0.0

    @property
    def unidentified_cost(self) -> float:
        return sum(s.cost for s in self.scored if s.unidentified)

    @property
    def unidentified_share(self) -> float:
        """How much of this score rests on demand nobody observed."""
        return self.unidentified_cost / self.total_cost if self.total_cost else 0.0

    @property
    def units_made(self) -> float:
        return sum(s.quantity for s in self.scored)

    def by_item(self) -> dict[str, float]:
        out: dict[str, float] = defaultdict(float)
        for s in self.scored:
            out[s.item_key] += s.cost
        return dict(out)


@dataclass
class BacktestResult:
    results: dict[str, PolicyResult]
    baseline: str
    evaluated_dates: list[str]
    skipped: dict[str, int]

    def compare(self, policy: str) -> dict[str, float]:
        """A policy against the baseline, on the days BOTH could score.

        Restricting to the common set matters: a policy that abstains on hard
        days would otherwise look good simply by not playing them.
        """
        base, cand = self.results[self.baseline], self.results[policy]
        common = _common_keys(base, cand)
        b = _subset_cost(base, common)
        c = _subset_cost(cand, common)
        days = len({k[0] for k in common})
        return {
            "baseline_cost": b,
            "policy_cost": c,
            "delta": c - b,
            "delta_pct": ((c - b) / b * 100.0) if b else float("nan"),
            "per_day": (c - b) / days if days else 0.0,
            "n_scored": float(len(common)),
            "days": float(days),
        }


def _common_keys(a: PolicyResult, b: PolicyResult) -> set[tuple[str, str]]:
    ka = {(s.date, s.item_key) for s in a.scored}
    kb = {(s.date, s.item_key) for s in b.scored}
    return ka & kb


def _subset_cost(r: PolicyResult, keys: set[tuple[str, str]]) -> float:
    return sum(s.cost for s in r.scored if (s.date, s.item_key) in keys)


def score_decision(
    q: float,
    obs: Observation,
    cu: float,
    co: float,
    censored_demand_factor: float = 1.0,
) -> tuple[float, float, float, bool]:
    """Cost of making `q` on the day `obs` describes.

    Returns (cost, waste_cost, stockout_cost, unidentified).

    Demand is taken as the observed lower bound. On an uncensored day that is
    exact. On a censored day it understates demand, which makes this a LOWER
    BOUND on the true cost -- and the understatement is identical across any
    two policies that both stay at or below supply, so their difference is
    still exact. `unidentified` marks the case where it is not.

    `censored_demand_factor` is for sensitivity analysis only. At 1.0 the
    scoring is assumption-free. Above 1.0 it assumes demand on sold-out days ran
    that much past supply, which is the direction the lower bound is wrong in.
    Sweeping it answers the question that actually matters: is the ranking of
    two policies robust to how badly we are underestimating demand, or does it
    flip? Never present a result from factor > 1.0 as measured.
    """
    demand = obs.demand_lower_bound
    if obs.censored and censored_demand_factor != 1.0:
        demand *= censored_demand_factor
    cost = realised_cost(q, demand, cu, co)
    waste, stockout = cost_parts(q, demand, cu, co)
    unidentified = obs.censored and q > obs.supply
    return cost, waste, stockout, unidentified


def run_backtest(
    observations: list[Observation],
    policies: list[Policy],
    costs: CostConfig,
    *,
    baseline: str,
    start_date: str | None = None,
    end_date: str | None = None,
    training_window_days: int | None = None,
    warmup_days: int = 28,
    censored_demand_factor: float = 1.0,
    leak_for_diagnostics: bool = False,
) -> BacktestResult:
    """Walk forward one day at a time.

    `training_window_days=None` means an expanding window (all prior history).
    An integer means a rolling window of that many days, which is the setting
    that lets the system forget a menu change instead of averaging across it.
    """
    by_date: dict[str, list[Observation]] = defaultdict(list)
    for o in observations:
        by_date[o.date].append(o)
    all_dates = sorted(by_date)
    if not all_dates:
        return BacktestResult({p.name: PolicyResult(p.name, p.version) for p in policies},
                              baseline, [], {})

    first_eval = start_date or _add_days(all_dates[0], warmup_days)
    eval_dates = [d for d in all_dates
                  if d >= first_eval and (end_date is None or d <= end_date)]

    results = {p.name: PolicyResult(p.name, p.version) for p in policies}
    skipped: dict[str, int] = defaultdict(int)

    for date in eval_dates:
        # Strictly-before slice. This is the only history a policy ever sees.
        lo = _add_days(date, -training_window_days) if training_window_days else None
        # `leak_for_diagnostics` DELIBERATELY hands the policy the whole record,
        # its own day included. It exists solely to produce the in-sample half
        # of an overfitting comparison and must never be set in production; a
        # result from it is not a measurement of anything.
        train = [o for o in observations
                 if (leak_for_diagnostics or o.date < date)
                 and (lo is None or o.date >= lo)]
        history = History(train)

        actual = {o.item_key: o for o in by_date[date]}
        items = tuple(sorted(actual))
        ctx = DayContext(date=date, items=items, history=history, costs=costs)

        for policy in policies:
            recs = policy.recommend(ctx)
            for item in items:
                q = recs.get(item, float("nan"))
                if q is None or isinstance(q, float) and math.isnan(q):
                    skipped[policy.name] += 1
                    continue
                obs = actual[item]
                try:
                    cu, co = costs.cu(item, date), costs.co(item, date)
                except KeyError:
                    skipped[policy.name] += 1
                    continue
                cost, waste, stockout, unid = score_decision(
                    q, obs, cu, co, censored_demand_factor)
                results[policy.name].scored.append(Scored(
                    date=date, item_key=item, policy=policy.name, quantity=q,
                    supply=obs.supply, sold=obs.sold, censored=obs.censored,
                    cost=cost, waste_cost=waste, stockout_cost=stockout,
                    unidentified=unid,
                ))

    return BacktestResult(results, baseline, eval_dates, dict(skipped))


def _add_days(date: str, n: int) -> str:
    import datetime
    y, m, d = (int(x) for x in date.split("-"))
    return (datetime.date(y, m, d) + datetime.timedelta(days=n)).isoformat()
