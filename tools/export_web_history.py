"""Generate web/public/history.json -- the app's opening balance of real days.

The workbook is a one-time seed, not a live dependency. This is the other half
of that seed: `export_web_seed.py` gives the app its menu, this gives it the
117 days behind the menu, so Insights, the sell-out chart and the model open
with something real in them instead of an empty axis.

    python tools/export_web_history.py

Output is gitignored -- it is the operator's actual trading history.

Two conventions are carried over verbatim from the extraction rather than being
re-decided here, because a second opinion about them would silently disagree
with every model that has already been fitted:

  * A blank waste cell on a produced row means ZERO waste -- the item sold out
    and demand is right-censored at made+refill. See extract_workbook.py. It is
    an observed zero, not a missing value, so it is written as an entry.
  * A row with no made, refill or waste figure at all is not a day of zero. It
    is a row the operator never filled in, and it is skipped entirely.

The one thing decided HERE, because it is about a day rather than a cell: a day
whose waste column is blank ALL the way down was never counted. The rule above
would read it as "every item sold out", which is the most damaging reading
available -- it tells the model demand was censored at the ceiling on every
line and pushes every future recommendation up. Those days go into `uncounted`
and carry no waste rows at all, so the app shows them as a leftover count still
owed rather than as a triumphant day.

Mutation ids are deterministic (`seed:date:item:type`), so importing twice adds
nothing the second time -- the same property the append-only log relies on.
"""

import argparse
import csv
import datetime
import json
import os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(HERE, "web", "public", "history.json")
DEFAULT_SEED = os.path.join(HERE, "web", "src", "data", "seed.json")


def read(path):
    with open(path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def num(v):
    return float(v) if v not in ("", None) else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--extract-dir", default="data")
    ap.add_argument("--seed", default=DEFAULT_SEED)
    ap.add_argument("--out", default=DEFAULT_OUT)
    args = ap.parse_args()

    with open(args.seed, encoding="utf-8") as fh:
        seed = json.load(fh)
    ids = {i["itemKey"]: i["itemId"] for i in seed["items"]}

    log = read(os.path.join(args.extract_dir, "daily_log.csv"))
    summary = read(os.path.join(args.extract_dir, "day_summary.csv"))

    # Items the seed dropped as no longer on the menu still appear in the
    # history, and 14% of rows are theirs. Importing without them would leave
    # Insights quietly understating every total, which is worse than a longer
    # item list -- so they come along, archived. They show in the history and
    # never on the production screen.
    missing = sorted({r["item_key"] for r in log} - set(ids))
    items_csv = {r["item_key"]: r for r in read(os.path.join(args.extract_dir, "items.csv"))}
    next_id = max(ids.values(), default=0) + 1
    next_sort = max((i["sortOrder"] for i in seed["items"]), default=-1) + 1
    archived = []
    for key in missing:
        meta = items_csv.get(key, {})
        archived.append(dict(
            itemId=next_id, itemKey=key, displayName=key,
            price=num(meta.get("proposed_price")), unitCost=None,
            sortOrder=next_sort, active=False,
            lastSeen=meta.get("last_seen") or None))
        ids[key] = next_id
        next_id += 1
        next_sort += 1

    dates = sorted({r["business_date"] for r in log})
    date_index = {d: i for i, d in enumerate(dates)}
    outage = {r["business_date"]: r["is_outage"] == "True" for r in summary}

    # Days that traded but were never counted. Derived from the rows rather
    # than from a flag, so it holds for any source that writes this log.
    produced, counted = set(), set()
    for r in log:
        if num(r["quantity_made"]) or num(r["quantity_refill"]):
            produced.add(r["business_date"])
        if num(r["quantity_wasted"]) is not None:
            counted.add(r["business_date"])
    uncounted = sorted(produced - counted - {d for d in dates if outage.get(d)})

    # Columnar: [dateIdx, itemId, made, refill, waste]. A flat table of 3.5k
    # objects with five repeated key names each is ~5x this for no benefit;
    # the app expands it on import.
    rows = []
    skipped = 0
    for r in log:
        made, refill = num(r["quantity_made"]), num(r["quantity_refill"])
        wasted = num(r["quantity_wasted"])
        # A blank cell is a sold-out zero ONLY on a day that was counted. On an
        # uncounted day it is simply unknown, and stays unknown.
        if (wasted is None and r["waste_blank"] == "True" and made is not None
                and r["business_date"] not in uncounted):
            wasted = 0.0                      # sold out -- observed, not missing
        if made is None and refill is None and wasted is None:
            skipped += 1                      # never filled in; absence is not zero
            continue
        rows.append([date_index[r["business_date"]], ids[r["item_key"]],
                     made, refill, wasted])

    payload = dict(
        # UTC with an explicit Z. The app stamps corrections with this and
        # orders them against its own UTC entries; a local time with no zone
        # would compare correctly only by accident of which zone this ran in.
        generatedAt=datetime.datetime.now(datetime.timezone.utc)
            .replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        source="workbook extract",
        fromDate=dates[0], toDate=dates[-1],
        archivedItems=archived,
        dates=dates,
        outages=[d for d in dates if outage.get(d)],
        uncounted=uncounted,
        columns=["dateIdx", "itemId", "made", "refill", "waste"],
        rows=rows,
    )

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))

    size = os.path.getsize(args.out)
    made_n = sum(1 for r in rows if r[2] is not None)
    waste_n = sum(1 for r in rows if r[4] is not None)
    print("wrote %s  (%.0f kB)" % (args.out, size / 1024))
    print("  days       %d   %s .. %s" % (len(dates), dates[0], dates[-1]))
    print("  rows       %d   (%d skipped as never filled in)" % (len(rows), skipped))
    print("  made       %d" % made_n)
    print("  waste      %d   (of which %d are sold-out zeros)"
          % (waste_n, sum(1 for r in rows if r[4] == 0)))
    print("  outages    %d" % len(payload["outages"]))
    print("  uncounted  %d   %s" % (len(uncounted), ", ".join(uncounted) or "-"))
    print("  archived   %d items carried over for history only" % len(archived))


if __name__ == "__main__":
    main()
