"""The per-roll rule.

What is protected here, in order of how much money a regression would cost:

  * a sell-out is read as "at least", never as "exactly" -- the old rule's
    mistake, which starved every item that sells out;
  * leftovers pull the number down, and a roll added on a leftover day buys
    nothing;
  * the risk is bounded: never more than one roll above the most made lately;
  * an item made in volume every day is not starved by the shrinkage (a flaw
    an earlier version of this rule had: the pull toward 0.5 compounded up
    the ladder and gave the 10th of ten always-sold rolls a 31% chance);
  * a roll above the most made lately is tested only if that most sold out;
  * the rule never sees the day it plans for.
"""

from __future__ import annotations

import datetime
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tests", "fixtures"))

from analysis.costs import CostConfig  # noqa: E402
from analysis.data import History, Observation  # noqa: E402
from analysis.policies import DayContext, SameWeekdayQuantile  # noqa: E402
from analysis import rollchance as rc  # noqa: E402

START = datetime.date(2026, 1, 5)  # a Monday


def d(n: int) -> str:
    return (START + datetime.timedelta(days=n)).isoformat()


def obs(n, made, wasted, item="roll"):
    return Observation(date=d(n), item_key=item, made=float(made), refill=0.0,
                       wasted=float(wasted))


def cfg(price=10.0, cost=2.5, promo=(), **kw):
    return CostConfig(prices={"roll": price}, unit_costs={"roll": cost},
                      promo_weekdays=promo, **kw)


def plan(day, history, costs=None):
    ctx = DayContext(date=d(day), items=("roll",),
                     history=History([o for o in history if o.date < d(day)]),
                     costs=costs or cfg())
    return rc.RollChance().ladder(ctx, "roll")


class TestTheBreakEven:
    def test_a_roll_is_made_exactly_when_its_chance_clears_cost_over_price(self):
        history = [obs(i, 6, 6 - (2 + i % 4)) for i in range(42)]   # sells 2..5
        lad = plan(42, history)
        assert lad.break_even == pytest.approx(0.25)
        q = lad.quantity
        assert lad.chance(q) >= 0.25 > lad.chance(q + 1)

    def test_a_thinner_margin_makes_fewer(self):
        history = [obs(i, 6, 6 - (2 + i % 4)) for i in range(42)]
        fat = plan(42, history, cfg(price=10, cost=1.0)).quantity
        thin = plan(42, history, cfg(price=10, cost=5.0)).quantity
        assert thin < fat

    def test_labour_and_the_stores_cut_raise_the_break_even(self):
        base = cfg()
        both = base.with_economics(labour_per_unit=0.5, sale_share=0.75)
        assert 1 - both.critical_ratio("roll", d(0)) == pytest.approx(3.0 / 7.5)
        assert 1 - base.critical_ratio("roll", d(0)) == pytest.approx(0.25)


class TestSellOuts:
    def test_a_sell_out_is_at_least_not_exactly(self):
        """Sold out at 3 every day: the old rule takes 3 as demand and stops
        there. Demand is at least 3; the per-roll rule tests a 4th."""
        history = [obs(i, 3, 0) for i in range(42)]
        old = SameWeekdayQuantile(window=8, min_observations=4).recommend(
            DayContext(date=d(42), items=("roll",),
                       history=History(history), costs=cfg()))["roll"]
        lad = plan(42, history)
        assert old == 3
        assert lad.quantity == 4 and lad.testing

    def test_the_risk_is_one_roll_at_a_time(self):
        history = [obs(i, 3, 0) for i in range(42)]
        lad = plan(42, history, cfg(price=10, cost=0.5))    # break-even 5%
        assert lad.quantity == lad.recent_max + rc.STEP == 4

    def test_a_volume_item_made_every_day_is_not_starved(self):
        history = [obs(i, 10, 0) for i in range(42)]
        lad = plan(42, history)
        assert lad.chance(10) > 0.5
        assert lad.quantity == 11


class TestLeftovers:
    def test_steady_leftovers_bring_the_number_down(self):
        history = [obs(i, 6, 4) for i in range(42)]        # sells 2 every day
        lad = plan(42, history)
        assert lad.quantity == 2
        assert not lad.testing

    def test_the_weekday_counts_most(self):
        """Mondays sell 6, every other day 2. Monday's plan is the bigger one."""
        def monday(i):
            return (START + datetime.timedelta(days=i)).isoweekday() == 1
        history = [obs(i, 8, 2 if monday(i) else 6) for i in range(56)]
        monday, tuesday = plan(56, history), plan(57, history)
        assert monday.quantity > tuesday.quantity

    def test_recent_weeks_count_most(self):
        """Sold 6 a day for ten weeks, then 2 a day for six: the plan follows."""
        history = [obs(i, 8, 2) for i in range(70)] + [obs(i, 8, 6) for i in range(70, 112)]
        assert plan(112, history).quantity <= 3

    def test_no_test_roll_when_the_most_you_made_came_back(self):
        """Made 3 and had one left, every day for three weeks. A 4th roll would
        find out nothing -- the ceiling was never hit -- so none is tested."""
        history = [obs(i, 8, 2) for i in range(70)] + [obs(i, 3, 1) for i in range(70, 91)]
        lad = plan(91, history)
        assert lad.quantity <= 3
        assert not lad.testing


class TestBoundaries:
    def test_no_opinion_on_a_new_item_until_it_has_a_week(self):
        six = [obs(i, 3, 1) for i in range(6)]
        assert plan(6, six).quantity is None
        assert plan(7, six + [obs(6, 3, 1)]).quantity is not None

    def test_an_item_on_the_menu_is_never_planned_at_zero(self):
        history = [obs(i, 2, 2) for i in range(42)]        # never sells
        assert plan(42, history).quantity == rc.FLOOR

    def test_the_planned_day_never_reaches_the_rule(self):
        history = [obs(i, 4, 1) for i in range(42)]
        poisoned = history + [obs(42, 99, 0), obs(43, 99, 0)]
        assert plan(42, history) == plan(42, poisoned)

    def test_the_version_names_every_setting(self):
        for part in ("o0.3", "h3", "p0.5", "m5/1@0.9", "s1", "f1"):
            assert part in rc.VERSION


class TestAmbition:
    """The climber: an activation point, a dial, and a budget."""

    def hot(self, n=42, made=3):
        return [obs(i, made, 0) for i in range(n)]            # sells out every day

    def test_careful_is_the_rule_alone(self):
        history = [obs(i, 3, 0) for i in range(35)] + [obs(i, 4, 0) for i in range(35, 42)]
        lad = rc.ladder_for(d(42), history, 0.28, ambition=1)
        assert lad.quantity == lad.base
        assert lad.climb.steps == 0

    def test_a_popular_item_that_keeps_selling_out_climbs(self):
        # Made 4 for a week and sold out on all but one day: popular (4 a day).
        # One leftover keeps the base rule at 4, so any rise is the climber's.
        history = [obs(i, 3, 0) for i in range(35)] +                   [obs(i, 4, 0 if i % 5 else 1) for i in range(35, 42)]
        lad = rc.ladder_for(d(42), history, 0.28, ambition=3)
        assert lad.base == 4
        assert lad.climb.steps >= 1
        assert lad.quantity == lad.base + lad.climb.steps
        assert lad.climb.continuation == 0.70

    def test_one_sell_out_on_a_slow_item_does_not(self):
        # Made 1 a day, usually 1 left; sold out once, yesterday.
        history = [obs(i, 1, 1) for i in range(41)] + [obs(41, 1, 0)]
        lad = rc.ladder_for(d(42), history, 0.28, ambition=5)
        assert lad.climb.steps == 0

    def test_it_needs_three_days_of_evidence(self):
        """Only two recent days reached a base of 3, and both sold out: not
        yet enough to act on, however ambitious."""
        history = [obs(i, 2, 1) for i in range(40)] + [obs(40, 3, 0), obs(41, 3, 0)]
        climb = rc.climb_for(d(42), history, 3, 0.28, 5)
        assert (climb.days, climb.sold_out) == (2, 2)
        assert climb.steps == 0

    def test_more_ambition_never_climbs_less(self):
        history = [obs(i, 3, 0) for i in range(35)] + [obs(i, 4, 0 if i % 3 else 1) for i in range(35, 42)]
        steps = [rc.ladder_for(d(42), history, 0.28, ambition=a).climb.steps for a in range(1, 6)]
        assert steps == sorted(steps)
        for a, s in zip(range(2, 6), steps[1:]):
            assert s <= rc.AMBITION[a][1]

    def test_promo_days_are_judged_on_promo_days(self):
        # Wednesdays sell out, other days never do.
        def wed(i):
            return (START + datetime.timedelta(days=i)).isoweekday() == 3
        history = [obs(i, 4, 0 if wed(i) else 2) for i in range(56)]
        wednesday = rc.ladder_for(d(58), history, 0.28, ambition=4, promo_weekdays=(3,))
        thursday = rc.ladder_for(d(59), history, 0.28, ambition=4, promo_weekdays=(3,))
        assert wednesday.climb.sold_out > 0 and thursday.climb.sold_out == 0

    def test_the_daily_budget_keeps_the_best_bets(self):
        hot = [obs(i, 3, 0, item="hot") for i in range(35)] + [obs(i, 4, 0, item="hot") for i in range(35, 42)]
        warm = [obs(i, 3, 0 if i % 4 else 1, item="warm") for i in range(35)] + \
               [obs(i, 4, 0 if i % 4 else 1, item="warm") for i in range(35, 42)]
        ladders = {"hot": rc.ladder_for(d(42), hot, 0.28, ambition=5),
                   "warm": rc.ladder_for(d(42), warm, 0.28, ambition=5)}
        total = sum(l.climb.steps for l in ladders.values())
        assert total >= 2
        saved = rc.AMBITION[5]
        rc.AMBITION[5] = (saved[0], saved[1], 1)       # a budget of one extra roll
        try:
            out = rc.apply_budget(ladders, 5)
        finally:
            rc.AMBITION[5] = saved
        extra = {k: out[k] - ladders[k].base for k in ladders}
        assert sum(extra.values()) == 1
        best = max(ladders, key=lambda k: ladders[k].climb.edges[0] if ladders[k].climb.edges else -1)
        assert extra[best] == 1

    def test_the_version_names_the_ambition(self):
        assert rc.RollChance(4).version.endswith("-a4")
        with pytest.raises(ValueError):
            rc.RollChance(6)


class TestSharedCasesWithTheApp:
    """The app's port must agree exactly. The cases file is generated by this
    implementation; if it is stale, the app is being tested against an old rule."""

    def test_the_cases_file_matches_this_implementation(self):
        import make_roll_chance_cases as mk
        path = os.path.join(ROOT, "web", "src", "lib", "fixtures", "roll_chance_cases.json")
        with open(path, encoding="utf-8") as fh:
            on_disk = json.load(fh)
        assert on_disk == mk.build(), (
            "regenerate: python tests/fixtures/make_roll_chance_cases.py")
