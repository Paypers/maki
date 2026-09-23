"""Tests for the write-it-down-first prediction and its scoring.

What is protected here: the interval is for the NEXT day, not for the mean;
everything predicted is "what this plan would sell", never demand the plan
could not have seen; and the score reads back exactly what was written.
"""

from __future__ import annotations

import datetime
import json
import math
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from analysis.costs import CostConfig  # noqa: E402
from analysis.data import Observation  # noqa: E402
from analysis.prediction import (  # noqa: E402
    DayPrediction, Interval, ItemPrediction, interval, predict_day, score_day,
)

TUE0 = datetime.date(2026, 6, 2)      # a Tuesday


def tue(n: int) -> str:
    return (TUE0 + datetime.timedelta(days=7 * n)).isoformat()


def obs(date, item, made, wasted):
    return Observation(date=date, item_key=item, made=made, refill=0.0, wasted=wasted)


def cfg():
    return CostConfig(prices={"a": 10.0, "b": 10.0, "c": 10.0},
                      unit_costs={"a": 2.5, "b": 2.5, "c": 2.5},
                      salvage=0.0, promo_weekdays=())


class TestInterval:
    def test_is_for_the_next_draw_not_the_mean(self):
        # The sqrt(1 + 1/n) term. Without it the band is a confidence interval
        # on the mean, which is the wrong question and always too narrow.
        vals = [30.0, 34.0, 36.0, 40.0, 32.0, 38.0, 35.0, 33.0]
        iv = interval(vals)
        import statistics
        n, s = len(vals), statistics.stdev(vals)
        expected_half = 2.365 * s * math.sqrt(1 + 1 / n)
        assert iv.hi95 - iv.point == pytest.approx(expected_half, abs=0.01)
        assert iv.hi68 < iv.hi95

    def test_clamps_to_what_is_possible(self):
        # You cannot sell fewer than zero or more than you made.
        iv = interval([1.0, 0.0, 2.0, 1.0], lo_cap=0, hi_cap=2)
        assert iv.lo95 == 0.0
        assert iv.hi95 == 2.0

    def test_single_value_has_no_width(self):
        iv = interval([5.0])
        assert (iv.lo95, iv.hi95) == (5.0, 5.0)


class TestPredictDay:
    def make_history(self):
        # Four Tuesdays. Item a: made 4, sold 2,3,4,4 (last two sold out).
        # Item b: made 2, sold 1 every time.
        rows = []
        for i, sold in enumerate([2, 3, 4, 4]):
            rows.append(obs(tue(i), "a", 4.0, 4.0 - sold))
            rows.append(obs(tue(i), "b", 2.0, 1.0))
        return rows

    def test_uses_only_days_before_the_date(self):
        hist = self.make_history()
        p = predict_day(tue(4), {"a": 4, "b": 2}, hist, cfg(), now="t")
        assert p.basis_dates == [tue(0), tue(1), tue(2), tue(3)]
        assert tue(4) not in p.basis_dates

    def test_predicts_what_the_plan_would_sell_not_what_was_sold(self):
        # Plan a=3. On the two 4-sold days the plan would have sold 3, not 4.
        hist = self.make_history()
        p = predict_day(tue(4), {"a": 3, "b": 2}, hist, cfg(), now="t")
        a = next(i for i in p.items if i.item == "a")
        assert a.sold.point == pytest.approx((2 + 3 + 3 + 3) / 4)
        # And the day total follows: a + b each day.
        assert p.sold.point == pytest.approx((3 + 4 + 4 + 4) / 4)

    def test_counts_a_sellout_when_demand_met_or_beat_the_plan(self):
        hist = self.make_history()
        p = predict_day(tue(4), {"a": 3, "b": 2}, hist, cfg(), now="t")
        a = next(i for i in p.items if i.item == "a")
        # sold 2 (no), 3 (yes), 4 (yes), 4 (yes)
        assert a.sold  # sanity
        assert a.sellout_share == pytest.approx(3 / 4)

    def test_waste_is_the_plan_minus_sold(self):
        hist = self.make_history()
        p = predict_day(tue(4), {"a": 4, "b": 2}, hist, cfg(), now="t")
        assert p.wasted.point == pytest.approx(p.total_made - p.sold.point)
        assert p.wasted.lo68 == pytest.approx(p.total_made - p.sold.hi68)

    def test_refuses_too_little_history(self):
        hist = self.make_history()[:4]      # two Tuesdays
        with pytest.raises(ValueError):
            predict_day(tue(4), {"a": 4}, hist, cfg(), now="t")

    def test_an_item_not_made_on_a_basis_day_counts_as_zero_sold(self):
        # No information is treated as the floor, consistently with the rest.
        hist = self.make_history() + [obs(tue(i), "c", 1.0, 0.0) for i in (2, 3)]
        p = predict_day(tue(4), {"a": 4, "c": 1}, hist, cfg(), now="t")
        c = next(i for i in p.items if i.item == "c")
        assert c.sold.point == pytest.approx((0 + 0 + 1 + 1) / 4)


class TestScoreDay:
    def stored(self):
        iv = Interval(point=10.0, lo68=8.0, hi68=12.0, lo95=5.0, hi95=15.0, n=8, sd=2.0)
        item = ItemPrediction(item="a", plan=4.0,
                              sold=Interval(3.0, 2.0, 4.0, 1.0, 4.0, 8, 1.0),
                              sellout_share=0.5)
        return DayPrediction(date=tue(4), weekday="Tuesday", plan_name="t", made_at="t",
                             basis_dates=[], plan={"a": 4.0}, total_made=4.0,
                             sold=iv, wasted=iv, waste_pct=iv, revenue=iv, sellouts=iv,
                             items=[item], notes=[])

    def test_flags_inside_and_outside_each_band(self):
        s = score_day(self.stored(), [obs(tue(4), "a", 4.0, 0.0)], cfg())
        by = {q.name: q for q in s.quantities}
        # sold 4: outside 68 (8-12) and outside 95 (5-15)
        assert not by["sold"].in68 and not by["sold"].in95
        assert by["sold"].z == pytest.approx((4 - 10) / 2)

    def test_item_range_check(self):
        s = score_day(self.stored(), [obs(tue(4), "a", 4.0, 0.0)], cfg())
        assert s.items_in_range == 1 and s.item_misses == []

    def test_notices_when_the_plan_was_not_followed(self):
        # Made 6, plan was 4: the prediction was for a different day than
        # the one that happened, and the score must say so.
        s = score_day(self.stored(), [obs(tue(4), "a", 6.0, 1.0)], cfg())
        assert not s.made_matches_plan

    def test_refuses_a_day_with_no_observations(self):
        with pytest.raises(ValueError):
            score_day(self.stored(), [obs(tue(3), "a", 4.0, 0.0)], cfg())

    def test_json_round_trip_is_lossless(self):
        # The scorer reads back what the predictor wrote. Anything lost in
        # between is a prediction that cannot be checked.
        p = self.stored()
        raw = json.loads(json.dumps(p.to_json()))
        sys.path.insert(0, os.path.join(ROOT, "tools"))
        from score_prediction import load_prediction  # noqa: E402
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False,
                                         encoding="utf-8") as fh:
            json.dump(raw, fh)
            path = fh.name
        try:
            back = load_prediction(path)
        finally:
            os.unlink(path)
        assert back == p
