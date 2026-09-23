"""Write today's prediction down, before the day.

    python tools/predict_day.py                      # today, the PROFIT plan
    python tools/predict_day.py --date 2026-09-22
    python tools/predict_day.py --plan-json plan.json   # a plan you chose yourself

Writes docs/predictions/<date>.json (the record the scorer reads back) and
docs/predictions/<date>.md (the same thing, readable). Refuses to overwrite an
existing prediction for the date: the whole point is that it was written
before the day, and a rewritten one is not.

Tomorrow: import the day, then `python tools/score_prediction.py <date>`.
"""

from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

# The files are UTF-8; the Windows console often is not. Never let a dash in
# a heading be the reason a prediction did not get written.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from analysis.data import load_observations, outage_dates_from  # noqa: E402
from analysis.prediction import predict_day, render_prediction  # noqa: E402
from analysis.prepsheet import build_prep_sheet  # noqa: E402
from analysis.sheet_order import load_sheet_order  # noqa: E402

OUT_DIR = os.path.join(HERE, "docs", "predictions")

# The operator's sheet order, so the file reads the way they write. Loaded
# rather than hard-coded: the item names are the operator's, and everything
# that names them stays in data/ and out of version control.
SHEET_ORDER = load_sheet_order()


def _costs(extract_dir: str):
    spec = importlib.util.spec_from_file_location(
        "rb", os.path.join(HERE, "tools", "run_backtest.py"))
    rb = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(rb)
    return rb.build_costs(extract_dir, 0.0)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", default=dt.date.today().isoformat())
    ap.add_argument("--extract-dir", default=os.path.join(HERE, "data"))
    ap.add_argument("--plan-json", default=None,
                    help="{item: qty}; default is the PROFIT rule's plan")
    ap.add_argument("--plan-name", default=None)
    ap.add_argument("--force", action="store_true",
                    help="overwrite an existing prediction (you are lying to yourself)")
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    json_path = os.path.join(OUT_DIR, f"{args.date}.json")
    md_path = os.path.join(OUT_DIR, f"{args.date}.md")
    if os.path.exists(json_path) and not args.force:
        print(f"{json_path} already exists. A prediction written twice is not "
              f"a prediction; pass --force only if you mean it.")
        return 1

    outages = outage_dates_from(os.path.join(args.extract_dir, "day_summary.csv"))
    obs = load_observations(os.path.join(args.extract_dir, "daily_log.csv"), outages)
    costs = _costs(args.extract_dir)

    if args.plan_json:
        with open(args.plan_json, encoding="utf-8") as fh:
            plan = {k: float(v) for k, v in json.load(fh).items()}
        name = args.plan_name or os.path.basename(args.plan_json)
    else:
        sheet = build_prep_sheet(args.date, obs, costs)
        plan = {ln.item_key: float(ln.recommended)
                for ln in sheet.lines if ln.recommended}
        name = args.plan_name or "profit"

    pred = predict_day(args.date, plan, obs, costs, plan_name=name)
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(pred.to_json(), fh, indent=2)
    with open(md_path, "w", encoding="utf-8") as fh:
        fh.write(render_prediction(pred, SHEET_ORDER))

    print(render_prediction(pred, SHEET_ORDER))
    print(f"wrote {os.path.relpath(json_path, HERE)} and .md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
