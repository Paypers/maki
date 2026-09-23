"""Unit economics: what a mistake costs, per item, per day.

Derivation, stated once so the rest of the code can just use it.

Unsold product is discarded. Waste is counted the morning after the business
date, by which time the 19:00 markdown window has long closed -- so anything
that cleared at a discount is already inside `sold`, and a unit that reaches the
bin earned nothing:

    c_o = unit_cost - salvage = unit_cost          (salvage = 0)

A unit you could have sold but did not make costs you its contribution margin:

    c_u = effective_price - unit_cost

`effective_price` is not the list price. Two adjustments:

  * Buy-2-get-1 on Wednesdays multiplies the realised price by 2/3. NOTE: this
    assumes the discount applies proportionally. If the promotion is really
    "cheapest of three free", the discount is smaller on expensive items and
    this over-discounts them -- set PROMO_MULTIPLIER accordingly once known.
  * A share of units clear at the 30%-off markdown, so the average realised
    price is slightly below list. The share is not measurable from the seed
    data, so it defaults to zero and is exposed as config.

With salvage at zero the newsvendor critical ratio collapses to the gross
margin ratio:

    CR = c_u / (c_u + c_o) = (p - c) / p = 1 - c/p

which is worth knowing, because it means the ratio is not a separate thing to
estimate -- it falls out of the price and the recipe.
"""

from __future__ import annotations

import datetime
from dataclasses import dataclass, field, replace


@dataclass(frozen=True)
class CostConfig:
    """Everything about the economics that is an assumption rather than a fact.

    Kept in one place, injected everywhere, never hardcoded at a call site --
    the operator is going to correct these numbers and nothing should have to
    be rewritten when they do.
    """

    #: item_key -> list price
    prices: dict[str, float]
    #: item_key -> unit cost from the recipe
    unit_costs: dict[str, float]
    #: Recovered per DISCARDED unit. Zero: waste is counted the morning after.
    salvage: float = 0.0
    #: ISO weekdays running buy-2-get-1. 3 = Wednesday.
    promo_weekdays: tuple[int, ...] = (3,)
    #: Realised price multiplier on a promo day. 2/3 for a proportional B2G1.
    promo_multiplier: float = 2.0 / 3.0
    #: Share of sold units clearing at the markdown price. Unmeasurable from the
    #: seed data; sensitivity is small (CR 0.725 -> 0.698 across 0 -> 30%).
    markdown_share: float = 0.0
    markdown_fraction: float = 0.30
    #: Cost of making one roll on top of its recipe -- time, if the operator
    #: counts it. Zero by default: only the operator knows what an hour is worth.
    labour_per_unit: float = 0.0
    #: Share of each sale that reaches the operator. 1.0 unless the store takes
    #: a cut; a 25% cut is 0.75, and it raises every break-even by a third.
    sale_share: float = 1.0
    #: Fallbacks for items with no price or recipe yet. Deliberately loud.
    default_price: float | None = None
    default_unit_cost: float | None = None

    missing: set[str] = field(default_factory=set, compare=False)

    def is_promo(self, date: str) -> bool:
        return _isoweekday(date) in self.promo_weekdays

    def price(self, item_key: str, date: str) -> float:
        p = self.prices.get(item_key)
        if p is None:
            if self.default_price is None:
                raise KeyError(f"no price for {item_key!r} and no default set")
            self.missing.add(item_key)
            p = self.default_price
        if self.is_promo(date):
            p *= self.promo_multiplier
        # Average realised price across full-price and marked-down units, then
        # the share of it the operator actually keeps.
        return p * (1.0 - self.markdown_fraction * self.markdown_share) * self.sale_share

    def unit_cost(self, item_key: str) -> float:
        c = self.unit_costs.get(item_key)
        if c is None:
            if self.default_unit_cost is None:
                raise KeyError(f"no unit cost for {item_key!r} and no default set")
            self.missing.add(item_key)
            c = self.default_unit_cost
        return c + self.labour_per_unit

    def with_economics(self, *, labour_per_unit: float | None = None,
                       sale_share: float | None = None) -> "CostConfig":
        """The same prices and recipes under different running costs."""
        return replace(
            self,
            labour_per_unit=self.labour_per_unit if labour_per_unit is None else labour_per_unit,
            sale_share=self.sale_share if sale_share is None else sale_share)

    def cu(self, item_key: str, date: str) -> float:
        """Cost of one unit of unmet demand: the margin you did not earn."""
        return max(0.0, self.price(item_key, date) - self.unit_cost(item_key))

    def co(self, item_key: str, date: str) -> float:  # noqa: ARG002 - date for symmetry
        """Cost of one unit discarded: the cost you sank into it."""
        return max(0.0, self.unit_cost(item_key) - self.salvage)

    def critical_ratio(self, item_key: str, date: str) -> float:
        """The newsvendor quantile.

        The degenerate case is c_o <= 0, not c_u + c_o <= 0: once a discarded
        unit costs nothing, the ratio is 1 and the model says make unlimited
        stock. That is a real answer to the wrong question -- the binding
        constraint there is labour and case space -- so it raises rather than
        returning a number that would be acted on.
        """
        cu, co = self.cu(item_key, date), self.co(item_key, date)
        if co <= 0:
            raise ValueError(
                f"{item_key}: c_o={co:.4f} (unit cost {self.unit_cost(item_key):.4f} "
                f"vs salvage {self.salvage:.4f}) -- no interior optimum. "
                "Overproducing costs nothing, so the newsvendor says make "
                "unlimited stock; the real constraint is labour and case space."
            )
        if cu <= 0:
            return 0.0  # no margin: the model correctly says make nothing
        return cu / (cu + co)


def _isoweekday(date: str) -> int:
    y, m, d = (int(x) for x in date.split("-"))
    return datetime.date(y, m, d).isoweekday()


def realised_cost(q: float, demand: float, cu: float, co: float) -> float:
    """Newsvendor loss for making `q` against demand `demand`.

    Zero exactly at q == demand, linear either side with different slopes. This
    is the only place the loss is defined; everything else calls it.
    """
    if q >= demand:
        return co * (q - demand)
    return cu * (demand - q)


def cost_parts(q: float, demand: float, cu: float, co: float) -> tuple[float, float]:
    """(waste cost, stockout cost) -- the same loss, split for reporting."""
    if q >= demand:
        return co * (q - demand), 0.0
    return 0.0, cu * (demand - q)
