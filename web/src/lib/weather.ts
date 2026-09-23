/**
 * Weather, from Open-Meteo.
 *
 * Why this source: no API key (so nothing to leak, rotate or pay for), an
 * archive going back decades AND a forecast from the same model, and a
 * geocoder that resolves a US ZIP. One source for both history and forecast
 * matters more than it sounds -- if the past were measured by a weather
 * station and the future by a forecast model, "a rainy day" would mean two
 * different things and the adjustment would be biased by the mismatch rather
 * than by anything real.
 *
 * Licensing note, honestly: Open-Meteo's free tier is offered for
 * non-commercial use, and this is a business. At roughly two requests a day
 * against a 10,000/day limit it is not the case the clause is aimed at, but
 * it IS a clause. The swap-out if it ever matters is api.weather.gov (US
 * government, public domain, no key, no restriction) for the forecast --
 * `fetchForecast` is the only function that would change.
 *
 * Everything here is cached in IndexedDB per business date. The app is
 * offline-first and the store wifi is unreliable: a day whose weather was
 * fetched once never needs fetching again, and a day that cannot be fetched
 * is simply absent rather than guessed.
 */

import type { BizDate } from "./businessDay";

const GEOCODE = "https://geocoding-api.open-meteo.com/v1/search";
/**
 * ZIP -> coordinates, from the USPS dataset.
 *
 * Open-Meteo's geocoder is a PLACE NAME search that happens to have some
 * postcodes indexed, and its ZIP coverage has holes: 21093 (Lutherville
 * Timonium, MD) returns HTTP 200 with no results at all, which the app then
 * reported as "No US location found for 21093" -- blaming the operator for a
 * ZIP that is perfectly real. One miss in a 27-ZIP Maryland sample.
 *
 * This is the authoritative lookup and runs first. No key, CORS open, and it
 * 404s cleanly on a ZIP that does not exist, which is the distinction the
 * error messages need.
 */
const ZIPPO = "https://api.zippopotam.us/us";
const ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
const FORECAST = "https://api.open-meteo.com/v1/forecast";

/** Where the kiosk is. Resolved once from a ZIP and then kept. */
export interface StoreLocation {
  zip: string;
  label: string;        // "Baltimore, Maryland"
  latitude: number;
  longitude: number;
  timezone: string;
  resolvedAt: string;
}

/**
 * One trading day's weather, already reduced to the hours the kiosk is open.
 *
 * `precip` is the TOTAL over the open window and `tempMax` the highest hour
 * in it -- not the calendar day's. Rain at 3am does not keep anyone out of a
 * shop that opens at 8.
 */
export interface DayWeather {
  date: BizDate;
  /** Inches of rain-equivalent during trading hours. */
  precip: number;
  /** Inches of snow during trading hours. */
  snow: number;
  tempMax: number;      // °F, within the window
  tempMin: number;
  /** WMO code for the worst hour in the window; see `describe`. */
  code: number;
  /** True when this came from the forecast rather than the archive. */
  forecast: boolean;
  fetchedAt: string;
}

/** Trading hours, local, 24h. Weather outside these is ignored. */
export interface TradingHours { open: number; close: number; }
export const DEFAULT_HOURS: TradingHours = { open: 8, close: 20 };

/** Rain at or above this, over the whole open window, counts as a wet day. */
export const WET_INCHES = 0.05;
/** And at or above this, a washout. */
export const HEAVY_INCHES = 0.4;

export type WeatherBand = "dry" | "wet" | "heavy" | "snow";

export function band(w: DayWeather): WeatherBand {
  if (w.snow >= 0.1) return "snow";
  if (w.precip >= HEAVY_INCHES) return "heavy";
  if (w.precip >= WET_INCHES) return "wet";
  return "dry";
}

export const BAND_LABEL: Record<WeatherBand, string> = {
  dry: "Dry", wet: "Rain", heavy: "Heavy rain", snow: "Snow",
};

/** WMO weather codes, collapsed to what an operator would say out loud. */
export function describe(w: DayWeather): string {
  const c = w.code;
  if (w.snow >= 0.1 || (c >= 71 && c <= 77) || c === 85 || c === 86) return "snow";
  if (c >= 95) return "thunderstorms";
  if (w.precip >= HEAVY_INCHES) return "heavy rain";
  if (c >= 80 && c <= 82) return "showers";
  if (c >= 61 && c <= 65) return "rain";
  if (c >= 51 && c <= 57) return "drizzle";
  if (c >= 45 && c <= 48) return "fog";
  if (c === 3) return "overcast";
  if (c === 1 || c === 2) return "partly cloudy";
  return "clear";
}

// ------------------------------------------------------------------ fetch ---

async function getJSON(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`weather service returned ${res.status}`);
  const body = await res.json();
  if (body?.error) throw new Error(String(body.reason ?? "weather service error"));
  return body;
}

/**
 * What is wrong with this input, in words, or null if it looks usable.
 *
 * Pure and synchronous so the field can say it WHILE you type. The bug this
 * exists to kill: the input silently truncated at five characters and the
 * button silently disabled itself, so typing a six-digit ZIP produced no
 * message, no error and no lookup -- the app simply did nothing and left the
 * operator to guess why.
 */
export function zipProblem(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/^\d{5}(-\d{4})?$/.test(s)) return null;      // 21093 or 21093-4567
  if (/^\d+$/.test(s)) {
    const n = s.length;
    if (n < 5) return `Only ${n} digit${n === 1 ? "" : "s"} — a US ZIP code has five.`;
    // Nine digits is a ZIP+4 run together, which has a correct spelling worth
    // naming. Six, seven or eight is a typo, and the only honest suggestion is
    // the first five -- NOT an invented +4 that is not theirs.
    if (n === 9) {
      return `That is ${n} digits. If you meant ZIP+4, write it `
           + `${s.slice(0, 5)}-${s.slice(5)} — or just use ${s.slice(0, 5)}.`;
    }
    return `That is ${n} digits — a US ZIP code has five. `
         + `Did you mean ${s.slice(0, 5)}?`;
  }
  if (/^[\d-]+$/.test(s)) return "A US ZIP code is five digits, like 21093.";
  return null;                                       // a place name; let it try
}

interface ZippoPlace {
  "place name"?: string;
  state?: string;
  latitude?: string;
  longitude?: string;
}

/** The authoritative ZIP lookup. Returns null when the ZIP does not exist. */
async function fromZippopotam(zip: string): Promise<StoreLocation | null> {
  const res = await fetch(`${ZIPPO}/${zip}`);
  if (res.status === 404) return null;               // a real answer: no such ZIP
  if (!res.ok) throw new Error(`postcode service returned ${res.status}`);
  const body = await res.json();
  const place = (body?.places as ZippoPlace[] | undefined)?.[0];
  const lat = Number(place?.latitude);
  const lon = Number(place?.longitude);
  if (!place || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    zip,
    label: [place["place name"], place.state].filter(Boolean).join(", "),
    latitude: lat,
    longitude: lon,
    // Zippopotam has no timezone field, and Open-Meteo resolves one from the
    // coordinates. Better than guessing: a kiosk is not always Eastern.
    timezone: "auto",
    resolvedAt: new Date().toISOString(),
  };
}

/** Open-Meteo's place search. Good at town names, patchy on postcodes. */
async function fromOpenMeteo(query: string, zip: string): Promise<StoreLocation | null> {
  const body = await getJSON(`${GEOCODE}?name=${encodeURIComponent(query)}`
    + `&count=1&language=en&format=json&countryCode=US`);
  const hit = (body.results as Array<Record<string, unknown>> | undefined)?.[0];
  if (!hit) return null;
  return {
    zip,
    label: [hit.name, hit.admin1].filter(Boolean).join(", "),
    latitude: hit.latitude as number,
    longitude: hit.longitude as number,
    timezone: (hit.timezone as string) ?? "auto",
    resolvedAt: new Date().toISOString(),
  };
}

/**
 * A ZIP code or a town name -> coordinates. US only, which is where the
 * kiosk is.
 *
 * Two sources, in order of authority: the postcode dataset for a ZIP, then
 * the place search. The fallback is not belt-and-braces -- it is the only way
 * a town name works at all, and it is the escape hatch when a ZIP sits in a
 * gap in both datasets.
 */
export async function resolveZip(input: string): Promise<StoreLocation> {
  const raw = input.trim();
  if (!raw) throw new Error("Type a ZIP code, or the name of your town.");

  const problem = zipProblem(raw);
  if (problem) throw new Error(problem);

  const zipMatch = raw.match(/^(\d{5})(?:-\d{4})?$/);
  if (zipMatch) {
    const zip = zipMatch[1];
    const exact = await fromZippopotam(zip).catch(() => null);
    if (exact) return exact;
    const loose = await fromOpenMeteo(zip, zip).catch(() => null);
    if (loose) return loose;
    throw new Error(`No US location found for ${zip}. If that ZIP is right, `
      + `type your town instead — "Lutherville, MD" works too.`);
  }

  const named = await fromOpenMeteo(raw, "");
  if (!named) {
    throw new Error(`No US location found for "${raw}". Try the town on its `
      + `own, or a five-digit ZIP code.`);
  }
  return named;
}

interface HourlySeries {
  time: string[];
  precipitation: Array<number | null>;
  snowfall: Array<number | null>;
  temperature_2m: Array<number | null>;
  weather_code: Array<number | null>;
}

/**
 * Collapse hourly rows into one row per date, keeping only the hours the
 * kiosk is open. `close` is exclusive: an 8-20 day covers 08:00..19:59.
 */
function reduceToDays(h: HourlySeries, hours: TradingHours,
                      forecast: boolean): DayWeather[] {
  const acc = new Map<BizDate, {
    precip: number; snow: number; temps: number[]; codes: number[];
  }>();
  h.time.forEach((stamp, i) => {
    const [date, clock] = stamp.split("T");
    const hour = Number(clock.slice(0, 2));
    if (hour < hours.open || hour >= hours.close) return;
    const row = acc.get(date) ?? { precip: 0, snow: 0, temps: [], codes: [] };
    row.precip += h.precipitation?.[i] ?? 0;
    row.snow += h.snowfall?.[i] ?? 0;
    const t = h.temperature_2m?.[i];
    if (t !== null && t !== undefined) row.temps.push(t);
    const c = h.weather_code?.[i];
    if (c !== null && c !== undefined) row.codes.push(c);
    acc.set(date, row);
  });

  const now = new Date().toISOString();
  return [...acc.entries()]
    .filter(([, r]) => r.temps.length > 0)
    .map(([date, r]) => ({
      date,
      precip: Math.round(r.precip * 1000) / 1000,
      snow: Math.round(r.snow * 1000) / 1000,
      tempMax: Math.max(...r.temps),
      tempMin: Math.min(...r.temps),
      // The worst hour, not the average: a day with one thunderstorm is a
      // thunderstorm day, and averaging the codes would call it overcast.
      code: Math.max(...r.codes, 0),
      forecast,
      fetchedAt: now,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

const common = (loc: StoreLocation) =>
  `latitude=${loc.latitude}&longitude=${loc.longitude}` +
  `&hourly=temperature_2m,precipitation,snowfall,weather_code` +
  `&temperature_unit=fahrenheit&precipitation_unit=inch` +
  `&timezone=${encodeURIComponent(loc.timezone)}`;

/** Past days. The archive lags about five days behind today. */
export async function fetchArchive(
  loc: StoreLocation, from: BizDate, to: BizDate, hours: TradingHours,
): Promise<DayWeather[]> {
  const body = await getJSON(
    `${ARCHIVE}?${common(loc)}&start_date=${from}&end_date=${to}`);
  return reduceToDays(body.hourly as unknown as HourlySeries, hours, false);
}

/**
 * Recent past and the days ahead, from the forecast model. `past_days` covers
 * the gap the archive leaves behind -- without it the last few days before
 * today would have no weather at all.
 */
export async function fetchForecast(
  loc: StoreLocation, hours: TradingHours,
  pastDays = 7, forecastDays = 3,
): Promise<DayWeather[]> {
  const body = await getJSON(
    `${FORECAST}?${common(loc)}&past_days=${pastDays}&forecast_days=${forecastDays}`);
  return reduceToDays(body.hourly as unknown as HourlySeries, hours, true);
}
