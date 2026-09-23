"""Policies: things that turn history into a quantity to make.

A policy sees a `History` containing only observations strictly before the day
it is deciding for, and nothing else. It cannot reach the future because it has
no reference to it.

Two of these are baselines rather than candidates:

  * `same_weekday_mean` is the mandated Phase 3 baseline. Deliberately dumb.
  * `operator_actual` replays what was really made. It is the incumbent, and
    the only bar that matters commercially -- beating a trailing mean is easy,
    beating the person who has been doing this every day is the actual test.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Protocol

from .costs import CostConfig
from .data import History, Observation, isoweekday


@dataclass(frozen=True)
class DayContext:
    date: str
    items: tuple[str, ...]
    history: History
    costs: CostConfig


class Policy(Protocol):
    name: str
    version: str

    def recommend(self, ctx: DayContext) -> dict[str, float]: ...


def _round_up(x: float) -> float:
    """Quantities are whole units. Round half up, floor at zero."""
    return float(max(0, math.floor(x + 0.5)))


class SameWeekdayMean:
    """THE baseline: trailing mean of units sold on the same weekday.

    Uses `sold`, which is censored on sold-out days, so this is biased low by
    construction. That is not a defect to fix here -- a baseline should be the
    obvious naive thing, and the bias is part of what a better model has to
    overcome.
    """

    name = "same_weekday_mean"

    def __init__(self, window: int = 4, min_observations: int = 2):
        self.window = window
        self.min_observations = min_observations
        self.version = f"1.0.0-w{window}-min{min_observations}"

    def recommend(self, ctx: DayContext) -> dict[str, float]:
        wd = isoweekday(ctx.date)
        out: dict[str, float] = {}
        for item in ctx.items:
            past = ctx.history.for_item_weekday(item, wd)[-self.window:]
            if len(past) < self.min_observations:
                out[item] = float("nan")  # not enough history; harness skips it
                continue
            out[item] = _round_up(sum(o.sold for o in past) / len(past))
        return out


class OperatorActual:
    """What the operator actually supplied. The incumbent process."""

    name = "operator_actual"
    version = "1.0.0"

    def __init__(self, actuals: dict[tuple[str, str], float]):
        self._actuals = actuals

    def recommend(self, ctx: DayContext) -> dict[str, float]:
        return {i: self._actuals.get((ctx.date, i), float("nan")) for i in ctx.items}

    @classmethod
    def from_observations(cls, observations: list[Observation]) -> "OperatorActual":
        return cls({(o.date, o.item_key): o.supply for o in observations})


class SameWeekdayQuantile:
    """Same trailing window, but the critical-ratio quantile instead of the mean.

    The cheapest possible upgrade over the baseline, and the reference point for
    whether Phase 4's machinery earns its complexity. With so few same-weekday
    observations the empirical quantile is coarse -- at n=4 and CR=0.72 it is
    essentially "the largest of the last four" -- which is exactly the small-data
    problem to be honest about rather than hide.
    """

    name = "same_weekday_quantile"

    def __init__(self, window: int = 8, min_observations: int = 4,
                 floor: int = 1):
        self.window = window
        self.min_observations = min_observations
        # An item still on the menu is stocked, not delisted by a calculation.
        # With four same-weekday observations the empirical quantile is very
        # coarse, and on a promo day the ratio drops far enough that an item
        # selling out eight days in ten can round to zero -- which would take it
        # out of the case entirely. The floor is a business constraint, not a
        # tuning knob, and it lives in the POLICY so the backtest scores the
        # same rule the prep sheet prints.
        self.floor = floor
        self.version = f"1.0.0-w{window}-min{min_observations}-f{floor}"

    def recommend(self, ctx: DayContext) -> dict[str, float]:
        wd = isoweekday(ctx.date)
        out: dict[str, float] = {}
        for item in ctx.items:
            past = ctx.history.for_item_weekday(item, wd)[-self.window:]
            if len(past) < self.min_observations:
                out[item] = float("nan")
                continue
            try:
                cr = ctx.costs.critical_ratio(item, ctx.date)
            except (KeyError, ValueError):
                out[item] = float("nan")
                continue
            values = sorted(o.sold for o in past)
            q = _round_up(_empirical_quantile(values, cr))
            # Only floor items that are actually being made; an item genuinely
            # at zero across its whole recent history stays at zero.
            if q < self.floor and any(o.supply > 0 for o in past):
                q = float(self.floor)
            out[item] = q
        return out


def _empirical_quantile(sorted_values: list[float], q: float) -> float:
    """Linear-interpolated empirical quantile. Clamped to the observed range."""
    if not sorted_values:
        return float("nan")
    if len(sorted_values) == 1:
        return sorted_values[0]
    pos = q * (len(sorted_values) - 1)
    lo = int(math.floor(pos))
    hi = min(lo + 1, len(sorted_values) - 1)
    frac = pos - lo
    return sorted_values[lo] * (1 - frac) + sorted_values[hi] * frac
