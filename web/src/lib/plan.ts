/**
 * The plan ahead: what the rule would suggest for each of the coming days.
 *
 * These are ESTIMATES, and every screen that shows one says so. The number on
 * the Make screen on the day is the one to follow. Each morning the rule runs
 * again with whatever has been counted since, so a plan seen days ahead moves:
 * a sell-out tomorrow can add a roll to Friday, a pile of leftovers can take
 * one away, and a change of ambition or menu moves everything. Nothing here is
 * stored -- it is worked out from the record each time, so it cannot go stale.
 *
 * The estimate for day D is the rule run for D on the days counted so far:
 * exactly what the Make screen would say on D if nothing more were counted in
 * between. An item the rule has no opinion on (under a week on record, no
 * price or recipe) takes your usual amount for that weekday, as the Make
 * screen does, and is marked so. The plan itself is what Make would suggest
 * before any weather is applied; where the forecast's rain would lower it,
 * the day also carries `rain` -- the same rule with the rain read in, which
 * Make offers on the day and the day sheet shows ahead of it.
 *
 * How much the estimates move is measured, not assumed. `planDrift` re-runs
 * the rule over the last four weeks as it would have looked 1 and 7 days
 * early, and counts how often the early number matched the morning's. On the
 * record to Sep 21: 93% of items matched a day ahead, 76% a week ahead, and
 * 98% were within one roll either way -- the numbers barely drift, but they
 * do drift, and the screen quotes the live figure rather than these.
 */

import type { BizDate } from "./businessDay";
import { addDays } from "./businessDay";
import type { DayObservation, RecommendOptions } from "./model";
import { recommendFromObservations } from "./model";
import type { Item, Settings } from "./types";

/** How far ahead a plan is estimated. Past this the calendar shows none. */
export const PLAN_DAYS = 14;

export type PlanSource = "rule" | "usual";

export interface PlannedItem {
  itemId: number;
  qty: number;
  /** "rule": the rule's number. "usual": the rule had no opinion, so your
   *  usual amount for the weekday stands in, as it does on Make. */
  source: PlanSource;
  /** The rule's reason, in its own words, when it gave one. */
  reason?: string;
  /** Rolls the climber added: the part most likely to move before the day. */
  climbSteps: number;
  /** One above the most made lately: kept only if the top keeps selling out. */
  testing: boolean;
}

export interface DayPlan {
  date: BizDate;
  /** Marked closed ahead of time: nothing planned. */
  closed: boolean;
  /** Items with something planned, in menu order. */
  items: PlannedItem[];
  total: number;
  /** Ingredients for the whole plan, from recipe costs. */
  ingredients: number;
  /** Some planned item has no recipe cost, so ingredients is at least this. */
  ingredientsIsFloor: boolean;
  /** Extra rolls from the climber, across the case. */
  extraRolls: number;
  /** Items whose number includes a test roll. */
  tests: number;
  /** Items at your usual amount because the rule had no opinion. */
  usualItems: number;
  /** With the forecast's rain read in, where it lowers the total. */
  rain?: { chance: number; ratio: number; total: number };
}

export interface PlanContext {
  items: Item[];
  /** Every item-day on record (toObservations of the whole log). */
  observations: DayObservation[];
  settings: Pick<Settings, "promoWeekdays" | "promoMultiplier" | "salvage" | "labourPerRoll"
    | "saleShare" | "ambition" | "showSuggestions">;
  /** Days whose leftovers were counted; the rule reads nothing else. */
  counted: ReadonlySet<BizDate>;
  /** Your usual amounts for a date's weekday, or null when none are set. */
  usual: (date: BizDate) => { quantities: Record<number, number> } | null;
  /** Days marked closed ahead of time. */
  closed?: ReadonlySet<BizDate>;
  /** Rain forecast for a date, as the rule reads it (weatherEffect's
   *  `advice.rain`): null where there is no forecast or no effect. */
  weatherFor?: (date: BizDate) => { factor: number; chance: number; ratio: number } | null;
}

function ruleOptions(ctx: PlanContext, counted: ReadonlySet<BizDate>): RecommendOptions {
  const s = ctx.settings;
  return {
    promoWeekdays: s.promoWeekdays, promoMultiplier: s.promoMultiplier, salvage: s.salvage,
    labourPerRoll: s.labourPerRoll, saleShare: s.saleShare, ambition: s.ambition, counted,
  };
}

/** The estimated plan for one day, from what is counted now. */
export function planDay(date: BizDate, ctx: PlanContext): DayPlan {
  const empty: DayPlan = {
    date, closed: true, items: [], total: 0, ingredients: 0, ingredientsIsFloor: false,
    extraRolls: 0, tests: 0, usualItems: 0,
  };
  if (ctx.closed?.has(date)) return empty;
  const usual = ctx.usual(date);
  const recs = ctx.settings.showSuggestions
    ? new Map(recommendFromObservations(date, ctx.items, usual, ctx.observations,
                                        ruleOptions(ctx, ctx.counted))
        .recommendations.map((r) => [r.itemId, r]))
    : new Map();
  const wx = ctx.settings.showSuggestions && ctx.weatherFor ? ctx.weatherFor(date) : null;
  const wet = wx && wx.factor < 1
    ? new Map(recommendFromObservations(date, ctx.items, usual, ctx.observations,
                                        { ...ruleOptions(ctx, ctx.counted),
                                          weather: { factor: wx.factor, chance: wx.chance } })
        .recommendations.map((r) => [r.itemId, r]))
    : null;
  let rainTotal = 0;
  const out: DayPlan = { ...empty, closed: false };
  for (const item of ctx.items) {
    const rec = recs.get(item.itemId);
    const fromRule = rec?.modelQty ?? null;
    const qty = fromRule ?? usual?.quantities[item.itemId] ?? 0;
    if (wet) rainTotal += wet.get(item.itemId)?.modelQty ?? qty;
    if (qty <= 0) continue;
    const planned: PlannedItem = {
      itemId: item.itemId, qty,
      source: fromRule === null ? "usual" : "rule",
      reason: fromRule === null ? undefined : rec?.reason,
      climbSteps: fromRule === null ? 0 : rec?.climbSteps ?? 0,
      testing: fromRule !== null && !!rec?.testing && !(rec?.climbSteps),
    };
    out.items.push(planned);
    out.total += qty;
    if (item.unitCost === null) out.ingredientsIsFloor = true;
    else out.ingredients += qty * item.unitCost;
    out.extraRolls += planned.climbSteps;
    if (planned.testing) out.tests += 1;
    if (planned.source === "usual") out.usualItems += 1;
  }
  if (wx && wet && rainTotal < out.total) {
    out.rain = { chance: wx.chance, ratio: wx.ratio, total: rainTotal };
  }
  return out;
}

/** Plans for the `days` days after `today`. Today's own is on Make. */
export function planAhead(today: BizDate, ctx: PlanContext, days = PLAN_DAYS): DayPlan[] {
  return Array.from({ length: days }, (_, i) => planDay(addDays(today, i + 1), ctx));
}

export interface Drift {
  /** Days between seeing the estimate and the day itself. */
  lead: number;
  /** Item-days compared. */
  items: number;
  /** Share where the early number was the morning's number exactly... */
  exact: number;
  /** ...and where it was within one roll either way. */
  withinOne: number;
}

/** Fewer item-days than this and the drift is not quoted. */
export const DRIFT_MIN_ITEMS = 40;

/**
 * How much estimates have moved lately: for each counted day in the last
 * `window` days, the rule as it would have read `lead` days early -- only the
 * days counted before then -- against the rule on the morning itself, item by
 * item. Only the rule's own numbers are compared; usual amounts do not drift.
 * Null for a lead with too little to go on.
 */
export function planDrift(today: BizDate, ctx: PlanContext, leads: number[] = [1, 7],
                          window = 28): (Drift | null)[] {
  const from = addDays(today, -window);
  const days = [...ctx.counted].filter((d) => d >= from && d < today).sort();
  const tally = leads.map(() => ({ items: 0, exact: 0, withinOne: 0 }));
  for (const date of days) {
    const morning = new Map(
      recommendFromObservations(date, ctx.items, null, ctx.observations, ruleOptions(ctx, ctx.counted))
        .recommendations.map((r) => [r.itemId, r.modelQty]));
    leads.forEach((lead, i) => {
      const seen = addDays(date, -lead);
      const early = new Set([...ctx.counted].filter((d) => d < seen));
      for (const r of recommendFromObservations(date, ctx.items, null, ctx.observations,
                                                ruleOptions(ctx, early)).recommendations) {
        const truth = morning.get(r.itemId);
        if (r.modelQty === null || truth === null || truth === undefined) continue;
        const gap = Math.abs(r.modelQty - truth);
        tally[i].items += 1;
        if (gap === 0) tally[i].exact += 1;
        if (gap <= 1) tally[i].withinOne += 1;
      }
    });
  }
  return leads.map((lead, i) => {
    const t = tally[i];
    return t.items < DRIFT_MIN_ITEMS ? null
      : { lead, items: t.items, exact: t.exact / t.items, withinOne: t.withinOne / t.items };
  });
}
