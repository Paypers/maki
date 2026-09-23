"""Draft ingredient costs and per-item recipes, for the operator to correct.

Every number here is MY ESTIMATE, not measured. The point is to give you rows to
edit rather than a blank form. Correct the two CSVs this writes; they become the
Phase 1 Step 4 seed for the `ingredients`, `ingredient_prices` and
`item_ingredients` tables.

    python tools/seed_recipes.py --out data/

Cost model: pack_cost / pack_qty = cost per unit_of_measure. A recipe line is
(item, ingredient, qty in that unit). Per-item cost is the sum. Because unsold
product is discarded with no salvage, c_o = cost and c_u = price - cost, so the
newsvendor critical ratio collapses to the gross margin ratio, 1 - cost/price.
"""

import argparse
import csv
import os

# name, unit, pack_cost, pack_qty (in units), note
INGREDIENTS = [
    ("sushi rice (dry)",      "g",     1.80,  454,  "$/lb dry; ~2.5x cooked yield"),
    ("nori sheet",            "sheet", 6.00,   50,  "50-sheet pack"),
    ("salmon (sushi grade)",  "g",     9.50,  454,  "$/lb"),
    ("tuna (yellowfin saku)", "g",    12.00,  454,  "$/lb"),
    ("imitation crab",        "g",     3.20,  454,  "$/lb"),
    ("lobster salad",         "g",    14.00,  454,  "$/lb"),
    ("cooked shrimp",         "g",     8.00,  454,  "$/lb"),
    ("shrimp tempura piece",  "each",  0.55,    1,  "frozen breaded, per piece"),
    ("eel (unagi, cooked)",   "g",    14.00,  454,  "$/lb"),
    ("avocado",               "each",  0.55,    1,  ""),
    ("cucumber",              "each",  0.60,    1,  ""),
    ("cream cheese",          "g",     3.20,  454,  "$/lb"),
    ("masago",                "g",     9.00,  454,  "$/lb"),
    ("tempura crunch",        "g",     4.50,  454,  "$/lb"),
    ("spicy mayo",            "g",     4.00,  454,  "$/lb"),
    ("eel sauce",             "g",     4.50,  454,  "$/lb"),
    ("sesame seeds",          "g",     5.00,  454,  "$/lb"),
    ("inari pocket",          "each",  0.28,    1,  ""),
    ("salad base (poke)",     "g",     3.00,  454,  "$/lb greens + toppings"),
    ("container S15",         "each",  0.22,    1,  ""),
    ("container S20",         "each",  0.28,    1,  ""),
    ("container S25",         "each",  0.34,    1,  ""),
    ("container bowl",        "each",  0.45,    1,  ""),
    ("condiment set",         "each",  0.09,    1,  "soy + wasabi + ginger"),
]

RICE, NORI = ("sushi rice (dry)", 60), ("nori sheet", 1)
S15, S20, S25, BOWL = "container S15", "container S20", "container S25", "container bowl"
COND = ("condiment set", 1)

# item_key -> list of (ingredient, qty)
RECIPES = {
    "cali roll":        [RICE, NORI, ("imitation crab", 40), ("avocado", .4), ("cucumber", .25), ("sesame seeds", 2), (S15, 1), COND],
    "cali large":       [("sushi rice (dry)", 95), NORI, ("imitation crab", 65), ("avocado", .6), ("cucumber", .35), ("sesame seeds", 3), (S15, 1), COND],
    "cali roll large":  [("sushi rice (dry)", 95), NORI, ("imitation crab", 65), ("avocado", .6), ("cucumber", .35), ("sesame seeds", 3), (S15, 1), COND],
    "spicy cali":       [RICE, NORI, ("imitation crab", 40), ("spicy mayo", 12), ("cucumber", .25), ("sesame seeds", 2), (S15, 1), COND],
    "spicy crab":       [RICE, NORI, ("imitation crab", 45), ("spicy mayo", 14), ("tempura crunch", 6), (S15, 1), COND],
    "spicy tuna":       [RICE, NORI, ("tuna (yellowfin saku)", 45), ("spicy mayo", 12), (S15, 1), COND],
    "crunchy spicy tuna": [RICE, NORI, ("tuna (yellowfin saku)", 45), ("spicy mayo", 12), ("tempura crunch", 8), (S15, 1), COND],
    "salmon avocado":   [RICE, NORI, ("salmon (sushi grade)", 55), ("avocado", .5), (S15, 1), COND],
    "tuna avocado":     [RICE, NORI, ("tuna (yellowfin saku)", 55), ("avocado", .5), (S15, 1), COND],
    "philly roll":      [RICE, NORI, ("salmon (sushi grade)", 45), ("cream cheese", 25), ("cucumber", .2), (S15, 1), COND],
    "vegetable roll":   [RICE, NORI, ("avocado", .5), ("cucumber", .5), ("sesame seeds", 2), (S15, 1), COND],
    "avocado roll":     [RICE, NORI, ("avocado", .9), ("sesame seeds", 2), (S15, 1), COND],
    "lobster roll":     [RICE, NORI, ("lobster salad", 50), ("cucumber", .2), (S15, 1), COND],
    "shrimp tempura roll":       [RICE, NORI, ("shrimp tempura piece", 2), ("avocado", .3), ("eel sauce", 10), (S15, 1), COND],
    "spicy shrimp tempura roll": [RICE, NORI, ("shrimp tempura piece", 2), ("spicy mayo", 12), ("tempura crunch", 6), (S15, 1), COND],
    "tornado shrimp tempura roll": [RICE, NORI, ("shrimp tempura piece", 2), ("avocado", .4), ("eel sauce", 10), ("tempura crunch", 6), (S15, 1), COND],
    "shrimp tempura side": [("shrimp tempura piece", 4), ("eel sauce", 10), (S15, 1)],
    "dragon roll":      [RICE, NORI, ("shrimp tempura piece", 2), ("eel (unagi, cooked)", 40), ("avocado", .7), ("eel sauce", 12), (S20, 1), COND],
    "rainbow roll":     [RICE, NORI, ("imitation crab", 35), ("avocado", .5), ("salmon (sushi grade)", 30), ("tuna (yellowfin saku)", 30), (S20, 1), COND],
    "rainbow roll tuna":   [RICE, NORI, ("imitation crab", 35), ("avocado", .5), ("tuna (yellowfin saku)", 55), (S20, 1), COND],
    "rainbow roll salmon": [RICE, NORI, ("imitation crab", 35), ("avocado", .5), ("salmon (sushi grade)", 55), (S20, 1), COND],
    "spicy tuna volcano":  [RICE, NORI, ("tuna (yellowfin saku)", 45), ("spicy mayo", 20), ("tempura crunch", 8), ("masago", 8), (S15, 1), COND],
    "spicy crab volcano":  [RICE, NORI, ("imitation crab", 45), ("spicy mayo", 20), ("tempura crunch", 8), ("masago", 8), (S15, 1), COND],
    "crunchy spicy crab volcano": [RICE, NORI, ("imitation crab", 45), ("spicy mayo", 20), ("tempura crunch", 14), ("masago", 8), (S15, 1), COND],
    "lobster volcano":     [RICE, NORI, ("lobster salad", 50), ("spicy mayo", 16), ("tempura crunch", 8), (S15, 1), COND],
    "crunchy lobster volcano": [RICE, NORI, ("lobster salad", 50), ("spicy mayo", 16), ("tempura crunch", 14), (S15, 1), COND],
    "tri volcano":      [("sushi rice (dry)", 150), ("nori sheet", 3), ("tuna (yellowfin saku)", 40), ("imitation crab", 40), ("lobster salad", 40), ("spicy mayo", 24), ("tempura crunch", 12), (S25, 1), COND],
    "lobster tuna sandwich": [("sushi rice (dry)", 80), NORI, ("lobster salad", 45), ("tuna (yellowfin saku)", 45), ("avocado", .4), (S20, 1), COND],
    "lobster inari":    [("sushi rice (dry)", 45), ("inari pocket", 3), ("lobster salad", 35), (S15, 1), COND],
    "spicy crab inari": [("sushi rice (dry)", 45), ("inari pocket", 3), ("imitation crab", 35), ("spicy mayo", 10), (S15, 1), COND],
    "spicy tuna inari": [("sushi rice (dry)", 45), ("inari pocket", 3), ("tuna (yellowfin saku)", 35), ("spicy mayo", 10), (S15, 1), COND],
    "sashimi":          [("salmon (sushi grade)", 85), ("tuna (yellowfin saku)", 85), (S15, 1), COND],
    "sashimi salmon":   [("salmon (sushi grade)", 170), (S15, 1), COND],
    "sashimi red":      [("tuna (yellowfin saku)", 170), (S15, 1), COND],
    "nigiri (6pc)":     [("sushi rice (dry)", 55), ("salmon (sushi grade)", 45), ("tuna (yellowfin saku)", 45), (S15, 1), COND],
    "nigiri (6pc) raw": [("sushi rice (dry)", 55), ("salmon (sushi grade)", 45), ("tuna (yellowfin saku)", 45), (S15, 1), COND],
    "nigiri (6pc) assorted": [("sushi rice (dry)", 55), ("salmon (sushi grade)", 30), ("cooked shrimp", 30), ("eel (unagi, cooked)", 30), (S15, 1), COND],
    "tuna tataki":      [("tuna (yellowfin saku)", 115), ("eel sauce", 12), ("sesame seeds", 3), (S15, 1), COND],
    "tuna tataki roll": [RICE, NORI, ("tuna (yellowfin saku)", 60), ("avocado", .4), ("eel sauce", 10), (S15, 1), COND],
    "poke":             [("sushi rice (dry)", 70), ("salad base (poke)", 90), ("salmon (sushi grade)", 70), ("avocado", .5), ("spicy mayo", 15), (BOWL, 1), COND],
    "salmon deluxe":    [("sushi rice (dry)", 110), ("nori sheet", 2), ("salmon (sushi grade)", 110), ("avocado", .7), ("cream cheese", 20), (S25, 1), COND],
    "delight roll combo": [("sushi rice (dry)", 150), ("nori sheet", 3), ("imitation crab", 40), ("salmon (sushi grade)", 40), ("tuna (yellowfin saku)", 40), ("avocado", .9), (S25, 1), COND],
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data")
    ap.add_argument("--items", default="data/items.csv",
                    help="items.csv from extract_workbook.py, for the cost report")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    unit_cost = {}
    ing_rows = []
    for name, unit, pack_cost, pack_qty, note in INGREDIENTS:
        unit_cost[name] = pack_cost / pack_qty
        ing_rows.append(dict(ingredient=name, unit_of_measure=unit,
                             pack_cost=pack_cost, pack_qty=pack_qty,
                             cost_per_unit=round(pack_cost / pack_qty, 6),
                             confidence="GUESS -- correct me", note=note))

    rec_rows = []
    for item in sorted(RECIPES):
        for ing, qty in RECIPES[item]:
            rec_rows.append(dict(item_key=item, ingredient=ing, qty_per_unit=qty,
                                 line_cost=round(qty * unit_cost[ing], 4),
                                 confidence="GUESS -- correct me"))

    def dump(name, rows):
        path = os.path.join(args.out, name)
        with open(path, "w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)
        return path, len(rows)

    print("wrote %s (%d rows)" % dump("ingredients_draft.csv", ing_rows))
    print("wrote %s (%d rows)" % dump("recipes_draft.csv", rec_rows))

    cost = {i: sum(q * unit_cost[n] for n, q in RECIPES[i]) for i in RECIPES}

    prices = {}
    try:
        for r in csv.DictReader(open(args.items)):
            if r["proposed_price"]:
                prices[r["item_key"]] = float(r["proposed_price"])
    except FileNotFoundError:
        pass

    print("\nDRAFT per-item economics.  With no salvage, critical ratio = 1 - cost/price.")
    print("%-28s %7s %7s %7s   %6s  %6s" %
          ("item", "price", "cost", "margin", "CR", "CR wed"))
    for i in sorted(RECIPES, key=lambda i: -cost[i]):
        p = prices.get(i)
        if not p:
            print("%-28s %7s %7.2f" % (i, "?", cost[i]))
            continue
        cr = 1 - cost[i] / p
        crw = 1 - cost[i] / (p * 2 / 3)
        print("%-28s %7.2f %7.2f %7.2f   %6.3f  %6.3f"
              % (i, p, cost[i], p - cost[i], cr, crw))
    flat = sum(cost.values()) / len(cost)
    print("\nunweighted mean drafted cost: $%.2f  (workbook assumes a flat $2.75)" % flat)


if __name__ == "__main__":
    main()
