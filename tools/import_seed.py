"""Phase 1 Step 4 -- load the reviewed CSVs into Postgres, idempotently.

    python tools/import_seed.py --dry-run                       # no DB needed
    python tools/import_seed.py --database-url "$DATABASE_URL"
    python tools/import_seed.py --database-url ... --reconcile "May sushi sales.xlsx"

This is a maintained component, not a throwaway. The transform is a set of pure
functions (build_seed and friends) that turn CSV rows into table rows with no
database and no I/O, which is what the tests exercise. The loader is a thin
shell around them.

Idempotency: dimensions upsert on their natural key. The append-only log keys on
(source_ref, value_hash) -- re-running unchanged data inserts nothing, while
corrected data inserts a new row that supersedes the old one by recorded_at. No
row is ever updated or deleted.

Reconciliation recomputes the workbook side straight from the .xlsx rather than
from the CSVs, so a bug in extract_workbook.py cannot hide by being consistent
with itself.
"""

import argparse
import csv
import datetime
import hashlib
import json
import os
import re
import sys
from collections import defaultdict

SEED_SOURCE = "workbook-seed"

ENTRY_COLUMNS = [
    ("quantity_made", "made"),
    ("quantity_refill", "refill"),
    ("quantity_wasted", "waste"),
    ("quantity_afternoon", "afternoon_count"),
]


# --------------------------------------------------------------- helpers ----

def read_csv(path):
    with open(path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def as_num(v):
    if v in (None, "", "None"):
        return None
    return float(v)


def as_bool(v):
    return str(v).strip().lower() in ("true", "1", "yes")


def norm_key(v):
    return re.sub(r"\s+", " ", str(v or "").replace(" ", " ").strip()).lower()


def value_hash(business_date, item_key, entry_type, quantity):
    raw = "%s|%s|%s|%s" % (business_date, item_key, entry_type, quantity)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ------------------------------------------------------------- transform ----

def build_items(item_rows):
    """items, item_aliases, item_attributes, item_lineage."""
    items, aliases, attributes, lineage = [], [], [], []
    for r in item_rows:
        key = norm_key(r["item_key"])
        items.append(dict(item_key=key, display_name=r["item_key"]))
        for raw in (r.get("raw_name_variants") or "").split("|"):
            raw = raw.strip()
            if raw:
                aliases.append(dict(raw_name=raw, item_id_key=key,
                                    note="seen in workbook"))
        price = as_num(r.get("proposed_price"))
        attributes.append(dict(
            item_id_key=key,
            effective_from=r["first_seen"],
            price=price,
            unit_cost=None,          # filled from the BOM, not assumed here
            plu_name=r.get("proposed_plu_name") or None,
            is_active=True,
            source="%s (price confidence: %s)" % (SEED_SOURCE,
                                                  r.get("price_confidence") or "?")))
        parent = (r.get("lineage_parent") or "").strip()
        if parent:
            lineage.append(dict(
                parent_key=norm_key(parent), child_key=key,
                effective_date=r.get("lineage_effective") or r["first_seen"],
                kind="split",
                note=r.get("lineage_role") or ""))
    return items, aliases, attributes, lineage


def build_days(day_rows):
    out = []
    for r in day_rows:
        out.append(dict(
            business_date=r["business_date"],
            day_of_week=r["day_of_week"],
            is_outage=as_bool(r["is_outage"]),
            weather=r.get("weather") or None,
            holiday_event=r.get("holiday_event") or None,
            notes=None if as_bool(r["crossfoot_made_ok"]) and as_bool(r["crossfoot_waste_ok"])
                  else "sheet totals disagree with item rows; item rows are authoritative",
            source=SEED_SOURCE))
    return out


def build_entries(log_rows, alias_to_key):
    """One row per observed quantity. Blank cells produce NO row -- absence is
    not zero, and inventing zeros would fabricate observations."""
    entries = []
    for r in log_rows:
        key = alias_to_key.get(str(r["raw_item_name"]).strip()) or norm_key(r["item_key"])
        for col, entry_type in ENTRY_COLUMNS:
            q = as_num(r.get(col))
            if q is None:
                continue
            entries.append(dict(
                business_date=r["business_date"],
                item_id_key=key,
                entry_type=entry_type,
                quantity=q,
                source=SEED_SOURCE,
                source_ref="%s!r%s:%s" % (r["sheet"], r["sheet_row"], entry_type),
                value_hash=value_hash(r["business_date"], key, entry_type, q),
                note=r.get("operator_note") or None))
    return entries


def build_bom(ingredient_rows, recipe_rows, effective_from):
    ingredients, prices, links = [], [], []
    for r in ingredient_rows:
        ingredients.append(dict(name=r["ingredient"],
                                unit_of_measure=r["unit_of_measure"]))
        prices.append(dict(ingredient_name=r["ingredient"],
                           effective_from=effective_from,
                           pack_cost=float(r["pack_cost"]),
                           pack_qty=float(r["pack_qty"]),
                           source=r.get("confidence") or ""))
    order = defaultdict(int)
    for r in recipe_rows:
        key = norm_key(r["item_key"])
        links.append(dict(item_id_key=key, ingredient_name=r["ingredient"],
                          effective_from=effective_from,
                          qty_per_unit=float(r["qty_per_unit"]),
                          sort_order=order[key]))
        order[key] += 1
    return ingredients, prices, links


def build_seed(extract_dir, bom_effective_from="2026-05-08"):
    """Pure: CSVs in, table rows out. No database, no network."""
    items_csv = read_csv(os.path.join(extract_dir, "items.csv"))
    days_csv = read_csv(os.path.join(extract_dir, "day_summary.csv"))
    log_csv = read_csv(os.path.join(extract_dir, "daily_log.csv"))

    items, aliases, attributes, lineage = build_items(items_csv)
    alias_to_key = {a["raw_name"]: a["item_id_key"] for a in aliases}
    seed = dict(
        items=items, item_aliases=aliases, item_attributes=attributes,
        item_lineage=lineage,
        production_days=build_days(days_csv),
        daily_entries=build_entries(log_csv, alias_to_key))

    ing_path = os.path.join(extract_dir, "ingredients_draft.csv")
    rec_path = os.path.join(extract_dir, "recipes_draft.csv")
    if os.path.exists(ing_path) and os.path.exists(rec_path):
        ings, prices, links = build_bom(read_csv(ing_path), read_csv(rec_path),
                                        bom_effective_from)
        seed.update(ingredients=ings, ingredient_prices=prices,
                    item_ingredients=links)
    else:
        seed.update(ingredients=[], ingredient_prices=[], item_ingredients=[])
    return seed


# ------------------------------------------------------------ reconcile ----

def workbook_truth(path):
    """Recompute per-item and per-day totals STRAIGHT from the .xlsx.

    Deliberately independent of extract_workbook.py -- a shared bug would
    otherwise reconcile perfectly against itself and prove nothing. Resolves
    columns by header text for the same reason the extractor does."""
    import openpyxl
    months = {m: i for i, m in enumerate(
        ["", "January", "February", "March", "April", "May", "June", "July",
         "August", "September", "October", "November", "December"]) if m}
    date_re = re.compile(r"^(%s) (\d{1,2})$" % "|".join(months), re.I)
    wb = openpyxl.load_workbook(path, data_only=True)

    # Accumulated per date first, so template copies can be removed AFTER the
    # signature scan identifies them. Summing straight into per_item would fold
    # the unfilled copies into every item's totals.
    per_day_item = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
    per_day, sheet_totals, signatures = {}, {}, defaultdict(list)

    for ws in wb.worksheets:
        m = date_re.match(ws.title.strip())
        if not m:
            continue
        d = datetime.date(2026, months[m.group(1).capitalize()], int(m.group(2)))
        hdr = cols = None
        for r in range(1, min(ws.max_row, 20) + 1):
            for c in range(1, min(ws.max_column, 30) + 1):
                if norm_key(ws.cell(r, c).value) == "items":
                    labels = {norm_key(ws.cell(r, cc).value): cc
                              for cc in range(1, min(ws.max_column, 30) + 1)
                              if ws.cell(r, cc).value not in (None, "")}
                    hdr, item_col = r, c
                    cols = {k: labels[v] for k, v in
                            (("made", "quantity made"), ("refill", "quantity afternoon refill"),
                             ("waste", "quantity wasted")) if v in labels}
                    break
            if hdr:
                break
        if hdr is None:
            continue

        sig, day = [], defaultdict(float)
        for r in range(hdr + 1, ws.max_row + 1):
            name = ws.cell(r, item_col).value
            key = norm_key(name)
            sig.append("|".join([str(name)] + [str(ws.cell(r, cols[k]).value)
                                               for k in sorted(cols)]))
            if not key or key in ("items", "sushi item"):
                continue
            for k, c in cols.items():
                v = ws.cell(r, c).value
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    n = float(v)
                elif isinstance(v, str):
                    mm = re.match(r"^\s*(-?\d+(?:\.\d+)?)", v)
                    n = float(mm.group(1)) if mm else None
                else:
                    n = None
                if n is not None:
                    per_day_item[d][key][k] += n
                    day[k] += n
        signatures[hashlib.md5("\n".join(sig).encode("utf-8", "replace")).hexdigest()[:12]].append(d)

        head = {}
        for r in range(1, hdr):
            for c in range(1, min(ws.max_column, 30) + 1):
                lab = norm_key(ws.cell(r, c).value)
                if lab in ("total made", "total waste", "quantity sold") and lab not in head:
                    head[lab] = ws.cell(r + 1, c).value
        per_day[d] = dict(day)
        sheet_totals[d] = head

    templates = {d for sig, ds in signatures.items() if len(ds) >= 3 for d in ds}
    per_item = defaultdict(lambda: defaultdict(float))
    for d, items in per_day_item.items():
        if d in templates:
            continue
        for key, kinds in items.items():
            for k, n in kinds.items():
                per_item[key][k] += n
    return dict(per_item=per_item, per_day=per_day, sheet_totals=sheet_totals,
                template_dates=templates)


def reconcile(seed, workbook_path, out=sys.stdout):
    """Compare what the seed will load against the workbook recomputed
    independently. Every discrepancy is printed with an explanation or is
    reported as unexplained -- never silently netted out."""
    truth = workbook_truth(workbook_path)
    real_dates = sorted(set(truth["per_day"]) - truth["template_dates"])

    seed_item = defaultdict(lambda: defaultdict(float))
    seed_days = set()
    for e in seed["daily_entries"]:
        if e["entry_type"] == "afternoon_count":
            continue
        seed_item[e["item_id_key"]][e["entry_type"]] += e["quantity"]
        seed_days.add(e["business_date"])

    # Apply the SAME declared alias map to the independently recomputed side.
    # Without this every confirmed merge (deluxe -> salmon deluxe) reads as a
    # discrepancy. The map is a reviewed input, so both sides must honour it --
    # but the merges are printed below so nothing is folded away silently.
    alias = {norm_key(a["raw_name"]): a["item_id_key"]
             for a in seed["item_aliases"]
             if norm_key(a["raw_name"]) != a["item_id_key"]}
    merged = defaultdict(lambda: defaultdict(float))
    for k, kinds in truth["per_item"].items():
        for kind, n in kinds.items():
            merged[alias.get(k, k)][kind] += n
    truth["per_item"] = merged

    w = out.write
    w("=" * 78 + "\nRECONCILIATION: seed  vs  workbook recomputed independently\n" + "=" * 78 + "\n")
    problems = []

    # --- day coverage ------------------------------------------------------
    lo, hi = real_dates[0], real_dates[-1]
    all_dates = [lo + datetime.timedelta(days=i) for i in range((hi - lo).days + 1)]
    missing = [d for d in all_dates if d.isoformat() not in seed_days]
    w("\ndate range        : %s .. %s (%d calendar days)\n" % (lo, hi, len(all_dates)))
    w("days in workbook  : %d\n" % len(real_dates))
    w("days in seed      : %d\n" % len(seed_days))
    w("excluded as template copies: %d\n" % len(truth["template_dates"]))
    if alias:
        w("\nnames merged by the reviewed alias map (applied to BOTH sides):\n")
        for raw, key in sorted(alias.items()):
            w("  %-28s -> %s\n" % (raw, key))
    if missing:
        w("\ndates in range with NO entries (%d):\n" % len(missing))
        for d in missing:
            why = "outage -- day totals recorded but every item row blank" \
                if truth["per_day"].get(d) == {} or not any(truth["per_day"].get(d, {}).values()) \
                else "UNEXPLAINED"
            w("  %s  %s\n" % (d, why))
            if why == "UNEXPLAINED":
                problems.append("no entries for %s" % d)
    else:
        w("dates in range with no entries: none\n")

    # --- per-item unit totals ---------------------------------------------
    w("\n%-30s %9s %9s %9s   %s\n" % ("item", "made", "refill", "waste", "vs workbook"))
    keys = sorted(set(seed_item) | {k for k in truth["per_item"]})
    for k in keys:
        s, t = seed_item[k], truth["per_item"].get(k, {})
        d = [(x, s.get(x, 0) - t.get(x, 0)) for x in ("made", "refill", "waste")]
        bad = [x for x, delta in d if abs(delta) > 1e-6]
        note = "ok" if not bad else "DIFFERS: " + ", ".join(
            "%s %+g" % (x, delta) for x, delta in d if abs(delta) > 1e-6)
        w("%-30s %9g %9g %9g   %s\n"
          % (k, s.get("made", 0), s.get("refill", 0), s.get("waste", 0), note))
        if bad:
            problems.append("%s: %s" % (k, note))

    # --- cross-foot against the sheet's own totals rows --------------------
    w("\ncross-foot vs the totals the sheet computes for itself:\n")
    bad_days = 0
    for d in real_dates:
        day, head = truth["per_day"][d], truth["sheet_totals"].get(d, {})
        tm, tw = head.get("total made"), head.get("total waste")
        items_made = day.get("made", 0) + day.get("refill", 0)
        if not any(day.values()) and tm:
            w("  %s  outage: sheet says made=%s waste=%s, item rows blank\n" % (d, tm, tw))
            continue
        msgs = []
        if isinstance(tm, (int, float)) and abs(tm - items_made) > 1e-6:
            msgs.append("Total Made %g vs item rows %g (diff %+g)"
                        % (tm, items_made, items_made - tm))
        if isinstance(tw, (int, float)) and abs(tw - day.get("waste", 0)) > 1e-6:
            msgs.append("Total Waste %g vs item rows %g (diff %+g)"
                        % (tw, day.get("waste", 0), day.get("waste", 0) - tw))
        if msgs:
            bad_days += 1
            w("  %s  %s\n" % (d, "; ".join(msgs)))
    w("  %d of %d days disagree with their own totals row.\n" % (bad_days, len(real_dates)))
    w("  Known cause: the sheet's Total Made formula sums the refill column only to\n"
      "  row 38 while items continue past it, and it ignores cells holding text.\n"
      "  The item rows are the primary record; the totals row is derived and wrong.\n")

    w("\n" + "-" * 78 + "\n")
    if problems:
        w("UNEXPLAINED DISCREPANCIES: %d\n" % len(problems))
        for p in problems:
            w("  - %s\n" % p)
    else:
        w("No unexplained discrepancies. Every difference above has a stated cause.\n")
    return problems


# ---------------------------------------------------------------- loader ----

UPSERTS = [
    ("items", "insert into items (item_key, display_name) values (%(item_key)s, %(display_name)s) "
              "on conflict (item_key) do update set display_name = excluded.display_name"),
    ("ingredients", "insert into ingredients (name, unit_of_measure) values (%(name)s, %(unit_of_measure)s) "
                    "on conflict (name) do update set unit_of_measure = excluded.unit_of_measure"),
]


def load(conn, seed, source_file, source_sha):
    cur = conn.cursor()
    cur.executemany(UPSERTS[0][1], seed["items"])
    if seed["ingredients"]:
        cur.executemany(UPSERTS[1][1], seed["ingredients"])

    cur.execute("select item_key, item_id from items")
    item_id = dict(cur.fetchall())
    cur.execute("select name, ingredient_id from ingredients")
    ing_id = dict(cur.fetchall())

    cur.executemany(
        "insert into item_aliases (raw_name, item_id, note) values (%(raw_name)s, %(iid)s, %(note)s) "
        "on conflict (raw_name) do nothing",
        [dict(r, iid=item_id[r["item_id_key"]]) for r in seed["item_aliases"]])
    cur.executemany(
        "insert into item_attributes (item_id, effective_from, price, unit_cost, plu_name, is_active, source) "
        "values (%(iid)s, %(effective_from)s, %(price)s, %(unit_cost)s, %(plu_name)s, %(is_active)s, %(source)s) "
        "on conflict (item_id, effective_from) do nothing",
        [dict(r, iid=item_id[r["item_id_key"]]) for r in seed["item_attributes"]])
    cur.executemany(
        "insert into item_lineage (parent_item_id, child_item_id, effective_date, kind, note) "
        "values (%(pid)s, %(cid)s, %(effective_date)s, %(kind)s, %(note)s) "
        "on conflict do nothing",
        [dict(r, pid=item_id[r["parent_key"]], cid=item_id[r["child_key"]])
         for r in seed["item_lineage"] if r["parent_key"] in item_id])
    cur.executemany(
        "insert into production_days (business_date, day_of_week, is_outage, weather, holiday_event, notes, source) "
        "values (%(business_date)s, %(day_of_week)s, %(is_outage)s, %(weather)s, %(holiday_event)s, %(notes)s, %(source)s) "
        "on conflict (business_date) do nothing", seed["production_days"])

    if seed["ingredient_prices"]:
        cur.executemany(
            "insert into ingredient_prices (ingredient_id, effective_from, pack_cost, pack_qty, source) "
            "values (%(gid)s, %(effective_from)s, %(pack_cost)s, %(pack_qty)s, %(source)s) "
            "on conflict (ingredient_id, effective_from) do nothing",
            [dict(r, gid=ing_id[r["ingredient_name"]]) for r in seed["ingredient_prices"]])
        cur.executemany(
            "insert into item_ingredients (item_id, ingredient_id, effective_from, qty_per_unit, sort_order) "
            "values (%(iid)s, %(gid)s, %(effective_from)s, %(qty_per_unit)s, %(sort_order)s) "
            "on conflict (item_id, ingredient_id, effective_from) do nothing",
            [dict(r, iid=item_id[r["item_id_key"]], gid=ing_id[r["ingredient_name"]])
             for r in seed["item_ingredients"] if r["item_id_key"] in item_id])

    cur.execute("insert into import_batches (source_file, source_sha256) values (%s, %s) "
                "returning batch_id", (source_file, source_sha))
    batch_id = cur.fetchone()[0]

    cur.executemany(
        "insert into daily_entries (business_date, item_id, entry_type, quantity, source, "
        "source_ref, value_hash, batch_id, note) "
        "values (%(business_date)s, %(iid)s, %(entry_type)s, %(quantity)s, %(source)s, "
        "%(source_ref)s, %(value_hash)s, %(batch)s, %(note)s) "
        "on conflict (source_ref, value_hash) do nothing",
        [dict(r, iid=item_id[r["item_id_key"]], batch=batch_id)
         for r in seed["daily_entries"]])

    cur.execute("update import_batches set finished_at = now(), row_count = "
                "(select count(*) from daily_entries where batch_id = %s) where batch_id = %s",
                (batch_id, batch_id))
    conn.commit()
    return batch_id


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--extract-dir", default="data")
    ap.add_argument("--database-url", default=os.environ.get("DATABASE_URL"))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--reconcile", metavar="WORKBOOK",
                    help="recompute totals from this .xlsx and compare")
    ap.add_argument("--schema", default="db/schema.sql")
    args = ap.parse_args()

    seed = build_seed(args.extract_dir)
    print("seed built from %s:" % args.extract_dir)
    for k in ("items", "item_aliases", "item_attributes", "item_lineage",
              "production_days", "daily_entries", "ingredients",
              "ingredient_prices", "item_ingredients"):
        print("  %-20s %6d rows" % (k, len(seed[k])))

    if args.reconcile:
        print()
        problems = reconcile(seed, args.reconcile)
        if problems:
            print("\nreconciliation found %d unexplained discrepancies" % len(problems))

    if args.dry_run or not args.database_url:
        if not args.dry_run:
            print("\nno --database-url and no DATABASE_URL; nothing loaded "
                  "(pass --dry-run to silence this)")
        return

    try:
        import psycopg
    except ImportError:
        sys.exit("pip install 'psycopg[binary]' to load, or use --dry-run")
    with psycopg.connect(args.database_url) as conn:
        with open(args.schema, encoding="utf-8") as fh:
            conn.execute(fh.read())
        conn.commit()
        batch = load(conn, seed, os.path.abspath(args.extract_dir),
                     hashlib.sha256(json.dumps(seed, default=str,
                                               sort_keys=True).encode()).hexdigest())
    print("\nloaded as batch %d" % batch)


if __name__ == "__main__":
    main()
