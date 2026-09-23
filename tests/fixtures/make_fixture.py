"""Build tests/fixtures/fixture.xlsx -- a small ANONYMISED workbook.

No real item names, no real quantities, no real revenue. It reproduces the
structural hazards found in the operator's file so the parser is tested against
them rather than against a tidy sheet:

  * date-named tabs, mixed month/day widths
  * a day whose whole header block is shifted one column right (July 15)
  * text mixed into a numeric column ('4 [out by 12pm]')
  * an item name with a trailing space
  * an appended item row below the bordered table, outside the total's range
  * a totals row whose formula range stops short, so it disagrees with the items
  * an outage day: day totals present, every item row blank
  * three identical unfilled template copies
  * blank waste cells meaning zero (the censoring signal)

    python tests/fixtures/make_fixture.py
"""

import os
import openpyxl

ITEMS = ["item alpha", "item beta", "item gamma", "item delta"]
HERE = os.path.dirname(os.path.abspath(__file__))


def day_sheet(wb, title, made, waste, refill=None, shift=0, blank_rows=False,
              totals_override=None, weather=None, trailing_space_on=None):
    """shift=1 moves the whole block one column right, as July 15 does."""
    ws = wb.create_sheet(title)
    c0 = 2 + shift                       # item column
    ws.cell(1, c0, "Holiday/Event:")
    ws.cell(2, c0, "Prep & Waste Log")
    for i, lab in enumerate(["Date", "Day of Week", "Weather", "Total Made",
                             "Total Waste", "Quantity Sold"]):
        ws.cell(3, c0 + i, lab)
    ws.cell(4, c0, title)
    ws.cell(4, c0 + 2, weather)

    for i, lab in enumerate(["Items", "Quantity Made", "Quantity in Afternoon",
                             "Quantity Afternoon Refill", "Quantity Wasted"]):
        ws.cell(5, c0 + i, lab)

    row = 6
    for idx, name in enumerate(ITEMS):
        label = name + " " if trailing_space_on == name else name
        ws.cell(row, c0, label)
        if not blank_rows:
            ws.cell(row, c0 + 1, made[idx])
            if refill and refill[idx] is not None:
                ws.cell(row, c0 + 3, refill[idx])
            # A blank waste cell means zero waste -- the item sold out.
            if waste[idx]:
                ws.cell(row, c0 + 4, waste[idx])
        row += 2 if idx == 1 else 1      # a category gap, as the real sheet has

    appended = row + 1                   # below the bordered table
    ws.cell(appended, c0, "item epsilon")
    if not blank_rows:
        ws.cell(appended, c0 + 1, 3)
        ws.cell(appended, c0 + 3, 2)     # a refill the totals formula will miss

    ws.merge_cells(start_row=2, start_column=c0, end_row=2, end_column=c0 + 4)
    ws._fixture = (c0, appended, totals_override)
    return ws


def write_totals(ws):
    """Write the totals row as LITERAL values, the way a reader sees them.

    The real workbook is a Google Sheets export: openpyxl reads cached results,
    not live formulas. Writing formulas here would leave those cells empty on
    read and the fixture would never exercise the cross-foot path. The numbers
    reproduce the operator's actual bug -- the refill range stops above the
    appended row, and SUM ignores cells holding text."""
    c0, appended, override = ws._fixture
    if override:
        made_total, waste_total = override
    else:
        num = lambda v: v if isinstance(v, (int, float)) else 0
        made_total = sum(num(ws.cell(r, c0 + 1).value) for r in range(6, appended + 1))
        made_total += sum(num(ws.cell(r, c0 + 3).value) for r in range(6, appended))
        waste_total = sum(num(ws.cell(r, c0 + 4).value) for r in range(6, appended + 1))
    ws.cell(4, c0 + 3, made_total)
    ws.cell(4, c0 + 4, waste_total)
    ws.cell(4, c0 + 5, made_total - waste_total)


def build(path):
    wb = openpyxl.Workbook()
    wb.remove(wb.active)

    # Two ordinary days. Zero waste on some items = sold out = censored demand.
    day_sheet(wb, "May 8", [4, 3, 2, 5], [1, 0, 0, 2], weather="Sunny")
    day_sheet(wb, "May 9", [5, 3, 3, 4], [0, 1, 0, 0])

    # Text mixed into the refill column, plus a trailing space on a name.
    ws = day_sheet(wb, "May 10", [4, 4, 2, 4], [2, 0, 1, 0],
                   trailing_space_on="item gamma")
    ws.cell(6, 5, "2 [out by 12pm]")

    # Whole block shifted one column right.
    day_sheet(wb, "May 11", [3, 3, 3, 3], [1, 1, 0, 0], shift=1)

    # Outage: totals typed in, every item row blank.
    day_sheet(wb, "May 12", [0, 0, 0, 0], [0, 0, 0, 0], blank_rows=True,
              totals_override=(12, 6), weather="Display case issue")

    # Three identical unfilled template copies.
    for t in ("May 13", "May 14", "May 15"):
        day_sheet(wb, t, [2, 2, 2, 2], [0, 0, 0, 0])

    for ws in wb.worksheets:
        if hasattr(ws, "_fixture"):
            write_totals(ws)

    wb.create_sheet("Sheet9")            # a stray empty tab
    wb.save(path)
    return path


if __name__ == "__main__":
    print("wrote", build(os.path.join(HERE, "fixture.xlsx")))
