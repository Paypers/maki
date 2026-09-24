"""Shared cases for the per-roll rule: Python computes, the app must agree.

    python tests/fixtures/make_roll_chance_cases.py

Writes web/src/lib/fixtures/roll_chance_cases.json. Every case is synthetic --
made-up items, made-up days -- so nothing about the real kiosk is in it.
`tests/test_rollchance.py` fails if the file on disk is stale; the app's
`model.test.ts` replays each case through its own port and must reproduce
every chance and every quantity.
"""

from __future__ import annotations

import datetime
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)

from analysis import rollchance as rc  # noqa: E402
from analysis.costs import CostConfig  # noqa: E402
from analysis.data import History, Observation  # noqa: E402
from analysis.policies import DayContext  # noqa: E402

OUT = os.path.join(ROOT, "web", "src", "lib", "fixtures", "roll_chance_cases.json")
START = datetime.date(2026, 1, 5)  # a Monday


def _d(n: int) -> str:
    return (START + datetime.timedelta(days=n)).isoformat()


def _lcg(seed: int):
    """Tiny deterministic generator, so the cases never change by accident."""
    state = seed
    while True:
        state = (1103515245 * state + 12345) % (2 ** 31)
        yield state / 2 ** 31


def _days(spec) -> list[dict]:
    return [{"date": _d(n), "made": made, "waste": waste} for n, made, waste in spec]


def _cases() -> list[dict]:
    r = _lcg(7)
    mixed = []
    for n in range(84):
        wd = (START + datetime.timedelta(days=n)).isoweekday()
        if wd == 7 and n % 14 == 6:
            continue                                   # a gap: closed that Sunday
        made = 3 + (2 if wd == 3 else 0) + int(next(r) * 3)
        demand = int(next(r) * (7 if wd == 3 else 5))
        mixed.append((n, made, max(0, made - demand)))
    return [
        {"name": "steady leftovers", "date": _d(42), "price": 8.0, "unitCost": 2.0,
         "days": _days([(n, 6, 6 - (2 + n % 4)) for n in range(42)])},
        {"name": "sells out every day at 3: tests a 4th", "date": _d(42), "price": 9.0,
         "unitCost": 2.25, "days": _days([(n, 3, 0) for n in range(42)])},
        {"name": "volume item sold out every day", "date": _d(42), "price": 7.0,
         "unitCost": 1.2, "days": _days([(n, 10, 0) for n in range(42)])},
        {"name": "mixed record, Wednesday promo", "date": _d(86), "price": 10.0,
         "unitCost": 2.6, "promoWeekdays": [3], "days": _days(mixed)},
        {"name": "mixed record, a Thursday", "date": _d(87), "price": 10.0,
         "unitCost": 2.6, "promoWeekdays": [3], "days": _days(mixed)},
        {"name": "labour and the store's cut", "date": _d(87), "price": 10.0,
         "unitCost": 2.6, "labour": 0.5, "share": 0.75, "days": _days(mixed)},
        {"name": "never sells: the floor", "date": _d(42), "price": 8.0, "unitCost": 2.0,
         "days": _days([(n, 2, 2) for n in range(42)])},
        {"name": "on the list but never made: stays at zero", "date": _d(42), "price": 8.0,
         "unitCost": 2.0, "days": _days([(n, 0, 0) for n in range(42)])},
        {"name": "a popular item climbing, balanced", "date": _d(42), "price": 8.99,
         "unitCost": 2.03, "share": 0.8, "ambition": 3,
         "days": _days([(n, 3, 0) for n in range(35)] + [(n, 4, 0 if n % 5 else 1) for n in range(35, 42)])},
        {"name": "the same item, bold", "date": _d(42), "price": 8.99,
         "unitCost": 2.03, "share": 0.8, "ambition": 4,
         "days": _days([(n, 3, 0) for n in range(35)] + [(n, 4, 0 if n % 5 else 1) for n in range(35, 42)])},
        {"name": "the same item, careful", "date": _d(42), "price": 8.99,
         "unitCost": 2.03, "share": 0.8, "ambition": 1,
         "days": _days([(n, 3, 0) for n in range(35)] + [(n, 4, 0 if n % 5 else 1) for n in range(35, 42)])},
        {"name": "promo Wednesday judged on Wednesdays", "date": _d(58), "price": 10.0,
         "unitCost": 2.6, "promoWeekdays": [3], "ambition": 5,
         "days": _days([(n, 4, 0 if (START + datetime.timedelta(days=n)).isoweekday() == 3 else 2)
                        for n in range(56)])},
        {"name": "six days only: no opinion", "date": _d(6), "price": 8.0, "unitCost": 2.0,
         "days": _days([(n, 3, n % 2) for n in range(6)])},
    ]


def _solve(case: dict) -> dict:
    costs = CostConfig(
        prices={"x": case["price"]}, unit_costs={"x": case["unitCost"]},
        promo_weekdays=tuple(case.get("promoWeekdays", ())), promo_multiplier=2.0 / 3.0,
        labour_per_unit=case.get("labour", 0.0), sale_share=case.get("share", 1.0))
    rows = [Observation(date=x["date"], item_key="x", made=float(x["made"]), refill=0.0,
                        wasted=float(x["waste"])) for x in case["days"]]
    ctx = DayContext(date=case["date"], items=("x",),
                     history=History([o for o in rows if o.date < case["date"]]), costs=costs)
    lad = rc.RollChance(case.get("ambition", rc.DEFAULT_AMBITION)).ladder(ctx, "x")
    climb = lad.climb
    return {"breakEven": lad.break_even, "chances": list(lad.chances),
            "quantity": lad.quantity, "recentMax": lad.recent_max, "testing": lad.testing,
            "base": lad.base,
            "climb": None if climb is None else {
                "steps": climb.steps, "days": climb.days, "soldOut": climb.sold_out,
                "popularity": climb.popularity, "continuation": climb.continuation,
                "confidence": climb.confidence}}


def build() -> dict:
    cases = _cases()
    for c in cases:
        c["expected"] = _solve(c)
    return {"version": rc.VERSION, "cases": cases}


if __name__ == "__main__":
    with open(OUT, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(build(), fh, indent=1)
        fh.write("\n")
    print(f"wrote {os.path.relpath(OUT, ROOT)}")
