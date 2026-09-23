"""Fold hand-transcribed prep sheets into the canonical log.

The workbook is the system of record, but days sometimes arrive as a printed
PDF instead. Transcribing those by hand is exactly the kind of task that goes
wrong silently -- one digit in one cell and a day is wrong forever, with no
symptom anyone would notice.

So nothing here trusts the transcription. Every page carries its own header
totals (made / waste / sold), and every day is cross-footed against them
before a single row is written. A mismatch aborts the whole import and prints
the offending day; it never writes a partial file.

THE ONE JUDGEMENT THIS MAKES
----------------------------
A blank waste cell normally means "none left" -- that is how the operator
fills the sheet, and 14 of 31 cells are blank on a median day. But a day whose
waste column is blank ALL THE WAY DOWN means something else entirely: the
count was never done. Reading that as "sold out completely" would be the worst
possible error, because it tells the model demand was censored at the ceiling
on every item and walks every future recommendation upward.

None of the 117 days already imported has an all-blank waste column, so this
is not a reinterpretation of anything -- it is a case the record has not seen
before, and it is flagged rather than guessed.

    python tools/import_pdf_days.py data/sept_2026_pdf.txt          # check only
    python tools/import_pdf_days.py data/sept_2026_pdf.txt --write  # commit it

A DAY THAT CHANGED
------------------
Sheets get re-sent. Sep 20 and 21 first arrived with a stock "made" column and
no leftover count, then again properly filled in. A day already in the record
is compared cell by cell with the sheet:

  * identical        skipped, silently -- the normal case for a re-sent PDF
  * different        NOTHING is written, and every changed cell is printed,
                     until that day is named with --replace. Skipping it
                     would keep the wrong day; overwriting it unasked would
                     let a mis-transcribed page replace a good one.

    python tools/import_pdf_days.py sheets.txt --write --replace 2026-09-20,2026-09-21
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DAILY_LOG = os.path.join(HERE, "data", "daily_log.csv")
DAY_SUMMARY = os.path.join(HERE, "data", "day_summary.csv")


class Day:
    __slots__ = ("date", "made", "waste", "sold", "revenue", "cells", "uncounted")

    def __init__(self, date, made, waste, sold, revenue):
        self.date = date
        self.made = made
        self.waste = waste
        self.sold = sold
        self.revenue = revenue
        self.cells: list[tuple[float | None, float | None]] = []
        self.uncounted = False


def parse(path: str) -> tuple[list[str], list[Day]]:
    items: list[str] = []
    days: list[Day] = []
    mode = None
    pending: Day | None = None

    with open(path, encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, 1):
            line = raw.split("#", 1)[0].strip()
            if not line:
                continue
            if line == "ITEMS":
                mode = "items"
                continue
            if line == "END":
                mode = None
                continue
            if mode == "items":
                items.append(line)
                continue
            if line.startswith("DAY "):
                _, date, made, waste, sold, revenue = line.split()
                pending = Day(date, int(made), int(waste), int(sold), float(revenue))
                days.append(pending)
                continue
            if pending is None:
                sys.exit(f"{path}:{lineno}: data before any DAY header")

            def cell(tok: str) -> float | None:
                return None if tok == "." else float(tok)

            for tok in line.split():
                m, w = tok.split("/")
                pending.cells.append((cell(m), cell(w)))

    return items, days


def validate(items: list[str], days: list[Day]) -> list[str]:
    """Cross-foot every day. Returns the problems found, empty if clean."""
    problems: list[str] = []
    for d in days:
        if len(d.cells) != len(items):
            problems.append(
                f"{d.date}: {len(d.cells)} cells for {len(items)} items")
            continue

        made = sum(m for m, _ in d.cells if m is not None)
        filled = [w for _, w in d.cells if w is not None]
        waste = sum(filled)

        if made != d.made:
            problems.append(f"{d.date}: made {made:g}, the sheet header says {d.made}")
        # An uncounted day's header waste is a spreadsheet artefact (a sum over
        # blanks), so it is not evidence of anything and is not checked.
        if filled and waste != d.waste:
            problems.append(f"{d.date}: waste {waste:g}, the sheet header says {d.waste}")
        if not filled:
            d.uncounted = True
            if d.waste != 0:
                problems.append(
                    f"{d.date}: waste column is blank throughout but the header "
                    f"says {d.waste} -- one of the two is a transcription error")
        elif d.made - d.waste != d.sold:
            problems.append(
                f"{d.date}: made-waste is {d.made - d.waste}, "
                f"the sheet header says sold {d.sold}")

        over = [items[i] for i, (m, w) in enumerate(d.cells)
                if m is not None and w is not None and w > m]
        for name in over:
            # Not fatal: the existing record has these too, and the app clamps
            # them. Worth saying out loud so it is a known fact, not a surprise.
            print(f"  note {d.date}: {name} wasted more than it made "
                  f"(an unrecorded refill)")
    return problems


def existing_dates(path: str, field: str = "business_date") -> set[str]:
    if not os.path.exists(path):
        return set()
    with open(path, encoding="utf-8", newline="") as fh:
        return {r[field] for r in csv.DictReader(fh)}


def log_rows(items: list[str], days: list[Day]) -> list[dict]:
    """Rows in daily_log.csv's shape, so the rest of the pipeline is unchanged."""
    out = []
    for d in days:
        date = dt.date.fromisoformat(d.date)
        sheet = f"{date.strftime('%B')} {date.day}"
        for i, (made, waste) in enumerate(d.cells):
            if made is None and waste is None:
                continue
            blank = waste is None
            out.append({
                "business_date": d.date,
                "sheet": sheet,
                "sheet_row": 6 + i,
                "raw_item_name": items[i],
                "item_key": items[i],
                "quantity_made": "" if made is None else f"{made:g}",
                "quantity_afternoon": "",
                "quantity_refill": "",
                "quantity_wasted": "" if blank else f"{waste:g}",
                # On an uncounted day sales are NOT known. Everywhere else a
                # blank cell means nothing was left, so sold equals made.
                "quantity_sold": "" if d.uncounted or made is None
                                 else f"{max(0.0, made - (waste or 0)):g}",
                "waste_blank": str(blank),
                # Censored means demand was cut off by the shelf. That is true
                # of a blank cell on a counted day and unknowable on a day that
                # was never counted.
                "demand_censored": str(blank and not d.uncounted),
                "operator_note": "waste never counted" if d.uncounted else "",
            })
    return out


def summary_rows(items: list[str], days: list[Day]) -> list[dict]:
    out = []
    for d in days:
        date = dt.date.fromisoformat(d.date)
        made = sum(m for m, _ in d.cells if m is not None)
        rows = sum(1 for m, w in d.cells if m is not None or w is not None)
        out.append({
            "business_date": d.date,
            "sheet": f"{date.strftime('%B')} {date.day}",
            "day_of_week": date.strftime("%A"),
            "weather": "",
            "holiday_event": "Prep & Waste Log",
            "item_rows": rows,
            "items_made": f"{made:g}",
            "items_refill": "0",
            # Left EMPTY on an uncounted day. A zero here would be read as a
            # measurement everywhere downstream.
            "items_wasted": "" if d.uncounted else f"{d.waste:g}",
            "items_sold": "" if d.uncounted else f"{d.sold:g}",
            "afternoon_cells": 0,
            "sheet_total_made": f"{d.made:g}",
            "sheet_total_waste": "" if d.uncounted else f"{d.waste:g}",
            "sheet_quantity_sold": "" if d.uncounted else f"{d.sold:g}",
            "sheet_total_revenue": "" if d.uncounted else f"{d.revenue:g}",
            "crossfoot_made_ok": "True",
            "crossfoot_waste_ok": "False" if d.uncounted else "True",
            "is_outage": "False",
        })
    return out


def recorded_cells(path: str) -> dict[tuple[str, str], tuple[float | None, float | None]]:
    """(date, item) -> (made, waste) as the record holds it; waste None = blank."""
    out: dict[tuple[str, str], tuple[float | None, float | None]] = {}
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8", newline="") as fh:
        for r in csv.DictReader(fh):
            made = float(r["quantity_made"]) if r["quantity_made"] else None
            waste = None if r["waste_blank"] == "True" or not r["quantity_wasted"] \
                else float(r["quantity_wasted"])
            out[(r["business_date"], r["item_key"])] = (made, waste)
    return out


def differences(items: list[str], day: Day,
                recorded: dict[tuple[str, str], tuple[float | None, float | None]]) -> list[str]:
    """Every cell where the sheet and the record disagree, in words."""
    out = []
    for i, (made, waste) in enumerate(day.cells):
        was = recorded.get((day.date, items[i]), (None, None))
        if (made, waste) != was:
            out.append(f"{items[i]}: made {_n(was[0])} -> {_n(made)}, "
                       f"left {_n(was[1])} -> {_n(waste)}")
    return out


def _n(v: float | None) -> str:
    return "blank" if v is None else f"{v:g}"


def drop_dates(path: str, dates: set[str]) -> int:
    """Remove every row for these dates, rewriting the rest untouched."""
    with open(path, encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        fields = reader.fieldnames or []
        rows = list(reader)
    keep = [r for r in rows if r["business_date"] not in dates]
    with open(path, "w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        w.writerows(keep)
    return len(rows) - len(keep)


def append(path: str, rows: list[dict]) -> None:
    with open(path, encoding="utf-8", newline="") as fh:
        fields = csv.DictReader(fh).fieldnames or []
    unknown = set(rows[0]) - set(fields) if rows else set()
    if unknown:
        sys.exit(f"{path}: refusing to write unknown columns {sorted(unknown)}")
    with open(path, "a", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        for r in rows:
            w.writerow({k: r.get(k, "") for k in fields})


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source")
    ap.add_argument("--write", action="store_true",
                    help="append to data/daily_log.csv and data/day_summary.csv")
    ap.add_argument("--replace", default="",
                    help="comma-separated dates already recorded to replace with the sheet's version")
    args = ap.parse_args()
    replace = {d.strip() for d in args.replace.split(",") if d.strip()}

    items, days = parse(args.source)
    print(f"{len(days)} days, {len(items)} items: "
          f"{days[0].date} .. {days[-1].date}")

    problems = validate(items, days)
    if problems:
        print("\nCROSS-FOOT FAILED -- nothing written:")
        for p in problems:
            print(f"  {p}")
        return 1

    uncounted = [d.date for d in days if d.uncounted]
    print(f"\ncross-foot: all {len(days)} days agree with their header totals")
    if uncounted:
        print(f"waste never counted on {len(uncounted)}: {', '.join(uncounted)}")
        print("  -> imported as production only; the app will ask for the count")

    already = existing_dates(DAILY_LOG)
    recorded = recorded_cells(DAILY_LOG)
    unknown = sorted(replace - {d.date for d in days if d.date in already})
    if unknown:
        print(f"\n--replace names days that are not both in the sheet and the record: "
              f"{', '.join(unknown)} -- nothing written")
        return 1

    same, changed, blocked = [], [], []
    for d in days:
        if d.date not in already:
            continue
        diff = differences(items, d, recorded)
        if not diff:
            same.append(d.date)
            continue
        print(f"\n{d.date} differs from the record in {len(diff)} cells"
              f"{' -- replacing' if d.date in replace else ''}:")
        for line in diff:
            print(f"    {line}")
        (changed if d.date in replace else blocked).append(d)
    if same:
        print(f"\nalready recorded and identical, skipping: {', '.join(same)}")
    if blocked:
        print(f"\nCHANGED DAYS NOT REPLACED -- nothing written. Check the cells above, "
              f"then rerun with --replace {','.join(d.date for d in blocked)}")
        return 1

    fresh = [d for d in days if d.date not in already]
    todo = fresh + changed
    if not todo:
        print("nothing new to add.")
        return 0

    rows = log_rows(items, todo)
    summ = summary_rows(items, todo)
    print(f"\n{len(rows)} item-rows: {len(fresh)} new days, {len(changed)} replaced")
    if not args.write:
        print("dry run -- pass --write to commit")
        return 0

    gone = {d.date for d in changed}
    if gone:
        n = drop_dates(DAILY_LOG, gone)
        drop_dates(DAY_SUMMARY, gone)
        print(f"removed {n} old rows for {', '.join(sorted(gone))}")
    append(DAILY_LOG, rows)
    append(DAY_SUMMARY, summ)
    print(f"wrote {_show(DAILY_LOG)} and {_show(DAY_SUMMARY)}")
    return 0


def _show(path: str) -> str:
    """Relative to the repo where possible. On Windows relpath raises across
    drives, and a crash AFTER the write would read as the write failing."""
    try:
        return os.path.relpath(path, HERE)
    except ValueError:
        return path


if __name__ == "__main__":
    raise SystemExit(main())
