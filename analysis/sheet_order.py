"""The order the operator's prep sheet lists items in.

Alphabetical was never right. The operator reads down a case arranged the way
the workbook lists it, so any other order makes them hunt for every line. This
is the one place that order is written down; the app's seed, the printed prep
sheet and the daily prediction all take it from here.

The file lives in data/ with everything else that names real items, so it
stays out of version control. When it is absent -- a fresh clone, or a
different operator -- callers fall back to alphabetical, which is wrong but
harmless, rather than failing to start.
"""

from __future__ import annotations

import os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PATH = os.path.join(HERE, "data", "sheet_order.txt")


def load_sheet_order(path: str | None = None) -> list[str]:
    """Item keys in sheet order. Empty when the file is not there."""
    path = path or DEFAULT_PATH
    if not os.path.exists(path):
        return []
    out: list[str] = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.split("#", 1)[0].strip()
            if line:
                out.append(line)
    return out


def load_sheet_groups(path: str | None = None) -> list[list[str]]:
    """The same list, split at the sheet's own blank-line group breaks."""
    path = path or DEFAULT_PATH
    if not os.path.exists(path):
        return []
    groups: list[list[str]] = []
    current: list[str] = []
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.split("#", 1)[0].strip()
            if not line:
                if current:
                    groups.append(current)
                    current = []
                continue
            current.append(line)
    if current:
        groups.append(current)
    return groups


def sort_key(order: list[str]):
    """A sort key that puts known items in sheet order and the rest after.

    Unknown items sort alphabetically at the end rather than at position zero.
    A new item on the menu is a thing to notice, not a thing to hide at the
    top of the list.
    """
    rank = {k: i for i, k in enumerate(order)}
    return lambda key: (rank.get(key, len(rank)), key)
