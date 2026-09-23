"""The evidence report: the per-roll rule vs the old rule vs what was made.

    python tools/compare_rules.py                     # whole record after warm-up
    python tools/compare_rules.py --start 2026-09-01  # one stretch
    python tools/compare_rules.py --items             # per item too

Reads the real record in data/ (never committed). Prints three things, in the
order they should be read -- see analysis/evidence.py for why each is honest:

  1. the extra-roll rate the rule borrows, and whether it has drifted
  2. calibration: did rolls predicted at X% sell X% of the time
  3. profit per day, with rolls nobody could observe shown as a range
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from analysis.data import add_days, load_observations, outage_dates_from  # noqa: E402
from analysis.evidence import calibration, compare, extra_roll_rate  # noqa: E402
from analysis.policies import SameWeekdayQuantile  # noqa: E402
from analysis.rollchance import PRIOR_CONTINUATION, RollChance  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "run_backtest", os.path.join(ROOT, "tools", "run_backtest.py"))
_rb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_rb)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--extract-dir", default=os.path.join(ROOT, "data"))
    ap.add_argument("--start", default=None, help="default: 28 days after the first record")
    ap.add_argument("--end", default=None)
    ap.add_argument("--labour", type=float, default=0.0, help="extra cost per roll, $")
    ap.add_argument("--keep", type=float, default=None,
                    help="share of each sale you keep (default: run_backtest.SALE_SHARE)")
    ap.add_argument("--items", action="store_true", help="also print the per-item table")
    args = ap.parse_args(argv)

    obs = load_observations(os.path.join(args.extract_dir, "daily_log.csv"),
                            outage_dates_from(os.path.join(args.extract_dir, "day_summary.csv")))
    if not obs:
        print("no counted days on record")
        return 1
    costs = _rb.build_costs(args.extract_dir, 0.0)
    if args.labour or args.keep is not None:
        costs = costs.with_economics(labour_per_unit=args.labour, sale_share=args.keep)
    print(f"economics: you keep {costs.sale_share:.0%} of each sale, "
          f"time per roll ${costs.labour_per_unit:.2f}")
    dates = sorted({o.date for o in obs})
    start = args.start or add_days(dates[0], 28)
    end = args.end or dates[-1]
    mid = dates[len(dates) // 2]

    print(f"{len([d for d in dates if start <= d <= end])} counted days, {start} .. {end}\n")

    print("1. THE EXTRA-ROLL RATE  (the rule assumes "
          f"{PRIOR_CONTINUATION:.0%} where it has no data)")
    for label, a, b in (("first half ", None, mid), ("second half", add_days(mid, 1), None),
                        ("all        ", None, None)):
        r = extra_roll_rate(obs, start=a, end=b)
        print(f"   {label}  next roll above your usual sold {r.sold}/{r.tried} = {r.rate:.0%}")
    drift = extra_roll_rate(obs).rate - PRIOR_CONTINUATION
    if abs(drift) > 0.1:
        print(f"   ! measured rate is {drift:+.0%} off the rule's number -- revisit "
              "rollchance.PRIOR_CONTINUATION")

    cal = calibration(obs, start=start, end=end)
    zp, zy, zn = cal.zone()
    print(f"\n2. CALIBRATION  ({cal.n} rolls you made, each predicted from earlier days only)")
    print(f"   rolls predicted 10-40% to sell: predicted {zp:.0%} on average, sold {zy:.0%}  (n={zn})")
    for lo, p, y, n in cal.bins():
        bar = "#" * int(round(y * 20))
        print(f"   predicted {lo:.0%}-{lo + 0.1:.0%}: sold {y:4.0%}  {bar:<20s} n={n}")

    old = SameWeekdayQuantile(window=8, min_observations=4)
    old.name = "old rule"
    new = RollChance()
    new.name = "per-roll rule"
    cmp = compare(obs, [old, new], costs, start=start, end=end,
                  continuation=extra_roll_rate(obs).rate)
    print("\n3. PROFIT PER DAY  (estimate [worst .. best] where rolls above what you made"
          " on a sold-out day are unknowable)")
    y = cmp.you
    print(f"   {'you (what was made)':22s} made {y.per_day('made'):5.1f}   left {y.per_day('left_est'):5.1f}"
          f"   profit ${y.per_day('profit_est'):7.2f}   (exact)")
    for name, t in cmp.rules.items():
        print(f"   {name:22s} made {t.per_day('made'):5.1f}   left~{t.per_day('left_est'):5.1f}"
              f"   profit ~${t.per_day('profit_est'):6.2f} [{t.per_day('profit_low'):6.2f} .. "
              f"{t.per_day('profit_high'):6.2f}]   unknowable rolls/day {t.per_day('unseen'):4.1f}"
              + (f"   no opinion on {t.no_opinion} item-days" if t.no_opinion else ""))

    if args.items:
        print("\n   per item, whole stretch:  you $ (made/left)  |  per-roll rule ~$ [worst..best] (made/left~)")
        rows = sorted(cmp.by_item.items(),
                      key=lambda kv: kv[1]["per-roll rule"]["profit_est"] - kv[1]["you"]["profit"])
        for item, d in rows:
            u, r = d["you"], d["per-roll rule"]
            print(f"   {item:28s} ${u['profit']:7.0f} ({u['made']:4.0f}/{u['left']:3.0f})  |  "
                  f"~${r['profit_est']:7.0f} [{r['profit_low']:6.0f}..{r['profit_high']:6.0f}] "
                  f"({r['made']:4.0f}/{r['left_est']:5.1f})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
