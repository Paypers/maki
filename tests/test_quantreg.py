"""Tests for the quantile-regression estimators.

The decisive checks here are:

  * agreement with statsmodels' QuantReg, an independent implementation. If two
    unrelated solvers land on the same coefficients, the LP formulation is right.
  * recovery of a KNOWN quantile from synthetic data with a known law.
  * that censoring is actually corrected -- an ordinary fit on censored data
    must come out biased low, and the censored fit must not.

statsmodels is used ONLY here, as a reference oracle. Nothing in analysis/
imports it.
"""

from __future__ import annotations

import os
import sys

import numpy as np
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from analysis.quantreg import (  # noqa: E402
    check_loss, fit_censored_quantile_regression, fit_quantile_regression,
)


def statsmodels_quantreg(X: np.ndarray, y: np.ndarray, tau: float) -> np.ndarray:
    import statsmodels.api as sm
    Z = sm.add_constant(np.asarray(X, dtype=float), has_constant="add")
    return sm.QuantReg(np.asarray(y, dtype=float), Z).fit(q=tau).params


class TestAgainstReferenceImplementation:
    @pytest.mark.parametrize("tau", [0.25, 0.5, 0.72, 0.9])
    def test_matches_statsmodels_on_continuous_data(self, tau):
        rng = np.random.default_rng(11)
        n = 400
        X = rng.normal(size=(n, 3))
        y = 2.0 + X @ np.array([1.5, -0.8, 0.3]) + rng.normal(scale=1.2, size=n)
        mine = fit_quantile_regression(X, y, tau).coef
        theirs = statsmodels_quantreg(X, y, tau)
        assert np.allclose(mine, theirs, atol=2e-3), (mine, theirs)

    def test_matches_statsmodels_with_dummy_columns(self):
        """Dummies are where a shaky formulation shows up: columns are collinear
        and the LP has ties."""
        rng = np.random.default_rng(3)
        n = 300
        dow = rng.integers(0, 7, size=n)
        X = np.column_stack([(dow == k).astype(float) for k in range(1, 7)])
        y = 5.0 + 2.0 * (dow == 2) + rng.normal(scale=1.0, size=n)
        mine = fit_quantile_regression(X, y, 0.7).coef
        theirs = statsmodels_quantreg(X, y, 0.7)
        pred_mine = np.hstack([np.ones((n, 1)), X]) @ mine
        pred_theirs = np.hstack([np.ones((n, 1)), X]) @ theirs
        # Coefficients can differ under ties; predictions must not.
        assert np.allclose(pred_mine, pred_theirs, atol=1e-2)


class TestRecoversKnownQuantiles:
    def test_intercept_only_recovers_the_empirical_quantile(self):
        rng = np.random.default_rng(5)
        y = rng.normal(loc=10.0, scale=3.0, size=2000)
        for tau in (0.1, 0.5, 0.75, 0.95):
            fit = fit_quantile_regression(np.zeros((len(y), 1)), y, tau)
            assert fit.coef[0] == pytest.approx(np.quantile(y, tau), abs=0.25)

    def test_recovers_a_known_conditional_quantile(self):
        """y = 3 + 2x + N(0,1). The true tau-quantile is 3 + 2x + z_tau."""
        rng = np.random.default_rng(7)
        n = 3000
        x = rng.uniform(-2, 2, size=n)
        y = 3.0 + 2.0 * x + rng.normal(size=n)
        tau = 0.8
        z = 0.8416  # Phi^-1(0.8)
        fit = fit_quantile_regression(x.reshape(-1, 1), y, tau)
        assert fit.coef[0] == pytest.approx(3.0 + z, abs=0.12)
        assert fit.coef[1] == pytest.approx(2.0, abs=0.08)

    def test_a_higher_tau_never_predicts_lower(self):
        rng = np.random.default_rng(9)
        X = rng.normal(size=(500, 2))
        y = X @ np.array([1.0, 0.5]) + rng.normal(size=500)
        preds = [fit_quantile_regression(X, y, t).predict(X) for t in (0.3, 0.6, 0.9)]
        assert preds[0].mean() < preds[1].mean() < preds[2].mean()

    def test_rejects_a_tau_outside_the_unit_interval(self):
        X, y = np.zeros((5, 1)), np.arange(5.0)
        for bad in (0.0, 1.0, -0.1, 1.5):
            with pytest.raises(ValueError, match="tau"):
                fit_quantile_regression(X, y, bad)


class TestCensoring:
    """The reason this module exists."""

    @staticmethod
    def _censored_sample(seed: int, n: int = 1200, limit_level: float = 12.0):
        """True demand ~ 10 + 3x + N(0,3), observed as min(demand, limit)."""
        rng = np.random.default_rng(seed)
        x = rng.uniform(-1, 1, size=n)
        true_demand = 10.0 + 3.0 * x + rng.normal(scale=3.0, size=n)
        limit = np.full(n, limit_level)
        observed = np.minimum(true_demand, limit)
        return x.reshape(-1, 1), observed, limit, true_demand

    def test_ordinary_fit_on_censored_data_is_biased_low(self):
        """Establishes the problem before testing the fix. If this ever stops
        failing, the synthetic data is not actually censored."""
        X, observed, limit, true_demand = self._censored_sample(21)
        tau = 0.75
        naive = fit_quantile_regression(X, observed, tau)
        truth = fit_quantile_regression(X, true_demand, tau)
        assert naive.predict(X).mean() < truth.predict(X).mean() - 0.5

    def test_censored_fit_recovers_the_uncensored_quantile(self):
        X, observed, limit, true_demand = self._censored_sample(21)
        tau = 0.75
        truth = fit_quantile_regression(X, true_demand, tau)
        naive = fit_quantile_regression(X, observed, tau)
        fixed = fit_censored_quantile_regression(X, observed, limit, tau)

        err_naive = abs(naive.predict(X).mean() - truth.predict(X).mean())
        err_fixed = abs(fixed.predict(X).mean() - truth.predict(X).mean())
        assert err_fixed < err_naive, (err_fixed, err_naive)
        assert err_fixed < 0.5

    def test_is_a_no_op_when_nothing_is_censored(self):
        rng = np.random.default_rng(2)
        X = rng.normal(size=(300, 2))
        y = X @ np.array([1.0, -0.5]) + rng.normal(size=300)
        limit = np.full(300, 1e9)
        plain = fit_quantile_regression(X, y, 0.7)
        censored = fit_censored_quantile_regression(X, y, limit, 0.7)
        assert np.allclose(plain.coef, censored.coef, atol=1e-6)
        assert censored.converged

    def test_reports_not_converged_when_almost_everything_is_censored(self):
        """A fit built on a handful of rows must announce itself rather than be
        passed off as reliable -- with 117 days this really happens."""
        X, observed, limit, _ = self._censored_sample(4, n=60, limit_level=6.0)
        fit = fit_censored_quantile_regression(X, observed, limit, 0.85)
        assert fit.converged is False
        assert fit.n_effective < 30

    def test_effective_sample_size_is_reported(self):
        X, observed, limit, _ = self._censored_sample(8, n=800, limit_level=12.0)
        fit = fit_censored_quantile_regression(X, observed, limit, 0.75)
        assert 0 < fit.n_effective <= fit.n_observations
        assert fit.observations_per_parameter == fit.n_effective / fit.n_parameters

    def test_validates_input_lengths(self):
        with pytest.raises(ValueError, match="same length"):
            fit_censored_quantile_regression(
                np.zeros((10, 1)), np.zeros(10), np.zeros(9), 0.5)


class TestCheckLoss:
    def test_is_zero_for_a_perfect_prediction(self):
        y = np.arange(10.0)
        assert check_loss(y, y, 0.7) == pytest.approx(0.0)

    def test_penalises_asymmetrically(self):
        """At tau = 0.9 under-predicting must hurt far more than over-predicting,
        which is the whole point of fitting a high quantile."""
        y = np.zeros(100)
        under = check_loss(y, np.full(100, -1.0), 0.9)
        over = check_loss(y, np.full(100, 1.0), 0.9)
        assert under == pytest.approx(9 * over)

    def test_is_minimised_at_the_true_quantile(self):
        rng = np.random.default_rng(13)
        y = rng.normal(size=5000)
        tau = 0.7
        losses = {q: check_loss(y, np.full_like(y, np.quantile(y, q)), tau)
                  for q in (0.5, 0.6, 0.7, 0.8, 0.9)}
        assert min(losses, key=lambda k: losses[k]) == 0.7


class TestDeterminism:
    def test_same_input_gives_identical_coefficients(self):
        rng = np.random.default_rng(1)
        X = rng.normal(size=(200, 3))
        y = X @ np.array([1.0, 2.0, -1.0]) + rng.normal(size=200)
        a = fit_quantile_regression(X, y, 0.72).coef
        b = fit_quantile_regression(X, y, 0.72).coef
        assert np.array_equal(a, b)
