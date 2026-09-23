/**
 * The per-day rollup.
 *
 * The calendar, the day sheet and the home strip all read from this, so a bug
 * here is a bug in three places at once and none of them would look broken --
 * they would just quietly agree on the wrong number. The cases that matter are
 * all variations on one question: has this day been counted, or not?
 */

import { describe, expect, it } from "vitest";
import { buildDayStats, emptyDay, wasteRate } from "./dayStats";
import type { DayRecord, Entry, Item } from "./types";

const TODAY = "2026-09-21";

const item = (itemId: number, unitCost: number | null = 1): Item => ({
  itemId, itemKey: `i${itemId}`, displayName: `item ${itemId}`,
  price: 10, unitCost, sortOrder: itemId, active: true,
});

const entry = (date: string, itemId: number,
               entryType: Entry["entryType"], quantity: number): Entry => ({
  businessDate: date, itemId, entryType, quantity,
  mutationId: `${date}-${itemId}-${entryType}`, recordedAt: `${date}T10:00:00Z`,
});

const day = (d: Partial<DayRecord> & { businessDate: string }): DayRecord => ({
  isOutage: false, productionConfirmedAt: `${d.businessDate}T06:00:00Z`,
  wasteConfirmedAt: null, ...d,
});

describe("buildDayStats", () => {
  it("reports an uncounted day as unknown, never as zero", () => {
    // The distinction the whole app rests on. A day that traded and was never
    // counted has UNKNOWN leftovers; rendering it as 0 would tell the model
    // everything sold out.
    const { byDate } = buildDayStats(
      [entry("2026-09-20", 1, "made", 5)],
      [day({ businessDate: "2026-09-20" })],
      [item(1)], TODAY);
    const d = byDate.get("2026-09-20")!;
    expect(d.phase).toBe("open");
    expect(d.made).toBe(5);
    expect(d.wasted).toBeNull();
    expect(d.soldOut).toBeNull();
    expect(d.wasteCost).toBeNull();
    expect(d.needsWaste).toBe(true);
  });

  it("reports a counted day with its real zero", () => {
    const { byDate } = buildDayStats(
      [entry("2026-09-20", 1, "made", 5), entry("2026-09-20", 1, "waste", 0)],
      [day({ businessDate: "2026-09-20", wasteConfirmedAt: "2026-09-21T06:00:00Z" })],
      [item(1)], TODAY);
    const d = byDate.get("2026-09-20")!;
    expect(d.phase).toBe("closed");
    expect(d.wasted).toBe(0);
    expect(d.soldOut).toBe(1);   // zero waste means it ran out
    expect(d.needsWaste).toBe(false);
  });

  it("counts refills into supply", () => {
    const { byDate } = buildDayStats(
      [entry("2026-09-20", 1, "made", 5), entry("2026-09-20", 1, "refill", 3),
       entry("2026-09-20", 1, "waste", 2)],
      [day({ businessDate: "2026-09-20", wasteConfirmedAt: "x" })],
      [item(1)], TODAY);
    expect(byDate.get("2026-09-20")!.made).toBe(8);
    expect(byDate.get("2026-09-20")!.wasted).toBe(2);
  });

  it("prices waste, and flags the total as a floor when a recipe is missing", () => {
    const { byDate } = buildDayStats(
      [entry("2026-09-20", 1, "made", 5), entry("2026-09-20", 1, "waste", 2),
       entry("2026-09-20", 2, "made", 4), entry("2026-09-20", 2, "waste", 1)],
      [day({ businessDate: "2026-09-20", wasteConfirmedAt: "x" })],
      [item(1, 2.5), item(2, null)], TODAY);
    const d = byDate.get("2026-09-20")!;
    expect(d.wasteCost).toBe(5);        // 2 x 2.50; item 2 is uncosted
    expect(d.costIsFloor).toBe(true);   // and the screen must say so
  });

  it("does not ask for a leftover count on today", () => {
    // Today's leftovers are still in the case. Asking now would invite a
    // guess, which is the one thing this screen must not collect.
    const { byDate } = buildDayStats(
      [entry(TODAY, 1, "made", 5)],
      [day({ businessDate: TODAY })],
      [item(1)], TODAY);
    const d = byDate.get(TODAY)!;
    expect(d.needsWaste).toBe(false);
    expect(d.phase).toBe("open");
  });

  it("asks for today's production until it is confirmed", () => {
    const { byDate } = buildDayStats(
      [], [day({ businessDate: TODAY, productionConfirmedAt: null })],
      [item(1)], TODAY);
    expect(byDate.get(TODAY)!.needsProduction).toBe(true);

    const after = buildDayStats(
      [entry(TODAY, 1, "made", 5)], [day({ businessDate: TODAY })], [item(1)], TODAY);
    expect(after.byDate.get(TODAY)!.needsProduction).toBe(false);
  });

  it("asks nothing of a day marked closed", () => {
    const { byDate } = buildDayStats(
      [entry("2026-09-20", 1, "made", 5)],
      [day({ businessDate: "2026-09-20", isOutage: true })],
      [item(1)], TODAY);
    const d = byDate.get("2026-09-20")!;
    expect(d.phase).toBe("outage");
    expect(d.needsWaste).toBe(false);
  });

  it("marks a day with no production as empty, not open", () => {
    const { byDate } = buildDayStats(
      [], [day({ businessDate: "2026-09-19", productionConfirmedAt: null })],
      [item(1)], TODAY);
    const d = byDate.get("2026-09-19")!;
    expect(d.phase).toBe("empty");
    expect(d.needsWaste).toBe(false);   // nothing was made, nothing to count
  });

  it("treats a later date as future and asks nothing of it", () => {
    const { byDate } = buildDayStats(
      [], [day({ businessDate: "2026-09-25", productionConfirmedAt: null })],
      [item(1)], TODAY);
    const d = byDate.get("2026-09-25")!;
    expect(d.phase).toBe("future");
    expect(d.needsProduction).toBe(false);
    expect(d.needsWaste).toBe(false);
  });

  it("returns dates sorted oldest first", () => {
    const { dates } = buildDayStats(
      [entry("2026-09-18", 1, "made", 1), entry("2026-09-20", 1, "made", 1),
       entry("2026-09-19", 1, "made", 1)],
      [], [item(1)], TODAY);
    expect(dates).toEqual(["2026-09-18", "2026-09-19", "2026-09-20"]);
  });

  it("survives entries with no matching day record", () => {
    const { byDate } = buildDayStats(
      [entry("2026-09-20", 1, "made", 5)], [], [item(1)], TODAY);
    const d = byDate.get("2026-09-20")!;
    expect(d.phase).toBe("open");
    expect(d.productionConfirmed).toBe(false);
    expect(d.needsWaste).toBe(true);
  });
});

describe("emptyDay", () => {
  it("is a real blank rather than a zeroed day", () => {
    const d = emptyDay("2026-09-19", TODAY);
    expect(d.phase).toBe("empty");
    expect(d.wasted).toBeNull();
    expect(d.made).toBe(0);
  });

  it("still asks for production when it is today", () => {
    expect(emptyDay(TODAY, TODAY).needsProduction).toBe(true);
  });
});

describe("wasteRate", () => {
  it("is null when the day was never counted", () => {
    const { byDate } = buildDayStats(
      [entry("2026-09-20", 1, "made", 5)],
      [day({ businessDate: "2026-09-20" })], [item(1)], TODAY);
    expect(wasteRate(byDate.get("2026-09-20")!)).toBeNull();
  });

  it("is the share of supply that came back", () => {
    const { byDate } = buildDayStats(
      [entry("2026-09-20", 1, "made", 4), entry("2026-09-20", 1, "waste", 1)],
      [day({ businessDate: "2026-09-20", wasteConfirmedAt: "x" })],
      [item(1)], TODAY);
    expect(wasteRate(byDate.get("2026-09-20")!)).toBe(0.25);
  });
});
