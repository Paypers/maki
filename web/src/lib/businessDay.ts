/**
 * Business-day arithmetic.
 *
 * Waste is counted the morning AFTER the day it belongs to, so "what day is it"
 * is the single most dangerous question in this app. Getting it wrong files a
 * whole day's waste against the wrong date and silently corrupts every model
 * downstream. All of it lives here, is pure, and is unit-tested.
 *
 * Dates are handled as local-time calendar days and carried as 'YYYY-MM-DD'
 * strings. Never a Date object across a boundary: a Date is a UTC instant, and
 * a kiosk in Maryland entering waste at 00:30 EDT is on the previous UTC day.
 */

export type BizDate = string; // 'YYYY-MM-DD'

/** Rollover hour in local time. 0 = the business day flips at midnight. */
export const DEFAULT_ROLLOVER_HOUR = 0;

export function toBizDate(d: Date): BizDate {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function fromBizDate(s: BizDate): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d); // local midnight, not UTC
}

/** The business date "now" belongs to, given the rollover hour. */
export function currentBizDate(now: Date, rolloverHour = DEFAULT_ROLLOVER_HOUR): BizDate {
  const shifted = new Date(now.getTime());
  shifted.setHours(shifted.getHours() - rolloverHour);
  return toBizDate(shifted);
}

export function addDays(s: BizDate, n: number): BizDate {
  const d = fromBizDate(s);
  d.setDate(d.getDate() + n);
  return toBizDate(d);
}

export function previousDay(s: BizDate): BizDate {
  return addDays(s, -1);
}

/** Same weekday, n weeks back. Used for the "vs last week" comparison. */
export function weeksBack(s: BizDate, weeks = 1): BizDate {
  return addDays(s, -7 * weeks);
}

/** ISO weekday, 1 = Monday .. 7 = Sunday. Matches template_assignments.weekday. */
export function isoWeekday(s: BizDate): number {
  const js = fromBizDate(s).getDay(); // 0 = Sunday
  return js === 0 ? 7 : js;
}

const WEEKDAY_NAMES = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
];

export function weekdayName(s: BizDate): string {
  return WEEKDAY_NAMES[isoWeekday(s) - 1];
}

export function formatShort(s: BizDate): string {
  const d = fromBizDate(s);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function daysBetween(a: BizDate, b: BizDate): number {
  return Math.round((fromBizDate(b).getTime() - fromBizDate(a).getTime()) / 86_400_000);
}

export interface DayState {
  date: BizDate;
  hasProduction: boolean;
  productionConfirmed: boolean;
  wasteConfirmed: boolean;
  isOutage: boolean;
}

export interface Task {
  date: BizDate;
  kind: "waste" | "production";
  /** True when this is not the current business day -- i.e. a backfill. */
  isBackfill: boolean;
  ageDays: number;
}

/**
 * What still needs doing, newest first.
 *
 * Driven by data rather than by the clock, so a missed day surfaces by itself
 * and backfill is the same screen rather than a separate mode. Waste is only
 * asked for on days that actually had production -- there is nothing to count
 * on a day nothing was made.
 */
export function outstandingTasks(
  days: DayState[],
  today: BizDate,
  lookbackDays = 14,
): Task[] {
  const tasks: Task[] = [];
  const byDate = new Map(days.map((d) => [d.date, d]));

  for (let i = 0; i <= lookbackDays; i++) {
    const date = addDays(today, -i);
    const d = byDate.get(date);
    if (d?.isOutage) continue;

    // Yesterday's waste before today's production: the case has to be cleared
    // before anything new goes in, and that is the order the operator works in.
    if (d?.hasProduction && !d.wasteConfirmed && date !== today) {
      tasks.push({ date, kind: "waste", isBackfill: i > 1, ageDays: i });
    }
    if (!d?.productionConfirmed) {
      // Today is always worth asking about: it has not happened yet.
      //
      // A PAST day is only worth asking about if it left a trace -- quantities
      // that were entered and never confirmed. A past date with no record at
      // all was either not traded or never opened, and there is no way to tell
      // which from here. Offering to "plan" it invites a number made up after
      // the fact, which is the same fabrication the lookback limit already
      // refuses further back; a fresh install has fourteen such days and used
      // to lead with the oldest of them.
      const worthChasing = i === 0 || (i === 1 && !!d?.hasProduction);
      if (worthChasing) {
        tasks.push({ date, kind: "production", isBackfill: i > 0, ageDays: i });
      }
    }
  }

  return tasks.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.kind === "waste" ? -1 : 1;
  });
}
