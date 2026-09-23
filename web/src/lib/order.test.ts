/**
 * Display order, and the line between presentation and identity.
 *
 * The operator asked for the item list to read the way their prep sheet
 * does, in the sheet's own blocks. The naive fix -- sort the seed before
 * assigning ids -- would have re-labelled every entry ever recorded, because
 * an entry references an itemId and nothing else. So these tests are mostly
 * about what must NOT move.
 *
 * They call planSeedOrder, the pure half of applySeedOrder, so what is tested
 * is the code that runs -- not a restatement of it.
 */

import { describe, expect, it } from "vitest";
import { applySeedOrder, planSeedOrder } from "./store";
import type { Item } from "./types";

const item = (itemId: number, itemKey: string, sortOrder: number,
              sheetGroup?: number): Item => ({
  itemId, itemKey, displayName: itemKey, price: 10, unitCost: 2.75,
  sortOrder, sheetGroup, active: true,
});

describe("planSeedOrder", () => {
  const seed = [
    item(30, "sashimi salmon", 0, 0),
    item(29, "sashimi red", 1, 0),
    item(8, "poke", 2, 1),
  ];

  it("moves sortOrder to match the seed", () => {
    const existing = [item(8, "poke", 0), item(29, "sashimi red", 1),
                      item(30, "sashimi salmon", 2)];
    const out = planSeedOrder(seed, existing);
    const byOrder = [...out].sort((a, b) => a.sortOrder - b.sortOrder);
    expect(byOrder.map((i) => i.itemKey))
      .toEqual(["sashimi salmon", "sashimi red", "poke"]);
  });

  it("reads the seed's sortOrder FIELD, not its array position", () => {
    // The exporter emits items alphabetically and carries the real order in
    // sortOrder. Ranking by position re-applied alphabetical, silently.
    const alphabetical = [item(8, "poke", 2), item(29, "sashimi red", 1),
                          item(30, "sashimi salmon", 0)];
    const out = planSeedOrder(alphabetical, [item(8, "poke", 0)]);
    expect(out[0].sortOrder).toBe(2);
  });

  it("never touches itemId", () => {
    // The whole hazard. Every entry ever written points at an itemId; move
    // one and the trading record silently means something else.
    const existing = [item(8, "poke", 0), item(29, "sashimi red", 1),
                      item(30, "sashimi salmon", 2), item(50, "tuna tataki", 3)];
    const out = planSeedOrder(seed, existing);
    for (const before of existing) {
      const after = out.find((i) => i.itemKey === before.itemKey)!;
      expect(after.itemId).toBe(before.itemId);
    }
  });

  it("matches on itemKey, not on id", () => {
    const out = planSeedOrder(seed, [item(99, "poke", 7)]);
    expect(out[0].sortOrder).toBe(2);
    expect(out[0].itemId).toBe(99);
  });

  it("copies the sheet block onto existing items", () => {
    const out = planSeedOrder(seed, [item(8, "poke", 0), item(30, "sashimi salmon", 5)]);
    expect(out.find((i) => i.itemKey === "poke")!.sheetGroup).toBe(1);
    expect(out.find((i) => i.itemKey === "sashimi salmon")!.sheetGroup).toBe(0);
  });

  it("puts an item the seed has never heard of AFTER the seeded ones", () => {
    // An archived history item, or something added by hand. Sorting it to
    // zero would bury a new item at the top of the production sheet.
    const out = planSeedOrder(seed, [item(50, "tuna tataki", 4), item(8, "poke", 0)]);
    const tataki = out.find((i) => i.itemKey === "tuna tataki")!;
    const poke = out.find((i) => i.itemKey === "poke")!;
    expect(tataki.sortOrder).toBeGreaterThan(poke.sortOrder);
    expect(tataki.sortOrder).toBeGreaterThanOrEqual(seed.length);
    expect(tataki.sheetGroup).toBeUndefined();   // drawn in the trailing block
  });

  it("keeps unlisted items in their own relative order", () => {
    const out = planSeedOrder(seed, [item(50, "b", 5), item(51, "a", 2)]);
    const a = out.find((i) => i.itemKey === "a")!;
    const b = out.find((i) => i.itemKey === "b")!;
    expect(a.sortOrder).toBeLessThan(b.sortOrder);   // 2 < 5, preserved
  });

  it("is a no-op when order and blocks already match", () => {
    const existing = seed.map((i) => ({ ...i }));
    expect(planSeedOrder(seed, existing)).toEqual(existing);
  });

  it("applySeedOrder is exported and callable", () => {
    expect(typeof applySeedOrder).toBe("function");
  });
});
