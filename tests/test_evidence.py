"""The evidence that accepts or refuses a rule.

The scoring is the part whose bugs would silently flatter a rule, so it is
tested for the one thing that matters: known outcomes are charged exactly, and
only rolls nobody could observe get a range.
"""

from __future__ import annotations

import datetime
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from analysis.costs import CostConfig  # noqa: E402
from analysis.data import Observation  # noqa: E402
from analysis.evidence import (  # noqa: E402
    calibration, compare, extra_roll_rate, outcome,
)

START = datetime.date(2026, 1, 5)  # a Monday


def d(n: int) -> str:
    return (START + datetime.timedelta(days=n)).isoformat()


def obs(n, made, wasted, item="roll"):
    return Observation(date=d(n), item_key=item, made=float(made), refill=0.0,
                       wasted=float(wasted))


class Fixed:
    """A rule that always says the same number."""

    def __init__(self, q, name="fixed"):
        self.q, self.name, self.version = q, name, "t"

    def recommend(self, ctx):
        return {i: float(self.q) for i in ctx.items}


class TestOutcome:
    def test_a_leftover_day_is_exact_either_way(self):
        day = obs(0, 5, 2)                       # demand was exactly 3
        assert outcome(2, day, 0.5).sold_low == outcome(2, day, 0.5).sold_high == 2
        extra = outcome(7, day, 0.5)
        assert extra.sold_low == extra.sold_high == 3     # the extra rolls did NOT sell
        assert extra.unseen == 0

    def test_at_or_below_supply_on_a_sell_out_is_exact(self):
        day = obs(0, 5, 0)
        o = outcome(4, day, 0.5)
        assert o.sold_low == o.sold_est == o.sold_high == 4 and o.unseen == 0

    def test_above_supply_on_a_sell_out_is_a_range(self):
        day = obs(0, 5, 0)
        o = outcome(7, day, 0.5)
        assert (o.sold_low, o.sold_high, o.unseen) == (5, 7, 2)
        assert o.sold_est == pytest.approx(5 + 0.5 + 0.25)


class TestCompare:
    def costs(self):
        return CostConfig(prices={"roll": 10.0}, unit_costs={"roll": 2.0}, promo_weekdays=())

    def test_a_roll_added_on_a_leftover_day_is_charged_in_full(self):
        """The property that lets profit catch a rule that over-adds: extra
        rolls on a day with leftovers are known failures, not unknowns."""
        history = [obs(i, 5, 2) for i in range(10)]
        c = compare(history, [Fixed(6, "six")], self.costs(), start=d(5), end=d(9),
                    continuation=0.9)
        t = c.rules["six"]
        assert t.profit_low == t.profit_est == t.profit_high
        assert t.per_day("profit_est") == pytest.approx(3 * 10 - 6 * 2)
        assert c.you.per_day("profit_est") == pytest.approx(3 * 10 - 5 * 2)

    def test_no_opinion_falls_back_to_what_was_made_and_is_counted(self):
        history = [obs(i, 5, 2) for i in range(4)]

        class Silent(Fixed):
            def recommend(self, ctx):
                return {i: float("nan") for i in ctx.items}

        c = compare(history, [Silent(0, "silent")], self.costs(), start=d(0), end=d(3),
                    continuation=0.5)
        assert c.rules["silent"].no_opinion == 4
        assert c.rules["silent"].profit_est == pytest.approx(c.you.profit_est)


class TestExtraRollRate:
    def test_counts_only_days_that_went_above_a_ceiling_that_would_have_sold_out(self):
        # Mondays: made 3 three times, then 4 (sold 4), then 4 again (sold 2 --
        # the usual 4 would NOT have sold out, so it is no test of a 5th).
        mondays = [0, 7, 14, 21, 28]
        rows = [obs(mondays[0], 3, 0), obs(mondays[1], 3, 1), obs(mondays[2], 3, 0),
                obs(mondays[3], 4, 0), obs(mondays[4], 5, 3)]
        r = extra_roll_rate(rows)
        assert (r.sold, r.tried) == (1, 1)


class TestCalibration:
    def test_one_prediction_per_roll_made_and_none_from_the_future(self):
        rows = [obs(i, 3, 1) for i in range(14)]
        cal = calibration(rows, start=d(9), end=d(13))
        assert cal.n == 5 * 3                  # 5 days x 3 rolls
        assert sum(y for _, y in cal.pairs) == 5 * 2
        poisoned = rows + [obs(14, 50, 0)]
        assert calibration(poisoned, start=d(9), end=d(13)).pairs == cal.pairs

    def test_a_new_item_is_not_predicted_before_it_has_a_week(self):
        rows = [obs(i, 3, 1) for i in range(10)]
        assert calibration(rows, start=d(0), end=d(6)).n == 0
