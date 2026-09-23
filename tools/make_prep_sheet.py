"""Print (or export) the morning prep sheet.

    python tools/make_prep_sheet.py --date 2026-09-02
    python tools/make_prep_sheet.py --days 14 --json web/src/data/prep.json

With no --date it plans the day after the last day of recorded history. This is
the command Phase 6 will run on a schedule.
"""

from __future__ import annotations

import argparse
import dataclasses
import importlib.util
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from analysis.data import add_days, load_observations, outage_dates_from  # noqa: E402
from analysis.prepsheet import build_prep_sheet, render_text  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "rb", os.path.join(os.path.dirname(os.path.abspath(__file__)), "run_backtest.py"))
_rb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_rb)


def load_template(path: str | None) -> dict[int, dict[str, float]]:
    """weekday -> {item_key: qty}, read from the app's generated seed."""
    if not path or not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        seed = json.load(fh)
    by_id = {i["itemId"]: i["itemKey"] for i in seed.get("items", [])}
    tpl = {t["templateId"]: t for t in seed.get("templates", [])}
    out: dict[int, dict[str, float]] = {}
    for a in seed.get("assignments", []):
        t = tpl.get(a["templateId"])
        if t:
            out[a["weekday"]] = {by_id[int(k)]: v for k, v in t["quantities"].items()
                                 if int(k) in by_id}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--extract-dir", default="data")
    ap.add_argument("--date", default=None)
    ap.add_argument("--days", type=int, default=1)
    ap.add_argument("--seed", default=os.path.join("web", "src", "data", "seed.json"))
    ap.add_argument("--json", default=None)
    ap.add_argument("--markdown-share", type=float, default=0.0)
    args = ap.parse_args()

    outages = outage_dates_from(os.path.join(args.extract_dir, "day_summary.csv"))
    obs = load_observations(os.path.join(args.extract_dir, "daily_log.csv"), outages)
    costs = _rb.build_costs(args.extract_dir, args.markdown_share)
    templates = load_template(args.seed)

    from analysis.data import isoweekday
    start = args.date or add_days(max(o.date for o in obs), 1)

    sheets = []
    for i in range(args.days):
        date = add_days(start, i)
        sheets.append(build_prep_sheet(
            date, obs, costs, template=templates.get(isoweekday(date))))

    if args.json:
        os.makedirs(os.path.dirname(args.json) or ".", exist_ok=True)
        with open(args.json, "w", encoding="utf-8") as fh:
            json.dump({s.date: dataclasses.asdict(s) for s in sheets}, fh, indent=2)
        print(f"wrote {args.json} ({len(sheets)} day(s))")
        if args.days == 1:
            print()

    if args.days == 1 or not args.json:
        print(render_text(sheets[0]))


if __name__ == "__main__":
    main()
