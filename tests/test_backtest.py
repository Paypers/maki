"""Tests for the backtest harness.

This is the component whose bugs would silently invalidate every later result,
so it gets adversarial tests rather than smoke tests. Four things must hold:

  1. The loss function is arithmetically right.
  2. No policy can see its own evaluation day or anything after it.
  3. Censoring is scored honestly -- under-production is never free on a
     sold-out day, and the harness says how much of a result it cannot know.
  4. On data where the right answer is computable by hand, the harness finds it.

If (4) fails, the harness is wrong regardless of what it says about any model.
"""

from __future__ import annotations

import datetime
import math
import os
import random
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from analysis.backtest import (  # noqa: E402
    BacktestResult, run_backtest, score_decision,
)
from analysis.costs import CostConfig, cost_parts, realised_cost  # noqa: E402
from analysis.data import History, Observation, isoweekday  # noqa: E402
from analysis.policies import (  # noqa: E402
    DayContext, OperatorActual, SameWeekdayMean, SameWeekdayQuantile,
)

START = datetime.date(2026, 1, 5)  # a Monday


def d(n: int) -> str:
    return (START + datetime.timedelta(days=n)).isoformat()


def obs(day: int, item: str = "roll", made: float = 10, wasted: float = 2,
        refill: float = 0) -> Observation:
    return Observation(date=d(day), item_key=item, made=made, refill=refill,
                       wasted=wasted)


def cfg(price: float = 10.0, cost: float = 2.5, **kw) -> CostConfig:
    return CostConfig(prices={"roll": price, "other": price},
                      unit_costs={"roll": cost, "other": cost},
                      promo_weekdays=(), **kw)


# ============================================================ the loss ======

class TestLossFunction:
    def test_zero_at_the_exact_quantity(self):
        assert realised_cost(7, 7, cu=5.0, co=2.0) == 0.0

    def test_overproduction_costs_co_per_unit(self):
        assert realised_cost(10, 7, cu=5.0, co=2.0) == pytest.approx(6.0)

    def test_underproduction_costs_cu_per_unit(self):
        assert realised_cost(4, 7, cu=5.0, co=2.0) == pytest.approx(15.0)

    def test_parts_always_sum_to_the_whole(self):
        for q in range(0, 15):
            for dem in range(0, 15):
                w, s = cost_parts(q, dem, cu=5.0, co=2.0)
                assert w + s == pytest.approx(realised_cost(q, dem, 5.0, 2.0))
                assert w == 0 or s == 0, "cannot waste and stock out at once"

    def test_asymmetry_is_preserved(self):
        """c_u > c_o means missing a sale hurts more than binning a unit. If
        this ever flips, every recommendation is biased the wrong way."""
        over = realised_cost(9, 7, cu=7.5, co=2.5)
        under = realised_cost(5, 7, cu=7.5, co=2.5)
        assert under > over


class TestCostConfig:
    def test_critical_ratio_is_the_gross_margin(self):
        """With salvage zero, CR collapses to 1 - cost/price. If this identity
        breaks, the economics module has drifted from its derivation."""
        c = cfg(price=10.0, cost=2.5)
        assert c.critical_ratio("roll", d(0)) == pytest.approx(0.75)
        assert c.critical_ratio("roll", d(0)) == pytest.approx(1 - 2.5 / 10.0)

    def test_promo_day_lowers_the_ratio(self):
        c = CostConfig(prices={"roll": 10.0}, unit_costs={"roll": 2.5},
                       promo_weekdays=(3,))
        wed = d(2)
        assert isoweekday(wed) == 3
        assert c.critical_ratio("roll", wed) < c.critical_ratio("roll", d(0))
        assert c.critical_ratio("roll", wed) == pytest.approx(1 - 2.5 / (10 * 2 / 3))

    def test_refuses_to_invent_a_ratio_when_overproducing_is_free(self):
        """Salvage >= cost has no interior optimum. Returning a number here
        would quietly tell the operator to make unlimited stock."""
        c = CostConfig(prices={"roll": 10.0}, unit_costs={"roll": 2.5},
                       salvage=2.5, promo_weekdays=())
        with pytest.raises(ValueError, match="no interior optimum"):
            c.critical_ratio("roll", d(0))

    def test_missing_price_raises_rather_than_defaulting_silently(self):
        c = CostConfig(prices={}, unit_costs={"roll": 2.5}, promo_weekdays=())
        with pytest.raises(KeyError):
            c.cu("roll", d(0))


# ======================================================== no look-ahead =====

class TestNoLeakage:
    def _spy_policy(self, seen: list):
        class Spy:
            name, version = "spy", "1.0.0"

            def recommend(self, ctx: DayContext) -> dict[str, float]:
                seen.append((ctx.date, [o.date for o in ctx.history.for_item("roll")]))
                return {i: 5.0 for i in ctx.items}
        return Spy()

    def test_history_never_contains_the_evaluation_day_or_later(self):
        seen: list = []
        data = [obs(i) for i in range(30)]
        run_backtest(data, [self._spy_policy(seen)], cfg(),
                     baseline="spy", warmup_days=7)
        assert seen, "policy was never called"
        for eval_date, hist_dates in seen:
            assert all(h < eval_date for h in hist_dates), (
                f"leakage: history for {eval_date} contained {max(hist_dates)}")

    def test_corrupting_the_future_cannot_change_a_past_recommendation(self):
        """The strongest available leakage check: if a decision is untouched by
        data that did not exist yet, it cannot have been using it."""
        clean = [obs(i, made=10, wasted=2) for i in range(40)]
        corrupt = [
            o if o.date <= d(20) else Observation(o.date, o.item_key, 9999, 0, 0)
            for o in clean
        ]
        policy = SameWeekdayMean(window=4, min_observations=2)
        a = run_backtest(clean, [policy], cfg(), baseline=policy.name,
                         warmup_days=7, end_date=d(20))
        b = run_backtest(corrupt, [policy], cfg(), baseline=policy.name,
                         warmup_days=7, end_date=d(20))
        qa = {(s.date, s.item_key): s.quantity for s in a.results[policy.name].scored}
        qb = {(s.date, s.item_key): s.quantity for s in b.results[policy.name].scored}
        assert qa == qb

    def test_rolling_window_excludes_older_than_the_window(self):
        seen: list = []
        data = [obs(i) for i in range(60)]
        run_backtest(data, [self._spy_policy(seen)], cfg(), baseline="spy",
                     warmup_days=30, training_window_days=14)
        for eval_date, hist_dates in seen:
            if not hist_dates:
                continue
            span = (datetime.date.fromisoformat(eval_date)
                    - datetime.date.fromisoformat(min(hist_dates))).days
            assert span <= 14


# ========================================================== censoring =======

class TestCensoring:
    def test_underproduction_is_never_free_on_a_sold_out_day(self):
        """The single most dangerous bug available. If demand were taken as
        anything below the observed sold figure, making less than was actually
        sold would score as costless and every comparison would favour cutting
        production."""
        sold_out = Observation(d(0), "roll", made=10, refill=0, wasted=0)
        assert sold_out.censored
        cost, _, stockout, _ = score_decision(4, sold_out, cu=7.5, co=2.5)
        assert stockout == pytest.approx(7.5 * 6)
        assert cost > 0

    def test_demand_lower_bound_is_exact_when_there_was_waste(self):
        o = Observation(d(0), "roll", made=10, refill=0, wasted=3)
        assert not o.censored
        assert o.demand_lower_bound == 7

    def test_above_supply_on_a_sold_out_day_is_flagged_unidentified(self):
        sold_out = Observation(d(0), "roll", made=10, refill=0, wasted=0)
        _, _, _, unid_over = score_decision(12, sold_out, cu=7.5, co=2.5)
        _, _, _, unid_at = score_decision(10, sold_out, cu=7.5, co=2.5)
        _, _, _, unid_under = score_decision(8, sold_out, cu=7.5, co=2.5)
        assert unid_over is True
        assert unid_at is False and unid_under is False

    def test_never_flagged_unidentified_when_waste_was_observed(self):
        o = Observation(d(0), "roll", made=10, refill=0, wasted=3)
        for q in (0, 5, 7, 10, 40):
            assert score_decision(q, o, 7.5, 2.5)[3] is False

    def test_difference_below_supply_is_exactly_identified(self):
        """The property the whole comparison rests on: on a sold-out day, two
        quantities at or below supply differ by a fixed amount no matter what
        the unobserved demand actually was."""
        supply, cu, co = 10.0, 7.5, 2.5
        q1, q2 = 6.0, 9.0
        diffs = set()
        for true_demand in (10, 12, 20, 100):  # every value consistent with D >= supply
            c1 = realised_cost(q1, true_demand, cu, co)
            c2 = realised_cost(q2, true_demand, cu, co)
            diffs.add(round(c2 - c1, 9))
        assert len(diffs) == 1, "difference depended on unobserved demand"
        assert diffs.pop() == pytest.approx(-cu * (q2 - q1))

    def test_unidentified_share_is_reported(self):
        data = [Observation(d(i), "roll", made=10, refill=0, wasted=0)
                for i in range(30)]

        class Greedy:
            name, version = "greedy", "1.0.0"

            def recommend(self, ctx):
                return {i: 25.0 for i in ctx.items}

        r = run_backtest(data, [Greedy()], cfg(), baseline="greedy", warmup_days=7)
        assert r.results["greedy"].unidentified_share == pytest.approx(1.0)

    def test_a_policy_at_or_below_supply_has_no_unidentified_cost(self):
        data = [Observation(d(i), "roll", made=10, refill=0, wasted=0)
                for i in range(30)]

        class Timid:
            name, version = "timid", "1.0.0"

            def recommend(self, ctx):
                return {i: 3.0 for i in ctx.items}

        r = run_backtest(data, [Timid()], cfg(), baseline="timid", warmup_days=7)
        assert r.results["timid"].unidentified_share == 0.0


# ================================================== known-answer recovery ===

class TestRecoversTheRightAnswer:
    """If the harness cannot find an answer that is computable by hand, nothing
    it says about a real model is worth reading."""

    def _fixed_policy(self, q: float, label: str):
        class Fixed:
            name, version = label, "1.0.0"

            def recommend(self, ctx):
                return {i: q for i in ctx.items}
        return Fixed()

    def test_the_newsvendor_quantile_beats_the_mean_on_known_demand(self):
        """Demand ~ uniform{0..20}, c_u = 7.5, c_o = 2.5 so CR = 0.75. The
        optimal quantity is the 75th percentile, 15 -- not the mean, 10. A
        harness that scored on squared error would pick 10 and be wrong."""
        rng = random.Random(20260906)
        demands = [rng.randint(0, 20) for _ in range(400)]
        data = [Observation(d(i), "roll", made=200, refill=0, wasted=200 - dem)
                for i, dem in enumerate(demands)]  # never censored

        policies = [self._fixed_policy(q, f"q{q}") for q in (8, 10, 12, 15, 18)]
        r = run_backtest(data, policies, cfg(price=10.0, cost=2.5),
                         baseline="q10", warmup_days=0)
        costs = {n: p.total_cost for n, p in r.results.items()}
        assert min(costs, key=lambda k: costs[k]) == "q15", costs
        assert costs["q15"] < costs["q10"], "quantile must beat the mean"

    def test_the_optimum_moves_with_the_critical_ratio(self):
        """Halve the margin and the optimal quantity must fall. If it does not,
        the cost model is not actually driving the result."""
        rng = random.Random(7)
        demands = [rng.randint(0, 20) for _ in range(400)]
        data = [Observation(d(i), "roll", made=200, refill=0, wasted=200 - dem)
                for i, dem in enumerate(demands)]
        policies = [self._fixed_policy(q, f"q{q}") for q in range(4, 21, 2)]

        def best(price, cost):
            r = run_backtest(data, policies, cfg(price=price, cost=cost),
                             baseline="q10", warmup_days=0)
            c = {n: p.total_cost for n, p in r.results.items()}
            return int(min(c, key=lambda k: c[k])[1:])

        high_margin = best(price=10.0, cost=1.0)   # CR = 0.90
        low_margin = best(price=10.0, cost=6.0)    # CR = 0.40
        assert high_margin > low_margin, (high_margin, low_margin)

    def test_perfect_foresight_scores_zero(self):
        data = [obs(i, made=10, wasted=2) for i in range(20)]
        actual_demand = {(o.date, o.item_key): o.sold for o in data}

        class Oracle:
            name, version = "oracle", "1.0.0"

            def recommend(self, ctx):
                return {i: actual_demand[(ctx.date, i)] for i in ctx.items}

        r = run_backtest(data, [Oracle()], cfg(), baseline="oracle", warmup_days=0)
        assert r.results["oracle"].total_cost == pytest.approx(0.0)

    def test_operator_actual_replays_what_really_happened(self):
        data = [obs(i, made=10, wasted=2, refill=1) for i in range(20)]
        policy = OperatorActual.from_observations(data)
        r = run_backtest(data, [policy], cfg(), baseline=policy.name, warmup_days=0)
        for s in r.results[policy.name].scored:
            assert s.quantity == s.supply == 11
            # 11 supplied, 9 sold, 2 binned at c_o = 2.5
            assert s.cost == pytest.approx(2 * 2.5)


# ================================================ comparison bookkeeping ====

class TestComparison:
    def test_compares_only_on_days_both_policies_scored(self):
        """A policy that abstains on hard days must not look good by skipping
        them. Restricting to the common set is what prevents that."""
        data = [obs(i, made=10, wasted=2) for i in range(40)]

        class Abstainer:
            name, version = "abstainer", "1.0.0"

            def recommend(self, ctx):
                # Only plays Mondays, where this synthetic demand is cheapest.
                return {i: (8.0 if isoweekday(ctx.date) == 1 else float("nan"))
                        for i in ctx.items}

        base = SameWeekdayMean(window=4, min_observations=2)
        r = run_backtest(data, [base, Abstainer()], cfg(),
                         baseline=base.name, warmup_days=14)
        c = r.compare("abstainer")
        assert c["n_scored"] == r.results["abstainer"].n
        assert c["n_scored"] < r.results[base.name].n

    def test_identical_policies_compare_to_zero(self):
        data = [obs(i, made=10, wasted=2) for i in range(40)]

        def fixed(label):
            class F:
                name, version = label, "1.0.0"

                def recommend(self, ctx):
                    return {i: 7.0 for i in ctx.items}
            return F()

        r = run_backtest(data, [fixed("a"), fixed("b")], cfg(),
                         baseline="a", warmup_days=7)
        assert r.compare("b")["delta"] == pytest.approx(0.0)

    def test_waste_and_stockout_split_sums_to_total(self):
        data = [obs(i, made=10, wasted=i % 4) for i in range(40)]
        base = SameWeekdayMean(window=4, min_observations=2)
        r = run_backtest(data, [base], cfg(), baseline=base.name, warmup_days=14)
        p = r.results[base.name]
        assert p.waste_cost + p.stockout_cost == pytest.approx(p.total_cost)


# =========================================================== robustness =====

class TestRobustness:
    def test_warmup_days_are_not_scored(self):
        data = [obs(i) for i in range(40)]
        base = SameWeekdayMean(window=4, min_observations=2)
        r = run_backtest(data, [base], cfg(), baseline=base.name, warmup_days=21)
        assert min(s.date for s in r.results[base.name].scored) >= d(21)

    def test_insufficient_history_is_skipped_not_guessed(self):
        """An item with too little history must produce no score at all. A
        fabricated number here would quietly enter every aggregate."""
        data = [obs(i, item="roll") for i in range(40)]
        data += [obs(39, item="other")]  # appears once, on the last day
        base = SameWeekdayMean(window=4, min_observations=2)
        r = run_backtest(data, [base], cfg(), baseline=base.name, warmup_days=14)
        assert not any(s.item_key == "other" for s in r.results[base.name].scored)
        assert r.skipped.get(base.name, 0) >= 1

    def test_empty_input_does_not_crash(self):
        base = SameWeekdayMean()
        r = run_backtest([], [base], cfg(), baseline=base.name)
        assert r.results[base.name].total_cost == 0.0
        assert r.evaluated_dates == []

    def test_is_deterministic(self):
        data = [obs(i, made=10, wasted=i % 3) for i in range(60)]
        base = SameWeekdayMean(window=4, min_observations=2)
        runs = [run_backtest(data, [base], cfg(), baseline=base.name, warmup_days=14)
                for _ in range(2)]
        a, b = (sorted((s.date, s.item_key, s.quantity, s.cost)
                       for s in r.results[base.name].scored) for r in runs)
        assert a == b

    def test_quantities_are_whole_units(self):
        data = [obs(i, made=10, wasted=i % 5) for i in range(60)]
        for policy in (SameWeekdayMean(window=4, min_observations=2),
                       SameWeekdayQuantile(window=8, min_observations=4)):
            r = run_backtest(data, [policy], cfg(), baseline=policy.name,
                             warmup_days=28)
            for s in r.results[policy.name].scored:
                assert s.quantity == math.floor(s.quantity), s

    def test_a_policy_returning_nan_never_reaches_the_score(self):
        data = [obs(i) for i in range(20)]

        class Broken:
            name, version = "broken", "1.0.0"

            def recommend(self, ctx):
                return {i: float("nan") for i in ctx.items}

        r = run_backtest(data, [Broken()], cfg(), baseline="broken", warmup_days=0)
        assert r.results["broken"].n == 0
        assert not any(math.isnan(s.cost) for s in r.results["broken"].scored)


class TestHistory:
    def test_same_weekday_filter_is_correct(self):
        h = History([obs(i) for i in range(21)])
        mondays = h.for_item_weekday("roll", 1)
        assert [o.date for o in mondays] == [d(0), d(7), d(14)]

    def test_history_is_sorted_oldest_first(self):
        h = History([obs(i) for i in reversed(range(10))])
        dates = [o.date for o in h.for_item("roll")]
        assert dates == sorted(dates)


class TestCensoringSensitivity:
    """The lower bound is wrong in a known direction. These tests pin down what
    that does to a ranking, so a Phase 4 result can be checked for robustness
    rather than taken on faith."""

    def test_factor_one_is_the_assumption_free_default(self):
        o = Observation(d(0), "roll", made=10, refill=0, wasted=0)
        assert score_decision(6, o, 7.5, 2.5) == score_decision(6, o, 7.5, 2.5, 1.0)

    def test_inflating_censored_demand_never_changes_an_uncensored_day(self):
        """Demand is known exactly when there was waste. The sensitivity knob
        must not touch those days or it stops being a sensitivity analysis."""
        o = Observation(d(0), "roll", made=10, refill=0, wasted=3)
        assert score_decision(6, o, 7.5, 2.5, 1.0) == score_decision(6, o, 7.5, 2.5, 1.5)

    def test_inflation_penalises_timidity_not_aggression(self):
        """Raising assumed demand on sold-out days must make under-production
        look worse, not better -- that is the whole direction of the bias."""
        o = Observation(d(0), "roll", made=10, refill=0, wasted=0)
        timid_1 = score_decision(6, o, 7.5, 2.5, 1.0)[0]
        timid_2 = score_decision(6, o, 7.5, 2.5, 1.3)[0]
        assert timid_2 > timid_1

    def test_a_ranking_can_be_checked_for_robustness(self):
        """Two policies, one timid and one at supply. Under the bound they are
        ranked one way; the sweep shows whether that survives the demand we
        could not see."""
        data = [Observation(d(i), "roll", made=10, refill=0, wasted=0)
                for i in range(30)]

        def fixed(q, label):
            class F:
                name, version = label, "1.0.0"

                def recommend(self, ctx):
                    return {i: q for i in ctx.items}
            return F()

        policies = [fixed(6.0, "timid"), fixed(10.0, "atsupply")]
        gaps = []
        for factor in (1.0, 1.2, 1.5):
            r = run_backtest(data, policies, cfg(), baseline="timid",
                             warmup_days=7, censored_demand_factor=factor)
            gaps.append(r.compare("atsupply")["delta"])
        # atsupply is better at every factor, and its advantage only grows.
        assert all(g < 0 for g in gaps), gaps
        assert gaps == sorted(gaps, reverse=True), gaps


class TestQuantityFloor:
    """An item still on the menu is stocked, not delisted by a calculation.

    The floor is a business constraint that lives in the policy so the backtest
    scores the same rule the prep sheet prints -- and it is kept because it
    measurably helps (-14.1% vs -10.2% against the baseline on the real data),
    not because it sounds sensible.
    """

    def test_a_selling_item_is_never_recommended_at_zero(self):
        # Sells out every day at a supply of 1: the quantile of [1,1,1,1] at a
        # low ratio can round below one, which would take it out of the case.
        data = [Observation(d(i), "roll", made=1, refill=0, wasted=1) for i in range(60)]
        pol = SameWeekdayQuantile(window=8, min_observations=4, floor=1)
        r = run_backtest(data, [pol], cfg(price=10.0, cost=6.0),
                         baseline=pol.name, warmup_days=28)
        assert r.results[pol.name].scored
        assert all(s.quantity >= 1 for s in r.results[pol.name].scored)

    def test_an_item_never_supplied_is_left_at_zero(self):
        """The floor must not conjure production for something not being made."""
        data = [Observation(d(i), "roll", made=0, refill=0, wasted=0) for i in range(60)]
        pol = SameWeekdayQuantile(window=8, min_observations=4, floor=1)
        r = run_backtest(data, [pol], cfg(), baseline=pol.name, warmup_days=28)
        assert all(s.quantity == 0 for s in r.results[pol.name].scored)

    def test_the_floor_is_recorded_in_the_version(self):
        """A change to the rule must change its version, or stored
        recommendations become impossible to attribute."""
        assert SameWeekdayQuantile(floor=1).version != SameWeekdayQuantile(floor=2).version

    def test_the_floor_never_lowers_a_higher_recommendation(self):
        data = [Observation(d(i), "roll", made=20, refill=0, wasted=5) for i in range(60)]
        a = SameWeekdayQuantile(window=8, min_observations=4, floor=0)
        b = SameWeekdayQuantile(window=8, min_observations=4, floor=1)
        r = run_backtest(data, [a, b], cfg(), baseline=a.name, warmup_days=28)
        qa = {(s.date, s.item_key): s.quantity for s in r.results[a.name].scored}
        for s in r.results[b.name].scored:
            assert s.quantity >= qa[(s.date, s.item_key)]
