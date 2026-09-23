"""Quantile regression, with and without right-censoring.

Two estimators live here.

`fit_quantile_regression` is ordinary linear quantile regression, solved as a
linear program. The check-function objective

    min_b  sum_i rho_tau(y_i - x_i'b),    rho_tau(r) = r * (tau - 1{r < 0})

is exactly an LP once residuals are split into positive and negative parts:

    min  tau * sum(u) + (1 - tau) * sum(v)
    s.t. X b + u - v = y,   u, v >= 0

Solved with HiGHS, so it is exact rather than iterative, and deterministic.
The tests check it against statsmodels' QuantReg on the same data -- an
independent implementation agreeing is the strongest available evidence the
formulation is right.

`fit_censored_quantile_regression` is Powell's censored quantile regression,
fitted by Buchinsky's iterative linear programming algorithm. This is the
estimator the project actually needs, because 49% of item-days are right-
censored: the item sold out, and all that was observed is min(demand, supply).

The idea is simple once seen. If Y* is true demand and we observe
Y = min(Y*, c) with a known limit c, then quantiles pass through the min:

    Q_tau(Y | x) = min(Q_tau(Y* | x), c)

So an observation is informative about the linear quantile exactly when the
fitted quantile lies below that day's censoring limit. Iterate: fit on the rows
where x'b < c, refit, repeat until the selected set stops changing.

Fitting an ordinary quantile regression to censored data instead biases the
estimate DOWNWARD -- and in this system that bias feeds back: under-forecast,
produce less, sell out again, observe an even lower ceiling.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.optimize import linprog


@dataclass(frozen=True)
class QuantileFit:
    """Coefficients plus everything needed to judge whether to trust them."""

    coef: np.ndarray          # includes the intercept as coef[0]
    tau: float
    n_observations: int
    n_effective: int          # rows the final fit actually used
    n_parameters: int
    converged: bool
    iterations: int

    @property
    def observations_per_parameter(self) -> float:
        return self.n_effective / self.n_parameters if self.n_parameters else 0.0

    def predict(self, X: np.ndarray) -> np.ndarray:
        return _with_intercept(X) @ self.coef


def _with_intercept(X: np.ndarray) -> np.ndarray:
    X = np.asarray(X, dtype=float)
    if X.ndim == 1:
        X = X.reshape(-1, 1)
    return np.hstack([np.ones((X.shape[0], 1)), X])


def fit_quantile_regression(
    X: np.ndarray,
    y: np.ndarray,
    tau: float,
    *,
    ridge: float = 1e-8,
) -> QuantileFit:
    """Ordinary linear quantile regression at level `tau`, solved exactly.

    `ridge` is a tiny L1 penalty on the slopes, present only to make the LP's
    optimum unique when columns are collinear -- with dummy variables and few
    observations that happens often, and an arbitrary pick among tied optima
    would make results depend on solver internals rather than on data.
    """
    if not 0.0 < tau < 1.0:
        raise ValueError(f"tau must be in (0, 1), got {tau}")
    Z = _with_intercept(X)
    y = np.asarray(y, dtype=float).ravel()
    n, p = Z.shape
    if n == 0:
        raise ValueError("no observations")

    # Variables: [b+ (p), b- (p), u (n), v (n)]. Splitting b lets the ridge term
    # be linear; u, v are the positive and negative residual parts.
    c = np.concatenate([
        np.full(p, ridge), np.full(p, ridge),
        np.full(n, tau), np.full(n, 1.0 - tau),
    ])
    c[0] = c[p] = 0.0  # never penalise the intercept

    A_eq = np.hstack([Z, -Z, np.eye(n), -np.eye(n)])
    res = linprog(c, A_eq=A_eq, b_eq=y,
                  bounds=[(0, None)] * (2 * p + 2 * n), method="highs")
    if not res.success:
        raise RuntimeError(f"quantile regression LP failed: {res.message}")

    coef = res.x[:p] - res.x[p:2 * p]
    return QuantileFit(coef=coef, tau=tau, n_observations=n, n_effective=n,
                       n_parameters=p, converged=True, iterations=1)


def fit_censored_quantile_regression(
    X: np.ndarray,
    y: np.ndarray,
    censoring_limit: np.ndarray,
    tau: float,
    *,
    max_iterations: int = 25,
    min_effective: int = 10,
    ridge: float = 1e-8,
) -> QuantileFit:
    """Powell's censored quantile regression via iterative LP (Buchinsky).

    `y` is the OBSERVED value, min(true, limit). `censoring_limit` is that day's
    limit -- here, the quantity actually supplied.

    Starts from the fit on all rows, then repeatedly keeps only rows whose
    predicted quantile sits below their censoring limit and refits. Those are
    exactly the rows where the observed value carries information about the
    linear quantile; the rest are known only to be at or above their limit.

    Falls back to the ordinary fit if the selected set collapses below
    `min_effective`, and says so via `converged=False` -- with 117 days that
    happens for thin items and must not be silently passed off as a real fit.
    """
    X = np.asarray(X, dtype=float)
    y = np.asarray(y, dtype=float).ravel()
    limit = np.asarray(censoring_limit, dtype=float).ravel()
    if not (len(y) == len(limit) == X.shape[0]):
        raise ValueError("X, y and censoring_limit must have the same length")

    base = fit_quantile_regression(X, y, tau, ridge=ridge)
    coef, selected = base.coef, np.ones(len(y), dtype=bool)

    for iteration in range(1, max_iterations + 1):
        pred = _with_intercept(X) @ coef
        keep = pred < limit
        if keep.sum() < max(min_effective, base.n_parameters + 1):
            # Not enough rows are informative. Report the uncensored fit and
            # flag it, rather than returning a fit built on almost nothing.
            return QuantileFit(coef=base.coef, tau=tau, n_observations=len(y),
                               n_effective=int(keep.sum()),
                               n_parameters=base.n_parameters,
                               converged=False, iterations=iteration)
        if np.array_equal(keep, selected) and iteration > 1:
            return QuantileFit(coef=coef, tau=tau, n_observations=len(y),
                               n_effective=int(keep.sum()),
                               n_parameters=base.n_parameters,
                               converged=True, iterations=iteration)
        selected = keep
        try:
            step = fit_quantile_regression(X[keep], y[keep], tau, ridge=ridge)
        except (RuntimeError, ValueError):
            return QuantileFit(coef=coef, tau=tau, n_observations=len(y),
                               n_effective=int(keep.sum()),
                               n_parameters=base.n_parameters,
                               converged=False, iterations=iteration)
        coef = step.coef

    return QuantileFit(coef=coef, tau=tau, n_observations=len(y),
                       n_effective=int(selected.sum()),
                       n_parameters=base.n_parameters,
                       converged=False, iterations=max_iterations)


def check_loss(y: np.ndarray, pred: np.ndarray, tau: float) -> float:
    """Mean pinball loss. Used for diagnostics only -- never for scoring a
    policy, which is done in dollars by the backtest harness."""
    r = np.asarray(y, dtype=float) - np.asarray(pred, dtype=float)
    return float(np.mean(np.maximum(tau * r, (tau - 1.0) * r)))
