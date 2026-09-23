/**
 * Where the kiosk is, when it trades, and what else moves its sales.
 *
 * Three things live here and they are ordered by how much they matter:
 *
 *   LOCATION  a ZIP, resolved once. Nothing is fetched until this is set --
 *             the app never reaches for a weather server on its own.
 *   HOURS     the window the weather is measured over. Changing it invalidates
 *             every cached reading, because the cache stores the reduction,
 *             not the raw hours, so this triggers a refetch and says so.
 *   FACTORS   things the operator believes move their sales. These do NOT get
 *             modelled -- one kiosk and one year cannot estimate them -- they
 *             get HELD OUT, so they stop contaminating the weather estimate.
 */

import { useEffect, useState } from "react";
import * as store from "../lib/store";
import { resolveZip, zipProblem, type StoreLocation } from "../lib/weather";
import { refetchAll, syncWeather } from "../lib/weatherSync";
import type { Settings } from "../lib/types";
import { Icon } from "../components/Icon";

interface Props {
  today: string;
  earliest: string | null;
  onBack: () => void;
  onChanged: () => void;
}

const HOUR_LABEL = (h: number) =>
  h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`;

export function WeatherSettings({ today, earliest, onBack, onChanged }: Props) {
  const [draft, setDraft] = useState<Settings | null>(null);
  const [zip, setZip] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  /** Flips the field to free text after a ZIP lookup fails, so the town-name
   *  escape hatch is reachable from a phone's numeric keypad. */
  const [byName, setByName] = useState(false);
  const [cached, setCached] = useState(0);

  useEffect(() => {
    void (async () => {
      const s = await store.getSettings();
      setDraft(s);
      setZip(s.location?.zip ?? "");
      setCached((await store.getWeather()).length);
    })();
  }, []);

  if (!draft) return <div className="card">Loading…</div>;

  const save = async (next: Settings) => {
    setDraft(next);
    await store.saveSettings(next);
    onChanged();
  };

  async function connect() {
    setBusy(true);
    setStatus(null);
    try {
      const loc: StoreLocation = await resolveZip(zip);
      setByName(false);
      const next = { ...draft!, location: loc, weatherEnabled: true };
      await save(next);
      setStatus(`Set to ${loc.label}. Fetching weather…`);
      const r = await syncWeather(loc, next.hours, today, earliest);
      setCached((await store.getWeather()).length);
      setStatus(r.error ? `Location saved, but the fetch failed: ${r.error}`
                        : `${loc.label} — ${r.fetched} days of weather loaded.`);
      onChanged();
    } catch (err) {
      setStatus((err as Error).message);
      // A ZIP that looked right and still found nothing: open the field up so
      // they can type the town without fighting a numeric keypad.
      if (/^\d{5}(-\d{4})?$/.test(zip.trim())) setByName(true);
    } finally {
      setBusy(false);
    }
  }

  /** Changing the window invalidates every stored reduction. */
  async function setHours(open: number, close: number) {
    const next = { ...draft!, hours: { open, close } };
    await save(next);
    if (!next.location || !next.weatherEnabled) return;
    setBusy(true);
    setStatus("Trading hours changed — re-reading the weather over the new window…");
    const r = await refetchAll(next.location, next.hours, today, earliest ?? today);
    setCached((await store.getWeather()).length);
    setStatus(r.error ? `Refetch failed: ${r.error}` : `${r.fetched} days re-read.`);
    setBusy(false);
    onChanged();
  }

  // Live validation: what is wrong with what has been typed so far, and
  // whether it is worth sending anywhere.
  const problem = zipProblem(zip);
  const ready = zip.trim().length >= (byName ? 3 : 5) && !problem;

  const factor = (key: keyof Settings["factors"], label: string, why: string) => (
    <label className="check" key={key}>
      <input type="checkbox" checked={draft.factors[key]}
             onChange={(e) => void save({
               ...draft, factors: { ...draft.factors, [key]: e.target.checked },
             })} />
      <span>
        <strong style={{ display: "block", fontWeight: 600 }}>{label}</strong>
        <span className="hint" style={{ margin: 0 }}>{why}</span>
      </span>
    </label>
  );

  return (
    <div>
      <header className="bar">
        <h1>
          Weather
          <span className="sub">
            {draft.location ? draft.location.label : "not set up"}
          </span>
        </h1>
        <button className="ghost" onClick={onBack} aria-label="Back">
          <Icon name="back" size={20} />
        </button>
      </header>

      <div className="card">
        <div className="eyebrow">Where the kiosk is</div>
        <p className="hint" style={{ marginTop: 10 }}>
          A US ZIP code, once. The app looks up the coordinates and pulls the
          weather for every day you have already recorded, so the comparison
          starts with your whole history rather than from today.
        </p>
        <label className="field">
          <span>{byName ? "ZIP code or town" : "ZIP code"}</span>
          {/* Deliberately NOT maxLength={5}. Truncating a sixth digit as it is
              typed hides the mistake: the operator sees five digits they did
              not type, an inert button, and no explanation. Let it be typed,
              then say what is wrong with it. */}
          <input value={zip}
                 inputMode={byName ? "text" : "numeric"}
                 maxLength={byName ? 60 : 10}
                 placeholder={byName ? "Lutherville, MD" : "21093"}
                 autoCapitalize={byName ? "words" : "off"} autoCorrect="off"
                 onChange={(e) => setZip(byName ? e.target.value
                                                : e.target.value.replace(/[^\d-]/g, ""))} />
        </label>
        {problem && <p className="hint warn">{problem}</p>}
        {/* Enabled whenever there is something worth trying. A button that
            silently refuses to light up explains nothing; a button that runs
            and returns a sentence explains everything. */}
        <button className="primary" disabled={busy || !ready} onClick={connect}>
          {busy ? "Working…" : draft.location ? "Update location" : "Set location"}
        </button>
        {draft.location && (
          <p className="hint" style={{ marginTop: 12 }}>
            {draft.location.label} · {cached} day{cached === 1 ? "" : "s"} cached ·{" "}
            {draft.location.latitude.toFixed(2)}, {draft.location.longitude.toFixed(2)}
          </p>
        )}
      </div>

      <div className="card">
        <div className="eyebrow">Trading hours</div>
        <p className="hint" style={{ marginTop: 10 }}>
          Only weather inside this window counts. Rain at 3am does not keep
          anyone out of a shop that opens at 8.
        </p>
        <div className="grid3" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 12 }}>
          <label className="field">
            <span>Opens</span>
            <select value={draft.hours.open}
                    onChange={(e) => void setHours(Number(e.target.value), draft.hours.close)}>
              {Array.from({ length: 13 }, (_, i) => i + 4).map((h) => (
                <option key={h} value={h}>{HOUR_LABEL(h)}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Closes</span>
            <select value={draft.hours.close}
                    onChange={(e) => void setHours(draft.hours.open, Number(e.target.value))}>
              {Array.from({ length: 13 }, (_, i) => i + 12).map((h) => (
                <option key={h} value={h}>{HOUR_LABEL(h)}</option>
              ))}
            </select>
          </label>
        </div>
        {draft.location && (
          <p className="hint">
            Changing these re-reads every cached day, because the stored figure
            is already reduced to the window rather than kept hour by hour.
          </p>
        )}
      </div>

      <div className="card">
        <div className="eyebrow">What else moves your sales</div>
        <p className="hint" style={{ marginTop: 10 }}>
          Tick anything you believe affects a day. These are <strong>not</strong>{" "}
          modelled — one kiosk and one year cannot estimate them honestly. They
          are held out of the weather comparison, so a busy payday weekend does
          not get credited to the sunshine.
        </p>
        {factor("paydays", "Paydays and the start of the month",
                "The 1st and the 15th are held out.")}
        {factor("schoolCalendar", "School terms and holidays",
                "Summer weekdays are held out — your record straddles exactly that boundary.")}
        {factor("storeEvents", "Store events and the circular",
                "Nothing automatic; mark individual days from the calendar.")}
      </div>

      {draft.location && (
        <div className="card">
          <div className="eyebrow">Turn it off</div>
          <p className="hint" style={{ marginTop: 10 }}>
            Stops fetching and removes the advisory from the production sheet.
            The days already cached are kept.
          </p>
          <label className="check">
            <input type="checkbox" checked={draft.weatherEnabled}
                   onChange={(e) => void save({ ...draft, weatherEnabled: e.target.checked })} />
            Use weather in the app
          </label>
        </div>
      )}

      {status && (
        <div className="banner">
          <Icon name="cloud" size={16} className="ico" />
          <span>{status}</span>
        </div>
      )}

      <div className="card">
        <details>
          <summary>Where the data comes from</summary>
          <p className="hint" style={{ marginTop: 10 }}>
            Open-Meteo — no account, no key, and the same model for both the
            historical readings and the forecast. That last part matters: if
            the past were measured by a weather station and the future by a
            forecast, "a rainy day" would mean two different things and the
            comparison would be biased by the mismatch rather than by anything
            real.
          </p>
        </details>
      </div>
    </div>
  );
}
