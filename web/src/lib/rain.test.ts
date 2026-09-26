/**
 * Rain, from the record to the rule.
 *
 * What is protected:
 *   - a weekday that rain really hits is found, and pulled toward the
 *     all-days mean by as much as its sample is thin -- never past it;
 *   - identical weekdays are not told apart: noise does not become a pattern;
 *   - a forecast is weighted by its chance of rain, and re-centred on the
 *     weekday's own typical mix of weather;
 *   - read into the rule, rain only ever lowers a number, takes the trial
 *     rolls first, leaves the always-stocked roll, and without it the rule is
 *     untouched;
 *   - the forecast's chance and the Weather Service's alerts are read right.
 */

import { describe, expect, it } from "vitest";
import { addDays, isoWeekday } from "./businessDay";
import type { DayWeather } from "./weather";
import { parseAlerts, reduceToDays } from "./weather";
import type { ScoredDay } from "./weatherEffect";
import { adviseFor, estimateWeatherEffect, planFactor, typicalFor } from "./weatherEffect";
import { chanceOf, recommendFor, thinnedChance, NO_TRIALS_CHANCE } from "./model";
import type { Entry, Item } from "./types";
import { toObservations } from "./model";
import { planDay } from "./plan";
import { DEFAULT_SETTINGS } from "./types";

const wx = (date: string, precip: number, over: Partial<DayWeather> = {}): DayWeather => ({
  date, precip, snow: 0, tempMax: 75, tempMin: 60, code: precip > 0 ? 61 : 0,
  forecast: false, fetchedAt: "2026-09-25T00:00:00Z", ...over,
});

/**
 * Twenty weeks from Monday 2026-05-04. Every weekday rains every third week;
 * `effect(weekday)` is what rain does to it, and `wobble` a fixed pattern of
 * day-to-day scatter (no randomness: the right answer is known).
 */
function record(effect: (wd: number) => number, wobble = 0.06): ScoredDay[] {
  const out: ScoredDay[] = [];
  const pattern = [0, 1, -1, 0.5, -0.5, 0.8, -0.8];
  for (let i = 0; i < 140; i++) {
    const date = addDays("2026-05-04", i);
    const wd = isoWeekday(date);
    const week = Math.floor(i / 7);
    const rainy = week % 3 === wd % 3;
    const scatter = 1 + wobble * pattern[(i * 3 + week) % 7];
    out.push({ date, sold: 40 * scatter * (rainy ? effect(wd) : 1), censoredShare: 0,
               weather: wx(date, rainy ? 0.3 : 0) });
  }
  return out;
}

describe("rain by weekday", () => {
  it("finds the weekday rain hits, and shrinks it toward the rest -- not past them", () => {
    const e = estimateWeatherEffect(record((wd) => (wd === 6 ? 0.75 : 1)));
    const sat = e.rain.byWeekday[5];
    const tue = e.rain.byWeekday[1];
    expect(e.rain.usable).toBe(true);
    expect(sat.ratio).toBeLessThan(0.85);               // clearly hit
    expect(sat.ratio).toBeGreaterThan(sat.raw);          // but pulled in
    expect(sat.ratio).toBeLessThan(e.rain.pooled);       // not past the mean
    expect(Math.abs(sat.ratio - 1)).toBeGreaterThan(2 * sat.se);  // endorsed
    expect(Math.abs(tue.ratio - 1)).toBeLessThan(0.06);  // Tuesday barely moves
  });

  it("offers a cut only where the weekday's effect is credible", () => {
    const e = estimateWeatherEffect(record((wd) => (wd === 6 ? 0.75 : 1)));
    const sat = adviseFor(wx("2026-09-26", 0.3), e)!;     // Saturday: hit
    const tue = adviseFor(wx("2026-09-22", 0.3), e)!;     // Tuesday: not
    expect(sat.rain!.credible).toBe(true);
    expect(tue.rain!.credible).toBe(false);
  });

  it("does not tell identical weekdays apart", () => {
    const e = estimateWeatherEffect(record(() => 0.9));
    const ratios = e.rain.byWeekday.map((w) => w.ratio);
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeLessThan(0.02);
    expect(e.rain.pooled).toBeGreaterThan(0.85);
    expect(e.rain.pooled).toBeLessThan(0.95);
  });

  it("weights a forecast by its chance of rain", () => {
    const e = estimateWeatherEffect(record((wd) => (wd === 6 ? 0.75 : 1)));
    const sat = "2026-09-26";
    const certain = adviseFor(wx(sat, 0.3), e)!;
    const half = adviseFor(wx(sat, 0.02, { forecast: true, rainChance: 0.5 }), e)!;
    const theta = e.rain.byWeekday[5].ratio;
    expect(certain.offered).toBeCloseTo(theta, 9);
    expect(half.offered).toBeCloseTo(1 + 0.5 * (theta - 1), 9);
    expect(half.rain).toMatchObject({ chance: 0.5, weekday: 6 });
    // Against a TYPICAL Saturday, which was wet a third of the time already.
    expect(half.rain!.relative).toBeCloseTo(theta / typicalFor(e, 6), 9);
    expect(planFactor(half.offered!, e, 6)).toBeCloseTo(half.offered! / typicalFor(e, 6), 9);
    // A dry forecast with no chance of rain is simply dry.
    expect(adviseFor(wx(sat, 0, { forecast: true, rainChance: 0 }), e)!.rain).toBeUndefined();
  });
});

// ------------------------------------------------------------- the rule --

const ITEM: Item = { itemId: 1, itemKey: "roll", displayName: "roll", price: 8.99, unitCost: 2.03,
                     sortOrder: 0, active: true };
const PLAN_DAY = "2026-09-26";   // a Saturday

/** Six weeks of one item: made `made` a day, left over per `left(i)`. */
function entries(made: number, left: (i: number) => number, days = 42): Entry[] {
  const out: Entry[] = [];
  for (let i = days; i >= 1; i--) {
    const d = addDays(PLAN_DAY, -i);
    out.push({ businessDate: d, itemId: 1, entryType: "made", quantity: made,
               mutationId: `m${i}`, recordedAt: `${d}T08:00:00Z` });
    const w = left(i);
    if (w > 0) out.push({ businessDate: d, itemId: 1, entryType: "waste", quantity: w,
                          mutationId: `w${i}`, recordedAt: `${d}T22:00:00Z` });
  }
  return out;
}
const OPTS = { promoWeekdays: [] as number[], saleShare: 0.8, ambition: 3 };
const qty = (e: Entry[], weather?: { factor: number; chance: number }) =>
  recommendFor(PLAN_DAY, [ITEM], null, e, { ...OPTS, weather }).recommendations[0];

describe("rain in the rule", () => {
  it("thins each roll's chance: unchanged at f = 1, lower as f falls", () => {
    const S = [0.97, 0.9, 0.7, 0.45, 0.2];
    for (let k = 1; k <= 7; k++) expect(thinnedChance(S, 1, k)).toBeCloseTo(chanceOf(S, k), 12);
    for (let k = 1; k <= 5; k++) {
      expect(thinnedChance(S, 0.8, k)).toBeLessThan(chanceOf(S, k));
      expect(thinnedChance(S, 0.6, k)).toBeLessThan(thinnedChance(S, 0.8, k));
    }
    // A ladder of [1] continues at the prior, halving: P(D = d) = 0.5^d. With
    // each customer kept at 0.7, P(D' >= 1) = sum 0.5^d (1 - 0.3^d)
    // = 1 - 0.15 / 0.85, exactly (the tail past a dozen rolls is ~0).
    expect(thinnedChance([1], 0.7, 1)).toBeCloseTo(1 - 0.15 / 0.85, 4);
  });

  it("only ever lowers a number", () => {
    const e = entries(6, (i) => (i % 3 === 0 ? 2 : 1));
    const dry = qty(e).modelQty!;
    for (const factor of [0.95, 0.85, 0.7, 0.5]) {
      const wet = qty(e, { factor, chance: 1 });
      expect(wet.modelQty!).toBeLessThanOrEqual(dry);
    }
    expect(qty(e, { factor: 0.5, chance: 1 }).modelQty!).toBeLessThan(dry);
  });

  it("is the plain rule when rain would add, or is not asked for", () => {
    const e = entries(6, (i) => (i % 3 === 0 ? 2 : 1));
    const plain = qty(e);
    expect(qty(e, { factor: 1.1, chance: 1 }).modelQty).toBe(plain.modelQty);
    expect(qty(e, { factor: 0.8, chance: 0 }).modelQty).toBe(plain.modelQty);
    expect(qty(e, { factor: 0.8, chance: 0 }).weatherCut).toBeUndefined();
  });

  it("takes the trial rolls off when rain is more likely than not", () => {
    // Five weeks selling out at 3, then a week at 4 that sold out on all but
    // one day: a popular item the climber adds rolls to (as in model.test.ts).
    const e: Entry[] = [];
    for (let i = 42; i >= 1; i--) {
      const d = addDays(PLAN_DAY, -i);
      const made = i > 7 ? 3 : 4;
      e.push({ businessDate: d, itemId: 1, entryType: "made", quantity: made,
               mutationId: `m${i}`, recordedAt: `${d}T08:00:00Z` });
      if (i <= 7 && i % 5 === 0) e.push({ businessDate: d, itemId: 1, entryType: "waste", quantity: 1,
                                            mutationId: `w${i}`, recordedAt: `${d}T22:00:00Z` });
    }
    const plain = qty(e);
    expect(plain.climbSteps).toBeGreaterThan(0);
    const unlikely = qty(e, { factor: 0.9, chance: NO_TRIALS_CHANCE - 0.1 });
    expect(unlikely.climbSteps).toBe(plain.climbSteps);
    const likely = qty(e, { factor: 0.9, chance: NO_TRIALS_CHANCE + 0.1 });
    expect(likely.climbSteps).toBe(0);
    expect(likely.weatherCut).toBe(plain.modelQty! - likely.modelQty!);
    expect(likely.weatherNote).toMatch(/^rain 60%/);
  });

  it("drops a test roll above the most made lately, too", () => {
    // Sold out every day at 4: the rule tests a 5th. On a rainy day, no tests.
    const e = entries(4, () => 0);
    const plain = qty(e);
    expect(plain.testing).toBe(true);
    const wet = qty(e, { factor: 0.85, chance: 1 });
    expect(wet.modelQty!).toBeLessThanOrEqual(plain.recentMax!);
  });

  it("keeps the one roll an item on the menu always gets", () => {
    const e = entries(1, (i) => (i % 2 ? 1 : 0));
    expect(qty(e, { factor: 0.3, chance: 1 }).modelQty).toBe(1);
  });
});

describe("the forecast and the Weather Service", () => {
  it("reads the chance of rain from opening hours only, and only on a forecast", () => {
    const hourly = {
      time: ["2026-09-26T06:00", "2026-09-26T09:00", "2026-09-26T15:00", "2026-09-26T21:00"],
      precipitation: [0, 0, 0.03, 0.2], snowfall: [0, 0, 0, 0],
      temperature_2m: [55, 60, 66, 60], weather_code: [0, 3, 53, 61],
      precipitation_probability: [95, 10, 69, 90],
    };
    const [f] = reduceToDays(hourly, { open: 8, close: 20 }, true);
    expect(f.rainChance).toBe(0.69);       // not the 95% at 6am or the 90% at 9pm
    const [a] = reduceToDays(hourly, { open: 8, close: 20 }, false);
    expect(a.rainChance).toBeUndefined();
  });

  it("lists real alerts, worst first, once each", () => {
    const f = (event: string, severity: string, status = "Actual") =>
      ({ properties: { event, severity, status, headline: `${event} issued`, ends: "2026-09-26T20:00:00-04:00" } });
    const out = parseAlerts({ features: [
      f("Wind Advisory", "Minor"), f("Flood Watch", "Severe"),
      f("Flood Watch", "Severe"), f("Test Message", "Minor", "Test"),
    ] });
    expect(out.map((a) => a.event)).toEqual(["Flood Watch", "Wind Advisory"]);
    expect(out[0].ends).toBe("2026-09-26T20:00:00-04:00");
    expect(parseAlerts({})).toEqual([]);
    expect(parseAlerts(null)).toEqual([]);
  });
});

describe("the plan ahead in rain", () => {
  it("carries the rain total where the forecast lowers it, and nothing where it doesn't", () => {
    const e = entries(6, (i) => (i % 3 === 0 ? 2 : 1));
    const counted = new Set(e.map((x) => x.businessDate));
    const ctx = {
      items: [ITEM], observations: toObservations(e),
      settings: { ...DEFAULT_SETTINGS, ...OPTS }, counted, usual: () => null,
    };
    const wet = planDay(PLAN_DAY, { ...ctx, weatherFor: () => ({ factor: 0.6, chance: 1, ratio: 0.6 }) });
    expect(wet.rain).toBeDefined();
    expect(wet.rain!.total).toBeLessThan(wet.total);
    expect(planDay(PLAN_DAY, { ...ctx, weatherFor: () => null }).rain).toBeUndefined();
    expect(planDay(PLAN_DAY, ctx).rain).toBeUndefined();
  });
});
