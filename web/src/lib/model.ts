/**
 * Recommendations for the morning screen.
 *
 * This is a deliberate reimplementation of the Python `SameWeekdayQuantile`
 * policy, so the app can produce a recommendation with no server and no
 * connection. The two implementations must agree exactly; `model.test.ts`
 * checks that against fixtures shared with the Python suite. If they ever
 * diverge, the app is showing a number the backtest never scored.
 *
 * As of Phase 4 no fitted model beat this rule out of sample, so this rule IS
 * the recommendation and the screen says so. When a model earns its place it
 * arrives from the server and slots in beside this as a fallback.
 *
 * Measured: -14.1% realised cost against the naive same-weekday mean, over 89
 * walk-forward days. Still well behind the operator's own judgement, which the
 * screen also says.
 */

import type { BizDate } from "./businessDay";
import { isoWeekday, weekdayName } from "./businessDay";
import type { Entry, Item, Recommendation } from "./types";

export const MODEL_NAME = "same_weekday_quantile";
export const MODEL_VERSION = "1.0.0-w8-min4-f1";

const WINDOW = 8;
const MIN_OBSERVATIONS = 4;
const RECENT = 10;
/** An item still on the menu is stocked, not delisted by a calculation. Kept
 *  because it measurably helps (-14.1% vs -10.2% against the naive baseline),
 *  and mirrored from the Python policy so both score the same rule. */
const FLOOR = 1;

/** One item-day as the model sees it. Demand is censored when nothing was left. */
export interface DayObservation {
  date: BizDate;
  itemId: number;
  supply: number;
  sold: number;
  censored: boolean;
}

/**
 * Collapse the append-only entry log into one observation per item-day.
 * Latest write per (date, item, type) wins, which is how corrections apply.
 */
export function toObservations(entries: Entry[]): DayObservation[] {
  const latest = new Map<string, Entry>();
  for (const e of entries) {
    const key = `${e.businessDate}|${e.itemId}|${e.entryType}`;
    const prev = latest.get(key);
    if (!prev || e.recordedAt >= prev.recordedAt) latest.set(key, e);
  }
  const acc = new Map<string, { made: number; refill: number; waste: number; seen: boolean }>();
  for (const e of latest.values()) {
    const key = `${e.businessDate}|${e.itemId}`;
    const row = acc.get(key) ?? { made: 0, refill: 0, waste: 0, seen: false };
    if (e.entryType === "made") { row.made = e.quantity; row.seen = true; }
    if (e.entryType === "refill") row.refill = e.quantity;
    if (e.entryType === "waste") row.waste = e.quantity;
    acc.set(key, row);
  }
  const out: DayObservation[] = [];
  for (const [key, row] of acc) {
    if (!row.seen) continue; // nothing was produced: there was no decision
    const [date, itemId] = key.split("|");
    const supply = row.made + row.refill;
    out.push({
      date, itemId: Number(itemId), supply,
      // Clamped: a few days record more waste than supply, which means a
      // refill went unrecorded. Negative demand is not a thing.
      sold: Math.max(0, supply - row.waste),
      censored: row.waste <= 0,
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** The economics the operator controls. Defaults match the measured setup. */
export interface RatioOptions {
  promoWeekdays?: number[];
  promoMultiplier?: number;
  salvage?: number;
}

/**
 * Critical ratio.
 *
 *   c_u = effective price - unit cost      (margin forgone on a lost sale)
 *   c_o = unit cost - salvage              (sunk into a unit that was binned)
 *   tau = c_u / (c_u + c_o) = (p - c) / (p - salvage)
 *
 * With salvage at zero -- waste counted the morning after, so anything that
 * cleared at markdown is already inside `sold` -- this collapses to the gross
 * margin ratio, 1 - cost/price.
 */
export function criticalRatio(item: Item, date: BizDate,
                              opts: RatioOptions | number[] = {}): number | null {
  // Tolerate the old positional weekday array so nothing silently changes
  // meaning if a caller was missed.
  const o: RatioOptions = Array.isArray(opts) ? { promoWeekdays: opts } : opts;
  const promoWeekdays = o.promoWeekdays ?? [3];
  const promoMultiplier = o.promoMultiplier ?? 2 / 3;
  const salvage = o.salvage ?? 0;

  if (item.price === null || item.unitCost === null || item.price <= 0) return null;
  const price = promoWeekdays.includes(isoWeekday(date))
    ? item.price * promoMultiplier : item.price;

  const cu = price - item.unitCost;
  const co = item.unitCost - salvage;
  // co <= 0 means binning a unit costs nothing, the ratio is 1, and the model
  // says make unlimited stock. That is a real answer to the wrong question, so
  // refuse rather than hand back a number that would be acted on.
  if (cu <= 0 || co <= 0) return null;
  return cu / (cu + co);
}

/** Linear-interpolated empirical quantile. Must match the Python helper. */
export function empiricalQuantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  const frac = pos - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

const roundUp = (x: number) => Math.max(0, Math.floor(x + 0.5));

function confidence(nWeekday: number, selloutRate: number, fallback: boolean) {
  if (fallback || nWeekday < 3) return "low" as const;
  if (selloutRate >= 0.6) return "low" as const;
  if (nWeekday >= 6 && selloutRate < 0.4) return "high" as const;
  return "medium" as const;
}

function describe(
  date: BizDate, recent: DayObservation[], weekdayObs: DayObservation[],
  promo: boolean, fallback: boolean,
): { reason: string; caveat?: string } {
  // Abbreviated: this renders on every one of forty rows in a 340px column,
  // and "Wednesday" spends nine of those characters saying what the header
  // above already says.
  const day = weekdayName(date).slice(0, 3);
  const sellouts = recent.filter((o) => o.censored).length;
  const leftovers = recent.length - sellouts;
  const heavy = recent.length > 0 && sellouts / recent.length >= 0.6;

  if (fallback) {
    return { reason: `too few ${day}s on record — using your plan`,
             caveat: "fewer than 4 comparable days on record" };
  }
  if (recent.length && sellouts >= Math.max(3, Math.floor(0.6 * recent.length))) {
    // No "nudging up": the arrow beside this line already says the direction,
    // and repeating it costs the room the numbers need.
    return { reason: `sold out ${sellouts} of last ${recent.length}`,
             caveat: heavy ? "true demand is higher than anything recorded — this is a floor" : undefined };
  }
  if (recent.length && leftovers >= Math.max(3, Math.floor(0.7 * recent.length))) {
    const wasted = recent.reduce((s, o) => s + Math.max(0, o.supply - o.sold), 0);
    return { reason: `${wasted} left over in ${recent.length} days` };
  }
  if (weekdayObs.length) {
    const typical = weekdayObs.reduce((s, o) => s + o.sold, 0) / weekdayObs.length;
    return { reason: `${day} sells about ${Math.round(typical)}${promo ? ", promo" : ""}` };
  }
  return { reason: `steady ${day}` };
}

export interface RecommendationSet {
  date: BizDate;
  recommendations: Recommendation[];
  degraded: boolean;
  degradedReason: string | null;
  notes: string[];
}

export function recommendFor(
  date: BizDate,
  items: Item[],
  template: { quantities: Record<number, number> } | null,
  entries: Entry[],
  opts: RatioOptions | number[] = {},
): RecommendationSet {
  const ratio: RatioOptions = Array.isArray(opts) ? { promoWeekdays: opts } : opts;
  const promoWeekdays = ratio.promoWeekdays ?? [3];
  // Strictly before the planned day. A recommendation built with same-day data
  // would look excellent and be worthless.
  const observations = toObservations(entries).filter((o) => o.date < date);
  const wd = isoWeekday(date);
  const promo = promoWeekdays.includes(wd);

  const byItem = new Map<number, DayObservation[]>();
  for (const o of observations) {
    const list = byItem.get(o.itemId) ?? [];
    list.push(o);
    byItem.set(o.itemId, list);
  }

  const recommendations: Recommendation[] = [];
  const heavy: string[] = [];

  for (const item of items) {
    const all = byItem.get(item.itemId) ?? [];
    const weekdayObs = all.filter((o) => isoWeekday(o.date) === wd).slice(-WINDOW);
    const recent = all.slice(-RECENT);
    const selloutRate = recent.length
      ? recent.filter((o) => o.censored).length / recent.length : 0;
    const baselineWindow = all.filter((o) => isoWeekday(o.date) === wd).slice(-4);
    const tau = criticalRatio(item, date, ratio);

    const baselineQty = baselineWindow.length >= 2
      ? roundUp(baselineWindow.reduce((s, o) => s + o.sold, 0) / baselineWindow.length)
      : null;

    let modelQty: number | null = null;
    if (weekdayObs.length >= MIN_OBSERVATIONS && tau !== null) {
      const sorted = weekdayObs.map((o) => o.sold).sort((a, b) => a - b);
      modelQty = roundUp(empiricalQuantile(sorted, tau));
      // Only floor items actually being made; something genuinely at zero
      // across its recent history stays at zero.
      if (modelQty < FLOOR && weekdayObs.some((o) => o.supply > 0)) modelQty = FLOOR;
    }

    const fallback = modelQty === null;
    const { reason, caveat } = describe(date, recent, weekdayObs, promo, fallback);
    if (selloutRate >= 0.6) heavy.push(item.displayName);

    recommendations.push({
      itemId: item.itemId,
      baselineQty: template?.quantities[item.itemId] ?? 0,
      // With no usable history the operator's own plan beats a rule fitted to
      // almost nothing, so no delta is shown at all.
      modelQty: fallback ? null : modelQty,
      naiveBaselineQty: baselineQty,
      modelName: MODEL_NAME,
      modelVersion: MODEL_VERSION,
      isFallback: fallback,
      fallbackReason: fallback ? caveat : undefined,
      reason,
      caveat,
      confidence: confidence(weekdayObs.length, selloutRate, fallback),
    });
  }

  const notes: string[] = [];
  if (promo) {
    notes.push("Buy-2-get-1 today: margin per unit is lower, so the target drops even as volume rises.");
  }
  if (heavy.length) {
    notes.push(
      `${heavy.length} item${heavy.length > 1 ? "s" : ""} sell out most days (${heavy.slice(0, 3).join(", ")}${heavy.length > 3 ? "…" : ""}). ` +
      "Their real demand has never been observed, so those numbers are floors, not estimates.",
    );
  }

  return {
    date,
    recommendations,
    degraded: true,
    degradedReason:
      "No fitted model yet — this is the trailing same-weekday quantile, " +
      "which beat the naive baseline by 14% in backtest but is still behind your own judgement.",
    notes,
  };
}

/** What shows beside your number. Null means no opinion, never zero. */
export function delta(rec: Recommendation): number | null {
  if (rec.modelQty === null) return null;
  return rec.modelQty - rec.baselineQty;
}
