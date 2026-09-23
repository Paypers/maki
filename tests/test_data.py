"""Tests for reading the reviewed extraction.

One rule is being protected: a blank waste cell means "none left" on a day
that was counted, and means NOTHING on a day that was not. The second half is
the dangerous one -- read wrong, a forgotten count becomes a day on which
every item sold out, and every quantile that touches it moves up.
"""

from __future__ import annotations

import csv
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from analysis.data import load_observations, uncounted_dates_from  # noqa: E402

FIELDS = ["business_date", "sheet", "sheet_row", "raw_item_name", "item_key",
          "quantity_made", "quantity_afternoon", "quantity_refill",
          "quantity_wasted", "quantity_sold", "waste_blank", "demand_censored",
          "operator_note"]


def write_log(path, rows):
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        w.writeheader()
        for date, item, made, wasted in rows:
            w.writerow({"business_date": date, "item_key": item, "raw_item_name": item,
                        "quantity_made": made, "quantity_wasted": wasted,
                        "waste_blank": str(wasted == "")})


def test_blank_cell_on_a_counted_day_is_a_sold_out_zero(tmp_path):
    p = tmp_path / "log.csv"
    write_log(p, [("2026-06-01", "a", "4", "1"),
                  ("2026-06-01", "b", "3", "")])      # b: blank, but a was counted
    obs = {o.item_key: o for o in load_observations(str(p))}
    assert obs["b"].wasted == 0.0
    assert obs["b"].censored
    assert obs["b"].sold == 3.0


def test_a_day_with_no_waste_written_anywhere_is_dropped(tmp_path):
    # Every cell blank: the count was never done. Not one observation may
    # come out of it -- least of all thirty "sold out" ones.
    p = tmp_path / "log.csv"
    write_log(p, [("2026-06-01", "a", "4", "1"),
                  ("2026-06-02", "a", "6", ""),
                  ("2026-06-02", "b", "5", "")])
    obs = load_observations(str(p))
    assert {o.date for o in obs} == {"2026-06-01"}
    assert uncounted_dates_from(str(p)) == frozenset({"2026-06-02"})


def test_a_single_recorded_zero_makes_the_day_counted(tmp_path):
    # "0" written in a cell is an act of counting, unlike a blank.
    p = tmp_path / "log.csv"
    write_log(p, [("2026-06-02", "a", "6", "0"),
                  ("2026-06-02", "b", "5", "")])
    obs = load_observations(str(p))
    assert len(obs) == 2
    assert uncounted_dates_from(str(p)) == frozenset()


def test_an_outage_is_not_reported_as_uncounted(tmp_path):
    # Nothing made and nothing counted is a closed day, which is a different
    # fact and already handled; it must not be double-reported here.
    p = tmp_path / "log.csv"
    write_log(p, [("2026-06-03", "a", "", "")])
    assert uncounted_dates_from(str(p)) == frozenset()
    assert load_observations(str(p)) == []
