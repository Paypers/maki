"""The sheet importer, when a day it already has comes back different.

Sep 20 and 21 were first imported from placeholder sheets (a stock "made"
column, no count), then re-sent filled in. The importer used to skip any date
it already had -- so the corrected days were silently dropped and the
placeholders stayed. What is protected here: a changed day is never skipped
quietly and never overwritten unasked; only the named days change; everything
else in the file is left byte for byte.
"""

from __future__ import annotations

import csv
import importlib.util
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location(
    "import_pdf_days", os.path.join(ROOT, "tools", "import_pdf_days.py"))
imp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(imp)

LOG_FIELDS = ["business_date", "sheet", "sheet_row", "raw_item_name", "item_key",
              "quantity_made", "quantity_afternoon", "quantity_refill", "quantity_wasted",
              "quantity_sold", "waste_blank", "demand_censored", "operator_note"]


def source(tmp_path, days: str) -> str:
    p = tmp_path / "sheets.txt"
    p.write_text("ITEMS\na\nb\nEND\n\n" + days, encoding="utf-8")
    return str(p)


@pytest.fixture
def record(tmp_path, monkeypatch):
    """A record holding two days: Sep 1 counted, Sep 2 a placeholder."""
    log, summ = tmp_path / "daily_log.csv", tmp_path / "day_summary.csv"
    items, days = imp.parse(source(tmp_path,
        "DAY 2026-09-01 5 2 3 30\n3/1 2/1\n\nDAY 2026-09-02 4 0 4 40\n2/. 2/.\n"))
    assert not imp.validate(items, days)
    for path, fields in ((log, LOG_FIELDS), (summ, list(imp.summary_rows(items, days)[0]))):
        with open(path, "w", encoding="utf-8", newline="") as fh:
            csv.DictWriter(fh, fieldnames=fields).writeheader()
    imp.append(str(log), imp.log_rows(items, days))
    imp.append(str(summ), imp.summary_rows(items, days))
    monkeypatch.setattr(imp, "DAILY_LOG", str(log))
    monkeypatch.setattr(imp, "DAY_SUMMARY", str(summ))
    return log, summ


def run(monkeypatch, *argv) -> int:
    monkeypatch.setattr(sys, "argv", ["import_pdf_days.py", *argv])
    return imp.main()


# Sep 2 re-sent, properly filled in: 6 made, 2 left over.
FIXED = "DAY 2026-09-01 5 2 3 30\n3/1 2/1\n\nDAY 2026-09-02 6 2 4 40\n4/1 2/1\n"


def test_identical_days_are_skipped_quietly(tmp_path, monkeypatch, record):
    before = record[0].read_bytes()
    src = source(tmp_path, "DAY 2026-09-01 5 2 3 30\n3/1 2/1\n")
    assert run(monkeypatch, src, "--write") == 0
    assert record[0].read_bytes() == before


def test_a_changed_day_blocks_the_write_until_named(tmp_path, monkeypatch, record, capsys):
    before = record[0].read_bytes()
    assert run(monkeypatch, source(tmp_path, FIXED), "--write") == 1
    out = capsys.readouterr().out
    assert "2026-09-02 differs" in out and "a: made 2 -> 4, left blank -> 1" in out
    assert record[0].read_bytes() == before          # nothing written


def test_replace_swaps_only_the_named_day(tmp_path, monkeypatch, record):
    assert run(monkeypatch, source(tmp_path, FIXED), "--write",
               "--replace", "2026-09-02") == 0
    got = imp.recorded_cells(str(record[0]))
    assert got[("2026-09-02", "a")] == (4.0, 1.0)
    assert got[("2026-09-01", "a")] == (3.0, 1.0)    # untouched
    with open(record[0], encoding="utf-8") as fh:
        dates = [r["business_date"] for r in csv.DictReader(fh)]
    assert dates.count("2026-09-02") == 2            # replaced, not duplicated
    # And the day is no longer flagged uncounted in the summary.
    with open(record[1], encoding="utf-8") as fh:
        sep2 = [r for r in csv.DictReader(fh) if r["business_date"] == "2026-09-02"]
    assert len(sep2) == 1 and sep2[0]["items_wasted"] == "2"


def test_replace_refuses_a_date_it_cannot_match(tmp_path, monkeypatch, record):
    assert run(monkeypatch, source(tmp_path, FIXED), "--write",
               "--replace", "2026-09-09") == 1


def test_drop_dates_leaves_every_other_row_byte_identical(record):
    log = record[0]
    lines = log.read_bytes().splitlines(keepends=True)
    imp.drop_dates(str(log), {"2026-09-02"})
    kept = log.read_bytes().splitlines(keepends=True)
    assert kept == [l for l in lines if b"2026-09-02" not in l]
