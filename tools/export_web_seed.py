"""Generate web/src/data/seed.json -- the app's item list and starting template.

The item list comes from the reviewed extraction, so the app opens with the real
roster instead of a blank screen. Output is gitignored: it carries real item
names and cost estimates.

    python tools/export_web_seed.py

The starting template is the trailing median of what was actually made on each
weekday. It is the operator's own recent behaviour, not a model -- a sensible
place to start editing from, and explicitly not a recommendation.
"""

import argparse
import csv
import datetime
import json
import os
import sys
import statistics
from collections import defaultdict

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(HERE, "web", "src", "data", "seed.json")


def read(path):
    with open(path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


HERE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE_ROOT)
from analysis.sheet_order import load_sheet_groups, load_sheet_order, sort_key  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--extract-dir", default="data")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--template-weeks", type=int, default=4,
                    help="trailing weeks used for the starting template")
    args = ap.parse_args()

    items_csv = read(os.path.join(args.extract_dir, "items.csv"))
    log = read(os.path.join(args.extract_dir, "daily_log.csv"))

    # Unit cost from the drafted BOM, if it has been generated.
    unit_cost = defaultdict(float)
    ing_path = os.path.join(args.extract_dir, "ingredients_draft.csv")
    rec_path = os.path.join(args.extract_dir, "recipes_draft.csv")
    if os.path.exists(ing_path) and os.path.exists(rec_path):
        per_unit = {r["ingredient"]: float(r["pack_cost"]) / float(r["pack_qty"])
                    for r in read(ing_path)}
        for r in read(rec_path):
            unit_cost[r["item_key"]] += float(r["qty_per_unit"]) * per_unit[r["ingredient"]]

    last_seen = max(r["last_seen"] for r in items_csv)
    cutoff = (datetime.date.fromisoformat(last_seen)
              - datetime.timedelta(weeks=args.template_weeks)).isoformat()

    # Only items still on the menu at the end of the seed period.
    active = [r for r in items_csv if r["last_seen"] >= cutoff]

    # IDENTITY. Assigned from the extraction's own row order and never from
    # anything that might be re-ordered later. Every entry ever recorded
    # references an itemId, and history.json is written against these same
    # ids -- so shuffling them silently re-labels the entire trading record.
    # If the display order ever wants to change, it changes sortOrder below.
    ids = {r["item_key"]: i + 1 for i, r in enumerate(active)}

    # PRESENTATION. The order the operator's own prep sheet lists items in.
    # Alphabetical put "avocado roll" first and "sashimi salmon" last, which
    # is the reverse of how the case is actually read.
    order = load_sheet_order()
    if order:
        listed = sorted(active, key=lambda r: sort_key(order)(r["item_key"]))
        unlisted = [r["item_key"] for r in listed if r["item_key"] not in set(order)]
        if unlisted:
            print(f"  note: not in data/sheet_order.txt, listed last: "
                  f"{', '.join(unlisted)}")
    else:
        print("  note: no data/sheet_order.txt; falling back to alphabetical")
        listed = active
    rank = {r["item_key"]: i for i, r in enumerate(listed)}
    # The sheet's own blank-line blocks, so the app can draw items in the same
    # groups the paper does. Presentation, like sortOrder: never identity.
    block = {key: g for g, keys in enumerate(load_sheet_groups()) for key in keys}

    items = [dict(
        itemId=ids[r["item_key"]],
        itemKey=r["item_key"],
        displayName=r["item_key"],
        price=float(r["proposed_price"]) if r["proposed_price"] else None,
        unitCost=round(unit_cost[r["item_key"]], 4) or None,
        sortOrder=rank[r["item_key"]],
        sheetGroup=block.get(r["item_key"]),
        active=True,
    ) for i, r in enumerate(active)]

    # Trailing median made, per weekday per item.
    made = defaultdict(list)
    for row in log:
        if row["business_date"] < cutoff or not row["quantity_made"]:
            continue
        key = row["item_key"]
        if key not in ids:
            continue
        wd = datetime.date.fromisoformat(row["business_date"]).isoweekday()
        made[(wd, key)].append(float(row["quantity_made"]))

    templates, assignments = [], []
    for wd in range(1, 8):
        quantities = {}
        for key, item_id in ids.items():
            vals = made.get((wd, key))
            if vals:
                quantities[item_id] = int(round(statistics.median(vals)))
        if not quantities:
            continue
        name = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][wd - 1]
        templates.append(dict(templateId=wd, name=f"{name} baseline",
                              quantities=quantities))
        assignments.append(dict(weekday=wd, effectiveFrom=last_seen, templateId=wd))

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(dict(items=items, templates=templates, assignments=assignments),
                  fh, indent=2)

    print("wrote %s" % args.out)
    print("  items      %d  (active as of %s)" % (len(items), last_seen))
    print("  templates  %d  (trailing %d-week median made per weekday)"
          % (len(templates), args.template_weeks))
    for t in templates:
        print("    %-14s %3d items" % (t["name"], sum(t["quantities"].values())))


if __name__ == "__main__":
    main()
