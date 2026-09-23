"""Observations and the history slice handed to a policy.

The important type here is `History`. The harness builds one per evaluation day
containing *only* observations strictly before that day, and a policy receives
nothing else. Leakage is prevented structurally rather than by discipline: a
policy has no reference to the full dataset to leak from.
"""

from __future__ import annotations

import csv
import datetime
from collections import defaultdict
from dataclasses import dataclass


@dataclass(frozen=True)
class Observation:
    """One item on one day, as recorded.

    `sold` is derived, never observed: sold = made + refill - wasted. When
    wasted is zero the item sold out and true demand is only known to be at
    least `sold` -- that is what `censored` marks, and roughly half of all
    item-days carry it.
    """

    date: str
    item_key: str
    made: float
    refill: float
    wasted: float
    #: False when the zero came from a blank cell nobody attested to. The seed
    #: workbook has no confirmation step, so everything from it is False.
    waste_attested: bool = False

    @property
    def supply(self) -> float:
        return self.made + self.refill

    @property
    def sold(self) -> float:
        # Clamped at zero. Four rows in the seed record more waste than supply,
        # which means a refill went unrecorded that day. Negative demand is not
        # a thing, and letting it through produces log(0) downstream.
        return max(0.0, self.supply - self.wasted)

    @property
    def inconsistent(self) -> bool:
        """More waste than was ever supplied -- the day is internally wrong."""
        return self.wasted > self.supply

    @property
    def censored(self) -> bool:
        return self.wasted <= 0

    @property
    def demand_lower_bound(self) -> float:
        """Everything we actually know about demand. Exact when uncensored."""
        return self.sold


class History:
    """An immutable view of observations strictly before some date."""

    def __init__(self, observations: list[Observation]):
        self._obs = observations
        self._by_item: dict[str, list[Observation]] = defaultdict(list)
        for o in observations:
            self._by_item[o.item_key].append(o)
        for rows in self._by_item.values():
            rows.sort(key=lambda o: o.date)

    def __len__(self) -> int:
        return len(self._obs)

    @property
    def items(self) -> list[str]:
        return sorted(self._by_item)

    def for_item(self, item_key: str) -> list[Observation]:
        return list(self._by_item.get(item_key, ()))

    def for_item_weekday(self, item_key: str, weekday: int) -> list[Observation]:
        """Same-weekday history, oldest first. The baseline's whole input."""
        return [o for o in self._by_item.get(item_key, ())
                if isoweekday(o.date) == weekday]

    def last_date(self) -> str | None:
        return max((o.date for o in self._obs), default=None)


def isoweekday(date: str) -> int:
    y, m, d = (int(x) for x in date.split("-"))
    return datetime.date(y, m, d).isoweekday()


def add_days(date: str, n: int) -> str:
    y, m, d = (int(x) for x in date.split("-"))
    return (datetime.date(y, m, d) + datetime.timedelta(days=n)).isoformat()


def load_observations(
    daily_log_csv: str,
    outage_dates: frozenset[str] = frozenset(),
) -> list[Observation]:
    """Read the reviewed extraction.

    A blank waste cell on a produced row means zero waste -- the operator wrote
    a number only when there was something to write. That inference is what
    makes 49% of item-days censored, so it is made here, once, explicitly,
    rather than falling out of a coercion somewhere downstream.

    With one exception, decided per DAY rather than per cell: a day whose waste
    column is blank all the way down was never counted, and its sales are
    unknown. Reading it by the cell rule would make it a total sell-out on
    every item -- the most damaging misreading available, since it censors
    every line at the ceiling and drags every quantile upward. Such days are
    dropped entirely: an unknown is not an observation.
    """
    with open(daily_log_csv, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))

    produced = {r["business_date"] for r in rows
                if _num(r.get("quantity_made")) or _num(r.get("quantity_refill"))}
    counted = {r["business_date"] for r in rows
               if _num(r.get("quantity_wasted")) is not None}
    uncounted = produced - counted - set(outage_dates)

    out: list[Observation] = []
    for row in rows:
        if row["business_date"] in outage_dates or row["business_date"] in uncounted:
            continue
        made = _num(row.get("quantity_made"))
        if made is None:
            continue  # nothing was produced; there is no decision to score
        out.append(Observation(
            date=row["business_date"],
            item_key=row["item_key"],
            made=made,
            refill=_num(row.get("quantity_refill")) or 0.0,
            wasted=_num(row.get("quantity_wasted")) or 0.0,
            waste_attested=False,
        ))
    out.sort(key=lambda o: (o.date, o.item_key))
    return out


def uncounted_dates_from(daily_log_csv: str) -> frozenset[str]:
    """Days that traded but were never counted; see load_observations."""
    with open(daily_log_csv, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    produced = {r["business_date"] for r in rows
                if _num(r.get("quantity_made")) or _num(r.get("quantity_refill"))}
    counted = {r["business_date"] for r in rows
               if _num(r.get("quantity_wasted")) is not None}
    return frozenset(produced - counted)


def outage_dates_from(day_summary_csv: str) -> frozenset[str]:
    with open(day_summary_csv, newline="", encoding="utf-8") as fh:
        return frozenset(
            r["business_date"] for r in csv.DictReader(fh)
            if str(r.get("is_outage", "")).strip().lower() == "true"
        )


def _num(v: object) -> float | None:
    if v in (None, "", "None"):
        return None
    return float(str(v))
