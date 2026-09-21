/**
 * Tests for the app's recommendation rule.
 *
 * The app reimplements the Python `SameWeekdayQuantile` policy so the morning
 * screen works with no server and no connection. That is a correctness risk:
 * if the two drift, the app shows a number the backtest never scored. The
 * fixtures in `TestMatchesPython` are copied from the Python suite and their
 * expected values were produced by running the Python implementation.
 */

import { describe, expect, it } from "vitest";
import {
  criticalRatio, delta, empiricalQuantile, recommendFor, toObservations,
} from "./model";
import type { Entry, Item } from "./types";

const ITEM: Item = {
  itemId: 1, itemKey: "roll", displayName: "roll",
  price: 10, unitCost: 2.5, sortOrder: 0, active: true,
};

function day(n: number): string {
  const d = new Date(2026, 0, 5); // Monday 2026-01-05
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let seq = 0;
function entry(n: number, type: Entry["entryType"], qty: number, itemId = 1): Entry {
  return {
    businessDate: day(n), itemId, entryType: type, quantity: qty,
    mutationId: `m${seq++}`, recordedAt: `2026-01-01T00:00:0${seq % 10}Z`,
  };
}

/** made/wasted for a run of days. */
function history(days: number, made: number, wasted: (i: number) => number): Entry[] {
  const out: Entry[] = [];
  for (let i = 0; i < days; i++) {
    out.push(entry(i, "made", made));
    const w = wasted(i);
    if (w > 0) out.push(entry(i, "waste", w));
  }
  return out;
}

describe("observations", () => {
  it("derives sold as made + refill - wasted", () => {
    const obs = toObservations([entry(0, "made", 8), entry(0, "refill", 2), entry(0, "waste", 3)]);
    expect(obs[0]).toMatchObject({ supply: 10, sold: 7, censored: false });
  });

  it("marks a day with no waste as censored", () => {
    const obs = toObservations([entry(0, "made", 10)]);
    expect(obs[0]).toMatchObject({ sold: 10, censored: true });
  });

  it("clamps negative demand, which means a refill went unrecorded", () => {
    const obs = toObservations([entry(0, "made", 2), entry(0, "waste", 3)]);
    expect(obs[0].sold).toBe(0);
  });

  it("takes the latest write per field, so corrections apply", () => {
    const a = entry(0, "made", 5);
    const b = { ...entry(0, "made", 9), recordedAt: "2027-01-01T00:00:00Z" };
    expect(toObservations([a, b])[0].supply).toBe(9);
  });

  it("ignores a day where nothing was produced", () => {
    expect(toObservations([entry(0, "waste", 3)])).toHaveLength(0);
  });
});

describe("critical ratio", () => {
  it("is the gross margin ratio when there is no salvage", () => {
    expect(criticalRatio(ITEM, day(0), [])).toBeCloseTo(0.75, 10);
  });

  it("drops on a promo day", () => {
    const wed = day(2);
    expect(criticalRatio(ITEM, wed, [3])).toBeCloseTo(1 - 2.5 / (10 * 2 / 3), 10);
    expect(criticalRatio(ITEM, wed, [3])!).toBeLessThan(criticalRatio(ITEM, day(0), [3])!);
  });

  it("is null when cost is missing or exceeds price", () => {
    expect(criticalRatio({ ...ITEM, unitCost: null }, day(0))).toBeNull();
    expect(criticalRatio({ ...ITEM, unitCost: 12 }, day(0))).toBeNull();
  });
});

describe("matches the Python implementation", () => {
  // Values below were produced by analysis.policies._empirical_quantile.
  it("empiricalQuantile agrees on interpolated positions", () => {
    const v = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(empiricalQuantile(v, 0.75)).toBeCloseTo(6.25, 10);
    expect(empiricalQuantile(v, 0.5)).toBeCloseTo(4.5, 10);
    expect(empiricalQuantile(v, 0.0)).toBeCloseTo(1, 10);
    expect(empiricalQuantile(v, 1.0)).toBeCloseTo(8, 10);
  });

  it("handles a single observation and an empty list like Python does", () => {
    expect(empiricalQuantile([4], 0.9)).toBe(4);
    expect(empiricalQuantile([], 0.5)).toBeNaN();
  });

  it("rounds half up to whole units", () => {
    // Eight Mondays selling 0..7, tau = 0.75 -> quantile 5.25 -> 5.
    const entries: Entry[] = [];
    for (let w = 0; w < 8; w++) {
      entries.push(entry(w * 7, "made", 20));
      entries.push(entry(w * 7, "waste", 20 - w));
    }
    const set = recommendFor(day(56), [ITEM], null, entries, []);
    expect(set.recommendations[0].modelQty).toBe(5);
  });
});

describe("recommendations", () => {
  it("never sees the day it is planning for", () => {
    const past = history(40, 10, () => 2);
    const poisoned = [...past, entry(40, "made", 999)];
    const a = recommendFor(day(40), [ITEM], null, past, []);
    const b = recommendFor(day(40), [ITEM], null, poisoned, []);
    expect(a.recommendations).toEqual(b.recommendations);
  });

  it("always carries the naive baseline, per the Phase 5 brief", () => {
    const set = recommendFor(day(40), [ITEM], null, history(40, 10, () => 2), []);
    expect(set.recommendations[0].naiveBaselineQty).not.toBeNull();
  });

  it("returns null rather than zero when there is no opinion", () => {
    const set = recommendFor(day(3), [ITEM], null, history(3, 10, () => 2), []);
    expect(set.recommendations[0].modelQty).toBeNull();
    expect(delta(set.recommendations[0])).toBeNull();
  });

  it("never gives high confidence to an item that sells out most days", () => {
    const set = recommendFor(day(70), [ITEM], null, history(70, 10, () => 0), []);
    expect(set.recommendations[0].confidence).toBe("low");
    expect(set.recommendations[0].caveat).toMatch(/floor/);
  });

  it("gives high confidence to a long clean history", () => {
    const set = recommendFor(day(70), [ITEM], null, history(70, 10, () => 3), []);
    expect(set.recommendations[0].confidence).toBe("high");
  });

  it("cites the leftovers behind a trim", () => {
    // The reason carries the evidence, not the direction: the arrow beside the
    // row already says which way, and repeating it cost the room the counts
    // need. So what is asserted here is that the counts survive.
    const set = recommendFor(day(40), [ITEM], null, history(40, 10, () => 6), []);
    expect(set.recommendations[0].reason).toMatch(/^\d+ left over in \d+ days$/);
  });

  it("cites the sell-outs behind a nudge up", () => {
    const set = recommendFor(day(40), [ITEM], null, history(40, 10, () => 0), []);
    expect(set.recommendations[0].reason).toMatch(/^sold out \d+ of last \d+$/);
  });

  it("keeps every reason short enough to render on one line", () => {
    // These sit in a 340px column on a phone. Past roughly 44 characters the
    // ellipsis starts eating the numbers, which is the only reason to print
    // the line at all.
    for (const h of [history(40, 10, () => 6), history(40, 10, () => 0),
                     history(40, 10, () => 3), history(3, 10, () => 3)]) {
      for (const rec of recommendFor(day(40), [ITEM], null, h, []).recommendations) {
        expect(rec.reason!.length).toBeLessThanOrEqual(44);
      }
    }
  });

  it("flags a promo day at set level and lists heavy sellers", () => {
    const wed = day(30);
    const set = recommendFor(wed, [ITEM], null, history(30, 10, () => 0), [3]);
    expect(set.notes.some((n) => n.includes("Buy-2-get-1"))).toBe(true);
    expect(set.notes.some((n) => n.includes("sell out most days"))).toBe(true);
  });

  it("says plainly that no fitted model is running", () => {
    const set = recommendFor(day(40), [ITEM], null, history(40, 10, () => 2), []);
    expect(set.degraded).toBe(true);
    expect(set.degradedReason).toMatch(/No fitted model/);
  });

  it("computes the delta against the operator's own template", () => {
    const set = recommendFor(day(40), [ITEM], { quantities: { 1: 3 } },
                             history(40, 10, () => 2), []);
    const rec = set.recommendations[0];
    expect(rec.baselineQty).toBe(3);
    expect(delta(rec)).toBe(rec.modelQty! - 3);
  });

  it("is deterministic", () => {
    const h = history(50, 10, (i) => i % 4);
    expect(recommendFor(day(50), [ITEM], null, h, []))
      .toEqual(recommendFor(day(50), [ITEM], null, h, []));
  });
});

describe("quantity floor", () => {
  it("never recommends zero for an item that is being made", () => {
    // Sells out every day at a supply of 1; a low ratio would round below one.
    const cheapMargin: Item = { ...ITEM, price: 10, unitCost: 6 };
    const entries: Entry[] = [];
    for (let w = 0; w < 8; w++) {
      entries.push(entry(w * 7, "made", 1));
      entries.push(entry(w * 7, "waste", 1));
    }
    const set = recommendFor(day(56), [cheapMargin], null, entries, []);
    expect(set.recommendations[0].modelQty).toBeGreaterThanOrEqual(1);
  });

  it("leaves an item that is never made at zero", () => {
    const entries: Entry[] = [];
    for (let w = 0; w < 8; w++) entries.push(entry(w * 7, "made", 0));
    const set = recommendFor(day(56), [ITEM], null, entries, []);
    expect(set.recommendations[0].modelQty).toBe(0);
  });

  it("carries the floor in the model version, so stored recs stay attributable", () => {
    const set = recommendFor(day(40), [ITEM], null, history(40, 10, () => 2), []);
    expect(set.recommendations[0].modelVersion).toContain("f1");
  });
});
