/**
 * What the weather has actually done to this kiosk's sales.
 *
 * Measured, not assumed, and reported with enough honesty that a null result
 * reads as a null result rather than as a small effect.
 *
 * Three decisions carry the whole file:
 *
 * 1. WITHIN WEEKDAY. Weekday is by far the biggest driver of this business --
 *    Wednesday's promo alone moves it more than any storm. Comparing wet days
 *    to dry days across the whole sample measures "were the rainy days
 *    Saturdays?" as much as it measures rain. So every comparison is made
 *    inside a weekday and then pooled, which is what made the signal in this
 *    operator's own history convincing: it was negative on all seven days
 *    independently.
 *
 * 2. DAY LEVEL, NOT ITEM LEVEL. With ~120 days and ~30 items, a per-item
 *    weather effect has a handful of wet observations per item and demand is
 *    right-censored on about half of them. Those estimates would be noise
 *    wearing a number's clothes. One day-level multiplier, applied uniformly,
 *    is what the data can carry. Per-item becomes defensible after a couple
 *    of years, not now.
 *
 * 3. UNITS SOLD, CENSORING ACKNOWLEDGED. Sold is min(demand, supply), so on a
 *    sell-out day it measures the shelf rather than the customer. That biases
 *    any weather effect TOWARD ZERO -- a rainy day that still sold out looks
 *    like no effect. So a measured effect here is a floor on the real one,
 *    and `censoredShare` is reported alongside it rather than buried.
 */

import type { BizDate } from "./businessDay";
import { isoWeekday } from "./businessDay";
import type { DayWeather, WeatherBand } from "./weather";
import { band } from "./weather";

/** A day that can be compared: it traded, and it was counted. */
export interface ScoredDay {
  date: BizDate;
  sold: number;
  /** Share of the day's items that ran out -- how censored this day is. */
  censoredShare: number;
  weather: DayWeather;
  /** Days the operator has flagged as unusual are held out of the baseline. */
  excluded?: boolean;
}

export interface BandEffect {
  band: WeatherBand;
  /** Days observed in this band, after exclusions. */
  n: number;
  /** Mean ratio to the same weekday's dry mean. 0.9 = sells 10% less. */
  ratio: number;
  /** Standard error of that ratio. */
  se: number;
  /** ratio-1 as a percentage, rounded for display. */
  pct: number;
  /** |ratio-1| / se. Above 2 is the usual bar for "not noise". */
  t: number;
  /** Weekdays that actually contributed a comparison. */
  weekdays: number[];
  /** Enough days, and a t large enough, to act on. */
  usable: boolean;
}

export interface WeatherEffect {
  /** Days with both a sale record and weather. */
  matched: number;
  /** Days held out because the operator flagged them. */
  excluded: number;
  dryDays: number;
  byBand: BandEffect[];
  /** Share of all matched item-days that hit their ceiling. */
  censoredShare: number;
  /** Observed temperature range, °F -- the range any claim is valid within. */
  tempRange: [number, number] | null;
  /** True when there is not enough to say anything at all. */
  insufficient: boolean;
}

/** Below this many days in a band, no estimate is offered at all. */
export const MIN_BAND_DAYS = 8;
/** And below this t, the estimate is shown but marked as not yet actionable. */
export const MIN_T = 2;

function mean(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}

function variance(v: number[]): number {
  if (v.length < 2) return 0;
  const m = mean(v);
  return v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1);
}

export function estimateWeatherEffect(days: ScoredDay[]): WeatherEffect {
  const usable = days.filter((d) => !d.excluded && d.sold > 0);
  const excluded = days.filter((d) => d.excluded).length;

  const temps = usable.map((d) => d.weather.tempMax);
  const tempRange: [number, number] | null =
    temps.length ? [Math.min(...temps), Math.max(...temps)] : null;

  // The dry baseline, per weekday. Everything is expressed relative to this.
  const dryByWeekday = new Map<number, number[]>();
  for (const d of usable) {
    if (band(d.weather) !== "dry") continue;
    const wd = isoWeekday(d.date);
    dryByWeekday.set(wd, [...(dryByWeekday.get(wd) ?? []), d.sold]);
  }

  const byBand: BandEffect[] = [];
  for (const b of ["wet", "heavy", "snow"] as WeatherBand[]) {
    // Each day becomes a ratio against its OWN weekday's dry mean, so the
    // weekday cancels out before anything is pooled.
    const ratios: number[] = [];
    const weekdays = new Set<number>();
    for (const d of usable) {
      if (band(d.weather) !== b) continue;
      const wd = isoWeekday(d.date);
      const dry = dryByWeekday.get(wd);
      // Two dry days is not a baseline; a weekday without one contributes
      // nothing rather than being compared to the overall mean.
      if (!dry || dry.length < 2) continue;
      const base = mean(dry);
      if (!(base > 0)) continue;
      ratios.push(d.sold / base);
      weekdays.add(wd);
    }
    const n = ratios.length;
    const ratio = n ? mean(ratios) : NaN;
    const se = n > 1 ? Math.sqrt(variance(ratios) / n) : NaN;
    const t = n > 1 && se > 0 ? Math.abs(ratio - 1) / se : 0;
    byBand.push({
      band: b, n, ratio, se,
      pct: n ? Math.round((ratio - 1) * 1000) / 10 : 0,
      t,
      weekdays: [...weekdays].sort(),
      usable: n >= MIN_BAND_DAYS && t >= MIN_T,
    });
  }

  const dryDays = usable.filter((d) => band(d.weather) === "dry").length;
  return {
    matched: usable.length,
    excluded,
    dryDays,
    byBand,
    censoredShare: usable.length ? mean(usable.map((d) => d.censoredShare)) : 0,
    tempRange,
    // Nothing can be said without a dry baseline to say it against.
    insufficient: dryDays < MIN_BAND_DAYS
      || byBand.every((e) => e.n < MIN_BAND_DAYS),
  };
}

/**
 * The multiplier to apply to today's plan, or null for "say nothing".
 *
 * Null is the common answer and deliberately so. It is returned when the
 * band was never measured, when the measurement is too noisy to act on, or
 * when today's weather sits outside anything in the record -- the operator
 * chose "say so and suggest nothing" over extrapolating, and a cold snap in
 * January is exactly the case that would otherwise be answered by a rule
 * fitted entirely to summer.
 */
export interface WeatherAdvice {
  band: WeatherBand;
  /**
   * The ENDORSED adjustment: non-null only when the estimate cleared both the
   * sample-size and the noise bar. This is what the app would be willing to
   * stand behind on its own.
   */
  multiplier: number | null;
  pct: number | null;
  /**
   * The point estimate, offered whenever the band has been measured at all --
   * even when it is too noisy to endorse.
   *
   * The two are separate on purpose. The app refusing to endorse a number is
   * not the same as the operator being forbidden to use it: it is their kiosk
   * and their judgement, they asked to be able to reach for it, and the honest
   * move is to hand over the figure together with its weakness rather than
   * hiding one to protect them from the other. Nothing applies it but a tap.
   */
  offered: number | null;
  offeredPct: number | null;
  /** Whether the offer is one the app itself would make. */
  endorsed: boolean;
  /** Why there is no endorsed multiplier, when there is none. */
  reason: "ok" | "unseen-band" | "too-noisy" | "out-of-range" | "no-data";
  /** Days behind the estimate. */
  n: number;
  /** The observed temperature range, when the reason is out-of-range. */
  tempRange: [number, number] | null;
}

/** How far outside the observed range still counts as "seen before". */
const TEMP_SLACK = 5;

export function adviseFor(
  today: DayWeather | undefined,
  effect: WeatherEffect,
): WeatherAdvice | null {
  if (!today) return null;
  const b = band(today);
  const base = { band: b, multiplier: null, pct: null, offered: null,
                 offeredPct: null, endorsed: false, n: 0,
                 tempRange: effect.tempRange } as WeatherAdvice;

  if (effect.insufficient) return { ...base, reason: "no-data" };

  // Temperature outside the record. The operator has never traded in this, so
  // neither has the model -- and a rain rule fitted in July has no claim on a
  // January morning even if it happens to be raining.
  if (effect.tempRange) {
    const [lo, hi] = effect.tempRange;
    if (today.tempMax < lo - TEMP_SLACK || today.tempMax > hi + TEMP_SLACK) {
      return { ...base, reason: "out-of-range" };
    }
  }

  if (b === "dry") {
    return { ...base, reason: "ok", multiplier: 1, pct: 0, endorsed: true };
  }

  const hit = effect.byBand.find((e) => e.band === b);
  // Never measured: there is no figure to offer, endorsed or otherwise.
  if (!hit || hit.n < MIN_BAND_DAYS) return { ...base, reason: "unseen-band" };

  // Measured but noisy: offered, not endorsed.
  if (!hit.usable) {
    return { ...base, reason: "too-noisy", n: hit.n,
             offered: hit.ratio, offeredPct: hit.pct };
  }

  return { band: b, multiplier: hit.ratio, pct: hit.pct,
           offered: hit.ratio, offeredPct: hit.pct, endorsed: true,
           reason: "ok", n: hit.n, tempRange: effect.tempRange };
}

/**
 * Turn the app's own day rollup into something comparable.
 *
 * Only days that traded AND were counted can be used: an uncounted day has
 * unknown sales, and treating its supply as sales would make every uncounted
 * day look like a bumper one.
 */
export function scoreDaysForWeather(
  stats: { byDate: Map<BizDate, { date: BizDate; phase: string; made: number;
                                  wasted: number | null; soldOut: number | null;
                                  itemsMade: number }> },
  weather: Map<BizDate, DayWeather>,
  unusualDates: string[] = [],
  _items?: unknown,
): ScoredDay[] {
  const unusual = new Set(unusualDates);
  const out: ScoredDay[] = [];
  for (const [date, d] of stats.byDate) {
    if (d.phase !== "closed" || d.wasted === null) continue;
    const w = weather.get(date);
    if (!w || w.forecast) continue;   // a forecast is not a measurement
    out.push({
      date,
      sold: Math.max(0, d.made - d.wasted),
      censoredShare: d.itemsMade ? (d.soldOut ?? 0) / d.itemsMade : 0,
      weather: w,
      excluded: unusual.has(date),
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * What a day of unremarkable weather is worth, relative to a dry one.
 *
 * Every matched day counted once, at its own band's ratio. Below 1 whenever
 * bad weather costs anything at all.
 */
export function typicalRatio(effect: WeatherEffect): number {
  let n = effect.dryDays;
  let weighted = effect.dryDays;      // dry contributes ratio 1 each
  for (const b of effect.byBand) {
    if (b.n < 1 || !Number.isFinite(b.ratio)) continue;
    n += b.n;
    weighted += b.n * b.ratio;
  }
  return n > 0 ? weighted / n : 1;
}

/**
 * The factor to apply to a plan whose own baseline already mixes weather.
 *
 * This is the one conversion that has to be got right, and it is easy to skip.
 * Every band ratio here is measured against DRY days of the same weekday. But
 * nothing the app plans from has a dry baseline:
 *
 *   the production rule   chances from recent days, same weekday weighted most
 *   the home outlook      the mean of the last 8 same-weekday days
 *
 * Both of those windows contain rainy days already. Multiplying them by a
 * vs-dry ratio charges for the rain twice -- a -7% day comes out at -7% below
 * an average that was itself dragged down by rain. Dividing by the typical day
 * removes the part that is already priced in, which is why a -7% band shows up
 * as about -5% on the sheet.
 *
 * It also makes the pleasant case say something true: a dry day is 1.00
 * against dry and therefore 0% forever, but a couple of percent ABOVE a
 * typical day -- small, and the honest size of the effect.
 */
export function planFactor(ratioVsDry: number, effect: WeatherEffect): number {
  const typical = typicalRatio(effect);
  return typical > 0 ? ratioVsDry / typical : ratioVsDry;
}

/**
 * Apply a day-level multiplier to a set of per-item quantities.
 *
 * Rounding each item independently does not work at this scale. The sheet is
 * thirty-odd items of one to four units; multiplying a 2 by 0.93 and rounding
 * gives 2, and a seven percent adjustment disappears entirely -- the screen
 * says "applied -6.9%" and not one number moves, which is worse than not
 * offering it.
 *
 * So the multiplier is applied to the TOTAL, and the units are taken off by
 * largest remainder: every item gets its exact scaled value floored, and the
 * units still owed go to whichever items were rounded down hardest. The day's
 * total moves by the right proportion, and the units come off the items where
 * the fractional loss was biggest rather than off whichever happened to sort
 * first.
 *
 * The floor of one is preserved: an item worth making at all is worth making
 * one of, whatever the weather. That means a big cut on a sheet of ones
 * cannot reach its target, which is correct -- and `applied` reports what was
 * actually achieved rather than what was asked for.
 */
export function scaleQuantities(
  quantities: Map<number, number>,
  factor: number,
): { scaled: Map<number, number>; before: number; after: number; applied: number } {
  const entries = [...quantities.entries()].filter(([, q]) => q > 0);
  const before = entries.reduce((s, [, q]) => s + q, 0);
  if (factor === 1 || before === 0) {
    return { scaled: new Map(quantities), before, after: before, applied: 1 };
  }

  const target = Math.max(entries.length, Math.round(before * factor));

  const parts = entries.map(([id, q]) => {
    const exact = q * factor;
    const floor = Math.max(1, Math.floor(exact));
    return { id, q, exact, floor, remainder: exact - floor };
  });

  let total = parts.reduce((s, p) => s + p.floor, 0);
  // Hand back units to the items that lost the most in the floor, biggest
  // fractional loss first, until the target is met.
  const byRemainder = [...parts].sort((a, b) => b.remainder - a.remainder);
  let i = 0;
  while (total < target && i < byRemainder.length) {
    const p = byRemainder[i];
    if (p.floor < p.q || factor > 1) { p.floor += 1; total += 1; }
    i++;
  }
  // Over target (the floor of one held units up): take from the items whose
  // exact value was furthest below what they ended up with.
  const bySlack = [...parts].sort((a, b) => (a.exact - a.floor) - (b.exact - b.floor));
  i = 0;
  while (total > target && i < bySlack.length) {
    const p = bySlack[i];
    if (p.floor > 1) { p.floor -= 1; total -= 1; }
    i++;
  }

  const scaled = new Map(quantities);
  for (const p of parts) scaled.set(p.id, p.floor);
  return { scaled, before, after: total, applied: before ? total / before : 1 };
}
