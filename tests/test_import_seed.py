"""Tests for the seed pipeline: workbook -> reviewable CSV -> table rows.

Runs entirely against tests/fixtures/fixture.xlsx (anonymised, committed). No
database and no network: the transform is pure, and that is where the bugs that
would silently corrupt the seed actually live.

    pip install pytest openpyxl
    pytest tests/ -q
"""

import io
import os
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

import import_seed  # noqa: E402

FIXTURE = os.path.join(ROOT, "tests", "fixtures", "fixture.xlsx")


@pytest.fixture(scope="module")
def extracted(tmp_path_factory):
    """Run the real extractor over the fixture, exactly as in production."""
    if not os.path.exists(FIXTURE):
        subprocess.run([sys.executable,
                        os.path.join(ROOT, "tests", "fixtures", "make_fixture.py")],
                       check=True)
    out = tmp_path_factory.mktemp("extract")
    subprocess.run([sys.executable, os.path.join(ROOT, "tools", "extract_workbook.py"),
                    FIXTURE, "--out", str(out)], check=True, capture_output=True)
    return str(out)


@pytest.fixture(scope="module")
def seed(extracted):
    return import_seed.build_seed(extracted)


# ------------------------------------------------------- structural parsing --

def test_template_copies_are_excluded(seed):
    """May 13-15 are byte-identical unfilled copies and must not become days."""
    dates = {d["business_date"] for d in seed["production_days"]}
    assert {"2026-05-08", "2026-05-09", "2026-05-10", "2026-05-11", "2026-05-12"} <= dates
    assert not ({"2026-05-13", "2026-05-14", "2026-05-15"} & dates)


def test_shifted_layout_still_parses(seed):
    """May 11 has its whole block one column right. Resolving columns by header
    name must find it; an index-based parser would read garbage."""
    made = [e for e in seed["daily_entries"]
            if e["business_date"] == "2026-05-11" and e["entry_type"] == "made"]
    assert sum(e["quantity"] for e in made) == 3 * 4 + 3   # four items + appended


def test_text_in_numeric_column_is_recovered(seed):
    """'2 [out by 12pm]' is a real quantity plus a note, not a parse failure."""
    hits = [e for e in seed["daily_entries"]
            if e["business_date"] == "2026-05-10" and e["entry_type"] == "refill"]
    assert any(e["quantity"] == 2 and e["note"] and "out by 12pm" in e["note"]
               for e in hits)


def test_trailing_space_does_not_create_a_second_item(seed):
    keys = [i["item_key"] for i in seed["items"]]
    assert keys.count("item gamma") == 1
    assert "item gamma " not in keys
    assert any(a["raw_name"] == "item gamma" and a["item_id_key"] == "item gamma"
               for a in seed["item_aliases"])


def test_appended_row_below_the_table_is_captured(seed):
    """The operator's totals formula misses these rows; the importer must not."""
    assert any(i["item_key"] == "item epsilon" for i in seed["items"])


def test_outage_day_is_flagged_and_has_no_entries(seed):
    day = [d for d in seed["production_days"] if d["business_date"] == "2026-05-12"]
    assert day and day[0]["is_outage"] is True
    assert not [e for e in seed["daily_entries"] if e["business_date"] == "2026-05-12"]


def test_blank_cells_do_not_become_zero_observations(seed):
    """Absence is not zero. A blank waste cell yields no waste row at all --
    downstream code infers 'sold out' from the missing row, and inventing zeros
    here would fabricate observations that were never made."""
    made = {e["business_date"] + e["item_id_key"]
            for e in seed["daily_entries"] if e["entry_type"] == "made"}
    waste = {e["business_date"] + e["item_id_key"]
             for e in seed["daily_entries"] if e["entry_type"] == "waste"}
    assert waste < made


# ---------------------------------------------------------------- identity --

def test_no_item_is_keyed_on_a_raw_name(seed):
    for i in seed["items"]:
        assert i["item_key"] == i["item_key"].strip().lower()


def test_every_entry_resolves_to_a_known_item(seed):
    keys = {i["item_key"] for i in seed["items"]}
    assert {e["item_id_key"] for e in seed["daily_entries"]} <= keys


def test_attributes_are_effective_dated(seed):
    assert all("effective_from" in a and a["effective_from"]
               for a in seed["item_attributes"])
    pairs = [(a["item_id_key"], a["effective_from"]) for a in seed["item_attributes"]]
    assert len(pairs) == len(set(pairs)), "overlapping attribute rows"


# ------------------------------------------------------------ idempotency ---

def test_build_is_deterministic(extracted):
    """Re-running the transform must produce byte-identical rows, or the
    (source_ref, value_hash) conflict key stops protecting against duplicates."""
    a, b = import_seed.build_seed(extracted), import_seed.build_seed(extracted)
    assert a == b


def test_entry_conflict_keys_are_unique(seed):
    keys = [(e["source_ref"], e["value_hash"]) for e in seed["daily_entries"]]
    assert len(keys) == len(set(keys))


def test_value_hash_changes_when_the_quantity_changes():
    a = import_seed.value_hash("2026-05-08", "item alpha", "made", 4)
    b = import_seed.value_hash("2026-05-08", "item alpha", "made", 5)
    assert a != b, "a corrected quantity must not collide with the original"


def test_source_ref_identifies_one_cell(seed):
    e = seed["daily_entries"][0]
    assert "!" in e["source_ref"] and e["source_ref"].endswith(e["entry_type"])


# ---------------------------------------------------------- reconciliation --

def test_reconcile_reports_no_unexplained_discrepancies(seed):
    buf = io.StringIO()
    problems = import_seed.reconcile(seed, FIXTURE, out=buf)
    assert problems == [], buf.getvalue()


def test_reconcile_recomputes_independently_and_catches_corruption(seed):
    """Drop an observation from the seed; reconciliation must notice. This is the
    check that would catch a silent parser regression."""
    broken = dict(seed, daily_entries=[
        e for e in seed["daily_entries"]
        if not (e["item_id_key"] == "item alpha" and e["entry_type"] == "made")])
    problems = import_seed.reconcile(broken, FIXTURE, out=io.StringIO())
    assert any("item alpha" in p for p in problems)


def test_reconcile_detects_the_sheets_own_totals_being_wrong(seed):
    """The fixture's totals formula stops short of the appended row, so the
    sheet disagrees with its own item rows -- as the real workbook does on 16
    days. Reconciliation must surface that without calling it a seed error."""
    buf = io.StringIO()
    import_seed.reconcile(seed, FIXTURE, out=buf)
    text = buf.getvalue()
    assert "disagree with their own totals row" in text
    assert "0 of" not in text.split("disagree with their own totals row")[0][-12:]
