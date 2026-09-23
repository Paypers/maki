/**
 * The weather effect estimator.
 *
 * This produces a percentage that an operator will act on, so the failure
 * that matters is not "slightly wrong" -- it is "confident about noise", or
 * "reports a weekday pattern as a weather pattern". Both are tested for
 * explicitly, with fixtures built so the right answer is known in advance.
 */

import { describe, expect, it } from "vitest";
import { adviseFor, estimateWeatherEffect, planFactor, scaleQuantities, typicalRatio,
         MIN_BAND_DAYS, type ScoredDay } from "./weatherEffect";
import type { DayWeather } from "./weather";
import { addDays } from "./businessDay";

const wx = (date: string, precip: number, tempMax = 75, snow = 0): DayWeather => ({
  date, precip, snow, tempMax, tempMin: tempMax - 15,
  code: precip > 0 ? 61 : 0, forecast: false, fetchedAt: "2026-09-21T00:00:00Z",
});

const day = (date: string, sold: number, precip: number,
             over: Partial<ScoredDay> = {}): ScoredDay => ({
  date, sold, censoredShare: 0, weather: wx(date, precip), ...over,
});

/** n days from a Monday, alternating wet/dry, with a known wet effect. */
function series(n: number, dryLevel: number, wetRatio: number,
                start = "2026-06-01"): ScoredDay[] {
  const out: ScoredDay[] = [];
  for (let i = 0; i < n; i++) {
    const date = addDays(start, i);
    const wet = i % 2 === 1;
    out.push(day(date, wet ? dryLevel * wetRatio : dryLevel, wet ? 0.2 : 0));
  }
  return out;
}

describe("estimateWeatherEffect", () => {
  it("recovers a known wet-day effect", () => {
    const e = estimateWeatherEffect(series(56, 100, 0.9));
    const wetE = e.byBand.find((b) => b.band === "wet")!;
    expect(wetE.n).toBeGreaterThanOrEqual(MIN_BAND_DAYS);
    expect(wetE.ratio).toBeCloseTo(0.9, 2);
    expect(wetE.pct).toBeCloseTo(-10, 1);
    expect(e.insufficient).toBe(false);
  });

  it("does NOT report a weekday pattern as a weather effect", () => {
    // The trap this whole file exists to avoid. Sales depend only on the
    // weekday; rain falls only on the low weekday. A naive wet-vs-dry
    // comparison would scream "rain costs you 50%". Comparing within the
    // weekday must find nothing.
    const out: ScoredDay[] = [];
    for (let i = 0; i < 70; i++) {
      const date = addDays("2026-06-01", i);
      const isSunday = new Date(date + "T00:00:00").getDay() === 0;
      // Sunday is a slow day AND is always wet; every other day is dry.
      out.push(day(date, isSunday ? 50 : 100, isSunday ? 0.2 : 0));
    }
    const e = estimateWeatherEffect(out);
    const wetE = e.byBand.find((b) => b.band === "wet")!;
    // Sunday has no dry baseline at all, so it contributes no comparison and
    // the estimator correctly declines to say anything.
    expect(wetE.n).toBe(0);
  });

  it("pools across weekdays, using each weekday's own baseline", () => {
    // Weekday levels differ wildly; the wet penalty is the same 20% on each.
    // The pooled answer must be 0.8, not something dragged by the levels.
    const out: ScoredDay[] = [];
    for (let i = 0; i < 84; i++) {
      const date = addDays("2026-06-01", i);
      const wd = new Date(date + "T00:00:00").getDay();
      const level = [40, 100, 60, 300, 80, 90, 50][wd];
      const wet = i % 3 === 0;
      out.push(day(date, wet ? level * 0.8 : level, wet ? 0.2 : 0));
    }
    const wetE = estimateWeatherEffect(out).byBand.find((b) => b.band === "wet")!;
    expect(wetE.ratio).toBeCloseTo(0.8, 2);
    expect(wetE.weekdays.length).toBe(7);
  });

  it("marks a real but tiny sample as not usable", () => {
    const e = estimateWeatherEffect(series(14, 100, 0.9));
    const wetE = e.byBand.find((b) => b.band === "wet")!;
    expect(wetE.n).toBeLessThan(MIN_BAND_DAYS);
    expect(wetE.usable).toBe(false);
  });

  it("marks a noisy estimate as not usable even with enough days", () => {
    // Wet days swing wildly around the dry mean: the average ratio is ~1 but
    // the variance is huge. n is fine, t is not, so it must not be acted on.
    const out: ScoredDay[] = [];
    for (let i = 0; i < 80; i++) {
      const date = addDays("2026-06-01", i);
      const wet = i % 2 === 1;
      const noisy = i % 4 === 1 ? 10 : 190;
      out.push(day(date, wet ? noisy : 100, wet ? 0.2 : 0));
    }
    const wetE = estimateWeatherEffect(out).byBand.find((b) => b.band === "wet")!;
    expect(wetE.n).toBeGreaterThanOrEqual(MIN_BAND_DAYS);
    expect(wetE.t).toBeLessThan(2);
    expect(wetE.usable).toBe(false);
  });

  it("separates heavy rain from light rain", () => {
    const out: ScoredDay[] = [];
    for (let i = 0; i < 90; i++) {
      const date = addDays("2026-06-01", i);
      const m = i % 3;
      const precip = m === 0 ? 0 : m === 1 ? 0.15 : 0.8;
      const sold = m === 0 ? 100 : m === 1 ? 92 : 70;
      out.push(day(date, sold, precip));
    }
    const e = estimateWeatherEffect(out);
    expect(e.byBand.find((b) => b.band === "wet")!.ratio).toBeCloseTo(0.92, 1);
    expect(e.byBand.find((b) => b.band === "heavy")!.ratio).toBeCloseTo(0.70, 1);
  });

  it("holds out days the operator flagged", () => {
    const base = series(56, 100, 0.9);
    // A store event doubled sales on four wet days. Left in, it would cancel
    // the rain effect; flagged, it must not.
    const flagged = base.map((d, i) =>
      i % 2 === 1 && i < 8 ? { ...d, sold: 200, excluded: true } : d);
    const e = estimateWeatherEffect(flagged);
    expect(e.excluded).toBe(4);
    expect(e.byBand.find((b) => b.band === "wet")!.ratio).toBeCloseTo(0.9, 2);
  });

  it("says it has nothing when there is nothing", () => {
    const e = estimateWeatherEffect([]);
    expect(e.insufficient).toBe(true);
    expect(e.tempRange).toBeNull();
  });

  it("reports the observed temperature range", () => {
    const out = series(30, 100, 0.9).map((d, i) => ({
      ...d, weather: { ...d.weather, tempMax: 60 + i },
    }));
    expect(estimateWeatherEffect(out).tempRange).toEqual([60, 89]);
  });
});

describe("adviseFor", () => {
  const solid = estimateWeatherEffect(
    series(84, 100, 0.9).map((d, i) => ({
      ...d, weather: { ...d.weather, tempMax: 70 + (i % 20) },
    })));

  it("gives a multiplier on a band it has measured", () => {
    const a = adviseFor(wx("2026-09-21", 0.2, 80), solid)!;
    expect(a.reason).toBe("ok");
    expect(a.multiplier).toBeCloseTo(0.9, 2);
    expect(a.pct).toBeCloseTo(-10, 1);
  });

  it("returns a neutral multiplier on a dry day", () => {
    const a = adviseFor(wx("2026-09-21", 0, 80), solid)!;
    expect(a.multiplier).toBe(1);
    expect(a.pct).toBe(0);
  });

  it("refuses to extrapolate outside the observed temperature range", () => {
    // 20°F in January against a record that only ever saw 70-89.
    const a = adviseFor(wx("2027-01-15", 0.2, 20), solid)!;
    expect(a.reason).toBe("out-of-range");
    expect(a.multiplier).toBeNull();
    expect(a.tempRange).toEqual([70, 89]);
  });

  it("refuses a band it has never seen, even in range", () => {
    const a = adviseFor(wx("2026-09-21", 0, 80, 2), solid)!;   // snow
    expect(a.band).toBe("snow");
    expect(a.reason).toBe("unseen-band");
    expect(a.multiplier).toBeNull();
  });

  it("says nothing at all when the history is too thin", () => {
    const thin = estimateWeatherEffect(series(10, 100, 0.9));
    const a = adviseFor(wx("2026-09-21", 0.2, 75), thin)!;
    expect(a.reason).toBe("no-data");
    expect(a.multiplier).toBeNull();
  });

  it("offers a noisy estimate by hand while refusing to endorse it", () => {
    // The operator asked to be able to reach for the number even when the app
    // will not stand behind it. Both halves must be true at once: `offered`
    // carries the figure, `multiplier` stays null, `endorsed` is false.
    const out: ScoredDay[] = [];
    for (let i = 0; i < 80; i++) {
      const date = addDays("2026-06-01", i);
      const wet = i % 2 === 1;
      out.push(day(date, wet ? (i % 4 === 1 ? 10 : 190) : 100, wet ? 0.2 : 0));
    }
    const a = adviseFor(wx("2026-09-21", 0.2, 75), estimateWeatherEffect(out))!;
    expect(a.reason).toBe("too-noisy");
    expect(a.multiplier).toBeNull();
    expect(a.endorsed).toBe(false);
    expect(a.offered).not.toBeNull();
    expect(a.offeredPct).not.toBeNull();
  });

  it("offers nothing at all for a band it has never measured", () => {
    // No figure exists, so there is nothing to reach for -- distinct from the
    // case above, where a figure exists but is weak.
    const a = adviseFor(wx("2026-09-21", 0, 80, 2), solid)!;
    expect(a.offered).toBeNull();
    expect(a.multiplier).toBeNull();
  });

  it("endorses an estimate that clears both bars", () => {
    const a = adviseFor(wx("2026-09-21", 0.2, 80), solid)!;
    expect(a.endorsed).toBe(true);
    expect(a.offered).toBeCloseTo(a.multiplier!, 6);
  });

  it("declines a measured but noisy band rather than acting on it", () => {
    const out: ScoredDay[] = [];
    for (let i = 0; i < 80; i++) {
      const date = addDays("2026-06-01", i);
      const wet = i % 2 === 1;
      out.push(day(date, wet ? (i % 4 === 1 ? 10 : 190) : 100, wet ? 0.2 : 0));
    }
    const noisy = estimateWeatherEffect(out);
    const a = adviseFor(wx("2026-09-21", 0.2, 75), noisy)!;
    expect(a.reason).toBe("too-noisy");
    expect(a.multiplier).toBeNull();
    expect(a.n).toBeGreaterThan(0);
  });

  it("is null when there is no weather for the day", () => {
    expect(adviseFor(undefined, solid)).toBeNull();
  });
});

describe("scaleQuantities", () => {
  const m = (...q: number[]) => new Map(q.map((v, i) => [i + 1, v]));
  const total = (x: Map<number, number>) => [...x.values()].reduce((a, b) => a + b, 0);

  it("moves the TOTAL by the factor, which per-item rounding cannot", () => {
    // The case that broke on the real sheet: thirty items of one to four
    // units. Rounding each by 0.93 leaves every one of them unchanged.
    const q = m(2, 4, 2, 1, 1, 4, 3, 2, 2, 2, 3, 4, 4, 1, 2, 3, 2, 1, 2, 2,
                2, 2, 2, 1, 2, 1, 1, 1, 2, 3, 2);
    const naive = [...q.values()].reduce((s, v) => s + Math.max(1, Math.round(v * 0.931)), 0);
    expect(naive).toBe(total(q));            // per-item rounding: no change at all

    const r = scaleQuantities(q, 0.931);
    expect(r.after).toBeLessThan(r.before);
    expect(r.after / r.before).toBeCloseTo(0.931, 1);
  });

  it("is exact when the arithmetic allows it", () => {
    const r = scaleQuantities(m(10, 10, 10, 10, 10, 10, 10, 10, 10, 10), 0.9);
    expect(r.before).toBe(100);
    expect(r.after).toBe(90);
  });

  it("takes units from the items rounded down hardest", () => {
    // 5 and 4 lose more absolute units at 0.8 than the 1s do, so that is
    // where the cut lands -- not on whichever item sorts first.
    const r = scaleQuantities(m(5, 4, 1, 1), 0.8);
    expect(r.after).toBe(9);                 // round(11 * 0.8)
    expect(r.scaled.get(3)).toBe(1);         // the ones are protected
    expect(r.scaled.get(4)).toBe(1);
  });

  it("never drops an item below one", () => {
    const r = scaleQuantities(m(1, 1, 1, 1, 1, 1), 0.5);
    expect([...r.scaled.values()].every((v) => v >= 1)).toBe(true);
    // The target could not be reached, and `applied` says so honestly rather
    // than claiming the requested cut.
    expect(r.after).toBe(6);
    expect(r.applied).toBe(1);
  });

  it("scales up as well as down", () => {
    const r = scaleQuantities(m(2, 2, 2, 2, 2), 1.2);
    expect(r.after).toBe(12);
  });

  it("is a no-op at factor 1", () => {
    const q = m(3, 1, 4, 1, 5);
    const r = scaleQuantities(q, 1);
    expect(r.scaled).toEqual(q);
    expect(r.applied).toBe(1);
  });

  it("leaves zero-quantity items alone", () => {
    const r = scaleQuantities(m(0, 0, 10, 10), 0.5);
    expect(r.scaled.get(1)).toBe(0);
    expect(r.scaled.get(2)).toBe(0);
    expect(r.after).toBe(10);
  });
});

/**
 * Re-centring, which is the conversion between "measured against dry days"
 * and "applied to a plan built from every kind of day".
 *
 * Getting this wrong is silent in both directions: too much and every rainy
 * day is docked twice, too little and fair weather reads as nothing forever.
 */
describe("planFactor", () => {
  const halfWet = estimateWeatherEffect(series(56, 100, 0.9));

  it("puts a typical day between the wet ratio and a dry one", () => {
    const wet = halfWet.byBand.find((b) => b.band === "wet")!;
    expect(typicalRatio(halfWet)).toBeGreaterThan(wet.ratio);
    expect(typicalRatio(halfWet)).toBeLessThan(1);
  });

  it("softens a wet day, because the baseline already contains rain", () => {
    // Half this record is wet, so a typical day is already 5% below a dry
    // one. Docking the plan the full 10% would charge for the rain twice.
    const wet = halfWet.byBand.find((b) => b.band === "wet")!;
    const f = planFactor(wet.ratio, halfWet);
    expect(f).toBeGreaterThan(wet.ratio);
    expect(f).toBeLessThan(1);
    expect(f).toBeCloseTo(0.9 / 0.95, 2);
  });

  it("turns a dry day into a small plus rather than a flat zero", () => {
    const f = planFactor(1, halfWet);
    expect(f).toBeGreaterThan(1);
    expect(f).toBeCloseTo(1 / 0.95, 2);
  });

  it("is the identity when every day on record was dry", () => {
    // Nothing to re-centre against: no band has been measured, so a plan
    // built from those days is already a plan for dry weather.
    const allDry = estimateWeatherEffect(
      Array.from({ length: 30 }, (_, i) => day(addDays("2026-06-01", i), 100, 0)));
    expect(typicalRatio(allDry)).toBe(1);
    expect(planFactor(0.9, allDry)).toBe(0.9);
  });

  it("the two ends multiply back to the raw ratio", () => {
    // The invariant that keeps the Insights bars and the production sheet
    // talking about the same estimate: one is the other times typicalRatio.
    const wet = halfWet.byBand.find((b) => b.band === "wet")!;
    expect(planFactor(wet.ratio, halfWet) * typicalRatio(halfWet))
      .toBeCloseTo(wet.ratio, 10);
  });
});
