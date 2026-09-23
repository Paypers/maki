"""Tests for censored Poisson regression.

The decisive test is `test_censored_fit_recovers_the_true_rate`: on data where
demand is generated from a known law and then censored at the supply level, an
ordinary fit must come out biased LOW and the censored fit must not. That is the
entire reason this estimator exists.
"""

from __future__ import annotations

import os
import sys

import numpy as np
import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from analysis.countreg import dispersion_ratio, fit_censored_poisson  # noqa: E402


def sample(seed, n=1500, beta=(1.4, 0.6), limit=None):
    """demand ~ Poisson(exp(b0 + b1 x)), observed as min(demand, limit)."""
    rng = np.random.default_rng(seed)
    x = rng.uniform(-1, 1, size=n)
    lam = np.exp(beta[0] + beta[1] * x)
    demand = rng.poisson(lam)
    if limit is None:
        return x.reshape(-1, 1), demand.astype(float), np.zeros(n, bool), demand
    observed = np.minimum(demand, limit)
    return x.reshape(-1, 1), observed.astype(float), demand >= limit, demand


class TestUncensored:
    def test_recovers_known_coefficients(self):
        X, y, cens, _ = sample(1)
        fit = fit_censored_poisson(X, y, cens, ridge=0.0)
        assert fit.converged
        assert fit.coef[0] == pytest.approx(1.4, abs=0.06)
        assert fit.coef[1] == pytest.approx(0.6, abs=0.08)

    def test_intercept_only_recovers_the_mean(self):
        rng = np.random.default_rng(2)
        y = rng.poisson(5.0, size=3000).astype(float)
        fit = fit_censored_poisson(np.zeros((len(y), 1)), y,
                                   np.zeros(len(y), bool), ridge=0.0)
        assert np.exp(fit.coef[0]) == pytest.approx(y.mean(), rel=0.03)


class TestCensoring:
    def test_ignoring_censoring_biases_the_rate_low(self):
        """Establishes the problem. If this stops failing, the fixture is not
        actually censored and the next test proves nothing."""
        X, observed, cens, demand = sample(3, limit=4)
        assert cens.mean() > 0.3
        naive = fit_censored_poisson(X, observed, np.zeros_like(cens), ridge=0.0)
        assert naive.rate(X).mean() < demand.mean() - 0.3

    def test_censored_fit_recovers_the_true_rate(self):
        X, observed, cens, demand = sample(3, limit=4)
        naive = fit_censored_poisson(X, observed, np.zeros_like(cens), ridge=0.0)
        fixed = fit_censored_poisson(X, observed, cens, ridge=0.0)
        assert fixed.converged
        truth = demand.mean()
        assert abs(fixed.rate(X).mean() - truth) < abs(naive.rate(X).mean() - truth)
        assert fixed.rate(X).mean() == pytest.approx(truth, rel=0.10)

    def test_recovers_coefficients_under_heavy_censoring(self):
        """Half the observations censored -- roughly this project's rate."""
        X, observed, cens, _ = sample(11, n=2500, limit=4)
        fit = fit_censored_poisson(X, observed, cens, ridge=0.0)
        assert fit.coef[0] == pytest.approx(1.4, abs=0.12)
        assert fit.coef[1] == pytest.approx(0.6, abs=0.15)

    def test_can_predict_above_every_observed_value(self):
        """The whole point: the fitted tail extends past the censoring frontier,
        which is what Powell's estimator structurally cannot do."""
        X, observed, cens, _ = sample(5, limit=4)
        fit = fit_censored_poisson(X, observed, cens, ridge=0.0)
        assert fit.quantile(X, 0.75).max() > observed.max()

    def test_reports_how_many_were_censored(self):
        X, observed, cens, _ = sample(7, limit=4)
        fit = fit_censored_poisson(X, observed, cens)
        assert fit.n_censored == int(cens.sum())
        assert fit.n_observations == len(observed)


class TestQuantiles:
    def test_quantiles_increase_with_tau(self):
        X, y, cens, _ = sample(13)
        fit = fit_censored_poisson(X, y, cens)
        q = [fit.quantile(X, t).mean() for t in (0.3, 0.5, 0.7, 0.9)]
        assert q == sorted(q)

    def test_quantile_matches_the_poisson_law_at_the_fitted_rate(self):
        from scipy.stats import poisson
        X, y, cens, _ = sample(17)
        fit = fit_censored_poisson(X, y, cens)
        assert np.array_equal(fit.quantile(X, 0.8), poisson.ppf(0.8, fit.rate(X)))


class TestDispersion:
    def test_is_about_one_for_genuine_poisson_data(self):
        X, y, cens, _ = sample(19, n=4000)
        fit = fit_censored_poisson(X, y, cens)
        assert dispersion_ratio(y, fit.rate(X)) == pytest.approx(1.0, abs=0.12)

    def test_detects_overdispersion(self):
        """Overdispersed demand means the Poisson tail is too thin and the
        recommendation comes out too low. The number has to be visible."""
        rng = np.random.default_rng(23)
        lam = rng.gamma(shape=2.0, scale=2.5, size=3000)
        y = rng.poisson(lam).astype(float)
        fit = fit_censored_poisson(np.zeros((len(y), 1)), y, np.zeros(len(y), bool))
        assert dispersion_ratio(y, fit.rate(np.zeros((len(y), 1)))) > 1.8


class TestRobustness:
    def test_rejects_negative_counts(self):
        with pytest.raises(ValueError, match="non-negative"):
            fit_censored_poisson(np.zeros((3, 1)), np.array([-1.0, 0, 1]),
                                 np.zeros(3, bool))

    def test_validates_lengths(self):
        with pytest.raises(ValueError, match="same length"):
            fit_censored_poisson(np.zeros((5, 1)), np.zeros(5), np.zeros(4, bool))

    def test_handles_all_zero_counts(self):
        X = np.zeros((40, 1))
        fit = fit_censored_poisson(X, np.zeros(40), np.zeros(40, bool))
        assert fit.rate(X).max() < 0.5

    def test_handles_everything_censored(self):
        X, observed, _, _ = sample(29, n=300, limit=1)
        fit = fit_censored_poisson(X, observed, np.ones(len(observed), bool))
        assert np.all(np.isfinite(fit.coef))

    def test_is_deterministic(self):
        X, y, cens, _ = sample(31)
        a = fit_censored_poisson(X, y, cens).coef
        b = fit_censored_poisson(X, y, cens).coef
        assert np.array_equal(a, b)
