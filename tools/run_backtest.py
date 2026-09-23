"""Run the Phase 3 backtest over the seeded history and print the scorecard.

    python tools/run_backtest.py --extract-dir data

Costs come from the reviewed CSVs, never from constants in here: the operator is
going to correct prices and recipes, and nothing should need rewriting when
they do.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from analysis.backtest import run_backtest  # noqa: E402
from analysis.costs import CostConfig  # noqa: E402
from analysis.data import (  # noqa: E402
    isoweekday, load_observations, outage_dates_from,
)
from analysis.policies import (  # noqa: E402
    OperatorActual, SameWeekdayMean, SameWeekdayQuantile,
)


#: Share of each sale that reaches the operator: a middle man takes 20% of all
#: sales (operator, 2026-09-23). Every break-even is cost / (price x this).
SALE_SHARE = 0.80


def read(path):
    with open(path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def build_costs(extract_dir: str, markdown_share: float) -> CostConfig:
    prices, unit_costs = {}, defaultdict(float)
    for r in read(os.path.join(extract_dir, "items.csv")):
        if r["proposed_price"]:
            prices[r["item_key"]] = float(r["proposed_price"])

    ing = os.path.join(extract_dir, "ingredients_draft.csv")
    rec = os.path.join(extract_dir, "recipes_draft.csv")
    if os.path.exists(ing) and os.path.exists(rec):
        per_unit = {r["ingredient"]: float(r["pack_cost"]) / float(r["pack_qty"])
                    for r in read(ing)}
        for r in read(rec):
            unit_costs[r["item_key"]] += float(r["qty_per_unit"]) * per_unit[r["ingredient"]]

    return CostConfig(prices=prices, unit_costs=dict(unit_costs),
                      salvage=0.0, promo_weekdays=(3,),
                      markdown_share=markdown_share, sale_share=SALE_SHARE)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--extract-dir", default="data")
    ap.add_argument("--warmup-days", type=int, default=28)
    ap.add_argument("--training-window-days", type=int, default=None,
                    help="omit for an expanding window")
    ap.add_argument("--markdown-share", type=float, default=0.0)
    ap.add_argument("--out", default=None, help="write scored rows to this CSV")
    args = ap.parse_args()

    outages = outage_dates_from(os.path.join(args.extract_dir, "day_summary.csv"))
    obs = load_observations(os.path.join(args.extract_dir, "daily_log.csv"), outages)
    costs = build_costs(args.extract_dir, args.markdown_share)

    baseline = SameWeekdayMean(window=4, min_observations=2)
    policies = [baseline,
                SameWeekdayQuantile(window=8, min_observations=4),
                OperatorActual.from_observations(obs)]

    result = run_backtest(obs, policies, costs, baseline=baseline.name,
                          warmup_days=args.warmup_days,
                          training_window_days=args.training_window_days)

    dates = result.evaluated_dates
    print("=" * 78)
    print("PHASE 3 BACKTEST -- walk-forward, scored in dollars of realised cost")
    print("=" * 78)
    print(f"observations   : {len(obs)} item-days over {len({o.date for o in obs})} days")
    print(f"outage days    : {len(outages)} excluded")
    print(f"evaluated      : {len(dates)} days, {dates[0]} .. {dates[-1]}"
          if dates else "evaluated      : none")
    print(f"warm-up        : {args.warmup_days} days")
    print(f"window         : {args.training_window_days or 'expanding'}")
    censored = sum(1 for o in obs if o.censored)
    print(f"censored       : {censored}/{len(obs)} item-days sold out "
          f"({censored / len(obs) * 100:.1f}%)")
    if costs.missing:
        print(f"WARNING        : no price/cost for {sorted(costs.missing)}")

    print("\n%-24s %8s %10s %10s %10s %9s %8s"
          % ("policy", "scored", "total $", "waste $", "stockout $", "$/day", "unid."))
    for name, p in result.results.items():
        print("%-24s %8d %10.2f %10.2f %10.2f %9.2f %7.0f%%"
              % (name, p.n, p.total_cost, p.waste_cost, p.stockout_cost,
                 p.cost_per_day, p.unidentified_share * 100))

    print("\nagainst the baseline (%s), on days both scored:" % baseline.name)
    for name in result.results:
        if name == baseline.name:
            continue
        c = result.compare(name)
        verdict = "better" if c["delta"] < 0 else "worse"
        print("  %-24s %+9.2f  (%+6.1f%%)  %+7.2f/day  %s over %d days -- %s"
              % (name, c["delta"], c["delta_pct"], c["per_day"],
                 "", int(c["days"]), verdict))

    worst_unid = max(p.unidentified_share for p in result.results.values())
    if worst_unid > 0.15:
        print("\n!! %.0f%% of the scored cost depends on demand that was never "
              "observed.\n   Treat the ranking above as indicative, not settled."
              % (worst_unid * 100))

    print("\nper-weekday cost, baseline vs operator:")
    print("  %-10s %10s %10s %9s" % ("weekday", "baseline $", "operator $", "delta"))
    names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    for wd in range(1, 8):
        b = sum(s.cost for s in result.results[baseline.name].scored
                if isoweekday(s.date) == wd)
        o = sum(s.cost for s in result.results["operator_actual"].scored
                if isoweekday(s.date) == wd)
        print("  %-10s %10.2f %10.2f %+9.2f" % (names[wd - 1], b, o, o - b))

    print("\nworst items by operator cost:")
    op_items = result.results["operator_actual"].by_item()
    base_items = result.results[baseline.name].by_item()
    print("  %-28s %10s %10s %9s" % ("item", "operator $", "baseline $", "delta"))
    for item in sorted(op_items, key=lambda k: -op_items[k])[:12]:
        b = base_items.get(item, 0.0)
        print("  %-28s %10.2f %10.2f %+9.2f" % (item, op_items[item], b, op_items[item] - b))

    if args.out:
        rows = [s for p in result.results.values() for s in p.scored]
        with open(args.out, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(vars(rows[0]).keys()))
            w.writeheader()
            for s in rows:
                w.writerow(vars(s))
        print(f"\nwrote {args.out} ({len(rows)} scored decisions)")


if __name__ == "__main__":
    main()
