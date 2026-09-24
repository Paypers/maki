/**
 * The ambition check: is the current ambition level paying?
 *
 * Ambition makes the rule add rolls to items that keep selling out. Whether
 * that pays at THIS kiosk cannot be known from past records -- nobody can see
 * what rolls that were never made would have sold -- so it is judged live,
 * from three things that are all counted, not estimated:
 *
 *   1. the climber's extra rolls you actually made: how many sold, and what
 *      they earned after the middle man and their ingredients. Exact, because
 *      a roll that was made either sold or came back.
 *   2. waste: the share of rolls left over, recent days against the days
 *      before the level was changed (or the four weeks before, if never).
 *   3. profit a day, the same two windows -- called up or down only when the
 *      gap is bigger than twice its own noise, since one good Friday proves
 *      nothing.
 *
 * One verdict comes out, with the numbers behind it:
 *   early     fewer than 7 counted days to judge by -- or the extra rolls it
 *             suggests are mostly not being made, so there is nothing to judge
 *   too-high  the extra rolls are losing money, or waste is up for no more profit
 *   paying    the extra rolls are earning, or profit is up beyond the noise
 *   room      many items still sell out and nothing says ambition is costing
 *   steady    none of the above
 */

import type { BizDate } from "./businessDay";
import { addDays } from "./businessDay";
import type { DayStatIndex } from "./dayStats";
import { AMBITION, AMBITION_NAMES, effectivePrice, recommendFor, toObservations } from "./model";
import type { Entry, Item, Settings } from "./types";

export type AmbitionVerdict = "early" | "too-high" | "paying" | "room" | "steady";

export interface WindowStats {
  days: number;
  profitPerDay: number;
  /** Sample standard deviation of daily profit, for the noise test. */
  profitSd: number;
  /** Share of rolls made that were left over, 0..1. */
  wasteShare: number;
  /** Share of item-days that sold out, 0..1. */
  selloutShare: number;
}

export interface ExtraRolls {
  /** Extra rolls the climber suggested on the recent days. */
  suggested: number;
  /** ...how many of them you actually made... */
  made: number;
  /** ...how many of those sold... */
  sold: number;
  /** ...and what they earned: sales after the middle man, less ingredients. */
  dollars: number;
}

export interface AmbitionCheck {
  level: number;
  name: string;
  verdict: AmbitionVerdict;
  /** One plain sentence for the front page. */
  headline: string;
  recent: WindowStats;
  before: WindowStats | null;
  extra: ExtraRolls;
}

/** At least this many counted days before anything is concluded. */
export const MIN_DAYS = 7;
/** Extra rolls needed before their dollars are trusted either way. */
export const MIN_EXTRA = 8;

function windowStats(stats: DayStatIndex, from: BizDate, to: BizDate): WindowStats {
  const days = stats.dates
    .filter((d) => d >= from && d < to)
    .map((d) => stats.byDate.get(d)!)
    .filter((d) => d.phase === "closed" && d.profit !== null);
  const n = days.length;
  const profits = days.map((d) => d.profit!);
  const mean = n ? profits.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(profits.reduce((s, p) => s + (p - mean) ** 2, 0) / (n - 1)) : 0;
  const made = days.reduce((s, d) => s + d.made, 0);
  const left = days.reduce((s, d) => s + (d.wasted ?? 0), 0);
  const itemDays = days.reduce((s, d) => s + d.itemsMade, 0);
  const soldOut = days.reduce((s, d) => s + (d.soldOut ?? 0), 0);
  return {
    days: n, profitPerDay: mean, profitSd: sd,
    wasteShare: made ? left / made : 0,
    selloutShare: itemDays ? soldOut / itemDays : 0,
  };
}

/**
 * Re-run the rule for each recent counted day, exactly as it would have run
 * that morning, and settle up every extra roll it suggested that you made.
 */
function settleExtraRolls(entries: Entry[], items: Item[], settings: Settings,
                          counted: ReadonlySet<BizDate>, days: BizDate[]): ExtraRolls {
  const out: ExtraRolls = { suggested: 0, made: 0, sold: 0, dollars: 0 };
  if (!AMBITION[settings.ambition]) return out;
  const obs = toObservations(entries);
  const byKey = new Map(obs.map((o) => [`${o.date}|${o.itemId}`, o]));
  const byId = new Map(items.map((i) => [i.itemId, i]));
  for (const date of days) {
    const recs = recommendFor(date, items, null, entries, {
      promoWeekdays: settings.promoWeekdays, promoMultiplier: settings.promoMultiplier,
      salvage: settings.salvage, labourPerRoll: settings.labourPerRoll,
      saleShare: settings.saleShare, counted, ambition: settings.ambition,
    }).recommendations;
    for (const rec of recs) {
      const steps = rec.climbSteps ?? 0;
      if (!steps || rec.ruleQty == null) continue;
      out.suggested += steps;
      const o = byKey.get(`${date}|${rec.itemId}`);
      const item = byId.get(rec.itemId);
      if (!o || !item || o.supply <= rec.ruleQty) continue;
      const extra = Math.min(o.supply, rec.ruleQty + steps) - rec.ruleQty;
      const sold = Math.max(0, Math.min(extra, o.sold - rec.ruleQty));
      const price = (effectivePrice(item, date, settings.promoWeekdays, settings.promoMultiplier) ?? 0)
        * (settings.saleShare ?? 1);
      const cost = (item.unitCost ?? 0) + (settings.labourPerRoll ?? 0);
      out.made += extra;
      out.sold += sold;
      out.dollars += sold * price - extra * cost;
    }
  }
  return out;
}

const pct = (x: number) => `${Math.round(100 * x)}%`;
const usd = (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(Math.round(x)).toLocaleString("en-US")}`;

export function checkAmbition(stats: DayStatIndex, entries: Entry[], items: Item[],
                              settings: Settings, today: BizDate): AmbitionCheck {
  const level = AMBITION[settings.ambition] !== undefined ? settings.ambition : 3;
  const name = AMBITION_NAMES[level];
  // Judge from the change if it was recent; otherwise the last two weeks.
  const since = settings.ambitionSince;
  const recentFrom = since && since > addDays(today, -28) ? since : addDays(today, -14);
  const recent = windowStats(stats, recentFrom, today);
  const beforeStats = windowStats(stats, addDays(recentFrom, -28), recentFrom);
  const before = beforeStats.days ? beforeStats : null;

  const counted = new Set(stats.dates.filter((d) => stats.byDate.get(d)?.wasteConfirmed));
  const recentDays = stats.dates.filter((d) => d >= recentFrom && d < today && counted.has(d));
  const extra = settleExtraRolls(entries, items, settings, counted, recentDays);

  const result = (verdict: AmbitionVerdict, headline: string): AmbitionCheck =>
    ({ level, name, verdict, headline, recent, before, extra });

  const madeNote = extra.suggested && extra.made < extra.suggested
    ? ` It suggested ${extra.suggested} extra rolls; you made ${extra.made}.` : "";

  if (level === 1) {
    return recent.selloutShare >= 0.45
      ? result("room", `Ambition is off. ${pct(recent.selloutShare)} of items sell out on a typical day — ` +
               "there may be money left; try Cautious.")
      : result("steady", "Ambition is off: the rule never goes above what it can prove.");
  }
  if (recent.days < MIN_DAYS) {
    return result("early", `Too early to judge ${name}: ${recent.days} of ${MIN_DAYS} counted days so far.${madeNote}`);
  }

  // Suggestions nobody follows cannot be judged; waste and profit moving on
  // those days are not the level's doing.
  if (extra.suggested >= MIN_EXTRA && extra.made < extra.suggested / 4) {
    return result("early", `Not judged yet: ${name} suggested ${extra.suggested} extra rolls on items that ` +
      `keep selling out, and ${extra.made} ${extra.made === 1 ? "was" : "were"} made. Make them for a week ` +
      "or two and this will tell you whether they pay.");
  }

  const diff = before ? recent.profitPerDay - before.profitPerDay : 0;
  const noise = before
    ? 2 * Math.sqrt(recent.profitSd ** 2 / recent.days + before.profitSd ** 2 / before.days) : Infinity;
  const profitUp = before !== null && diff > noise;
  const wasteUp = before !== null && recent.wasteShare - before.wasteShare >= 0.05;
  const judged = extra.made >= MIN_EXTRA;

  if ((judged && extra.dollars < 0) || (wasteUp && !profitUp)) {
    return result("too-high", judged && extra.dollars < 0
      ? `Ambition may be too high: the extra rolls sold ${extra.sold} of ${extra.made} and lost ${usd(-extra.dollars)}. Try one level down.`
      : `Ambition may be too high: ${pct(recent.wasteShare)} of rolls left over (was ${pct(before!.wasteShare)}) ` +
        `for about the same profit. Try one level down.`);
  }
  if ((judged && extra.dollars > 0) || profitUp) {
    return result("paying", judged && extra.dollars > 0
      ? `${name} is paying: the extra rolls sold ${extra.sold} of ${extra.made}, +${usd(extra.dollars)} after costs.${madeNote}`
      : `${name} is paying: profit ${usd(recent.profitPerDay)} a day, up from ${usd(before!.profitPerDay)}.`);
  }
  if (level < 5 && recent.selloutShare >= 0.45 && !wasteUp) {
    return result("room", `${pct(recent.selloutShare)} of items still sell out on a typical day and nothing says ` +
                  `${name} is costing you — there may be more to squeeze. Try one level up.${madeNote}`);
  }
  return result("steady", before
    ? `${name} looks steady: ${pct(recent.wasteShare)} left over (was ${pct(before.wasteShare)}), ` +
      `profit ${usd(recent.profitPerDay)} a day (was ${usd(before.profitPerDay)}).${madeNote}`
    : `${name} looks steady: ${pct(recent.wasteShare)} left over, profit ${usd(recent.profitPerDay)} a day.${madeNote}`);
}
