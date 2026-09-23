/**
 * Keeping the weather cache fed, without ever getting in the way.
 *
 * Every rule here exists because this is a kiosk app on store wifi and the
 * weather is a nice-to-have:
 *
 *  - It never blocks a render. The app opens, then weather arrives or it
 *    doesn't.
 *  - It never fetches without a location the operator set.
 *  - Past days are fetched once and kept forever; only the recent window and
 *    the forecast are re-fetched, because only those change.
 *  - A failure is silent in the UI and visible in Settings. A kiosk owner at
 *    5am does not need a toast telling them a weather server is down.
 */

import type { BizDate } from "./businessDay";
import { addDays, daysBetween } from "./businessDay";
import * as store from "./store";
import type { DayWeather, StoreLocation, TradingHours } from "./weather";
import { fetchArchive, fetchForecast } from "./weather";

/** The archive lags real time; the forecast endpoint covers the gap. */
const ARCHIVE_LAG_DAYS = 6;
/** Never ask for more history than this in one go. */
const MAX_BACKFILL_DAYS = 1100;

export interface SyncResult {
  fetched: number;
  from?: BizDate;
  to?: BizDate;
  error?: string;
}

/** Was this date already fetched as a settled (non-forecast) reading? */
function settled(have: Map<BizDate, DayWeather>, date: BizDate): boolean {
  const row = have.get(date);
  return !!row && !row.forecast;
}

/**
 * Bring the cache up to date for the days the app actually has sales for,
 * plus the days ahead it will plan for.
 *
 * `neededFrom` is normally the operator's earliest recorded day -- there is
 * no reason to hold weather for days the kiosk did not trade.
 */
export async function syncWeather(
  loc: StoreLocation,
  hours: TradingHours,
  today: BizDate,
  neededFrom: BizDate | null,
): Promise<SyncResult> {
  try {
    const have = new Map((await store.getWeather()).map((w) => [w.date, w]));
    let fetched = 0;

    // --- settled past ------------------------------------------------------
    const archiveEnd = addDays(today, -ARCHIVE_LAG_DAYS);
    if (neededFrom && neededFrom <= archiveEnd) {
      const span = Math.min(daysBetween(neededFrom, archiveEnd), MAX_BACKFILL_DAYS);
      const start = addDays(archiveEnd, -span);
      // Only ask if something in the range is actually missing. On every run
      // after the first this is false and no request is made at all.
      const missing = Array.from({ length: span + 1 }, (_, i) => addDays(start, i))
        .some((d) => !settled(have, d));
      if (missing) {
        const rows = await fetchArchive(loc, start, archiveEnd, hours);
        fetched += await store.putWeather(rows);
      }
    }

    // --- recent past and the days ahead ------------------------------------
    // Always re-fetched: a forecast for tomorrow is not tomorrow's weather,
    // and the last few days have not reached the archive yet.
    const rows = await fetchForecast(loc, hours, ARCHIVE_LAG_DAYS + 1, 3);
    fetched += await store.putWeather(rows);

    return { fetched, from: neededFrom ?? undefined, to: addDays(today, 2) };
  } catch (err) {
    return { fetched: 0, error: (err as Error).message };
  }
}

/**
 * Refetch everything for a date range, discarding what is cached.
 *
 * Needed when the trading hours change: the stored rows were reduced to the
 * OLD window, so an 8-20 cache is simply wrong once the kiosk moves to 10-16.
 * The alternative -- storing all 24 hours and windowing at read time -- costs
 * 24x the storage for a number that changes about once.
 */
export async function refetchAll(
  loc: StoreLocation, hours: TradingHours, today: BizDate, from: BizDate,
): Promise<SyncResult> {
  try {
    await store.clearWeather();
    return await syncWeather(loc, hours, today, from);
  } catch (err) {
    return { fetched: 0, error: (err as Error).message };
  }
}
