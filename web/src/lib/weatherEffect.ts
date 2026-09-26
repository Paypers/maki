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
 *
 * 4. RAIN BY WEEKDAY, SHRUNK. Pooling every weekday into one rain effect hid
 *    the finding that mattered (the record to Sep 21): rain cost Saturdays
 *    about a fifth of their sales, seven rainy Saturdays out of seven, while
 *    rainy Sundays sold MORE and the weekdays moved a few percent. Averaged
 *    together that read "-4%" for every day -- wrong on Saturday by five
 *    times and wrong on Sunday in sign. The weekdays really do differ
 *    (Cochran's Q = 12.5 on 6 df), so each gets its own estimate -- but seven
 *    days is a small sample, so each is pulled toward the all-days mean by
 *    exactly as much as its own noise warrants against the measured spread
 *    between weekdays (DerSimonian & Laird's random effects, 1986), with the
 *    day-to-day scatter pooled across weekdays. A weekday with three rainy
 *    days and a wild number is pulled almost all the way in.
 *
 *    How firm is Saturday's? Its RAW drop is: -17% to -22%, whether rain is
 *    measured at the ZIP's centre or 3 km east, and whether or not the
 *    too-close-to-call days (0.02-0.10") are left out. How much of it is
 *    Saturday rather than chance is not: shrunk, it lands anywhere from -3%
 *    to -14%, because a few light-shower days flip between "wet" and "dry"
 *    with the exact spot, and seven weekdays is a thin basis for the spread.
 *    So the app shows the shrunk figure, says when it could still be chance,
 *    and leaves applying it to the operator.
 *
 *    Cross-checked with a stronger design (Sep 26 audit): log sales on
 *    weekday AND week fixed effects, so each rainy day is compared with the
 *    dry days of its own week, clustered by week. Weekdays: rain ~0% (+-9).
 *    Saturday: -16% to -24% raw. A permutation test shuffling rain within
 *    weekday put the Saturday difference at p = 0.007; rain moved a week
 *    later (placebo) showed nothing; the amount made did not move with rain,
 *    so it is demand, not supply. Hierarchical Bayes with the spread
 *    integrated rather than plugged in: Saturday -9% to -13%, 90% interval
 *    reaching -24%. Predicting each rainy Saturday from the rest, this
 *    estimate cut the error by 37% against ignoring rain; one pooled rain
 *    effect for all days cut it by 5%.
 *
 *    Rain is ONE band here, wet and heavy together: the record shows no dose
 *    response -- heavy days (0.4"+) sold no less than light ones, and short
 *    showers cost as much as all-day rain -- so splitting them would fit
 *    noise. The band split stays for the display.
 *
 * 5. A LOCAL BASELINE. Each wet day is compared to dry days of its weekday
 *    within four weeks either side, not the whole summer's, so a season that
 *    drifts (a busy May, a quiet July) is not read as weather.
 */

import type { BizDate } from "./businessDay";
import { daysBetween, isoWeekday } from "./businessDay";
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

/** Rain on one weekday: its own measurement, and what survives shrinking. */
export interface WeekdayRain {
  weekday: number;
  /** Rainy days of this weekday with a dry baseline to compare against. */
  n: number;
  /** Their own mean ratio to dry, before shrinking. NaN with no days. */
  raw: number;
  /** The estimate to use: shrunk toward the all-days mean. 0.8 = 20% less. */
  ratio: number;
  /** Its standard error, after shrinking. */
  se: number;
  /** Share of this weekday's matched days that were rainy. */
  rainShare: number;
}

/** Rain, one band, by weekday -- see decision 4 above. */
export interface RainModel {
  /** Rainy days with a baseline, all weekdays. */
  n: number;
  /** The all-days (random-effects) mean ratio. */
  pooled: number;
  /** How much weekdays really differ, in ratio units (0.10 = 10 points). */
  tau: number;
  /** Seven entries, Monday first. */
  byWeekday: WeekdayRain[];
  /** Enough rainy days for any of it to be offered. */
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
  rain: RainModel;
}

/** Below this many days in a band, no estimate is offered at all. */
export const MIN_BAND_DAYS = 8;
/** And below this t, the estimate is shown but marked as not yet actionable. */
export const MIN_T = 2;
/**
 * The bar for a weekday's rain effect to change the plan at all: 90% sure it
 * is not chance (one-sided). Chosen by a walk-forward backtest over Jul-Sep
 * with the effect re-estimated each day from the days before it only, the
 * rule's plan scored against what actually sold, forecasts right 70% of the
 * time with false alarms on dry days counted too. Net profit, at the two rain
 * measurement points: no bar -$9 / -$1; this bar +$22 / +$6; the 2-SE bar
 * +$12 / -$14. Without a bar the app cut Sundays (which sell MORE in rain) and
 * weekdays (where rain does nothing measurable) and gave back what Saturdays
 * earned. The sums are small -- a few dollars a week -- and say so honestly:
 * rain is a real effect on Saturday sales and a modest one on profit.
 */
export const CREDIBLE_Z = 1.2816;

function mean(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}

function variance(v: number[]): number {
  if (v.length < 2) return 0;
  const m = mean(v);
  return v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1);
}

/** Dry days of the same weekday within this many days count as its baseline. */
export const BASELINE_SPAN_DAYS = 28;

/**
 * The dry baseline for a day: the mean of dry days of its weekday within four
 * weeks either side, or of every dry day of that weekday when fewer than two
 * are near. Null when there are not two to average at all.
 */
function baselineOf(usable: ScoredDay[]): (d: ScoredDay) => number | null {
  const dry = new Map<number, ScoredDay[]>();
  for (const d of usable) {
    if (band(d.weather) !== "dry") continue;
    const wd = isoWeekday(d.date);
    dry.set(wd, [...(dry.get(wd) ?? []), d]);
  }
  return (d) => {
    const same = (dry.get(isoWeekday(d.date)) ?? []).filter((x) => x.date !== d.date);
    const near = same.filter((x) => Math.abs(daysBetween(x.date, d.date)) <= BASELINE_SPAN_DAYS);
    const pick = near.length >= 2 ? near : same;
    if (pick.length < 2) return null;
    const m = mean(pick.map((x) => x.sold));
    return m > 0 ? m : null;
  };
}

const isRain = (w: DayWeather) => {
  const b = band(w);
  return b === "wet" || b === "heavy";
};

/**
 * Rain by weekday, each weekday's mean ratio shrunk toward the all-days mean.
 *
 *   per weekday   r_w = mean ratio, v_w = its variance (s^2 / n)
 *   spread        tau^2, DerSimonian-Laird: how much more the weekdays differ
 *                 than their own noise explains (zero when they don't)
 *   all days      mu = sum r_w/(v_w+tau^2) / sum 1/(v_w+tau^2)
 *   shrunk        (r_w/v_w + mu/tau^2) / (1/v_w + 1/tau^2)
 *
 * With no real spread every weekday gets the all-days mean; with a lot, each
 * keeps its own. v_w uses the day-to-day scatter pooled over all weekdays
 * (see below). A weekday with no rainy days gets the all-days mean, as
 * uncertain as the spread between weekdays says.
 */
function estimateRain(usable: ScoredDay[], baseline: (d: ScoredDay) => number | null): RainModel {
  const ratios = new Map<number, number[]>();
  const seen = new Map<number, { all: number; rainy: number }>();
  for (const d of usable) {
    const wd = isoWeekday(d.date);
    const c = seen.get(wd) ?? { all: 0, rainy: 0 };
    c.all += 1;
    if (isRain(d.weather) && d.weather.snow < 0.1) {
      c.rainy += 1;
      const b = baseline(d);
      if (b) ratios.set(wd, [...(ratios.get(wd) ?? []), d.sold / b]);
    }
    seen.set(wd, c);
  }
  // How much one rainy day scatters around its weekday's mean, pooled over
  // every weekday: sum (n_w - 1) s_w^2 / sum (n_w - 1). Pooled, not each
  // weekday's own: with three or four rainy days a weekday's own spread is
  // itself a wild guess, and a small one by chance hands that weekday a huge
  // weight. Measured on pure noise (seven weekdays, three to eight rainy days
  // each), own spreads made some weekday "stand out" in 28% of runs; pooled,
  // 4.5% -- the 5% the 2-standard-error bar is meant to allow.
  const all = [...ratios.values()].flat();
  const n = all.length;
  let dof = 0, ss = 0;
  for (const v of ratios.values()) {
    if (v.length < 2) continue;
    dof += v.length - 1;
    ss += (v.length - 1) * variance(v);
  }
  const s2 = dof > 0 ? ss / dof : variance(all);
  // A floor of one point squared: nothing here is infinitely certain.
  const groups = [...ratios.entries()]
    .map(([wd, v]) => ({ wd, n: v.length, m: mean(v), v: Math.max(s2 / v.length, 1e-4) }));

  let tau2 = 0;
  let mu = n ? mean(all) : 1;
  let seMu = n > 1 ? Math.sqrt(Math.max(variance(all) / n, 1e-4)) : 1;
  if (groups.length >= 2) {
    const w = groups.map((g) => 1 / g.v);
    const W = w.reduce((a, b) => a + b, 0);
    const fixed = groups.reduce((a, g, i) => a + w[i] * g.m, 0) / W;
    const q = groups.reduce((a, g, i) => a + w[i] * (g.m - fixed) ** 2, 0);
    const c = W - w.reduce((a, b) => a + b * b, 0) / W;
    tau2 = c > 0 ? Math.max(0, (q - (groups.length - 1)) / c) : 0;
    const ws = groups.map((g) => 1 / (g.v + tau2));
    const Ws = ws.reduce((a, b) => a + b, 0);
    mu = groups.reduce((a, g, i) => a + ws[i] * g.m, 0) / Ws;
    seMu = Math.sqrt(1 / Ws);
  } else if (groups.length === 1) {
    mu = groups[0].m;
    seMu = Math.sqrt(groups[0].v);
  }

  const byWeekday: WeekdayRain[] = [1, 2, 3, 4, 5, 6, 7].map((wd) => {
    const own = ratios.get(wd) ?? [];
    const g = groups.find((x) => x.wd === wd);
    const c = seen.get(wd);
    const rainShare = c && c.all ? c.rainy / c.all : 0;
    if (g && tau2 > 0) {
      const precision = 1 / g.v + 1 / tau2;
      return { weekday: wd, n: g.n, raw: g.m, rainShare,
               ratio: (g.m / g.v + mu / tau2) / precision, se: Math.sqrt(1 / precision) };
    }
    return { weekday: wd, n: own.length, raw: own.length ? mean(own) : NaN, rainShare,
             ratio: mu, se: Math.sqrt(seMu ** 2 + tau2) };
  });
  return { n, pooled: mu, tau: Math.sqrt(tau2), byWeekday, usable: n >= MIN_BAND_DAYS };
}

export function estimateWeatherEffect(days: ScoredDay[]): WeatherEffect {
  const usable = days.filter((d) => !d.excluded && d.sold > 0);
  const excluded = days.filter((d) => d.excluded).length;

  const temps = usable.map((d) => d.weather.tempMax);
  const tempRange: [number, number] | null =
    temps.length ? [Math.min(...temps), Math.max(...temps)] : null;

  // The dry baseline, per weekday and nearby in time. Everything is
  // expressed relative to this.
  const baseline = baselineOf(usable);

  const byBand: BandEffect[] = [];
  for (const b of ["wet", "heavy", "snow"] as WeatherBand[]) {
    // Each day becomes a ratio against its OWN weekday's dry mean, so the
    // weekday cancels out before anything is pooled.
    const ratios: number[] = [];
    const weekdays = new Set<number>();
    for (const d of usable) {
      if (band(d.weather) !== b) continue;
      // Fewer than two dry days is not a baseline; a weekday without one
      // contributes nothing rather than being compared to the overall mean.
      const base = baseline(d);
      if (base === null) continue;
      ratios.push(d.sold / base);
      weekdays.add(isoWeekday(d.date));
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
    rain: estimateRain(usable, baseline),
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
  /**
   * Rain, when there is a chance of it and the record can speak to it.
   * `ratio` is a rainy day of this weekday against a dry one; `chance` is
   * how likely rain is (1 for a day that has already rained); `relative` is
   * a rainy day against the TYPICAL day the plan is built from -- the factor
   * the production rule thins each item's demand by (model.ts).
   */
  rain?: {
    ratio: number; chance: number; relative: number; weekday: number;
    /** At least 90% sure this weekday's effect is not chance (CREDIBLE_Z):
     *  only then is a cut offered. */
    credible: boolean;
  };
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

  // Rain, by this weekday, weighted by how sure the forecast is. A forecast's
  // amount is one model's guess; its chance is what it actually knows.
  const chance = today.forecast && today.rainChance !== undefined
    ? today.rainChance : (b === "wet" || b === "heavy") ? 1 : 0;
  if (b !== "snow" && chance > 0 && effect.rain.usable) {
    const wd = isoWeekday(today.date);
    const wr = effect.rain.byWeekday[wd - 1];
    const expected = 1 + chance * (wr.ratio - 1);
    const endorsed = wr.se > 0 && Math.abs(wr.ratio - 1) >= MIN_T * wr.se;
    const pct = Math.round((expected - 1) * 1000) / 10;
    return {
      ...base, reason: endorsed ? "ok" : "too-noisy", n: wr.n,
      multiplier: endorsed ? expected : null, pct: endorsed ? pct : null,
      offered: expected, offeredPct: pct, endorsed,
      rain: { ratio: wr.ratio, chance, relative: wr.ratio / typicalFor(effect, wd), weekday: wd,
              credible: wr.se > 0 && Math.abs(wr.ratio - 1) >= CREDIBLE_Z * wr.se },
    };
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
export function planFactor(ratioVsDry: number, effect: WeatherEffect, weekday?: number): number {
  const typical = weekday !== undefined && effect.rain.usable
    ? typicalFor(effect, weekday) : typicalRatio(effect);
  return typical > 0 ? ratioVsDry / typical : ratioVsDry;
}

/**
 * A typical day of one weekday against a dry one: its rainy share at its own
 * rain ratio. The plan for a Saturday is built from Saturdays that were wet
 * about a third of the time, so that is what "normal" already prices in.
 */
export function typicalFor(effect: WeatherEffect, weekday: number): number {
  const wr = effect.rain.byWeekday[weekday - 1];
  if (!wr || !effect.rain.usable) return typicalRatio(effect);
  return 1 + wr.rainShare * (wr.ratio - 1);
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
