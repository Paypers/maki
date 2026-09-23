"""Tests for feature construction.

The one that matters is the causality test. The backtest hides the future from a
policy, but a feature builder that computed a trailing mean across the whole
training block would leak the future INSIDE the training set -- the model would
learn against a predictor it can never have at decision time, and the harness
could not detect it. That leak is prevented in build_design and pinned here.
"""

from __future__ import annotations

import os
import sys

import numpy as np
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from analysis.data import Observation  # noqa: E402
from analysis.features import (  # noqa: E402
    FEATURE_NAMES, add_item_dummies, build_design, day_features, trailing_level,
)

EPOCH = "2026-01-05"  # a Monday


def d(n: int) -> str:
    import datetime
    return (datetime.date.fromisoformat(EPOCH) + datetime.timedelta(days=n)).isoformat()


def obs(n: int, item="roll", made=10.0, wasted=2.0):
    return Observation(date=d(n), item_key=item, made=made, refill=0.0, wasted=wasted)


class TestCausality:
    def test_trailing_level_uses_only_strictly_earlier_rows(self):
        """Row i's trailing level must be the mean of rows before i -- never
        including i itself, and never anything after."""
        series = [obs(i, made=10.0, wasted=10.0 - (i + 1)) for i in range(12)]
        # sold on row i is i + 1
        design = build_design(series, epoch=EPOCH, level_window=100, min_history=3)
        col = FEATURE_NAMES.index("trailing_level")
        for row, date in enumerate(design.dates):
            i = [o.date for o in series].index(date)
            expected = sum(o.sold for o in series[:i]) / i
            assert design.X[row, col] == pytest.approx(expected), date

    def test_a_spike_at_the_end_cannot_affect_earlier_rows(self):
        clean = [obs(i, made=10.0, wasted=2.0) for i in range(20)]
        spiked = clean[:15] + [obs(i, made=999.0, wasted=0.0) for i in range(15, 20)]
        a = build_design(clean, epoch=EPOCH, min_history=3)
        b = build_design(spiked, epoch=EPOCH, min_history=3)
        early = [i for i, dt in enumerate(a.dates) if dt < d(15)]
        assert np.allclose(a.X[early], b.X[early])

    def test_rows_without_enough_history_are_dropped_not_zero_filled(self):
        series = [obs(i) for i in range(10)]
        design = build_design(series, epoch=EPOCH, min_history=3)
        assert len(design) == 7
        assert min(design.dates) == d(3)


class TestEncoding:
    def test_monday_is_the_reference_level(self):
        f = day_features(d(0), trailing_level=0.0, trend=0.0)  # a Monday
        assert f[:6].sum() == 0.0

    def test_each_other_weekday_sets_exactly_one_dummy(self):
        for offset in range(1, 7):
            f = day_features(d(offset), 0.0, 0.0)
            assert f[:6].sum() == 1.0, d(offset)

    def test_wednesday_maps_to_its_own_column(self):
        f = day_features(d(2), 0.0, 0.0)
        assert f[FEATURE_NAMES.index("dow_wed")] == 1.0

    def test_trend_is_measured_in_weeks(self):
        f = day_features(d(14), 0.0, trend=2.0)
        assert f[FEATURE_NAMES.index("trend")] == 2.0

    def test_feature_count_matches_the_declared_names(self):
        assert len(day_features(d(3), 1.0, 2.0)) == len(FEATURE_NAMES)


class TestTrailingLevel:
    def test_empty_history_is_zero(self):
        assert trailing_level([], 14) == 0.0

    def test_respects_the_window(self):
        series = [obs(i, made=10.0, wasted=10.0 - (i + 1)) for i in range(20)]
        assert trailing_level(series, 3) == pytest.approx((18 + 19 + 20) / 3)


class TestPooledDesign:
    def test_item_dummies_use_the_first_item_as_reference(self):
        series = [obs(i, item="a") for i in range(8)] + [obs(i, item="b") for i in range(8)]
        design = build_design(series, epoch=EPOCH, min_history=3)
        X, names = add_item_dummies(design, ["a", "b"])
        assert names[0] == "item_b"
        for row, key in enumerate(design.item_keys):
            assert X[row, 0] == (1.0 if key == "b" else 0.0)

    def test_single_item_gets_no_dummies(self):
        series = [obs(i) for i in range(8)]
        design = build_design(series, epoch=EPOCH, min_history=3)
        X, names = add_item_dummies(design, ["roll"])
        assert names == FEATURE_NAMES
        assert X.shape[1] == len(FEATURE_NAMES)

    def test_censoring_limit_is_the_supply(self):
        series = [Observation(d(i), "roll", made=8.0, refill=2.0, wasted=0.0)
                  for i in range(8)]
        design = build_design(series, epoch=EPOCH, min_history=3)
        assert np.all(design.limit == 10.0)
        assert np.all(design.y == 10.0)  # sold out: observed == limit
