"""Phase 1 Step 3 -- extract the seed workbook to reviewable CSVs.

Read-only. Never writes to the workbook. Emits intermediate CSVs for human
review; nothing here touches Postgres.

    python tools/extract_workbook.py "path/to/May sushi sales.xlsx" --out data/

Design rules (from the brief):
  * Columns are addressed by RESOLVED HEADER NAME, never by index. One sheet
    (July 15) has its whole header block shifted one column right; index-based
    parsing silently mangles it.
  * Every anomaly is recorded in exceptions.csv rather than silently repaired.
  * Fabricated template days are detected by rule (identical data regions),
    not by a hardcoded date, so the rule still holds if the file is re-exported.
  * The log records what was observed. Lineage is declared separately and
    resolved downstream -- the importer never merges two items' observations.
"""

import argparse
import csv
import datetime
import hashlib
import os
import re
import sys
from collections import defaultdict

try:
    import openpyxl
except ImportError:
    sys.exit("pip install openpyxl")


MONTHS = {m: i for i, m in enumerate(
    ["", "January", "February", "March", "April", "May", "June", "July",
     "August", "September", "October", "November", "December"]) if m}

SHEET_DATE_RE = re.compile(r"^(%s) (\d{1,2})$" % "|".join(MONTHS), re.I)

# Header labels we resolve by name. Left = canonical key, right = the literal
# text as it appears in the sheet (matched case-insensitively, whitespace
# collapsed).
ITEM_COLUMNS = {
    "made":      "quantity made",
    "afternoon": "quantity in afternoon",
    "refill":    "quantity afternoon refill",
    "wasted":    "quantity wasted",
}
DAY_FIELDS = ["date", "day of week", "weather", "total made", "total waste",
              "quantity sold", "total revenue", "holiday/event:", "multiplier:"]

# Rows in the item block that are structural, not products.
NON_ITEM_LABELS = {"items", "prep & waste log", "date", "sushi item"}

# Confirmed by the operator: interchangeable, later name is more specific.
ALIASES = {"deluxe": "salmon deluxe"}

# Declared lineage. Recorded, not applied -- observations stay attached to the
# name actually written down. Phase 4 decides whether parent history informs a
# child, and the backtest scores that decision.
LINEAGE = [
    # (parent, [children], effective date, kind)
    ("sashimi",      ["sashimi salmon", "sashimi red"],             "2026-08-02", "split"),
    ("nigiri (6pc)", ["nigiri (6pc) raw", "nigiri (6pc) assorted"], "2026-08-02", "split"),
    ("rainbow roll", ["rainbow roll tuna", "rainbow roll salmon"],  "2026-08-02", "split"),
]

# Proposed PLU price mapping, replacing the workbook's broken wildcard VLOOKUP.
# confidence: "ok" = unambiguous, "check" = needs the operator's eye.
PLU_MAP = {
    "avocado roll":               ("AVOCADO ROLL",                     6.99,  "ok"),
    "cali large":                 ("CALIFORNIA ROLL (LARGE)",         10.99,  "ok"),
    "cali roll":                  ("CALIFORNIA ROLL",                  6.99,  "ok"),
    "cali roll large":            ("CALIFORNIA ROLL (LARGE)",         10.99,  "ok"),
    "crunchy lobster volcano":    ("LOBSTER VOLCANO ROLL",             9.49,  "check"),
    "crunchy spicy crab volcano": ("SPICY CRAB VOLCANO ROLL",          9.49,  "check"),
    "crunchy spicy tuna":         ("CRUNCH SPICY TUNA ROLL",           7.99,  "ok"),
    "delight roll combo":         ("DELIGHT ROLL COMBO",              11.99,  "ok"),
    "dragon roll":                ("DRAGON ROLL",                     11.99,  "ok"),
    "lobster inari":              ("LOBSTER ON INARI",                 8.99,  "ok"),
    "lobster roll":               ("LOBSTER ROLL",                     7.99,  "ok"),
    "lobster tuna sandwich":      ("LOBSTER & SPICY TUNA SANDWICH",   11.49,  "ok"),
    "lobster volcano":            ("LOBSTER VOLCANO ROLL",             9.49,  "ok"),
    "nigiri (6pc)":               ("NIGIRI (6 PCS)",                  11.99,  "ok"),
    "nigiri (6pc) assorted":      ("ASSORTED NIGIRI",                 12.49,  "check"),
    "nigiri (6pc) raw":           ("NIGIRI (6 PCS)",                  11.99,  "check"),
    "philly roll":                ("PHILADELPHIA ROLL",                8.49,  "ok"),
    "poke":                       ("SALMON POWER SALAD POKE BOWL",    13.99,  "check"),
    "rainbow roll":               ("RAINBOW ROLL",                    11.99,  "ok"),
    "rainbow roll salmon":        ("PINK RAINBOW ROLL",               11.49,  "check"),
    "rainbow roll tuna":          ("RAINBOW ROLL",                    11.99,  "check"),
    "salmon avocado":             ("SALMON AVOCADO ROLL",              7.99,  "ok"),
    "salmon deluxe":              ("SUSHI DELUXE",                    16.99,  "check"),
    "sashimi":                    ("SASHIMI (10PC)",                  13.99,  "ok"),
    "sashimi red":                ("SASHIMI (10PC)",                  13.99,  "check"),
    "sashimi salmon":             ("SASHIMI (10PC)",                  13.99,  "check"),
    "shrimp tempura roll":        ("SHRIMP TEMPURA ROLL",              8.99,  "ok"),
    "shrimp tempura side":        ("SHRIMP TEMPURA",                   6.49,  "ok"),
    "spicy cali":                 ("SPICY CALIFORNIA ROLL",            6.99,  "ok"),
    "spicy crab":                 ("SPICY CRAB ROLL",                  6.99,  "ok"),
    "spicy crab inari":           ("SPICY CRAB ON INARI",              8.49,  "ok"),
    "spicy crab volcano":         ("SPICY CRAB VOLCANO ROLL",          9.49,  "ok"),
    "spicy shrimp tempura roll":  ("SPICY SHRIMP TEMPURA ROLL",        8.99,  "ok"),
    "spicy tuna":                 ("SPICY TUNA ROLL",                  7.99,  "ok"),
    "spicy tuna inari":           ("SPICY TUNA ON INARI",              8.99,  "ok"),
    "spicy tuna volcano":         ("COOKED SPICY TUNA VOLCANO ROLL",   9.99,  "check"),
    "tornado shrimp tempura roll":("SHRIMP TEMPURA TORNADO ROLL",      8.99,  "ok"),
    "tri volcano":                ("TRI VOLCANO COMBO",               13.49,  "ok"),
    "tuna avocado":               ("TUNA AVOCADO ROLL",                7.99,  "ok"),
    "tuna tataki":                ("TUNA TATAKI - (8PC)",             12.99,  "ok"),
    "tuna tataki roll":           ("TUNA TATAKI ROLL",                11.99,  "ok"),
    "vegetable roll":             ("VEGETABLE ROLL",                   6.99,  "ok"),
}


def norm(v):
    """Collapse a cell's text to a comparison key. This is the function that
    decides whether one item silently becomes two."""
    if v is None:
        return ""
    return re.sub(r"\s+", " ", str(v).replace(" ", " ").strip()).lower()


NUM_PREFIX_RE = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*(.*)$", re.S)


def parse_qty(v):
    """Return (number|None, annotation|None, problem|None).

    Cells like '4 [out by 12pm]' carry a real quantity plus an operator note.
    Keep both; never coerce silently."""
    if v is None or v == "":
        return None, None, None
    if isinstance(v, bool):
        return None, None, "boolean in quantity column"
    if isinstance(v, (int, float)):
        return float(v), None, None
    m = NUM_PREFIX_RE.match(str(v))
    if m:
        note = m.group(2).strip().strip("[]()") or None
        return float(m.group(1)), note, "text mixed into quantity column"
    return None, str(v).strip(), "non-numeric quantity"


def sheet_date(title):
    m = SHEET_DATE_RE.match(title.strip())
    if not m:
        return None
    return datetime.date(2026, MONTHS[m.group(1).capitalize()], int(m.group(2)))


def find_item_header(ws):
    """Locate the item-block header row and map canonical key -> column index.

    Returns (row, {key: col}, {raw_label: col}). Resolved by text, so a sheet
    whose block is shifted sideways still parses correctly."""
    for r in range(1, min(ws.max_row, 20) + 1):
        for c in range(1, min(ws.max_column, 30) + 1):
            if norm(ws.cell(r, c).value) == "items":
                raw = {}
                for cc in range(1, min(ws.max_column, 30) + 1):
                    lab = norm(ws.cell(r, cc).value)
                    if lab:
                        raw[lab] = cc
                cols = {k: raw[v] for k, v in ITEM_COLUMNS.items() if v in raw}
                return r, cols, raw, c
    return None, {}, {}, None


def read_day_header(ws, stop_row):
    """Read the day-level summary block above the item table, by label."""
    out = {}
    for r in range(1, stop_row):
        for c in range(1, min(ws.max_column, 30) + 1):
            lab = norm(ws.cell(r, c).value)
            if lab in DAY_FIELDS and lab not in out:
                out[lab] = ws.cell(r + 1, c).value
    return out


def data_signature(ws, hdr_row, item_col, cols):
    """Hash only the entered data region. Template copies differ in their date
    and weekday cells but are identical here, so this is what identifies a
    fabricated day -- hashing the whole sheet does not."""
    parts = []
    for r in range(hdr_row + 1, ws.max_row + 1):
        vals = [str(ws.cell(r, item_col).value)]
        vals += [str(ws.cell(r, cols[k]).value) for k in sorted(cols)]
        parts.append("|".join(vals))
    return hashlib.md5("\n".join(parts).encode("utf-8", "replace")).hexdigest()[:12]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workbook")
    ap.add_argument("--out", default="data")
    ap.add_argument("--min-template-group", type=int, default=3,
                    help="identical data regions this many times or more are "
                         "treated as unfilled template copies")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    wb = openpyxl.load_workbook(args.workbook, data_only=True)

    exceptions = []
    def flag(date, sheet, cell, kind, detail):
        exceptions.append(dict(business_date=date, sheet=sheet, cell=cell,
                               kind=kind, detail=detail))

    # ---- pass 1: parse every date-named sheet -------------------------------
    parsed = []
    for ws in wb.worksheets:
        d = sheet_date(ws.title)
        if d is None:
            continue
        hdr_row, cols, raw, item_col = find_item_header(ws)
        if hdr_row is None:
            flag("", ws.title, "", "no item header", "no cell reading 'Items'")
            continue
        missing = set(ITEM_COLUMNS) - set(cols)
        if missing:
            flag(d, ws.title, "", "missing column",
                 "no header for: %s" % ", ".join(sorted(missing)))
        if item_col != 2:
            flag(d, ws.title, "%s%d" % (openpyxl.utils.get_column_letter(item_col), hdr_row),
                 "shifted layout", "item block starts in column %s, not B"
                 % openpyxl.utils.get_column_letter(item_col))

        head = read_day_header(ws, hdr_row)
        rows = []
        for r in range(hdr_row + 1, ws.max_row + 1):
            name_raw = ws.cell(r, item_col).value
            key = norm(name_raw)
            if not key:
                # A quantity with no item name beside it is a lost observation.
                for k, c in cols.items():
                    if ws.cell(r, c).value not in (None, ""):
                        flag(d, ws.title,
                             "%s%d" % (openpyxl.utils.get_column_letter(c), r),
                             "orphan value",
                             "%s=%r on a row with no item name"
                             % (k, ws.cell(r, c).value))
                continue
            if key in NON_ITEM_LABELS:
                continue
            if str(name_raw) != str(name_raw).strip():
                flag(d, ws.title, "%s%d" % (openpyxl.utils.get_column_letter(item_col), r),
                     "whitespace in name", repr(name_raw))
            rec = {"row": r, "raw_name": name_raw, "key": key,
                   "canonical": ALIASES.get(key, key), "note": None}
            for k in ITEM_COLUMNS:
                c = cols.get(k)
                if c is None:
                    rec[k] = None
                    continue
                val, note, problem = parse_qty(ws.cell(r, c).value)
                rec[k] = val
                if note:
                    rec["note"] = note
                if problem:
                    flag(d, ws.title,
                         "%s%d" % (openpyxl.utils.get_column_letter(c), r),
                         problem, "%s=%r" % (k, ws.cell(r, c).value))
            rows.append(rec)

        parsed.append(dict(date=d, sheet=ws.title, head=head, rows=rows,
                           sig=data_signature(ws, hdr_row, item_col, cols)))

    parsed.sort(key=lambda p: p["date"])

    # ---- pass 2: identify fabricated template days by rule ------------------
    by_sig = defaultdict(list)
    for p in parsed:
        by_sig[p["sig"]].append(p)
    template_sigs = {s for s, g in by_sig.items()
                     if len(g) >= args.min_template_group}
    for s in template_sigs:
        g = sorted(by_sig[s], key=lambda p: p["date"])
        for p in g:
            p["excluded"] = "identical data region shared with %d other sheets" % (len(g) - 1)
        flag(g[0]["date"], "%s..%s" % (g[0]["sheet"], g[-1]["sheet"]),
             "", "template block",
             "%d sheets share data signature %s -- treated as unfilled "
             "templates, excluded" % (len(g), s))

    real = [p for p in parsed if not p.get("excluded")]

    # ---- write day_summary.csv ---------------------------------------------
    def num(x):
        return x if isinstance(x, (int, float)) else None

    day_rows = []
    for p in real:
        made = sum(r["made"] or 0 for r in p["rows"])
        refill = sum(r["refill"] or 0 for r in p["rows"])
        wasted = sum(r["wasted"] or 0 for r in p["rows"])
        aft = sum(1 for r in p["rows"] if r["afternoon"] is not None)
        h = p["head"]
        sheet_made, sheet_waste = num(h.get("total made")), num(h.get("total waste"))
        outage = (not p["rows"] or (made == 0 and wasted == 0)) and bool(sheet_made)
        cf_made = sheet_made is None or abs(sheet_made - (made + refill)) < 1e-6
        cf_waste = sheet_waste is None or abs(sheet_waste - wasted) < 1e-6
        if not outage and not (cf_made and cf_waste):
            flag(p["date"], p["sheet"], "", "cross-foot mismatch",
                 "sheet says made=%s waste=%s; item rows give made+refill=%s waste=%s"
                 % (sheet_made, sheet_waste, made + refill, wasted))
        if outage:
            flag(p["date"], p["sheet"], "", "outage day",
                 "day totals present but every item row blank (%s)"
                 % (h.get("weather") or "no note"))
        day_rows.append(dict(
            business_date=p["date"], sheet=p["sheet"],
            day_of_week=p["date"].strftime("%A"),
            weather=h.get("weather") or "", holiday_event=h.get("holiday/event:") or "",
            item_rows=len(p["rows"]),
            items_made=made, items_refill=refill, items_wasted=wasted,
            items_sold=made + refill - wasted, afternoon_cells=aft,
            sheet_total_made=sheet_made, sheet_total_waste=sheet_waste,
            sheet_quantity_sold=num(h.get("quantity sold")),
            sheet_total_revenue=num(h.get("total revenue")),
            crossfoot_made_ok=cf_made, crossfoot_waste_ok=cf_waste,
            is_outage=outage))

    # ---- write daily_log.csv ------------------------------------------------
    log_rows = []
    for p in real:
        for r in p["rows"]:
            made, refill, wasted = r["made"], r["refill"], r["wasted"]
            sold = None
            if made is not None or refill is not None or wasted is not None:
                sold = (made or 0) + (refill or 0) - (wasted or 0)
            # The operator writes a waste figure only when there IS waste, so a
            # blank cell on a row that was produced means zero waste -- i.e. the
            # item sold out and true demand is right-censored at `made+refill`.
            # waste_blank keeps that inference visible instead of burying it.
            log_rows.append(dict(
                business_date=p["date"], sheet=p["sheet"], sheet_row=r["row"],
                raw_item_name=r["raw_name"], item_key=r["canonical"],
                quantity_made=made, quantity_afternoon=r["afternoon"],
                quantity_refill=refill, quantity_wasted=wasted,
                quantity_sold=sold, waste_blank=(wasted is None),
                demand_censored=(made is not None and (wasted or 0) == 0),
                operator_note=r["note"] or ""))

    # ---- write items.csv ----------------------------------------------------
    agg = defaultdict(lambda: dict(days=0, made=0.0, wasted=0.0, sold=0.0,
                                   first=None, last=None, raw=set()))
    for row in log_rows:
        a = agg[row["item_key"]]
        a["days"] += 1
        a["made"] += row["quantity_made"] or 0
        a["wasted"] += row["quantity_wasted"] or 0
        a["sold"] += row["quantity_sold"] or 0
        a["raw"].add(str(row["raw_item_name"]))
        d = row["business_date"]
        a["first"] = d if a["first"] is None else min(a["first"], d)
        a["last"] = d if a["last"] is None else max(a["last"], d)

    lineage_role, lineage_parent, lineage_date = {}, {}, {}
    for parent, children, eff, kind in LINEAGE:
        lineage_role[parent] = "%s parent" % kind
        lineage_date[parent] = eff
        for ch in children:
            lineage_role[ch] = "%s child" % kind
            lineage_parent[ch] = parent
            lineage_date[ch] = eff
    for old, new in ALIASES.items():
        lineage_role.setdefault(new, "renamed")

    item_rows = []
    for key in sorted(agg, key=lambda k: (-agg[k]["days"], k)):
        a = agg[key]
        plu, price, conf = PLU_MAP.get(key, ("", "", "MISSING"))
        item_rows.append(dict(
            item_key=key, days_present=a["days"],
            first_seen=a["first"], last_seen=a["last"],
            total_made=a["made"], total_wasted=a["wasted"], total_sold=a["sold"],
            waste_rate=round(a["wasted"] / a["made"], 4) if a["made"] else "",
            raw_name_variants=" | ".join(sorted(a["raw"])),
            lineage_role=lineage_role.get(key, ""),
            lineage_parent=lineage_parent.get(key, ""),
            lineage_effective=lineage_date.get(key, ""),
            proposed_plu_name=plu, proposed_price=price,
            price_confidence=conf))
        if conf == "MISSING":
            flag("", "", "", "unmapped item",
                 "%r has no proposed PLU price" % key)

    def dump(name, rows):
        path = os.path.join(args.out, name)
        if not rows:
            return path, 0
        with open(path, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        return path, len(rows)

    written = [dump("day_summary.csv", day_rows),
               dump("daily_log.csv", log_rows),
               dump("items.csv", item_rows),
               dump("exceptions.csv", exceptions)]

    excluded = [p for p in parsed if p.get("excluded")]
    print("workbook      : %s" % args.workbook)
    print("date sheets   : %d" % len(parsed))
    print("  real days   : %d  (%s .. %s)"
          % (len(real), real[0]["date"], real[-1]["date"]))
    print("  excluded    : %d  (%s .. %s)"
          % (len(excluded), excluded[0]["date"], excluded[-1]["date"])
          if excluded else "  excluded    : 0")
    print("item-day rows : %d" % len(log_rows))
    print("distinct items: %d" % len(item_rows))
    print("exceptions    : %d" % len(exceptions))
    for path, n in written:
        print("  wrote %-28s %5d rows" % (path, n))
    kinds = defaultdict(int)
    for e in exceptions:
        kinds[e["kind"]] += 1
    if kinds:
        print("\nexceptions by kind:")
        for k in sorted(kinds, key=lambda k: -kinds[k]):
            print("  %-26s %d" % (k, kinds[k]))


if __name__ == "__main__":
    main()
