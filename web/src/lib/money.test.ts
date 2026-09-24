/**
 * The money every screen shows.
 *
 * What is protected: the receipt adds up (sales = middle man + ingredients
 * sold + thrown away + profit), an uncounted day never gets an invented sales
 * figure, and a projection keeps what is known apart from what is estimated.
 */

import { describe, expect, it } from "vitest";
import { buildDayStats } from "./dayStats";
import {
  estimateDay, itemMoney, monthOf, projectPeriod, usd, usdShort, weekOf,
  type Economics,
} from "./money";
import type { DayRecord, Entry, Item } from "./types";

const ECON: Economics = { promoWeekdays: [3], promoMultiplier: 2 / 3, saleShare: 0.8 };

const ROLL: Item = {
  itemId: 1, itemKey: "roll", displayName: "roll", price: 10, unitCost: 2,
  sortOrder: 0, active: true,
};

const entry = (date: string, entryType: Entry["entryType"], quantity: number): Entry => ({
  businessDate: date, itemId: 1, entryType, quantity,
  mutationId: `${date}-${entryType}`, recordedAt: `${date}T10:00:00Z`,
});

const counted = (date: string): DayRecord => ({
  businessDate: date, isOutage: false, productionConfirmedAt: `${date}T06:00:00Z`,
  wasteConfirmedAt: `${date}T22:00:00Z`,
});

describe("one item, one day", () => {
  it("prints a receipt that adds up", () => {
    // Made 5, 2 left: 3 sold at $10 = $30; middle man 20% = $6; ingredients
    // for all 5 = $10, of which $4 went in the bin; profit $14.
    const m = itemMoney(ROLL, "2026-09-21", 5, 2, ECON);   // a Monday
    expect(m).toMatchObject({ sales: 30, cost: 10, wasteCost: 4, profit: 14 });
    expect(m.fee).toBeCloseTo(6, 10);
    expect(m.fee! + (m.cost - m.wasteCost!) + m.wasteCost! + m.profit!).toBeCloseTo(m.sales!, 10);
  });

  it("prices a buy-2-get-1 Wednesday at two thirds", () => {
    const m = itemMoney(ROLL, "2026-09-23", 3, 0, ECON);
    expect(m.sales).toBeCloseTo(20, 10);
  });

  it("knows the ingredient bill but not the sales of an uncounted day", () => {
    const m = itemMoney(ROLL, "2026-09-21", 5, null, ECON);
    expect(m.cost).toBe(10);
    expect(m.sales).toBeNull();
    expect(m.profit).toBeNull();
  });
});

describe("a day's money", () => {
  it("is filled in once counted, and left blank before", () => {
    const { byDate } = buildDayStats(
      [entry("2026-09-20", "made", 5), entry("2026-09-20", "waste", 1),
       entry("2026-09-21", "made", 4)],
      [counted("2026-09-20"), { ...counted("2026-09-21"), wasteConfirmedAt: null }],
      [ROLL], "2026-09-22", ECON);
    const done = byDate.get("2026-09-20")!;
    expect(done.sales).toBe(40);
    expect(done.profit).toBeCloseTo(40 - 8 - 10, 10);
    expect(done.wasteCost).toBe(2);
    const open = byDate.get("2026-09-21")!;
    expect(open.costMade).toBe(8);
    expect(open.sales).toBeNull();
    expect(open.profit).toBeNull();
  });
});

describe("projecting a period", () => {
  // Four counted Mondays, each $14 profit (made 5, 2 left).
  const mondays = ["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21"];
  const entries = mondays.flatMap((d) => [entry(d, "made", 5), entry(d, "waste", 2)]);
  const days = mondays.map(counted);

  it("adds what is known to what is expected, and keeps them apart", () => {
    const stats = buildDayStats(entries, days, [ROLL], "2026-09-22", ECON);
    // Next week: nothing counted yet, one Monday expected.
    const p = projectPeriod(stats, "2026-09-22", "2026-09-28", "2026-09-28");
    expect(p.actual.profit).toBe(0);
    expect(p.estimate.profit).toBeCloseTo(14, 10);
    expect(p.aheadDays).toBe(1);
    // This month so far: the three September Mondays are known.
    const m = projectPeriod(stats, "2026-09-22", "2026-09-01", "2026-09-21");
    expect(m.countedDays).toBe(3);
    expect(m.actual.profit).toBeCloseTo(42, 10);
    expect(m.estimate.profit).toBe(0);
  });

  it("estimates a past day that traded but was never counted, and says so", () => {
    const stats = buildDayStats(
      [...entries, entry("2026-09-28", "made", 5)],
      [...days, { ...counted("2026-09-28"), wasteConfirmedAt: null }],
      [ROLL], "2026-09-30", ECON);
    const p = projectPeriod(stats, "2026-09-30", "2026-09-28", "2026-09-28");
    expect(p.uncountedDays).toBe(1);
    expect(p.estimate.profit).toBeCloseTo(14, 10);
  });

  it("does not invent trade on past days with nothing recorded, or closed days", () => {
    const stats = buildDayStats(entries,
      [...days, { businessDate: "2026-09-29", isOutage: true,
                  productionConfirmedAt: null, wasteConfirmedAt: null }],
      [ROLL], "2026-10-02", ECON);
    const p = projectPeriod(stats, "2026-10-02", "2026-09-22", "2026-10-01");
    expect(p.estimate.days).toBe(0);
    expect(p.total.profit).toBe(0);
    // ...but the blank ones are named, so their $0 is not read as a result.
    expect(p.blankDays).toHaveLength(9);          // 22-30 Sep and 1 Oct, less the closed 29th
    expect(p.blankDays).not.toContain("2026-09-29");
  });

  it("gets less certain the more days are still ahead", () => {
    const varied = mondays.flatMap((d, i) => [entry(d, "made", 5), entry(d, "waste", i % 3)]);
    const stats = buildDayStats(varied, days, [ROLL], "2026-09-22", ECON);
    const one = projectPeriod(stats, "2026-09-22", "2026-09-28", "2026-09-28");
    const two = projectPeriod(stats, "2026-09-22", "2026-09-28", "2026-10-05");
    const width = (p: typeof one) => p.profitRange[1] - p.profitRange[0];
    expect(width(two)).toBeGreaterThan(width(one));
    expect(one.profitRange[0]).toBeLessThan(one.total.profit);
  });

  it("falls back to every weekday when one has too few counted days", () => {
    const stats = buildDayStats(entries, days, [ROLL], "2026-09-22", ECON);
    const tue = estimateDay(stats, "2026-09-22", "2026-09-22")!;
    expect(tue.pooled).toBe(true);
    expect(tue.mean.profit).toBeCloseTo(14, 10);
  });

  it("cannot project from nothing", () => {
    const stats = buildDayStats([], [], [ROLL], "2026-09-22", ECON);
    expect(projectPeriod(stats, "2026-09-22", "2026-09-21", "2026-09-27").canProject).toBe(false);
  });
});

describe("periods and formatting", () => {
  it("runs weeks Monday to Sunday and months first to last", () => {
    expect(weekOf("2026-09-24")).toEqual(["2026-09-21", "2026-09-27"]);
    expect(monthOf("2026-09-24")).toEqual(["2026-09-01", "2026-09-30"]);
    expect(monthOf("2026-02-10")).toEqual(["2026-02-01", "2026-02-28"]);
  });

  it("prints whole dollars, with a real minus sign", () => {
    expect(usd(1234.4)).toBe("$1,234");
    expect(usd(-34.2)).toBe("−$34");
    expect(usdShort(152.3)).toBe("$152");
    expect(usdShort(1234)).toBe("$1.2k");
    expect(usdShort(-8)).toBe("−$8");
  });
});
