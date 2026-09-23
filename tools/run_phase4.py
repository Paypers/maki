"""Phase 4 evaluation: censored quantile regression vs the Phase 3 baseline.

    python tools/run_phase4.py --extract-dir data

Reports out-of-sample dollars through the same walk-forward harness every other
policy is scored with, plus the overfitting evidence: the in-sample score of the
same models fitted on everything and graded on the data they were fitted to.
A model that looks good in-sample and mediocre out-of-sample is memorising.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from analysis.backtest import run_backtest  # noqa: E402
from analysis.data import load_observations, outage_dates_from  # noqa: E402
from analysis.models import (  # noqa: E402
    CensoredPoisson, PerItemCQR, PooledCQR,
)
from analysis.policies import (  # noqa: E402
    OperatorActual, SameWeekdayMean, SameWeekdayQuantile,
)

_spec = importlib.util.spec_from_file_location(
    "rb", os.path.join(os.path.dirname(os.path.abspath(__file__)), "run_backtest.py"))
_rb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_rb)


def build(observations):
    return [
        SameWeekdayMean(window=4, min_observations=2),
        SameWeekdayQuantile(window=8, min_observations=4),
        OperatorActual.from_observations(observations),
        PerItemCQR(level_window=14, min_observations=40, refit_every_days=7),
        PooledCQR(level_window=14, refit_every_days=7, log_scale=True),
        CensoredPoisson(pooled=True, level_window=14, refit_every_days=7),
        CensoredPoisson(pooled=False, level_window=14, refit_every_days=7),
    ]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--extract-dir", default="data")
    ap.add_argument("--warmup-days", type=int, default=28)
    ap.add_argument("--markdown-share", type=float, default=0.0)
    ap.add_argument("--sensitivity", action="store_true",
                    help="sweep the censored-demand factor")
    args = ap.parse_args()

    outages = outage_dates_from(os.path.join(args.extract_dir, "day_summary.csv"))
    obs = load_observations(os.path.join(args.extract_dir, "daily_log.csv"), outages)
    costs = _rb.build_costs(args.extract_dir, args.markdown_share)

    policies = build(obs)
    baseline = policies[0].name

    t0 = time.time()
    oos = run_backtest(obs, policies, costs, baseline=baseline,
                       warmup_days=args.warmup_days)
    elapsed = time.time() - t0

    print("=" * 82)
    print("PHASE 4 -- censored quantile regression, walk-forward, dollars")
    print("=" * 82)
    print(f"evaluated {len(oos.evaluated_dates)} days "
          f"({oos.evaluated_dates[0]} .. {oos.evaluated_dates[-1]}) in {elapsed:.0f}s")

    print("\nOUT OF SAMPLE  (each decision made with only prior data)")
    print("%-24s %7s %9s %8s %9s %9s %6s"
          % ("policy", "scored", "total $", "$/day", "waste $", "stock $", "unid."))
    for name, p in oos.results.items():
        print("%-24s %7d %9.2f %8.2f %9.2f %9.2f %5.0f%%"
              % (name, p.n, p.total_cost, p.cost_per_day, p.waste_cost,
                 p.stockout_cost, p.unidentified_share * 100))

    print(f"\nvs the baseline ({baseline}), on item-days both scored:")
    for name in oos.results:
        if name == baseline:
            continue
        c = oos.compare(name)
        mark = "BETTER" if c["delta"] < 0 else "worse "
        print("  %-24s %+9.2f  (%+6.1f%%)  %+6.2f/day  %s  n=%d"
              % (name, c["delta"], c["delta_pct"], c["per_day"], mark,
                 int(c["n_scored"])))

    print("\nmodel usage (how often a real fit was used vs a fallback):")
    for p in policies:
        diag = getattr(p, "diagnostics", None)
        if not diag:
            continue
        used, fell = diag.get("model", 0), diag.get("fallback", 0)
        total = used + fell
        print("  %-24s model %5d  fallback %5d  (%.0f%% modelled)  "
              "converged %d / not %d"
              % (p.name, used, fell, 100 * used / total if total else 0,
                 diag.get("converged", 0), diag.get("not_converged", 0)))

    # ---- overfitting evidence -------------------------------------------
    # A genuine in-sample contrast: fit each model ONCE on the entire history
    # (evaluation days included) and score it on those same days. Walk-forward
    # never lets a model see its own day; this deliberately does. The gap
    # between the two is what memorising history buys you.
    print("\nOVERFITTING CHECK -- fitted on all data INCLUDING the days it is graded on")
    ins = run_backtest(obs, build(obs), costs, baseline=baseline,
                       warmup_days=args.warmup_days, start_date=oos.evaluated_dates[0],
                       training_window_days=None, leak_for_diagnostics=True)
    print("%-24s %11s %11s %9s %s"
          % ("policy", "in-sample $", "out-samp $", "gap", "reading"))
    for name in oos.results:
        a, b = ins.results[name].total_cost, oos.results[name].total_cost
        gap = (b - a) / a * 100 if a else 0.0
        p_ = next((x for x in policies if x.name == name), None)
        diag = getattr(p_, "diagnostics", {}) or {}
        modelled = diag.get("model", 0)
        total_dec = modelled + diag.get("fallback", 0)
        if total_dec == 0 or modelled / total_dec < 0.05:
            # Almost nothing was fitted, so there is nothing that could have
            # been overfitted -- the decisions came from the fallback, and this
            # row is describing the fallback rather than the model.
            reading = "n/a - never fitted"
        elif gap < 0:
            # Out-of-sample beating in-sample is not generalisation; it means
            # the fit is unstable to which rows it sees.
            reading = "unstable fit"
        else:
            reading = ("memorising" if gap > 15 else
                       "some overfit" if gap > 5 else "generalises")
        print("%-24s %11.2f %11.2f %+8.1f%% %s" % (name, a, b, gap, reading))

    for p_ in policies:
        if getattr(p_, "dispersion", None) is not None:
            disp = p_.dispersion
            if disp > 1.5:
                verdict = ("overdispersed -- the fitted tail is too THIN, so "
                           "recommendations come out too low")
            elif disp < 0.85:
                verdict = ("underdispersed -- the fitted tail is too FAT, so "
                           "recommendations come out too high")
            else:
                verdict = "consistent with Poisson"
            print("\nPoisson assumption check (%s): dispersion = %.2f\n  %s"
                  % (p_.name, disp, verdict))

    if args.sensitivity:
        print("\nCENSORED-DEMAND SENSITIVITY (only factor 1.00 is measured)")
        print("%-8s " % "factor" + " ".join("%>14s" % n for n in oos.results))
        for f in (1.0, 1.1, 1.25, 1.5):
            r = run_backtest(obs, build(obs), costs, baseline=baseline,
                             warmup_days=args.warmup_days, censored_demand_factor=f)
            costs_by = {n: p.total_cost for n, p in r.results.items()}
            best = min(costs_by, key=lambda k: costs_by[k])
            print("%-8.2f " % f + " ".join("%14.0f" % costs_by[n] for n in oos.results)
                  + f"   best: {best}")


if __name__ == "__main__":
    main()
