/**
 * The ambition check on the front page.
 *
 * What is protected: it never judges on too little, it calls a level "too
 * high" when waste rises for no more profit, it calls one "paying" only past
 * the noise, and the extra-roll tally only ever counts rolls that were made
 * -- and settles them to the cent.
 */

import { describe, expect, it } from "vitest";
import { checkAmbition } from "./ambition";
import { addDays } from "./businessDay";
import { buildDayStats } from "./dayStats";
import { economicsOf } from "./money";
import type { DayRecord, Entry, Item, Settings } from "./types";
import { DEFAULT_SETTINGS } from "./types";

const TODAY = "2026-09-24";
const ROLL: Item = {
  itemId: 1, itemKey: "roll", displayName: "roll", price: 8.99, unitCost: 2.03,
  sortOrder: 0, active: true,
};
const SETTINGS: Settings = { ...DEFAULT_SETTINGS, promoWeekdays: [], saleShare: 0.8, ambition: 3 };

let seq = 0;
function day(date: string, made: number, waste: number): { e: Entry[]; d: DayRecord } {
  const e: Entry[] = [{ businessDate: date, itemId: 1, entryType: "made", quantity: made,
                        mutationId: `m${seq++}`, recordedAt: `${date}T08:00:00Z` }];
  if (waste > 0) {
    e.push({ businessDate: date, itemId: 1, entryType: "waste", quantity: waste,
             mutationId: `w${seq++}`, recordedAt: `${date}T22:00:00Z` });
  }
  return { e, d: { businessDate: date, isOutage: false,
                   productionConfirmedAt: `${date}T08:00:00Z`, wasteConfirmedAt: `${date}T22:00:00Z` } };
}

/** `plan(i)` gives [made, waste] for the day i days before today (1 = yesterday). */
function record(n: number, plan: (i: number) => [number, number], settings = SETTINGS) {
  const rows = Array.from({ length: n }, (_, k) => {
    const i = n - k;
    const [made, waste] = plan(i);
    return day(addDays(TODAY, -i), made, waste);
  });
  const entries = rows.flatMap((r) => r.e);
  const stats = buildDayStats(entries, rows.map((r) => r.d), [ROLL], TODAY, economicsOf(settings));
  return { entries, stats };
}

describe("the ambition check", () => {
  it("does not judge a level changed three days ago", () => {
    const settings = { ...SETTINGS, ambitionSince: addDays(TODAY, -3) };
    const { entries, stats } = record(42, () => [10, 2], settings);
    const c = checkAmbition(stats, entries, [ROLL], settings, TODAY);
    expect(c.verdict).toBe("early");
    expect(c.headline).toMatch(/3 of 7 counted days/);
  });

  it("calls it too high when waste rises for no more profit", () => {
    // Four weeks at 10 made / 2 left, then two weeks at 12 made / 4 left.
    const { entries, stats } = record(42, (i) => (i <= 14 ? [12, 4] : [10, 2]));
    const c = checkAmbition(stats, entries, [ROLL], SETTINGS, TODAY);
    expect(c.verdict).toBe("too-high");
    expect(c.headline).toMatch(/left over \(was 20%\)/);
  });

  it("calls it paying only when profit rises past the noise", () => {
    const { entries, stats } = record(42, (i) => (i <= 14 ? [10, 1] : [10, 5]));
    const c = checkAmbition(stats, entries, [ROLL], SETTINGS, TODAY);
    expect(c.verdict).toBe("paying");
    expect(c.recent.profitPerDay).toBeGreaterThan(c.before!.profitPerDay);
  });

  it("points out room when ambition is off and much still sells out", () => {
    const careful = { ...SETTINGS, ambition: 1 };
    const { entries, stats } = record(42, () => [3, 0], careful);
    const c = checkAmbition(stats, entries, [ROLL], careful, TODAY);
    expect(c.verdict).toBe("room");
  });

  it("does not judge a level whose extra rolls are not being made", () => {
    // Sells out two days in three at 5; the rule wants more; 5 is all that is made.
    const { entries, stats } = record(42, (i) => [5, i % 3 ? 0 : 1]);
    const c = checkAmbition(stats, entries, [ROLL], SETTINGS, TODAY);
    expect(c.extra.suggested).toBeGreaterThanOrEqual(8);
    expect(c.extra.made).toBe(0);
    expect(c.verdict).toBe("early");
    expect(c.headline).toMatch(/^Not judged yet/);
  });

  it("settles only the extra rolls that were made, to the cent", () => {
    // A popular item that kept selling out at 4, and two weeks of making 7
    // -- above the rule's base -- with a leftover every other day.
    const { entries, stats } = record(42, (i) => (i <= 14 ? [7, i % 2] : [4, i % 5 ? 0 : 1]));
    const c = checkAmbition(stats, entries, [ROLL], SETTINGS, TODAY);
    const e = c.extra;
    expect(e.suggested).toBeGreaterThan(0);
    expect(e.made).toBeGreaterThan(0);
    expect(e.made).toBeLessThanOrEqual(e.suggested);
    expect(e.sold).toBeLessThanOrEqual(e.made);
    expect(e.dollars).toBeCloseTo(e.sold * 8.99 * 0.8 - e.made * 2.03, 8);
  });
});
