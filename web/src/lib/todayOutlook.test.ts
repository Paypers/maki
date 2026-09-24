/**
 * The home-screen outlook.
 *
 * Two things are being protected here, and they pull in opposite directions:
 *
 *   The card must SAY SOMETHING. A blank home screen is the failure that
 *   started this feature -- the operator wants a number when they open the
 *   app, and "not enough data" on a card that never fills in is useless.
 *
 *   The card must not say MORE than the data supports. A percentage on the
 *   first screen is the most load-bearing number in the app; an unmeasured
 *   band rendered as a confident figure would be worse than no card at all.
 *
 * So most of these tests are about the boundary: what degrades, in what
 * order, and what is refused outright.
 */

import { describe, expect, it } from "vitest";
import { buildTodayOutlook, typicalRatio, MIN_BASELINE_DAYS } from "./todayOutlook";
import { estimateWeatherEffect, type ScoredDay } from "./weatherEffect";
import type { DayStat, DayStatIndex } from "./dayStats";
import type { DayWeather } from "./weather";
import { addDays } from "./businessDay";

const TODAY = "2026-09-22";        // a Tuesday

const wx = (date: string, precip = 0, tempMax = 75): DayWeather => ({
  date, precip, snow: 0, tempMax, tempMin: tempMax - 12, code: precip ? 61 : 0,
  forecast: false, fetchedAt: "2026-09-22T05:00:00Z",
});

const stat = (date: string, made: number, wasted: number | null): DayStat => ({
  date, phase: wasted === null ? "open" : "closed",
  made, wasted, soldOut: wasted === null ? null : 0,
  wasteCost: null, costIsFloor: false, itemsMade: 10,
  sales: null, fee: null, costMade: 0, profit: null, salesIsFloor: false,
  productionConfirmed: true, wasteConfirmed: wasted !== null,
  needsWaste: wasted === null, needsProduction: false,
});

function index(rows: DayStat[]): DayStatIndex {
  return {
    byDate: new Map(rows.map((r) => [r.date, r])),
    dates: rows.map((r) => r.date).sort(),
  };
}

/** N recent Tuesdays, each selling `sold` of `made`. */
function tuesdays(n: number, made: number, sold: number): DayStat[] {
  return Array.from({ length: n }, (_, i) =>
    stat(addDays(TODAY, -7 * (i + 1)), made, made - sold));
}

/**
 * Deterministic jitter on [-0.5, 0.5), so these tests never flake.
 *
 * mulberry32 rather than a one-line LCG: a textbook LCG's successive values
 * are correlated enough that a planted 2% effect measures back as 6%, which
 * would make every fixture here a quiet lie about what it was testing.
 */
function noise(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) - 0.5;
  };
}

/**
 * A synthetic record, with day-to-day variation in it.
 *
 * The variation is not decoration: a record with none gives every band a
 * standard error of zero, t of zero, and nothing would ever be endorsed --
 * the opposite of what a "clean effect" fixture is supposed to test.
 * `spread` is the +/- swing as a share of the mean.
 */
function effectWith(dry: number, wet: number, wetPct: number,
                    spread = 0.10, seed = 11) {
  const rnd = noise(seed);
  const days: ScoredDay[] = [];
  let d = "2026-01-01";
  const sell = (mult: number) => Math.round(100 * mult * (1 + rnd() * 2 * spread));
  for (let i = 0; i < dry; i++) {
    days.push({ date: d, sold: sell(1), censoredShare: 0, weather: wx(d) });
    d = addDays(d, 1);
  }
  for (let i = 0; i < wet; i++) {
    days.push({ date: d, sold: sell(1 - wetPct), censoredShare: 0, weather: wx(d, 0.2) });
    d = addDays(d, 1);
  }
  return estimateWeatherEffect(days);
}

/** Same, plus a well-sampled snow band -- for the "today is a band you have
 *  barely seen" case, which needs SOME band measured or the whole estimate
 *  reads as "no data" instead. */
function effectWithSnowToday() {
  return effectWith(80, 20, 0.10);
}

describe("buildTodayOutlook", () => {
  it("shows the weekday baseline even with no weather at all", () => {
    // The most common first-run state: no ZIP yet. The card still has to be
    // worth looking at, or the operator learns to ignore it.
    const o = buildTodayOutlook(TODAY, index(tuesdays(6, 60, 40)), undefined, null);
    expect(o.baseline).toBe(40);
    expect(o.baselineDays).toBe(6);
    expect(o.projected).toBe(40);
    expect(o.reason).toBe("no-weather");
    expect(o.confidence).toBe("none");
    expect(o.pct).toBe(0);
  });

  it("refuses a baseline from fewer than three counted weekdays", () => {
    const o = buildTodayOutlook(TODAY, index(tuesdays(2, 60, 40)), undefined, null);
    expect(o.baseline).toBeNull();
    expect(o.projected).toBeNull();
    expect(o.baselineDays).toBeLessThan(MIN_BASELINE_DAYS);
  });

  it("ignores uncounted days -- an uncounted day is not a sell-out", () => {
    // `made` on an uncounted day would read as sales and walk the baseline up.
    const rows = [
      ...tuesdays(4, 60, 40),
      stat(addDays(TODAY, -35), 90, null),     // a Tuesday, never counted
    ];
    const o = buildTodayOutlook(TODAY, index(rows), undefined, null);
    expect(o.baseline).toBe(40);
    expect(o.baselineDays).toBe(4);
  });

  it("uses only the same weekday", () => {
    const rows = [
      ...tuesdays(4, 60, 40),
      stat(addDays(TODAY, -1), 60, 0),         // a Monday selling 60
      stat(addDays(TODAY, -2), 60, 0),
    ];
    expect(buildTodayOutlook(TODAY, index(rows), undefined, null).baseline).toBe(40);
  });

  it("takes the most recent weekdays, not the oldest", () => {
    // Eight recent Tuesdays at 40, and older ones at 10. Averaging the wrong
    // end would report a business half its real size.
    const recent = tuesdays(8, 60, 40);
    const old = Array.from({ length: 6 }, (_, i) =>
      stat(addDays(TODAY, -7 * (i + 9)), 60, 50));
    const o = buildTodayOutlook(TODAY, index([...old, ...recent]), undefined, null);
    expect(o.baseline).toBe(40);
    expect(o.baselineDays).toBe(8);
  });

  it("never counts today or a future day in its own baseline", () => {
    const rows = [...tuesdays(4, 60, 40), stat(TODAY, 999, 0)];
    expect(buildTodayOutlook(TODAY, index(rows), undefined, null).baseline).toBe(40);
  });
});

describe("re-centring", () => {
  it("puts a typical day below a dry one whenever bad weather costs anything", () => {
    const e = effectWith(80, 20, 0.10);
    const wet = e.byBand.find((b) => b.band === "wet")!;
    // Strictly between the wet ratio and 1, and at the sample-weighted point:
    // a fifth of days at ~0.90 pulls a typical day about 2% below a dry one.
    expect(typicalRatio(e)).toBeGreaterThan(wet.ratio);
    expect(typicalRatio(e)).toBeLessThan(1);
    expect(typicalRatio(e)).toBeCloseTo((80 + 20 * wet.ratio) / 100, 6);
  });

  it("is exactly 1 when there is no weather variation to re-centre against", () => {
    const e = effectWith(30, 0, 0);
    expect(typicalRatio(e)).toBe(1);
  });

  it("reads a dry day as a small PLUS, not as zero", () => {
    // The whole reason this file exists. Against a dry baseline good weather
    // is 0% forever, which answers a question nobody asked.
    const e = effectWith(80, 20, 0.10);
    const o = buildTodayOutlook(TODAY, index(tuesdays(8, 60, 40)), wx(TODAY), e);
    expect(o.band).toBe("dry");
    expect(o.pct).toBeGreaterThan(0);
    expect(o.pct).toBeLessThan(5);            // small, because the truth is small
    expect(o.projected).toBe(41);             // 40 x ~1.02
  });

  it("reads a wet day as less of a drop than the raw band figure", () => {
    // A -10% day against DRY is a smaller drop against a TYPICAL day, because
    // typical days already include the wet ones. Getting this backwards would
    // double-count the rain.
    const e = effectWith(80, 20, 0.10);
    const raw = Math.abs(e.byBand.find((b) => b.band === "wet")!.pct);
    const o = buildTodayOutlook(TODAY, index(tuesdays(8, 60, 40)), wx(TODAY, 0.2), e);
    expect(o.band).toBe("wet");
    expect(o.pct).toBeLessThan(0);
    expect(Math.abs(o.pct)).toBeLessThan(raw);
    expect(Math.abs(o.pct)).toBeGreaterThan(raw * 0.5);   // reduced, not erased
  });

  it("keeps the two ends consistent: dry x typical = 1", () => {
    const e = effectWith(80, 20, 0.10);
    const dry = buildTodayOutlook(TODAY, index(tuesdays(8, 60, 40)), wx(TODAY), e);
    expect(dry.relative * typicalRatio(e)).toBeCloseTo(1, 6);
  });
});

describe("confidence", () => {
  it("endorses a large, well-sampled effect", () => {
    const o = buildTodayOutlook(TODAY, index(tuesdays(8, 60, 40)),
                                wx(TODAY, 0.2), effectWith(80, 20, 0.10));
    expect(o.confidence).toBe("measured");
    expect(o.reason).toBe("ok");
  });

  it("marks a dry day weak when the wet estimate it borrows from is weak", () => {
    // The trap this guards: a dry day's uplift is derived entirely from the
    // wet estimate, so presenting it as solid would launder a noisy number
    // into a confident one by flipping its sign.
    const noisy = effectWith(40, 10, 0.02);   // a real but tiny effect
    const o = buildTodayOutlook(TODAY, index(tuesdays(8, 60, 40)), wx(TODAY), noisy);
    expect(noisy.byBand.find((b) => b.band === "wet")!.usable).toBe(false);
    expect(o.band).toBe("dry");
    expect(o.confidence).not.toBe("measured");
  });

  it("says nothing at all about a band it has never seen", () => {
    // Rain is well measured; snow has never happened. The rain figure must
    // not be quietly reused for a kind of day it was not measured on.
    const e = effectWithSnowToday();
    // Same temperature as the record, so this tests the BAND guard and not
    // the temperature one.
    const snowy: DayWeather = { ...wx(TODAY, 0.1, 75), snow: 2, code: 73 };
    const o = buildTodayOutlook(TODAY, index(tuesdays(8, 60, 40)), snowy, e);
    expect(o.reason).toBe("unseen-band");
    expect(o.confidence).toBe("none");
    expect(o.pct).toBe(0);
    // The baseline survives: the weather failing to say anything does not
    // take the weekday average down with it.
    expect(o.projected).toBe(40);
  });

  it("refuses to extrapolate past the temperature it has traded in", () => {
    // A rain rule fitted in July has no claim on a January morning.
    const e = effectWith(80, 20, 0.10);        // all fitted at 75F
    const o = buildTodayOutlook(TODAY, index(tuesdays(8, 60, 40)),
                                wx(TODAY, 0.2, 20), e);
    expect(o.reason).toBe("out-of-range");
    expect(o.pct).toBe(0);
    expect(o.projected).toBe(40);
    expect(o.tempRange).not.toBeNull();
  });

  it("still reports the sky when it has nothing to say about sales", () => {
    // Refusing to predict is not a reason to hide the forecast.
    const o = buildTodayOutlook(TODAY, index(tuesdays(8, 60, 40)),
                                wx(TODAY, 0.2, 20), effectWith(80, 20, 0.10));
    expect(o.sky).toBe("rain");
    expect(o.band).toBe("wet");
    expect(o.weather).not.toBeNull();
  });
});

describe("the operator's own numbers", () => {
  it("reproduces the real record: a wet Tuesday runs a few percent light", () => {
    // 76 dry days and 26 wet at about -7% against dry, which is what four
    // months of this kiosk actually looks like. Re-centred that is about -5%,
    // and it must come back marked NOT separable from chance -- the estimate
    // is real but the sample is not big enough to stand behind.
    const e = effectWith(76, 26, 0.07, 0.25);
    const wet = e.byBand.find((b) => b.band === "wet")!;
    expect(wet.n).toBe(26);
    expect(wet.t).toBeLessThan(2);
    expect(wet.usable).toBe(false);            // t under 2 on this much history

    const o = buildTodayOutlook(TODAY, index(tuesdays(8, 60, 40)), wx(TODAY, 0.27), e);
    expect(o.reason).toBe("too-noisy");
    expect(o.confidence).toBe("weak");
    expect(o.pct).toBeLessThan(0);
    expect(o.pct).toBeGreaterThan(-12);
    expect(o.projected).toBeLessThan(40);
  });
});
