"""Phase 4 policies: censored quantile regression at the critical ratio.

Two variants, because the right one is an empirical question that the backtest
answers rather than something to assert up front:

  `PerItemCQR`   one fit per item, as specified. Nine parameters against roughly
                 ninety observations per item -- and the censored fit discards
                 rows above the censoring frontier, so the effective count is
                 smaller again. Overfitting risk is real and is measured, not
                 assumed away.

  `PooledCQR`    one fit across all items with per-item intercepts and shared
                 day-of-week, level and trend coefficients. Far more data per
                 parameter; it cannot express an item whose weekly shape genuinely
                 differs from the rest.

The critical ratio varies by item AND by day (Wednesday's promotion lowers it),
so a single tau will not do. The pooled model is fitted on a small grid of taus
and interpolated to whatever each item-day needs; the per-item model is fitted
at the distinct taus that item actually requires.

Both fall back to the trailing same-weekday quantile whenever a fit is thin or
did not converge, and both record how often that happened. A model that silently
falls back most of the time while reporting a good score is exactly the failure
this project cannot afford.
"""

from __future__ import annotations

import math
from collections import defaultdict

import numpy as np

from .costs import CostConfig
from .data import Observation, isoweekday
from .features import (
    FEATURE_NAMES, add_item_dummies, build_design, day_features,
    select_features, trailing_level,
)
from .policies import DayContext, _empirical_quantile, _round_up
from .quantreg import QuantileFit, fit_censored_quantile_regression

#: Grid the pooled model is fitted on, then interpolated between.
TAU_GRID = (0.55, 0.65, 0.75, 0.85)


class _FallbackMixin:
    """Shared fallback: the trailing same-weekday empirical quantile.

    Deliberately the Phase 3 quantile policy rather than something cleverer, so
    a degraded day behaves exactly like a known-quantity baseline and the
    morning sheet stays interpretable when the model is unavailable.
    """

    fallback_window = 8
    fallback_min = 3

    def _fallback(self, ctx: DayContext, item: str) -> float:
        past = ctx.history.for_item_weekday(item, isoweekday(ctx.date))[-self.fallback_window:]
        if len(past) < self.fallback_min:
            return float("nan")
        try:
            tau = ctx.costs.critical_ratio(item, ctx.date)
        except (KeyError, ValueError):
            return float("nan")
        return _round_up(_empirical_quantile(sorted(o.sold for o in past), tau))


class PerItemCQR(_FallbackMixin):
    """Independent censored quantile regression per item."""

    name = "per_item_cqr"

    def __init__(self, *, level_window: int = 14, min_observations: int = 40,
                 refit_every_days: int = 7, max_quantity: float = 60.0):
        self.level_window = level_window
        self.min_observations = min_observations
        self.refit_every_days = refit_every_days
        self.max_quantity = max_quantity
        self.version = f"1.0.0-lw{level_window}-min{min_observations}"
        self._cache: dict[tuple[str, float], QuantileFit | None] = {}
        self._cache_key: str | None = None
        self.diagnostics: dict[str, int] = defaultdict(int)

    def _taus_for(self, item: str, costs: CostConfig, dates: list[str]) -> list[float]:
        out = set()
        for d in dates:
            try:
                out.add(round(costs.critical_ratio(item, d), 4))
            except (KeyError, ValueError):
                continue
        return sorted(out)

    def _refit(self, ctx: DayContext) -> None:
        self._cache.clear()
        obs = [o for item in ctx.history.items for o in ctx.history.for_item(item)]
        if not obs:
            return
        epoch = min(o.date for o in obs)
        # A week of upcoming dates is enough to cover both tau values in play.
        upcoming = [ctx.date] + [_shift(ctx.date, k) for k in range(1, 7)]

        for item in ctx.history.items:
            item_obs = ctx.history.for_item(item)
            design = build_design(item_obs, epoch=epoch, level_window=self.level_window)
            if len(design) < self.min_observations:
                self.diagnostics["too_few_observations"] += 1
                continue
            for tau in self._taus_for(item, ctx.costs, upcoming):
                try:
                    fit = fit_censored_quantile_regression(
                        design.X, design.y, design.limit, tau)
                except (RuntimeError, ValueError):
                    self.diagnostics["fit_failed"] += 1
                    continue
                self._cache[(item, tau)] = fit
                self.diagnostics["converged" if fit.converged else "not_converged"] += 1

    def recommend(self, ctx: DayContext) -> dict[str, float]:
        key = _refit_key(ctx.date, self.refit_every_days)
        if key != self._cache_key:
            self._cache_key = key
            self._refit(ctx)

        obs = [o for item in ctx.history.items for o in ctx.history.for_item(item)]
        epoch = min((o.date for o in obs), default=ctx.date)

        out: dict[str, float] = {}
        for item in ctx.items:
            try:
                tau = round(ctx.costs.critical_ratio(item, ctx.date), 4)
            except (KeyError, ValueError):
                out[item] = float("nan")
                continue
            fit = self._cache.get((item, tau))
            if fit is None or not fit.converged:
                self.diagnostics["fallback"] += 1
                out[item] = self._fallback(ctx, item)
                continue
            hist = ctx.history.for_item(item)
            x = day_features(ctx.date, trailing_level(hist, self.level_window),
                             _weeks_between(epoch, ctx.date)).reshape(1, -1)
            pred = float(fit.predict(x)[0])
            self.diagnostics["model"] += 1
            out[item] = _round_up(min(max(pred, 0.0), self.max_quantity))
        return out


class PooledCQR(_FallbackMixin):
    """One censored quantile regression across all items, with item intercepts.

    `log_scale` fits on log(1 + demand). Quantiles are equivariant under any
    monotone transform, so this is a valid quantile estimator -- and it makes
    the shared day-of-week coefficients multiplicative, which is the only way
    one Wednesday effect can sensibly apply to both an item selling four a day
    and one selling a tenth of that.
    """

    name = "pooled_cqr"

    def __init__(self, *, level_window: int = 14, refit_every_days: int = 7,
                 log_scale: bool = True, min_observations: int = 200,
                 max_quantity: float = 60.0):
        self.level_window = level_window
        self.refit_every_days = refit_every_days
        self.log_scale = log_scale
        self.min_observations = min_observations
        self.max_quantity = max_quantity
        self.version = f"1.0.0-{'log' if log_scale else 'lin'}-lw{level_window}"
        self.name = "pooled_cqr_log" if log_scale else "pooled_cqr"
        self._fits: dict[float, QuantileFit] = {}
        self._item_order: list[str] = []
        self._cache_key: str | None = None
        self.diagnostics: dict[str, int] = defaultdict(int)

    def _refit(self, ctx: DayContext) -> None:
        self._fits.clear()
        obs = [o for item in ctx.history.items for o in ctx.history.for_item(item)]
        if not obs:
            return
        epoch = min(o.date for o in obs)
        design = build_design(obs, epoch=epoch, level_window=self.level_window)
        if len(design) < self.min_observations:
            self.diagnostics["too_few_observations"] += 1
            return

        self._item_order = sorted(set(design.item_keys))
        X, _ = add_item_dummies(design, self._item_order)
        y, limit = design.y, design.limit
        if self.log_scale:
            y, limit = np.log1p(y), np.log1p(limit)

        for tau in TAU_GRID:
            try:
                fit = fit_censored_quantile_regression(X, y, limit, tau)
            except (RuntimeError, ValueError):
                self.diagnostics["fit_failed"] += 1
                continue
            self._fits[tau] = fit
            self.diagnostics["converged" if fit.converged else "not_converged"] += 1

    def _predict(self, item: str, ctx: DayContext, epoch: str, tau: float) -> float | None:
        # A non-converged Powell fit is not a usable model: it is whatever the
        # iteration happened to be holding when it gave up. Treat it as absent
        # and fall back, the same way the per-item model does.
        usable = {t: f for t, f in self._fits.items() if f.converged}
        if not usable or item not in self._item_order:
            return None
        hist = ctx.history.for_item(item)
        base = day_features(ctx.date, trailing_level(hist, self.level_window),
                            _weeks_between(epoch, ctx.date))
        dummies = np.zeros(len(self._item_order) - 1, dtype=float)
        idx = self._item_order.index(item) - 1
        if idx >= 0:
            dummies[idx] = 1.0
        x = np.concatenate([dummies, base]).reshape(1, -1)

        grid = sorted(usable)
        preds = [float(usable[t].predict(x)[0]) for t in grid]
        if self.log_scale:
            preds = [math.expm1(p) for p in preds]
        # Quantiles must not cross; enforce it rather than trusting the fits.
        preds = list(np.maximum.accumulate(preds))
        if len(grid) == 1:
            return preds[0]
        return float(np.interp(tau, grid, preds))

    def recommend(self, ctx: DayContext) -> dict[str, float]:
        key = _refit_key(ctx.date, self.refit_every_days)
        if key != self._cache_key:
            self._cache_key = key
            self._refit(ctx)

        obs = [o for item in ctx.history.items for o in ctx.history.for_item(item)]
        epoch = min((o.date for o in obs), default=ctx.date)

        out: dict[str, float] = {}
        for item in ctx.items:
            try:
                tau = ctx.costs.critical_ratio(item, ctx.date)
            except (KeyError, ValueError):
                out[item] = float("nan")
                continue
            pred = self._predict(item, ctx, epoch, tau)
            if pred is None:
                self.diagnostics["fallback"] += 1
                out[item] = self._fallback(ctx, item)
                continue
            self.diagnostics["model"] += 1
            out[item] = _round_up(min(max(pred, 0.0), self.max_quantity))
        return out


def _refit_key(date: str, every: int) -> str:
    """Bucket dates so the model refits on a cadence instead of every day.

    Weekly matches what Phase 6 will actually run, so the backtest measures the
    model that gets deployed rather than a daily-refit version of it that never
    exists in production.
    """
    import datetime
    d = datetime.date.fromisoformat(date)
    return str(d.toordinal() // max(1, every))


def _weeks_between(epoch: str, date: str) -> float:
    import datetime
    return (datetime.date.fromisoformat(date)
            - datetime.date.fromisoformat(epoch)).days / 7.0


def _shift(date: str, days: int) -> str:
    import datetime
    return (datetime.date.fromisoformat(date)
            + datetime.timedelta(days=days)).isoformat()


def observations_from(ctx_history_items, history) -> list[Observation]:  # pragma: no cover
    return [o for item in ctx_history_items for o in history.for_item(item)]


class CensoredPoisson(_FallbackMixin):
    """Censored Poisson regression, pooled across items or fitted per item.

    The only model here that can recommend above what has ever been supplied.
    Powell's estimator learns strictly below the censoring frontier; supply has
    been sitting near the median of demand, so for a critical ratio near 0.75
    there is nothing below the frontier to learn from. This borrows the shape of
    the distribution instead: fit the conditional mean -- which censored days do
    inform, each contributing P(Y >= supply) -- and read the tail off the
    Poisson law.

    The assumption is that demand is Poisson given the covariates, i.e. variance
    equals mean. `dispersion` records whether that holds; above about 1.5 the
    fitted tail is too thin and every recommendation is biased low.
    """

    def __init__(self, *, pooled: bool = True, level_window: int = 14,
                 refit_every_days: int = 7, min_observations: int = 60,
                 ridge: float = 1e-3, max_quantity: float = 60.0,
                 use_features: tuple[str, ...] | None = None, label: str = ""):
        # `use_features` selects a subset of FEATURE_NAMES, for the ablation the
        # brief asks for: a feature stays only if it pays for itself in dollars
        # out of sample.
        self.use_features = use_features
        self.pooled = pooled
        self.level_window = level_window
        self.refit_every_days = refit_every_days
        self.min_observations = min_observations
        self.ridge = ridge
        self.max_quantity = max_quantity
        self.name = (label or ("pooled_poisson" if pooled else "per_item_poisson"))
        self.version = f"1.0.0-{'pooled' if pooled else 'peritem'}-lw{level_window}"
        self._pooled_fit = None
        self._per_item: dict[str, object] = {}
        self._item_order: list[str] = []
        self._cache_key: str | None = None
        self.diagnostics: dict[str, int] = defaultdict(int)
        self.dispersion: float | None = None

    def _refit(self, ctx: DayContext) -> None:
        from .countreg import dispersion_ratio, fit_censored_poisson

        self._pooled_fit = None
        self._per_item.clear()
        obs = [o for item in ctx.history.items for o in ctx.history.for_item(item)]
        if not obs:
            return
        epoch = min(o.date for o in obs)

        if self.pooled:
            design = select_features(
                build_design(obs, epoch=epoch, level_window=self.level_window),
                self.use_features)
            if len(design) < self.min_observations:
                self.diagnostics["too_few_observations"] += 1
                return
            self._item_order = sorted(set(design.item_keys))
            X, _ = add_item_dummies(design, self._item_order)
            censored = design.y >= design.limit
            try:
                fit = fit_censored_poisson(X, design.y, censored, ridge=self.ridge)
            except (ValueError, RuntimeError):
                self.diagnostics["fit_failed"] += 1
                return
            self._pooled_fit = fit
            self.dispersion = dispersion_ratio(design.y, fit.rate(X))
            self.diagnostics["converged" if fit.converged else "not_converged"] += 1
            return

        for item in ctx.history.items:
            design = select_features(
                build_design(ctx.history.for_item(item), epoch=epoch,
                             level_window=self.level_window),
                self.use_features)
            if len(design) < self.min_observations:
                self.diagnostics["too_few_observations"] += 1
                continue
            censored = design.y >= design.limit
            try:
                fit = fit_censored_poisson(design.X, design.y, censored, ridge=self.ridge)
            except (ValueError, RuntimeError):
                self.diagnostics["fit_failed"] += 1
                continue
            self._per_item[item] = fit
            self.diagnostics["converged" if fit.converged else "not_converged"] += 1

    def recommend(self, ctx: DayContext) -> dict[str, float]:
        key = _refit_key(ctx.date, self.refit_every_days)
        if key != self._cache_key:
            self._cache_key = key
            self._refit(ctx)

        obs = [o for item in ctx.history.items for o in ctx.history.for_item(item)]
        epoch = min((o.date for o in obs), default=ctx.date)

        out: dict[str, float] = {}
        for item in ctx.items:
            try:
                tau = ctx.costs.critical_ratio(item, ctx.date)
            except (KeyError, ValueError):
                out[item] = float("nan")
                continue

            hist = ctx.history.for_item(item)
            base = day_features(ctx.date, trailing_level(hist, self.level_window),
                                _weeks_between(epoch, ctx.date))
            if self.use_features is not None:
                base = base[[FEATURE_NAMES.index(n) for n in self.use_features]]

            if self.pooled:
                fit = self._pooled_fit
                if fit is None or item not in self._item_order:
                    self.diagnostics["fallback"] += 1
                    out[item] = self._fallback(ctx, item)
                    continue
                dummies = np.zeros(len(self._item_order) - 1, dtype=float)
                idx = self._item_order.index(item) - 1
                if idx >= 0:
                    dummies[idx] = 1.0
                x = np.concatenate([dummies, base]).reshape(1, -1)
            else:
                fit = self._per_item.get(item)
                if fit is None:
                    self.diagnostics["fallback"] += 1
                    out[item] = self._fallback(ctx, item)
                    continue
                x = base.reshape(1, -1)

            pred = float(fit.quantile(x, tau)[0])
            self.diagnostics["model"] += 1
            out[item] = _round_up(min(max(pred, 0.0), self.max_quantity))
        return out
