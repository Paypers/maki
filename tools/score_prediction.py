"""Score a stored prediction against the day as it was recorded.

    python tools/score_prediction.py 2026-09-22

Reads docs/predictions/<date>.json, reads the day from data/daily_log.csv
(import it first -- tools/import_pdf_days.py or the workbook extract), prints
the comparison and appends it to docs/predictions/<date>.md. Then updates the
running tally in docs/predictions/TALLY.md, which is the only place an
accuracy claim lives: one day is one row in it.
"""

from __future__ import annotations

import argparse
import dataclasses
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
from analysis.prediction import (  # noqa: E402
    DayPrediction, Interval, ItemPrediction, render_score, score_day,
)

OUT_DIR = os.path.join(HERE, "docs", "predictions")
TALLY = os.path.join(OUT_DIR, "TALLY.md")


def _costs(extract_dir: str):
    spec = importlib.util.spec_from_file_location(
        "rb", os.path.join(HERE, "tools", "run_backtest.py"))
    rb = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(rb)
    return rb.build_costs(extract_dir, 0.0)


def load_prediction(path: str) -> DayPrediction:
    with open(path, encoding="utf-8") as fh:
        d = json.load(fh)
    iv = lambda x: Interval(**x)
    d["sold"], d["wasted"], d["waste_pct"] = iv(d["sold"]), iv(d["wasted"]), iv(d["waste_pct"])
    d["revenue"], d["sellouts"] = iv(d["revenue"]), iv(d["sellouts"])
    d["items"] = [ItemPrediction(item=i["item"], plan=i["plan"], sold=iv(i["sold"]),
                                 sellout_share=i["sellout_share"]) for i in d["items"]]
    return DayPrediction(**d)


def update_tally(date: str, score) -> str:
    """One row per scored day; the coverage line at the top is recomputed."""
    rows: dict[str, tuple[int, int, int, int, int]] = {}
    if os.path.exists(TALLY):
        with open(TALLY, encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("| 20"):
                    cells = [c.strip() for c in line.strip().strip("|").split("|")]
                    d, n, a, b, ii, it = cells[:6]
                    rows[d] = (int(n), int(a), int(b), int(ii), int(it))
    n, a, b = score.tally()
    rows[date] = (n, a, b, score.items_in_range, score.items_total)

    N = sum(r[0] for r in rows.values())
    A = sum(r[1] for r in rows.values())
    B = sum(r[2] for r in rows.values())
    I = sum(r[3] for r in rows.values())
    IT = sum(r[4] for r in rows.values())
    L = ["# Prediction tally", "",
         f"{len(rows)} day(s) scored. Day-level quantities inside the 68% band: "
         f"**{A}/{N} = {100 * A / N:.0f}%** (target ~68%). Inside the 95% band: "
         f"**{B}/{N} = {100 * B / N:.0f}%** (target ~95%). "
         f"Items inside their 95% range: {I}/{IT} = {100 * I / IT:.0f}%.", "",
         "The model is calibrated when those percentages sit near their targets "
         "over many days. Below target means the intervals are too narrow -- the "
         "model is overconfident. Well above means too wide. One day says nothing.",
         "",
         "| date | quantities | in 68% | in 95% | items in range | items |",
         "|---|---|---|---|---|---|"]
    for d in sorted(rows):
        r = rows[d]
        L.append(f"| {d} | {r[0]} | {r[1]} | {r[2]} | {r[3]} | {r[4]} |")
    L.append("")
    text = "\n".join(L)
    with open(TALLY, "w", encoding="utf-8") as fh:
        fh.write(text)
    return text


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("date")
    ap.add_argument("--extract-dir", default=os.path.join(HERE, "data"))
    args = ap.parse_args()

    json_path = os.path.join(OUT_DIR, f"{args.date}.json")
    md_path = os.path.join(OUT_DIR, f"{args.date}.md")
    if not os.path.exists(json_path):
        print(f"no prediction on file for {args.date} ({json_path})")
        return 1
    pred = load_prediction(json_path)

    outages = outage_dates_from(os.path.join(args.extract_dir, "day_summary.csv"))
    obs = load_observations(os.path.join(args.extract_dir, "daily_log.csv"), outages)
    if not any(o.date == args.date for o in obs):
        print(f"{args.date} is not in the log as a COUNTED day. Import it first; "
              f"a day whose leftovers were never counted cannot be scored.")
        return 1

    score = score_day(pred, obs, _costs(args.extract_dir))
    text = render_score(score, pred)
    print(text)
    with open(md_path, "a", encoding="utf-8") as fh:
        fh.write("\n" + text)
    tally = update_tally(args.date, score)
    print(tally.split("\n")[2])
    print(f"\nappended to {os.path.relpath(md_path, HERE)}; tally in docs/predictions/TALLY.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
