/**
 * What today looks like, in one line, before anything has been tapped.
 *
 * This is the "open the app and see it" number. It answers a question the
 * operator actually asks at 5am -- "is today going to be a normal day?" --
 * and it is built from two pieces that carry very different weight:
 *
 *   BASELINE   what this weekday normally sells. Strong. Weekday is the
 *              biggest driver in this business by a distance, and eight
 *              recent Tuesdays is a real sample of Tuesdays.
 *
 *   WEATHER    a modifier on top. Weak, usually, and labelled as such.
 *
 * The two are kept separate all the way to the screen so a wobbly modifier
 * can never quietly contaminate a solid baseline: if the weather says nothing,
 * the baseline still shows.
 *
 * -----------------------------------------------------------------------
 * WHY A DRY DAY READS AS A SMALL PLUS
 *
 * The estimator in weatherEffect.ts measures every band against the same
 * weekday's DRY average, so a dry day is 1.00 by construction. Shown that
 * way, good weather forever reads "0%", which is true against a dry baseline
 * and useless against the question being asked -- the operator wants to know
 * how today compares with a *typical* day, and a typical day includes the
 * rainy ones.
 *
 * So the ratio is re-centred on the whole sample. If a fifth of days are wet
 * and wet days run 7% light, a typical day is about 2% below a dry one, and a
 * dry day is therefore about 2% ABOVE typical. That is the same estimate seen
 * from the other end, not a new claim -- and it is small, which is the honest
 * answer. Fine weather does not add 20% to a sushi kiosk.
 *
 * The corollary matters: the dry uplift is only as trustworthy as the wet
 * estimate it is derived from. So a dry day inherits the confidence of the
 * bands it was re-centred against, and never claims more.
 */

import type { BizDate } from "./businessDay";
import { isoWeekday } from "./businessDay";
import type { DayStatIndex } from "./dayStats";
import type { DayWeather, WeatherBand } from "./weather";
import { band, describe } from "./weather";
import { adviseFor, planFactor, MIN_BAND_DAYS, type WeatherEffect } from "./weatherEffect";
// Re-exported so the home screen and the production sheet are provably
// reading the same conversion, not two copies of it.
export { typicalRatio, planFactor } from "./weatherEffect";

/** Same-weekday days averaged for the baseline. */
export const BASELINE_DAYS = 8;
/** Below this many, there is no baseline worth showing. */
export const MIN_BASELINE_DAYS = 3;

export type OutlookConfidence = "measured" | "weak" | "none";

export interface TodayOutlook {
  date: BizDate;
  /** Null when no location is set, or the fetch has not landed yet. */
  weather: DayWeather | null;
  /** "rain", "clear", "overcast" -- what an operator would say out loud. */
  sky: string | null;
  band: WeatherBand | null;
  /** Units sold on a typical recent day of this weekday. */
  baseline: number | null;
  /** How many same-weekday days went into it. */
  baselineDays: number;
  /** Today versus a typical day of this weekday. 1 = normal. */
  relative: number;
  /** (relative - 1) as a percentage, one decimal. */
  pct: number;
  /** baseline x relative, rounded. Null whenever the baseline is. */
  projected: number | null;
  /** How much the app stands behind the percentage. */
  confidence: OutlookConfidence;
  /** Why the weather contributed nothing, when it did not. */
  reason: "ok" | "unseen-band" | "too-noisy" | "out-of-range" | "no-data"
        | "no-weather";
  /** Days behind the weather modifier. */
  weatherDays: number;
  /** The temperature range on record, for the out-of-range wording. */
  tempRange: [number, number] | null;
}

/**
 * The most recent same-weekday days that were actually counted.
 *
 * Counted is the whole constraint. An uncounted day has unknown leftovers, so
 * its sales are unknown too -- averaging it in as `made` would read every
 * forgotten count as a sell-out and walk the baseline steadily upward.
 */
function sameWeekdayBaseline(
  stats: DayStatIndex, today: BizDate,
): { mean: number | null; days: number } {
  const wd = isoWeekday(today);
  const sold: number[] = [];
  // Newest first, so the window is the most recent N rather than the first N.
  for (let i = stats.dates.length - 1; i >= 0; i--) {
    const date = stats.dates[i];
    if (date >= today) continue;
    if (isoWeekday(date) !== wd) continue;
    const d = stats.byDate.get(date);
    if (!d || d.phase !== "closed" || d.wasted === null) continue;
    sold.push(Math.max(0, d.made - d.wasted));
    if (sold.length >= BASELINE_DAYS) break;
  }
  if (sold.length < MIN_BASELINE_DAYS) return { mean: null, days: sold.length };
  return { mean: sold.reduce((a, b) => a + b, 0) / sold.length, days: sold.length };
}

export function buildTodayOutlook(
  today: BizDate,
  stats: DayStatIndex,
  weather: DayWeather | undefined,
  effect: WeatherEffect | null,
): TodayOutlook {
  const { mean: baseline, days: baselineDays } = sameWeekdayBaseline(stats, today);
  const flat: TodayOutlook = {
    date: today,
    weather: weather ?? null,
    sky: weather ? describe(weather) : null,
    band: weather ? band(weather) : null,
    baseline: baseline === null ? null : Math.round(baseline * 10) / 10,
    baselineDays,
    relative: 1,
    pct: 0,
    projected: baseline === null ? null : Math.round(baseline),
    confidence: "none",
    reason: weather ? "no-data" : "no-weather",
    weatherDays: 0,
    tempRange: effect?.tempRange ?? null,
  };

  if (!weather || !effect) return flat;

  const advice = adviseFor(weather, effect);
  if (!advice) return flat;

  // The band's ratio against a dry day of the same weekday. Dry is 1 by
  // construction; a band that has never been measured has none at all.
  const vsDry = advice.band === "dry" ? 1 : advice.offered;
  if (vsDry === null
      || advice.reason === "out-of-range" || advice.reason === "no-data") {
    return { ...flat, reason: advice.reason, weatherDays: advice.n };
  }

  const relative = planFactor(vsDry, effect);

  // A dry day's uplift is borrowed from the wet estimate, so it cannot be
  // more certain than the estimate it came from.
  const anyUsable = effect.byBand.some((b) => b.usable);
  const anyMeasured = effect.byBand.some((b) => b.n >= MIN_BAND_DAYS);
  const confidence: OutlookConfidence =
    advice.band === "dry"
      ? (anyUsable ? "measured" : anyMeasured ? "weak" : "none")
      : (advice.endorsed ? "measured" : advice.reason === "too-noisy" ? "weak" : "none");

  return {
    ...flat,
    relative,
    pct: Math.round((relative - 1) * 1000) / 10,
    projected: baseline === null ? null : Math.round(baseline * relative),
    confidence,
    reason: advice.reason,
    // A dry day is being compared against every day on record, so the count
    // that supports it is the dry sample, not the (empty) band sample.
    weatherDays: advice.band === "dry" ? effect.dryDays : advice.n,
  };
}
