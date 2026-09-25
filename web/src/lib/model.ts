/**
 * Recommendations for the morning screen: the per-roll rule.
 *
 * For roll k of an item, estimate the chance it sells, S(k), and suggest it
 * when S(k) clears its break-even, cost / price. That is the newsvendor
 * critical fractile read one roll at a time: roll k earns its price if it
 * sells and costs its cost either way, so it pays exactly when
 * price * S(k) >= cost.
 *
 * S(k) comes from the record with sell-outs read as "at least", never as
 * "exactly" (a weighted Kaplan-Meier product: the chance the next roll sells,
 * given the ones before it did). A roll above the most made lately is a test,
 * made only when that most sold out and the estimate still clears break-even,
 * and never more than one above it.
 *
 * AMBITION. On top sits a climber with an activation point: when an item has
 * sold out on enough of its last 8 days of the same kind, and is popular
 * enough that an extra roll usually sells, it adds up to 1-3 rolls -- but only
 * when it is sure enough that each extra roll pays, and only within a daily
 * budget of extra rolls. How sure, how many and how big a budget are the
 * ambition level, 1 (careful: never climbs) to 5 (max). Details and the
 * measurements behind them are in analysis/rollchance.py.
 *
 * This is a port of `analysis/rollchance.py`, which carries the derivation,
 * the references and the evidence. The two must agree exactly:
 * `model.test.ts` replays the Python-generated cases in
 * `fixtures/roll_chance_cases.json` through this file.
 *
 * Measured on Jun 5 - Sep 21 after the middle man's 20% (tools/compare_rules.py):
 * about level with the operator's own numbers on profit, and $6-10 a day ahead
 * of the old same-weekday quantile, which read every sell-out as the most that
 * could have sold.
 */

import type { BizDate } from "./businessDay";
import { isoWeekday } from "./businessDay";
import type { Entry, Item, Recommendation } from "./types";

// Settings. Every one mirrors analysis/rollchance.py -- change them there,
// regenerate the shared cases, and model.test.ts says what to change here.
/** Weight of a day on a different weekday from the one being planned. */
export const OTHER_WEEKDAY = 0.3;
/** A day this many weeks old counts half as much as yesterday. */
export const HALF_LIFE_WEEKS = 3;
/** Chance the next roll sells, given the ones before it did, where the record
 *  has little or nothing on it. Measured at 57-58%; the rule assumes less. */
export const PRIOR_CONTINUATION = 0.5;
/** Days of evidence that is worth, for a roll made only some days... */
export const PRIOR_STRENGTH = 5;
/** ...and for a roll made on nearly every day, whose record is fair. */
export const PRIOR_STRENGTH_DAILY = 1;
export const DAILY_SHARE = 0.9;
/** A week of an item on record before the rule overrides your own plan. */
export const MIN_DAYS = 7;
/** At most this many rolls above the most made recently. */
export const STEP = 1;
const RECENT_DAYS = 7;
const RECENT_SAME_WEEKDAYS = 2;
/** An item still on the menu is stocked, not delisted by a calculation. */
export const FLOOR = 1;
/** Recent days behind the sell-out count in the reasons and confidence. */
const RECENT = 10;

/** Ambition levels: [how sure extra rolls must be to pay, most rolls above
 *  the base, most extra rolls across the case in a day]. 1 never climbs. */
export const AMBITION: Record<number, [number, number, number] | null> = {
  1: null,
  2: [0.90, 1, 4],
  3: [0.75, 2, 8],
  4: [0.60, 3, 12],
  5: [0.50, 3, 16],
};
export const AMBITION_NAMES: Record<number, string> = {
  1: "Careful", 2: "Cautious", 3: "Balanced", 4: "Bold", 5: "Max",
};
export const DEFAULT_AMBITION = 3;
export const CLIMB_WINDOW = 8;
export const CLIMB_MIN_DAYS = 3;
const POPULARITY_DAYS = 28;
/** Measured here: after the usual amount sold out, how often the next roll
 *  sold, by how much the item sells a day. [upper bound, chance] */
export const CONTINUATION: [number, number][] = [[1, 0.42], [2, 0.62], [Infinity, 0.70]];

const fmt = (x: number) => String(Number(x.toPrecision(12)));
export const MODEL_NAME = "roll_chance";
export const MODEL_VERSION =
  `2.1.0-o${fmt(OTHER_WEEKDAY)}-h${fmt(HALF_LIFE_WEEKS)}-p${fmt(PRIOR_CONTINUATION)}` +
  `-m${fmt(PRIOR_STRENGTH)}/${fmt(PRIOR_STRENGTH_DAILY)}@${fmt(DAILY_SHARE)}-s${STEP}-f${FLOOR}` +
  `-c${CLIMB_WINDOW}/${CLIMB_MIN_DAYS}`;

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
  /** Cost of making one roll on top of its recipe -- time, if you count it. */
  labourPerRoll?: number;
  /** Share of each sale that reaches you. 1 unless the store takes a cut. */
  saleShare?: number;
}

/**
 * What a unit of this item actually sells for on this date.
 *
 * Two kinds of promotion, and they do NOT stack. A flat promo price on the
 * item wins outright: a roll marked $5.99 on Wednesday sells at $5.99, not
 * at two thirds of it. The store-wide buy-2-get-1 multiplier then applies
 * only to items without their own promo price.
 *
 * This is the single point where a price becomes a target quantity, because
 * the critical ratio is (p - c) / p: drop the price and the ratio falls, so
 * the model makes fewer of a discounted item, not more. That is correct and
 * frequently surprising -- a deeper discount on the same cost is a thinner
 * margin, and a thinner margin is less tolerance for binning one.
 */
export function effectivePrice(
  item: Item, date: BizDate,
  promoWeekdays: number[] = [3], promoMultiplier = 2 / 3,
): number | null {
  if (item.price === null) return null;
  const wd = isoWeekday(date);
  if (item.promoPrice != null && item.promoPrice > 0
      && (item.promoWeekdays ?? []).includes(wd)) {
    return item.promoPrice;
  }
  return promoWeekdays.includes(wd) ? item.price * promoMultiplier : item.price;
}

/**
 * Critical ratio.
 *
 *   p   = effective price x the share of it you keep
 *   c   = unit cost + labour per roll
 *   c_u = p - c                            (margin forgone on a lost sale)
 *   c_o = c - salvage                      (sunk into a unit that was binned)
 *   tau = c_u / (c_u + c_o) = (p - c) / (p - salvage)
 *
 * With salvage at zero -- waste counted the morning after, so anything that
 * cleared at markdown is already inside `sold` -- this collapses to the gross
 * margin ratio, 1 - cost/price. Break-even, the chance a roll must have to be
 * worth making, is 1 - tau.
 */
export function criticalRatio(item: Item, date: BizDate,
                              opts: RatioOptions | number[] = {}): number | null {
  // Tolerate the old positional weekday array so nothing silently changes
  // meaning if a caller was missed.
  const o: RatioOptions = Array.isArray(opts) ? { promoWeekdays: opts } : opts;
  const promoWeekdays = o.promoWeekdays ?? [3];
  const promoMultiplier = o.promoMultiplier ?? 2 / 3;
  const salvage = o.salvage ?? 0;
  const labour = o.labourPerRoll ?? 0;
  const share = o.saleShare ?? 1;

  if (item.price === null || item.unitCost === null || item.price <= 0) return null;
  const listed = effectivePrice(item, date, promoWeekdays, promoMultiplier);
  if (listed === null || listed <= 0) return null;
  const price = listed * share;
  const cost = item.unitCost + labour;

  const cu = price - cost;
  const co = cost - salvage;
  // co <= 0 means binning a unit costs nothing, the ratio is 1, and the model
  // says make unlimited stock. That is a real answer to the wrong question, so
  // refuse rather than hand back a number that would be acted on.
  if (cu <= 0 || co <= 0) return null;
  return cu / (cu + co);
}

// ------------------------------------------------------------ the ladder --

/** Everything the rule knows about one item on one day. */
export interface Ladder {
  /** chances[k-1] = estimated chance roll k sells. */
  chances: number[];
  /** Per roll: [weighted days it was a real test, of which it sold]. */
  evidence: [number, number][];
  breakEven: number | null;
  quantity: number | null;
  /** The most made of this item recently; above it is untested. */
  recentMax: number;
  /** The suggestion goes above recentMax: a deliberate test roll. */
  testing: boolean;
  days: number;
  /** What the rule alone says, before any climbing. */
  base: number | null;
  climb: Climb | null;
}

/** Why the climber did, or did not, add rolls. */
export interface Climb {
  /** Rolls added on top of the base, before the daily budget. */
  steps: number;
  /** Recent days of the same kind that made at least the base... */
  days: number;
  /** ...and how many of them sold out. */
  soldOut: number;
  /** Average sold a day lately, and the measured chance that goes with it. */
  popularity: number;
  continuation: number;
  /** Probability the first extra roll pays. */
  confidence: number;
  /** The chance each added roll is expected to sell, best first. */
  edges: number[];
}

const DAY_MS = 86_400_000;
function dayNumber(date: BizDate): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

/** How much each past day counts toward `date`. */
export function weights(date: BizDate, rows: DayObservation[]): number[] {
  const wd = isoWeekday(date);
  const t = dayNumber(date);
  return rows.map((o) => {
    const recency = Math.pow(0.5, (t - dayNumber(o.date)) / (7 * HALF_LIFE_WEEKS));
    return recency * (isoWeekday(o.date) === wd ? 1 : OTHER_WEEKDAY);
  });
}

/** S(1..top) by the shrunk, weighted product-limit estimator. */
export function chances(rows: DayObservation[], w: number[], top: number):
    { chances: number[]; evidence: [number, number][] } {
  let total = 0;
  for (const x of w) total += x;
  let s = 1;
  const out: number[] = [];
  const evidence: [number, number][] = [];
  for (let j = 0; j < top; j++) {
    let made = 0, tried = 0, sold = 0;
    for (let i = 0; i < rows.length; i++) {
      const o = rows[i];
      if (o.supply >= j + 1) {
        made += w[i];
        // Roll j+1 existed and the j before it all sold: a real test.
        if (o.sold >= j) {
          tried += w[i];
          if (o.sold >= j + 1) sold += w[i];
        }
      }
    }
    const m = made >= DAILY_SHARE * total ? PRIOR_STRENGTH_DAILY : PRIOR_STRENGTH;
    s *= (sold + m * PRIOR_CONTINUATION) / (tried + m);
    out.push(s);
    evidence.push([tried, sold]);
  }
  return { chances: out, evidence };
}

function recentDays(date: BizDate, rows: DayObservation[]): DayObservation[] {
  const wd = isoWeekday(date);
  const same = rows.filter((o) => isoWeekday(o.date) === wd).slice(-RECENT_SAME_WEEKDAYS);
  return [...rows.slice(-RECENT_DAYS), ...same];
}

export function recentMax(date: BizDate, rows: DayObservation[]): number {
  return Math.trunc(Math.max(0, ...recentDays(date, rows).map((o) => o.supply)));
}

/** Only a sell-out at the most you made lately makes one more worth testing. */
export function hitTheCeiling(date: BizDate, rows: DayObservation[], ceiling: number): boolean {
  return recentDays(date, rows).some((o) => o.censored && o.supply > 0 && o.supply >= ceiling);
}

/** P(Beta(a, b) >= x) for whole a, b: exactly P(Binomial(a+b-1, x) <= a-1). */
export function betaTail(a: number, b: number, x: number): number {
  if (x <= 0) return 1;
  if (x >= 1) return 0;
  const n = a + b - 1;
  let total = 0;
  for (let j = 0; j < a; j++) total += comb(n, j) * x ** j * (1 - x) ** (n - j);
  return total;
}

function comb(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

export function popularity(rows: DayObservation[]): number {
  const recent = rows.slice(-POPULARITY_DAYS);
  if (!recent.length) return 0;
  let sum = 0;
  for (const o of recent) sum += o.sold;
  return sum / recent.length;
}

export function continuationFor(pop: number): number {
  for (const [upper, chance] of CONTINUATION) if (pop < upper) return chance;
  return CONTINUATION[CONTINUATION.length - 1][1];
}

/** The activation point: climb only when sure enough the extra roll pays. */
export function climbFor(date: BizDate, rows: DayObservation[], base: number,
                         breakEven: number, ambition: number,
                         promoWeekdays: readonly number[] = []): Climb {
  const pop = popularity(rows);
  const cont = continuationFor(pop);
  const promo = promoWeekdays.includes(isoWeekday(date));
  const sameKind = rows.filter((o) => promoWeekdays.includes(isoWeekday(o.date)) === promo);
  const ev = sameKind.slice(-CLIMB_WINDOW).filter((o) => o.supply >= Math.max(1, base));
  const soldOut = ev.filter((o) => o.censored).length;
  const level = AMBITION[ambition] ?? null;
  if (!level || ev.length < CLIMB_MIN_DAYS) {
    return { steps: 0, days: ev.length, soldOut, popularity: pop, continuation: cont,
             confidence: 0, edges: [] };
  }
  const [sure, most] = level;
  const a = 1 + soldOut, b = 1 + ev.length - soldOut;
  const first = betaTail(a, b, breakEven / cont);
  let steps = 0;
  for (let k = 1; k <= most; k++) {
    if (betaTail(a, b, breakEven / cont ** k) >= sure) steps = k;
    else break;
  }
  const mean = a / (a + b);
  const edges: number[] = [];
  for (let k = 1; k <= steps; k++) edges.push(mean * cont ** k);
  return { steps, days: ev.length, soldOut, popularity: pop, continuation: cont,
           confidence: first, edges };
}

/** Extra rolls across the whole case, best bets first, within the budget.
 *  Returns how many climbing rolls each item keeps. */
export function applyBudget(ladders: { key: string; lad: Ladder }[], ambition: number):
    Map<string, number> {
  const out = new Map<string, number>();
  const level = AMBITION[ambition] ?? null;
  const bets: { edge: number; key: string; j: number }[] = [];
  for (const { key, lad } of ladders) {
    out.set(key, 0);
    if (!level || !lad.climb || lad.breakEven === null) continue;
    lad.climb.edges.forEach((chance, i) =>
      bets.push({ edge: chance - lad.breakEven!, key, j: i + 1 }));
  }
  if (!level) return out;
  bets.sort((x, y) => y.edge - x.edge || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0) || x.j - y.j);
  const keep = new Set(bets.slice(0, level[2]).map((b) => `${b.key}\u0000${b.j}`));
  for (const { key } of ladders) {
    let n = 0;
    while (keep.has(`${key}\u0000${n + 1}`)) n += 1;
    out.set(key, n);
  }
  return out;
}

/** The rule for one item. `rows` strictly before `date`, oldest first. */
export function ladderFor(date: BizDate, rows: DayObservation[],
                          breakEven: number | null, ambition = DEFAULT_AMBITION,
                          promoWeekdays: readonly number[] = []): Ladder {
  if (rows.length < MIN_DAYS) {
    return { chances: [], evidence: [], breakEven, quantity: null, recentMax: 0,
             testing: false, days: rows.length, base: null, climb: null };
  }
  const cap = recentMax(date, rows);
  // Every roll the record has touched, plus the ones the cap could reach.
  const top = Math.max(cap + STEP + 1, ...rows.map((o) => Math.trunc(o.supply) + 1));
  const { chances: s, evidence } = chances(rows, weights(date, rows), top);
  if (breakEven === null) {
    return { chances: s, evidence, breakEven, quantity: null, recentMax: cap,
             testing: false, days: rows.length, base: null, climb: null };
  }
  let q = s.filter((p) => p >= breakEven).length;
  q = Math.min(q, cap + (hitTheCeiling(date, rows, cap) ? STEP : 0));
  if (q < FLOOR && rows.slice(-10).some((o) => o.supply > 0)) q = FLOOR;
  const climb = climbFor(date, rows, q, breakEven, ambition, promoWeekdays);
  const total = q + climb.steps;
  return { chances: s, evidence, breakEven, quantity: total, recentMax: cap,
           testing: total > cap, days: rows.length, base: q, climb };
}

/**
 * Chance roll k sells. Past the ladder nothing was ever made, so each further
 * roll gets exactly the prior: half the one before. That is what `chances`
 * would compute there, not an approximation of it.
 */
export function chanceOf(chancesList: readonly number[], k: number): number {
  if (k <= 0) return 1;
  if (!chancesList.length) return 0;
  if (k <= chancesList.length) return chancesList[k - 1];
  return chancesList[chancesList.length - 1]
    * Math.pow(PRIOR_CONTINUATION, k - chancesList.length);
}

export function ordinal(n: number): string {
  const suffix = n % 100 >= 10 && n % 100 <= 20 ? "th"
    : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

export const pct = (p: number) => `${Math.round(100 * p)}%`;

/**
 * Why the rule and your number differ, in the rule's own terms: the chance
 * of the roll in dispute against the chance it needs to pay for itself.
 *   rule above you:  "a 4th would sell 41% of days · needs 23%"
 *   a test roll:     "test a 4th: would sell 44% · needs 23%"
 *   rule below you:  "your 4th sells 12% of days · needs 23%"
 * Written as a sentence, not a code: it wraps to two lines in the narrow
 * column, and two readable lines beat one that has to be deciphered.
 * Null when you agree, or when the rule has no opinion.
 */
export function explainRoll(rec: Recommendation, yours: number): string | null {
  if (rec.modelQty === null || !rec.chances?.length || rec.breakEven == null) return null;
  if (rec.modelQty === yours) return null;
  const needs = `needs ${pct(rec.breakEven)}`;
  // The gap is the climber's: say what set it off, in its own terms.
  if (rec.modelQty > yours && rec.climb && rec.climbSteps && rec.ruleQty != null
      && yours >= rec.ruleQty) {
    return `climbing: sold out ${rec.climb.soldOut} of last ${rec.climb.days} · ` +
      `${pct(rec.climb.confidence)} sure a ${ordinal(rec.ruleQty + 1)} pays`;
  }
  if (rec.modelQty > yours) {
    const k = yours + 1;
    const p = pct(chanceOf(rec.chances, k));
    return rec.testing && rec.modelQty === k
      ? `test a ${ordinal(k)}: would sell ${p} · ${needs}`
      : `a ${ordinal(k)} would sell ${p} of days · ${needs}`;
  }
  return `your ${ordinal(yours)} sells ${pct(chanceOf(rec.chances, yours))} of days · ${needs}`;
}

// ------------------------------------------------------------- reasons --

function confidence(nWeekday: number, selloutRate: number, fallback: boolean) {
  if (fallback || nWeekday < 3) return "low" as const;
  if (selloutRate >= 0.6) return "low" as const;
  if (nWeekday >= 6 && selloutRate < 0.4) return "high" as const;
  return "medium" as const;
}

/** Short -- this renders on one line of a 340px column. */
function describe(recent: DayObservation[], lad: Ladder, fallback: boolean,
                  climbSteps: number): { reason: string; caveat?: string } {
  if (fallback || lad.quantity === null || lad.breakEven === null) {
    return { reason: "under a week on record — your plan",
             caveat: `fewer than ${MIN_DAYS} days on record` };
  }
  if (climbSteps > 0 && lad.climb) {
    return { reason: `climbing +${climbSteps} · sold out ${lad.climb.soldOut} of last ${lad.climb.days}` };
  }
  const q = lad.quantity;
  const needs = `needs ${pct(lad.breakEven)}`;
  const at = (k: number) => pct(chanceOf(lad.chances, k));
  if (lad.testing) {
    return { reason: `testing a ${ordinal(q)} · ~${at(q)}, ${needs}`,
             caveat: "one more than lately — a test roll" };
  }
  const leftovers = recent.filter((o) => !o.censored).length;
  if (recent.length && leftovers >= Math.max(3, Math.floor(0.7 * recent.length))) {
    const wasted = recent.reduce((s, o) => s + Math.max(0, o.supply - o.sold), 0);
    return { reason: `${wasted} left in ${recent.length} days · ${ordinal(q + 1)} ~${at(q + 1)}` };
  }
  return { reason: `${ordinal(q)} ~${at(q)}, ${ordinal(q + 1)} ~${at(q + 1)} · ${needs}` };
}

export interface RecommendationSet {
  date: BizDate;
  recommendations: Recommendation[];
  degraded: boolean;
  degradedReason: string | null;
  notes: string[];
}

export interface RecommendOptions extends RatioOptions {
  /**
   * The days whose leftovers were actually counted. When given, every other
   * day is left out of the rule entirely.
   *
   * An uncounted day has no waste entries, and toObservations reads "no
   * waste" as "sold out, sold everything" -- so without this, a day nobody
   * counted enters the rule as the best day that item ever had. A 74-unit
   * Tuesday left uncounted inflated every Tuesday suggestion after it. Its
   * sales are unknown, so it is not an observation at all: absence is not
   * zero, and it is not a sell-out either.
   */
  counted?: ReadonlySet<BizDate>;
  /** 1 (careful: never climbs) to 5 (max). */
  ambition?: number;
}

export function recommendFor(
  date: BizDate,
  items: Item[],
  template: { quantities: Record<number, number> } | null,
  entries: Entry[],
  opts: RecommendOptions | number[] = {},
): RecommendationSet {
  return recommendFromObservations(date, items, template, toObservations(entries), opts);
}

/**
 * The same, from observations already collapsed out of the entry log -- for
 * callers that run the rule for many days at once (the plan ahead, the
 * ambition check) and would otherwise re-read every entry for each one.
 */
export function recommendFromObservations(
  date: BizDate,
  items: Item[],
  template: { quantities: Record<number, number> } | null,
  allObservations: DayObservation[],
  opts: RecommendOptions | number[] = {},
): RecommendationSet {
  const ratio: RecommendOptions = Array.isArray(opts) ? { promoWeekdays: opts } : opts;
  const promoWeekdays = ratio.promoWeekdays ?? [3];
  const counted = ratio.counted;
  const ambition = AMBITION[ratio.ambition ?? DEFAULT_AMBITION] !== undefined
    ? (ratio.ambition ?? DEFAULT_AMBITION) : DEFAULT_AMBITION;
  // Strictly before the planned day. A recommendation built with same-day data
  // would look excellent and be worthless.
  const observations = allObservations
    .filter((o) => o.date < date && (!counted || counted.has(o.date)));
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

  // Every item's ladder first: the daily budget of climbing rolls is shared
  // across the case, so no item's number is final until all are known.
  const ladders = items.map((item) => {
    const tau = criticalRatio(item, date, ratio);
    const lad = ladderFor(date, byItem.get(item.itemId) ?? [], tau === null ? null : 1 - tau,
                          ambition, promoWeekdays);
    return { key: item.itemKey, lad };
  });
  const allowed = applyBudget(ladders, ambition);
  let climbingRolls = 0, climbingItems = 0;

  items.forEach((item, idx) => {
    const all = byItem.get(item.itemId) ?? [];
    const recent = all.slice(-RECENT);
    const sameWeekday = all.filter((o) => isoWeekday(o.date) === wd);
    const selloutRate = recent.length
      ? recent.filter((o) => o.censored).length / recent.length : 0;
    const lad = ladders[idx].lad;
    const climbSteps = allowed.get(item.itemKey) ?? 0;
    const quantity = lad.base === null ? null : lad.base + climbSteps;
    if (climbSteps > 0) { climbingRolls += climbSteps; climbingItems += 1; }

    // The naive same-weekday mean, kept visible beside every suggestion so a
    // number can always be checked against the dumbest alternative.
    const baselineWindow = sameWeekday.slice(-4);
    const baselineQty = baselineWindow.length >= 2
      ? Math.max(0, Math.floor(baselineWindow.reduce((s, o) => s + o.sold, 0)
          / baselineWindow.length + 0.5))
      : null;

    const fallback = quantity === null;
    const { reason, caveat } = describe(recent, lad, fallback, climbSteps);
    if (selloutRate >= 0.6) heavy.push(item.displayName);

    recommendations.push({
      itemId: item.itemId,
      baselineQty: template?.quantities[item.itemId] ?? 0,
      // With no usable history the operator's own plan beats a rule fitted to
      // almost nothing, so no delta is shown at all.
      modelQty: quantity,
      naiveBaselineQty: baselineQty,
      modelName: MODEL_NAME,
      modelVersion: `${MODEL_VERSION}-a${ambition}`,
      isFallback: fallback,
      fallbackReason: fallback ? caveat : undefined,
      reason,
      caveat,
      confidence: confidence(sameWeekday.slice(-8).length, selloutRate, fallback),
      chances: lad.chances,
      breakEven: lad.breakEven,
      testing: quantity !== null && quantity > lad.recentMax,
      recentMax: lad.recentMax,
      ruleQty: lad.base,
      climb: lad.climb,
      climbSteps,
    });
  });

  const notes: string[] = [];
  if (climbingRolls > 0) {
    notes.push(
      `Ambition ${AMBITION_NAMES[ambition].toLowerCase()}: trying ${climbingRolls} extra ` +
      `roll${climbingRolls === 1 ? "" : "s"} on ${climbingItems} item${climbingItems === 1 ? "" : "s"} ` +
      "that keep selling out. Change the level in Setup → Settings.",
    );
  }
  if (promo) {
    notes.push("Buy-2-get-1 today: each roll earns less, so it needs a better chance of selling to be worth making.");
  }
  if (heavy.length) {
    notes.push(
      `${heavy.length} item${heavy.length > 1 ? "s" : ""} sell out most days (${heavy.slice(0, 3).join(", ")}${heavy.length > 3 ? "…" : ""}). ` +
      "Their real demand is higher than the record shows; the rule estimates it and tests one extra roll at a time.",
    );
  }
  notes.push(
    "A roll is suggested when its chance of selling beats its break-even: cost ÷ price. " +
    "Sell-outs count as “at least”, recent weeks and the same weekday count most, " +
    "and a roll above your usual is tried only after the usual sold out.",
  );

  return { date, recommendations, degraded: false, degradedReason: null, notes };
}

/** What shows beside your number. Null means no opinion, never zero. */
export function delta(rec: Recommendation): number | null {
  if (rec.modelQty === null) return null;
  return rec.modelQty - rec.baselineQty;
}
