/**
 * One row per calendar day: what was made, what came back, what it cost, and
 * what still needs doing.
 *
 * The calendar, the day sheet and the home screen all need the same rollup,
 * and it is the kind of thing that goes subtly wrong in three different ways
 * if each screen computes it itself -- so it is computed once, here, and
 * tested.
 *
 * The distinction this file exists to protect: a day with production and no
 * confirmed waste count is NOT a day with zero waste. It is a day whose
 * leftovers are unknown, and it has to read that way everywhere -- a dash on
 * the sheet, an amber ring on the calendar, a line in the waiting list.
 */

import type { BizDate } from "./businessDay";
import { daysBetween } from "./businessDay";
import { toObservations } from "./model";
import { DEFAULT_ECONOMICS, itemMoney, type Economics } from "./money";
import type { DayRecord, Entry, Item } from "./types";

export type DayPhase =
  | "future"    // hasn't happened
  | "empty"     // past, nothing recorded -- the kiosk may not have opened
  | "outage"    // explicitly marked closed
  | "open"      // production recorded, leftovers not counted yet
  | "closed";   // both halves done

export interface DayStat {
  date: BizDate;
  phase: DayPhase;
  /** Units put out, made + refill. */
  made: number;
  /** Null until the count is confirmed. Absence is not zero. */
  wasted: number | null;
  /** Items that ran out. Null until counted, for the same reason. */
  soldOut: number | null;
  /** What the waste cost, or null if it cannot be priced yet. */
  wasteCost: number | null;
  /** True when some item in the day has no recipe, so cost is a floor. */
  costIsFloor: boolean;
  /** What customers paid, estimated from menu prices. Null until counted:
   *  what sold is unknown before then. See lib/money.ts for the method. */
  sales: number | null;
  /** The middle man's share of those sales. Null until counted. */
  fee: number | null;
  /** Ingredients for everything made -- known as soon as production is in. */
  costMade: number;
  /** sales - fee - costMade. Null until counted. */
  profit: number | null;
  /** True when something that sold has no menu price, so sales is a floor. */
  salesIsFloor: boolean;
  itemsMade: number;
  productionConfirmed: boolean;
  wasteConfirmed: boolean;
  /** Leftovers are outstanding: it traded, the count was never confirmed. */
  needsWaste: boolean;
  /** Production is outstanding: today, or yesterday if it was half-started. */
  needsProduction: boolean;
}

export interface DayStatIndex {
  byDate: Map<BizDate, DayStat>;
  /** Every date with any record, oldest first. */
  dates: BizDate[];
}

export function buildDayStats(
  entries: Entry[],
  days: DayRecord[],
  items: Item[],
  today: BizDate,
  econ: Economics = DEFAULT_ECONOMICS,
): DayStatIndex {
  const byId = new Map(items.map((i) => [i.itemId, i]));
  const obs = toObservations(entries);

  const acc = new Map<BizDate, {
    made: number; wasted: number; soldOut: number; itemsMade: number;
    wasteCost: number; costIsFloor: boolean;
    sales: number; fee: number; costMade: number; salesIsFloor: boolean;
  }>();
  for (const o of obs) {
    const row = acc.get(o.date)
      ?? { made: 0, wasted: 0, soldOut: 0, itemsMade: 0, wasteCost: 0, costIsFloor: false,
           sales: 0, fee: 0, costMade: 0, salesIsFloor: false };
    const left = Math.max(0, o.supply - o.sold);
    row.made += o.supply;
    row.wasted += left;
    row.itemsMade += 1;
    if (o.censored) row.soldOut += 1;
    const item = byId.get(o.itemId);
    if (item) {
      // Money as if counted; the day-level fields below blank it out when
      // the count was never confirmed.
      const m = itemMoney(item, o.date, o.supply, left, econ);
      row.sales += m.sales ?? 0;
      row.fee += m.fee ?? 0;
      row.costMade += m.cost;
      row.wasteCost += m.wasteCost ?? 0;
      if (!m.costed && o.supply > 0) row.costIsFloor = true;
      if (!m.priced && o.sold > 0) row.salesIsFloor = true;
    } else if (o.supply > 0) {
      row.costIsFloor = true;
      if (o.sold > 0) row.salesIsFloor = true;
    }
    acc.set(o.date, row);
  }

  const dayByDate = new Map(days.map((d) => [d.businessDate, d]));
  const all = new Set<BizDate>([...acc.keys(), ...dayByDate.keys()]);

  const byDate = new Map<BizDate, DayStat>();
  for (const date of all) {
    const rec = dayByDate.get(date);
    const row = acc.get(date);
    const age = daysBetween(date, today);
    const traded = !!row && row.itemsMade > 0;
    const wasteConfirmed = !!rec?.wasteConfirmedAt;
    const productionConfirmed = !!rec?.productionConfirmedAt;
    const isOutage = !!rec?.isOutage;

    const phase: DayPhase =
      age < 0 ? "future"
      : isOutage ? "outage"
      : !traded ? "empty"
      : wasteConfirmed ? "closed"
      : "open";

    byDate.set(date, {
      date,
      phase,
      made: row?.made ?? 0,
      wasted: wasteConfirmed ? (row?.wasted ?? 0) : null,
      soldOut: wasteConfirmed ? (row?.soldOut ?? 0) : null,
      wasteCost: wasteConfirmed && row ? row.wasteCost : null,
      costIsFloor: row?.costIsFloor ?? false,
      sales: wasteConfirmed && row ? row.sales : null,
      fee: wasteConfirmed && row ? row.fee : null,
      costMade: row?.costMade ?? 0,
      profit: wasteConfirmed && row ? row.sales - row.fee - row.costMade : null,
      salesIsFloor: row?.salesIsFloor ?? false,
      itemsMade: row?.itemsMade ?? 0,
      productionConfirmed,
      wasteConfirmed,
      // Yesterday and older: it traded and was never counted. Not today --
      // today's leftovers are still in the case.
      needsWaste: traded && !wasteConfirmed && !isOutage && age > 0,
      needsProduction: age === 0 && !productionConfirmed && !isOutage,
    });
  }

  return { byDate, dates: [...byDate.keys()].sort() };
}

/** A blank day, so callers never have to branch on "no record". */
export function emptyDay(date: BizDate, today: BizDate): DayStat {
  return {
    date,
    phase: daysBetween(date, today) < 0 ? "future" : "empty",
    made: 0, wasted: null, soldOut: null, wasteCost: null, costIsFloor: false,
    sales: null, fee: null, costMade: 0, profit: null, salesIsFloor: false,
    itemsMade: 0, productionConfirmed: false, wasteConfirmed: false,
    needsWaste: false,
    needsProduction: date === today,
  };
}

/** Waste rate, 0..1, or null when the day was never counted. */
export function wasteRate(d: DayStat): number | null {
  if (d.wasted === null || d.made <= 0) return null;
  return d.wasted / d.made;
}
