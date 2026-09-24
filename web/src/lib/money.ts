/**
 * Money: what a day took in, what it cost, what was thrown away, what was
 * left -- and where the week and the month are heading.
 *
 * Every screen that shows a dollar figure reads it from here, so the home
 * screen, the calendar, the day sheet and the reports can never disagree.
 *
 * How a day's money is worked out (and every piece is an estimate, which the
 * screens say):
 *
 *   sales         units sold x the price the customer paid that day
 *                 (menu price; on a promo weekday the item's promo price, or
 *                 two thirds of it for buy-2-get-1 -- the store gives the
 *                 cheapest of three free, which cannot be split per item from
 *                 end-of-day counts, so two thirds is the average assumed)
 *   middle man    his share of every sale (Settings: share you keep)
 *   ingredients   recipe cost of EVERYTHING made, sold or not
 *   thrown away   the part of that ingredient bill that went in the bin
 *   profit        sales - middle man - ingredients
 *
 * So:  sales = middle man + ingredients of what sold + thrown away + profit,
 * which is the receipt the day sheet and the calendar print.
 *
 * A day whose leftovers were never counted has no sales figure: what sold is
 * unknown. Its ingredient bill is known (production was entered), so that is
 * shown, and nothing else is guessed -- except in a projection, where it is
 * estimated and labelled as estimated.
 */

import type { BizDate } from "./businessDay";
import { addDays, daysBetween, fromBizDate, isoWeekday, toBizDate } from "./businessDay";
import type { DayStat, DayStatIndex } from "./dayStats";
import { effectivePrice } from "./model";
import type { Item, Settings } from "./types";

export interface Economics {
  promoWeekdays: number[];
  promoMultiplier: number;
  /** Share of each sale that reaches the operator, 0..1. */
  saleShare: number;
}

export const DEFAULT_ECONOMICS: Economics = {
  promoWeekdays: [3], promoMultiplier: 2 / 3, saleShare: 1,
};

export function economicsOf(s: Pick<Settings, "promoWeekdays" | "promoMultiplier" | "saleShare">):
    Economics {
  return {
    promoWeekdays: s.promoWeekdays,
    promoMultiplier: s.promoMultiplier,
    saleShare: s.saleShare ?? 1,
  };
}

/** One item on one day. `left` null means the leftovers were never counted. */
export interface ItemMoney {
  /** Null when uncounted: what sold is unknown. */
  sales: number | null;
  fee: number | null;
  /** Ingredients for everything made. */
  cost: number;
  /** Ingredients that went in the bin. Null when uncounted. */
  wasteCost: number | null;
  profit: number | null;
  /** False when the item has no menu price, so its sales are missing. */
  priced: boolean;
  /** False when the item has no recipe cost, so its costs are missing. */
  costed: boolean;
}

export function itemMoney(item: Item, date: BizDate, supply: number, left: number | null,
                          econ: Economics = DEFAULT_ECONOMICS): ItemMoney {
  const unit = item.unitCost && item.unitCost > 0 ? item.unitCost : 0;
  const price = effectivePrice(item, date, econ.promoWeekdays, econ.promoMultiplier) ?? 0;
  const cost = supply * unit;
  if (left === null) {
    return { sales: null, fee: null, cost, wasteCost: null, profit: null,
             priced: price > 0, costed: unit > 0 };
  }
  const sold = Math.max(0, supply - left);
  const sales = sold * price;
  const fee = sales * (1 - econ.saleShare);
  return {
    sales, fee, cost, wasteCost: Math.min(left, supply) * unit,
    profit: sales - fee - cost, priced: price > 0, costed: unit > 0,
  };
}

// ------------------------------------------------------------- periods --

export interface PeriodTotals {
  days: number;
  sales: number;
  fee: number;
  /** Ingredients for everything made. */
  cost: number;
  wasteCost: number;
  profit: number;
  made: number;
  left: number;
}

const zero = (): PeriodTotals =>
  ({ days: 0, sales: 0, fee: 0, cost: 0, wasteCost: 0, profit: 0, made: 0, left: 0 });

function add(a: PeriodTotals, b: PeriodTotals): PeriodTotals {
  return {
    days: a.days + b.days, sales: a.sales + b.sales, fee: a.fee + b.fee,
    cost: a.cost + b.cost, wasteCost: a.wasteCost + b.wasteCost,
    profit: a.profit + b.profit, made: a.made + b.made, left: a.left + b.left,
  };
}

/** A counted day as totals. Null when its money is not known. */
export function dayTotals(d: DayStat): PeriodTotals | null {
  if (d.phase !== "closed" || d.sales === null || d.profit === null) return null;
  return {
    days: 1, sales: d.sales, fee: d.fee ?? 0, cost: d.costMade,
    wasteCost: d.wasteCost ?? 0, profit: d.profit, made: d.made, left: d.wasted ?? 0,
  };
}

/** What a day not yet counted is expected to look like, with its spread. */
export interface DayEstimate {
  mean: PeriodTotals;
  /** Variance of profit and of sales across the days it was drawn from. */
  profitVar: number;
  salesVar: number;
  /** How many counted days it was drawn from. */
  basis: number;
  /** True when too few same weekdays existed and every weekday was used. */
  pooled: boolean;
}

/** Counted days the estimate for one weekday is drawn from. */
export const LOOKBACK = 6;

/**
 * The expected day for `date`: the average of the last six counted days on
 * the same weekday before `today`. A weekday with fewer than two counted days
 * falls back to the last fourteen counted days of any weekday, and says so.
 * Null when nothing has been counted at all.
 */
export function estimateDay(stats: DayStatIndex, today: BizDate, date: BizDate,
                            lookback = LOOKBACK): DayEstimate | null {
  const counted = stats.dates
    .filter((d) => d < today)
    .map((d) => stats.byDate.get(d)!)
    .filter((d) => dayTotals(d) !== null);
  const wd = isoWeekday(date);
  let ref = counted.filter((d) => isoWeekday(d.date) === wd).slice(-lookback);
  let pooled = false;
  if (ref.length < 2) { ref = counted.slice(-14); pooled = true; }
  if (!ref.length) return null;
  const rows = ref.map((d) => dayTotals(d)!);
  const n = rows.length;
  const mean = rows.reduce(add, zero());
  for (const k of ["sales", "fee", "cost", "wasteCost", "profit", "made", "left"] as const) {
    mean[k] /= n;
  }
  mean.days = 1;
  const variance = (k: "profit" | "sales") => n < 2 ? 0
    : rows.reduce((s, r) => s + (r[k] - mean[k]) ** 2, 0) / (n - 1);
  return { mean, profitVar: variance("profit"), salesVar: variance("sales"), basis: n, pooled };
}

export interface PeriodProjection {
  from: BizDate;
  to: BizDate;
  /** Counted days: known. */
  actual: PeriodTotals;
  /** Days still to come, today, and past days never counted: estimated. */
  estimate: PeriodTotals;
  total: PeriodTotals;
  /** About two periods in three land inside these. */
  profitRange: [number, number];
  salesRange: [number, number];
  countedDays: number;
  /** Past days that traded but were never counted, so are estimated. */
  uncountedDays: number;
  /** Today and the days after it. */
  aheadDays: number;
  /** Past days in the period, after the record began, with nothing entered
   *  and not marked closed. They count as $0 -- and the screen says so,
   *  because a day the kiosk traded but nobody entered drags the total down
   *  without any sign of why. */
  blankDays: BizDate[];
  /** False when nothing has ever been counted, so nothing can be projected. */
  canProject: boolean;
  /** Some weekday had too few counted days and every weekday stood in. */
  pooled: boolean;
}

/**
 * The period so far, plus what the rest of it is expected to bring.
 *
 * Counted days are taken as they are. Every other day in the period that the
 * kiosk is expected to trade -- today, the days after it, and past days that
 * traded but were never counted -- gets the estimate above. Past days with
 * nothing recorded, and days marked closed, count as nothing. The range adds
 * up each estimated day's own spread (days are treated as independent), so a
 * week with four days left is less certain than one with a day left.
 */
export function projectPeriod(stats: DayStatIndex, today: BizDate, from: BizDate, to: BizDate):
    PeriodProjection {
  let actual = zero();
  let estimate = zero();
  let profitVar = 0, salesVar = 0;
  let countedDays = 0, uncountedDays = 0, aheadDays = 0;
  const blankDays: BizDate[] = [];
  let canProject = false, pooled = false;
  const first = stats.dates[0];

  for (let d = from; d <= to; d = addDays(d, 1)) {
    const stat = stats.byDate.get(d);
    const known = stat ? dayTotals(stat) : null;
    if (known) { actual = add(actual, known); countedDays += 1; continue; }
    if (stat?.phase === "outage") continue;
    const ahead = d >= today;
    const uncounted = !ahead && stat?.phase === "open";
    // Before the record starts, or a past day with nothing on it: not a
    // trading day the app knows of, so it is not invented -- but a blank past
    // day inside the record is named, so its $0 is not mistaken for a result.
    if (!first || d < first) continue;
    if (!ahead && !uncounted) { blankDays.push(d); continue; }
    const est = estimateDay(stats, today, d);
    if (!est) continue;
    canProject = true;
    pooled ||= est.pooled;
    estimate = add(estimate, est.mean);
    profitVar += est.profitVar;
    salesVar += est.salesVar;
    if (ahead) aheadDays += 1; else uncountedDays += 1;
  }
  const total = add(actual, estimate);
  const pSd = Math.sqrt(profitVar), sSd = Math.sqrt(salesVar);
  return {
    from, to, actual, estimate, total,
    profitRange: [total.profit - pSd, total.profit + pSd],
    salesRange: [total.sales - sSd, total.sales + sSd],
    countedDays, uncountedDays, aheadDays, blankDays,
    canProject: canProject || countedDays > 0, pooled,
  };
}

/** Monday to Sunday around `date`. */
export function weekOf(date: BizDate): [BizDate, BizDate] {
  const monday = addDays(date, -(isoWeekday(date) - 1));
  return [monday, addDays(monday, 6)];
}

/** The 1st to the last day of `date`'s month. */
export function monthOf(date: BizDate): [BizDate, BizDate] {
  const d = fromBizDate(date);
  return [toBizDate(new Date(d.getFullYear(), d.getMonth(), 1)),
          toBizDate(new Date(d.getFullYear(), d.getMonth() + 1, 0))];
}

export function daysIn(from: BizDate, to: BizDate): number {
  return daysBetween(from, to) + 1;
}

// ------------------------------------------------------------ formatting --

/** "$1,234", "−$34". Whole dollars: cents on a sushi estimate are noise. */
export function usd(x: number): string {
  const r = Math.round(x);
  const s = `$${Math.abs(r).toLocaleString("en-US")}`;
  return r < 0 ? `−${s}` : s;
}

/** Compact for a calendar cell: "$152", "$1.2k", "−$8". */
export function usdShort(x: number): string {
  const r = Math.round(x);
  const a = Math.abs(r);
  const s = a >= 1000 ? `$${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k` : `$${a}`;
  return r < 0 ? `−${s}` : s;
}

export function share(part: number, whole: number): string {
  if (!whole) return "—";
  return `${Math.round((100 * part) / whole)}%`;
}
