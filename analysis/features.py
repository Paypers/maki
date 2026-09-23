"""Feature construction.

The mandated starting set and nothing more:

  * day of week (six dummies, Monday is the reference level)
  * a trailing demand level for the item
  * a linear time trend

Anything beyond this has to earn its place by improving out-of-sample dollars in
the backtest, not by sounding plausible.

The one subtlety that matters: the trailing level for a historical row must be
computed from rows STRICTLY BEFORE it. The backtest already hides the future
from a policy, but a feature builder that computed a trailing mean over the
whole training block would leak the future *within* the training set -- the
model would learn against a predictor it can never actually have. That is a
leak the harness cannot catch, so it is prevented here and tested directly.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .data import Observation, isoweekday

#: Column names, in the order build_design emits them. Kept explicit so a
#: coefficient can always be traced back to what it multiplies.
FEATURE_NAMES = (
    "dow_tue", "dow_wed", "dow_thu", "dow_fri", "dow_sat", "dow_sun",
    "trailing_level", "trend",
)


@dataclass(frozen=True)
class Design:
    X: np.ndarray
    y: np.ndarray               # observed sold (censored where the item sold out)
    limit: np.ndarray           # censoring limit = supply that day
    dates: tuple[str, ...]
    item_keys: tuple[str, ...]
    feature_names: tuple[str, ...]

    def __len__(self) -> int:
        return len(self.y)


def day_features(date: str, trailing_level: float, trend: float) -> np.ndarray:
    wd = isoweekday(date)
    return np.array(
        [1.0 if wd == k else 0.0 for k in range(2, 8)] + [trailing_level, trend],
        dtype=float,
    )


def trailing_level(history: list[Observation], window: int) -> float:
    """Mean sold over the most recent `window` observations of this item.

    Uses `sold`, which is censored on sold-out days, so this predictor is itself
    biased low. That is acceptable here in a way it would not be in the target:
    it is a level indicator the model is free to scale, not the thing being
    estimated.
    """
    if not history:
        return 0.0
    recent = history[-window:]
    return float(sum(o.sold for o in recent) / len(recent))


def _trend(date: str, epoch: str) -> float:
    """Days since the epoch, in weeks, so the coefficient is a weekly drift."""
    import datetime
    a = datetime.date.fromisoformat(epoch)
    b = datetime.date.fromisoformat(date)
    return (b - a).days / 7.0


def build_design(
    observations: list[Observation],
    *,
    epoch: str,
    level_window: int = 14,
    min_history: int = 3,
) -> Design:
    """Design matrix over `observations`, with causally-computed trailing levels.

    Rows without `min_history` prior observations for their item are dropped:
    their trailing level would be built from too little to mean anything, and a
    zero would be a fabricated predictor rather than a missing one.
    """
    by_item: dict[str, list[Observation]] = {}
    for o in sorted(observations, key=lambda o: (o.item_key, o.date)):
        by_item.setdefault(o.item_key, []).append(o)

    rows, ys, limits, dates, items = [], [], [], [], []
    for item_key, obs_list in by_item.items():
        for i, o in enumerate(obs_list):
            prior = obs_list[:i]          # strictly before -- the whole point
            if len(prior) < min_history:
                continue
            rows.append(day_features(o.date, trailing_level(prior, level_window),
                                     _trend(o.date, epoch)))
            ys.append(o.sold)
            limits.append(o.supply)
            dates.append(o.date)
            items.append(item_key)

    X = np.array(rows, dtype=float) if rows else np.zeros((0, len(FEATURE_NAMES)))
    return Design(X=X, y=np.array(ys, dtype=float), limit=np.array(limits, dtype=float),
                  dates=tuple(dates), item_keys=tuple(items),
                  feature_names=FEATURE_NAMES)


def add_item_dummies(design: Design, item_order: list[str]) -> tuple[np.ndarray, tuple[str, ...]]:
    """Design matrix for a pooled fit: item intercepts plus the shared features.

    The first item is the reference level, so its intercept is the model's
    global intercept. Item intercepts are what let one set of day-of-week and
    trend coefficients apply across items that differ tenfold in volume.
    """
    if len(item_order) < 2:
        return design.X, design.feature_names
    index = {k: i for i, k in enumerate(item_order)}
    dummies = np.zeros((len(design), len(item_order) - 1), dtype=float)
    for row, key in enumerate(design.item_keys):
        col = index.get(key, 0) - 1
        if col >= 0:
            dummies[row, col] = 1.0
    names = tuple(f"item_{k}" for k in item_order[1:]) + design.feature_names
    return np.hstack([dummies, design.X]), names


def select_features(design: Design, names: tuple[str, ...] | None) -> Design:
    """Keep only the named feature columns. Used for the ablation: a feature is
    kept only if dropping it makes out-of-sample dollars worse."""
    if names is None:
        return design
    keep = [design.feature_names.index(n) for n in names]
    return Design(X=design.X[:, keep], y=design.y, limit=design.limit,
                  dates=design.dates, item_keys=design.item_keys,
                  feature_names=tuple(names))
