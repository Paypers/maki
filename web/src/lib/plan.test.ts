/**
 * The plan ahead.
 *
 * What is protected: an estimate is exactly the rule's number for that day on
 * what is counted now (never a separate model that could disagree with Make);
 * where the rule has no opinion your usual amount stands in and is marked so;
 * closed days plan nothing; and the drift figure the screen quotes is only
 * quoted on enough days, and moves when demand does.
 */

import { describe, expect, it } from "vitest";
import { addDays } from "./businessDay";
import { recommendFor, toObservations } from "./model";
import type { PlanContext } from "./plan";
import { DRIFT_MIN_ITEMS, planAhead, planDay, planDrift } from "./plan";
import type { Entry, Item } from "./types";
import { DEFAULT_SETTINGS } from "./types";

const TODAY = "2026-09-24";
const ROLL: Item = {
  itemId: 1, itemKey: "roll", displayName: "roll", price: 8.99, unitCost: 2.03,
  sortOrder: 0, active: true,
};
/** On the menu, but no recipe yet: the rule cannot price it. */
const NO_RECIPE: Item = {
  itemId: 2, itemKey: "norecipe", displayName: "no recipe", price: 7.99, unitCost: null,
  sortOrder: 1, active: true,
};
/** A second priced roll, so the drift has enough item-days to be quoted. */
const ROLL2: Item = { ...ROLL, itemId: 3, itemKey: "roll2", displayName: "roll 2", sortOrder: 2 };
const SETTINGS = { ...DEFAULT_SETTINGS, promoWeekdays: [], saleShare: 0.8, ambition: 3 };
const USUAL = { quantities: { 1: 3, 2: 2 } as Record<number, number> };

let seq = 0;
/** `plan(i)` gives [made, left] for the day i days before today, or null for none. */
function record(n: number, plan: (i: number) => [number, number] | null) {
  const entries: Entry[] = [];
  const counted = new Set<string>();
  for (let i = n; i >= 1; i--) {
    const p = plan(i);
    if (!p) continue;
    const date = addDays(TODAY, -i);
    for (const itemId of [1, 2, 3]) {
      entries.push({ businessDate: date, itemId, entryType: "made", quantity: p[0],
                     mutationId: `m${seq++}`, recordedAt: `${date}T08:00:00Z` });
      if (p[1] > 0) {
        entries.push({ businessDate: date, itemId, entryType: "waste", quantity: p[1],
                       mutationId: `w${seq++}`, recordedAt: `${date}T22:00:00Z` });
      }
    }
    counted.add(date);
  }
  return { entries, counted };
}

function context(entries: Entry[], counted: Set<string>, over: Partial<PlanContext> = {}): PlanContext {
  return {
    items: [ROLL, NO_RECIPE], observations: toObservations(entries), settings: SETTINGS,
    counted, usual: () => USUAL, ...over,
  };
}

describe("the plan ahead", () => {
  it("is exactly the rule's number for that day, on what is counted now", () => {
    const { entries, counted } = record(42, (i) => [5, i % 3 ? 1 : 0]);
    const ctx = context(entries, counted);
    for (const day of planAhead(TODAY, ctx, 7)) {
      const rule = recommendFor(day.date, [ROLL], null, entries, {
        promoWeekdays: [], saleShare: 0.8, ambition: 3, counted,
      }).recommendations[0];
      const roll = day.items.find((p) => p.itemId === 1)!;
      expect(roll.source).toBe("rule");
      expect(roll.qty).toBe(rule.modelQty);
    }
  });

  it("starts tomorrow: today's own plan is on Make", () => {
    const { entries, counted } = record(14, () => [4, 1]);
    const days = planAhead(TODAY, context(entries, counted), 3);
    expect(days.map((d) => d.date)).toEqual([addDays(TODAY, 1), addDays(TODAY, 2), addDays(TODAY, 3)]);
  });

  it("uses your usual amount where the rule has no opinion, and says so", () => {
    const { entries, counted } = record(42, () => [5, 1]);
    const day = planDay(addDays(TODAY, 1), context(entries, counted));
    const noRecipe = day.items.find((p) => p.itemId === 2)!;
    expect(noRecipe).toMatchObject({ qty: 2, source: "usual", climbSteps: 0, testing: false });
    expect(noRecipe.reason).toBeUndefined();
    expect(day.usualItems).toBe(1);
    const roll = day.items.find((p) => p.itemId === 1)!;
    expect(day.total).toBe(roll.qty + 2);
    // Ingredients are known for the roll only, so the total is a floor.
    expect(day.ingredients).toBeCloseTo(roll.qty * 2.03, 8);
    expect(day.ingredientsIsFloor).toBe(true);
  });

  it("with suggestions off, is your usual amounts and nothing else", () => {
    const { entries, counted } = record(42, () => [5, 0]);
    const day = planDay(addDays(TODAY, 1),
                        context(entries, counted, { settings: { ...SETTINGS, showSuggestions: false } }));
    expect(day.items.map((p) => [p.qty, p.source])).toEqual([[3, "usual"], [2, "usual"]]);
    expect(day.total).toBe(5);
  });

  it("plans nothing on a day marked closed", () => {
    const { entries, counted } = record(42, () => [5, 1]);
    const closedDay = addDays(TODAY, 2);
    const day = planDay(closedDay, context(entries, counted, { closed: new Set([closedDay]) }));
    expect(day).toMatchObject({ closed: true, total: 0, items: [] });
  });

  it("ignores a day that traded but was never counted", () => {
    const { entries, counted } = record(42, () => [5, 1]);
    const before = planDay(addDays(TODAY, 1), context(entries, counted));
    // Yesterday: a huge day, never counted. It must not read as a sell-out.
    const y = addDays(TODAY, -1);
    const more: Entry[] = [...entries.filter((e) => e.businessDate !== y), {
      businessDate: y, itemId: 1, entryType: "made", quantity: 30,
      mutationId: "big", recordedAt: `${y}T08:00:00Z`,
    }];
    const after = planDay(addDays(TODAY, 1),
                          context(more, new Set([...counted].filter((d) => d !== y))));
    expect(after.items.find((p) => p.itemId === 1)!.qty)
      .toBeLessThanOrEqual(before.items.find((p) => p.itemId === 1)!.qty);
  });
});

describe("how much estimates drift", () => {
  it("does not move on a steady record", () => {
    const { entries, counted } = record(70, () => [5, 1]);
    const [day, week] = planDrift(TODAY, context(entries, counted, { items: [ROLL, ROLL2] }));
    expect(day).not.toBeNull();
    expect(day!.exact).toBe(1);
    expect(week!.exact).toBe(1);
    expect(week!.items).toBeGreaterThanOrEqual(DRIFT_MIN_ITEMS);
  });

  it("moves when demand does, and more a week out than a day out", () => {
    // Steady at 5 with a leftover, then a fortnight of selling out at 7.
    const { entries, counted } = record(70, (i) => (i <= 14 ? [7, 0] : [5, 1]));
    const [day, week] = planDrift(TODAY, context(entries, counted, { items: [ROLL, ROLL2] }));
    expect(week!.exact).toBeLessThan(1);
    expect(day!.exact).toBeGreaterThanOrEqual(week!.exact);
    expect(week!.withinOne).toBeGreaterThanOrEqual(week!.exact);
  });

  it("is not quoted on too little", () => {
    const { entries, counted } = record(10, () => [5, 1]);
    expect(planDrift(TODAY, context(entries, counted, { items: [ROLL, ROLL2] }))).toEqual([null, null]);
  });
});
