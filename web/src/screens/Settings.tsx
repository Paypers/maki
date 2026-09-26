/**
 * Settings, plus backup.
 *
 * Four of these change what the recommendation rule computes, so they are
 * labelled with what they do rather than what they are called. Each moves the
 * break-even -- the chance a roll must have of selling to be worth making:
 *
 *   salvage         lowers it, so every suggestion rises
 *   labour per roll raises it, so suggestions fall
 *   share you keep  below 100% raises it, so suggestions fall
 *   promo weekdays  raise it on those days: each roll earns less
 *
 * Backup is here rather than buried because IndexedDB lives in one browser on
 * one phone. Until the cloud sync is connected, an export is the only thing
 * standing between a lost phone and a lost year of history.
 */

import { useEffect, useRef, useState } from "react";
import * as store from "../lib/store";
import { downloadBackup } from "../lib/backup";
import type { Look, Settings as SettingsType } from "../lib/types";
import type { LookInfo, Mode } from "../lib/theme";
import { LOOKS, applyLook, effectiveMode, lookInfo, lookOf } from "../lib/theme";
import { AMBITION, AMBITION_NAMES } from "../lib/model";
import { Icon } from "../components/Icon";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface Props {
  onBack: () => void;
  onChanged: () => void;
}

function ambitionSays(level: number): string {
  const l = AMBITION[level];
  if (!l) return "Careful: only what your record proves. It never adds a roll it hasn't seen sell.";
  const [sure, most, budget] = l;
  const lead = level === 3 ? "Balanced (recommended)" : AMBITION_NAMES[level];
  const tail = level === 5 ? " Expect more leftovers — this takes near even-odds bets." : "";
  return `${lead}: adds a roll only when ${Math.round(sure * 100)}% sure it pays; up to ${most} extra ` +
    `on an item, ${budget} extra across the case a day.${tail}`;
}

/**
 * A thumbnail of a look in its own colours, whatever look is on: a card on
 * its ground with a figure in its display face, a bar of owed amber and one
 * of the rule's blue. Decoration for the button's name, so hidden from
 * screen readers.
 */
function LookPreview({ info, mode }: { info: LookInfo; mode: Mode }) {
  const c = info.swatch[mode];
  return (
    <span className="look-preview" aria-hidden="true"
          style={{ background: c.bg, borderColor: c.line, borderRadius: info.radius + 2 }}>
      <span className="lp-card"
            style={{ background: c.surface, borderColor: c.line, borderRadius: info.radius }}>
        <span className="lp-num" style={{ color: c.ink, fontFamily: info.display }}>$955</span>
        <span className="lp-row">
          <i style={{ background: c.accent }} />
          <i style={{ background: c.rule }} />
        </span>
        <span className="lp-line" style={{ background: c.muted }} />
      </span>
    </span>
  );
}

export function Settings({ onBack, onChanged }: Props) {
  const [draft, setDraft] = useState<SettingsType | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [counts, setCounts] = useState({ entries: 0, days: 0, items: 0 });
  const [history, setHistory] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      setDraft(await store.getSettings());
      const [entries, days, items] = await Promise.all(
        [store.getAllEntries(), store.getDays(), store.getItems()]);
      setCounts({ entries: entries.length, days: days.length, items: items.length });
      setHistory(await store.historyImportedAt());
    })();
  }, []);

  if (!draft) return <div className="card">Loading…</div>;
  const look = lookOf(draft.look);
  const mode = effectiveMode(draft.theme);

  const set = <K extends keyof SettingsType>(k: K, v: SettingsType[K]) => {
    const next = { ...draft, [k]: v };
    setDraft(next);
    void store.saveSettings(next).then(onChanged);
  };

  /** A new level starts a new trial: the ambition check judges it from today. */
  function setAmbition(level: number) {
    if (!draft || draft.ambition === level) return;
    const next = { ...draft, ambition: level, ambitionSince: store.today(draft.rolloverHour) };
    setDraft(next);
    void store.saveSettings(next).then(onChanged);
  }

  /** A theme or light/dark goes on the page at once, then into Settings --
   *  waiting for the save and the app's reload of everything would make the
   *  tap feel ignored for a moment. */
  function setLook(next: Look) {
    if (!draft || draft.look === next) return;
    const cfg = { ...draft, look: next };
    setDraft(cfg);
    applyLook(next, cfg.theme);
    void store.saveSettings(cfg).then(onChanged);
  }
  function setBrightness(next: SettingsType["theme"]) {
    if (!draft || draft.theme === next) return;
    const cfg = { ...draft, theme: next };
    setDraft(cfg);
    applyLook(lookOf(cfg.look), next);
    void store.saveSettings(cfg).then(onChanged);
  }

  function toggleWeekday(index: number) {
    const day = index + 1;
    const has = draft!.promoWeekdays.includes(day);
    set("promoWeekdays", has
      ? draft!.promoWeekdays.filter((d) => d !== day)
      : [...draft!.promoWeekdays, day].sort());
  }

  /**
   * Re-run the opening import. Normally nothing to do -- it runs itself on
   * first launch -- but it is the recovery path if that first launch happened
   * offline, and it is the only place the app admits the history exists.
   */
  async function loadHistory() {
    setLoading(true);
    setStatus(null);
    try {
      const res = await fetch("/history.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`not found (HTTP ${res.status})`);
      const added = await store.importHistory(await res.json());
      setStatus(added.entries || added.corrections || added.days
        ? `Loaded ${added.entries} entries across ${added.days} days`
          + (added.corrections ? `, and corrected ${added.corrections} from newer sheets.` : ".")
        : "Already loaded — nothing new to add.");
      setHistory(await store.historyImportedAt());
      const [entries, days, items] = await Promise.all(
        [store.getAllEntries(), store.getDays(), store.getItems()]);
      setCounts({ entries: entries.length, days: days.length, items: items.length });
      onChanged();
    } catch (err) {
      setStatus(`Could not load the history: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  async function doExport() {
    const n = await downloadBackup();
    setStatus(`Exported ${n} entries.`);
  }

  async function doImport(file: File) {
    try {
      const backup = JSON.parse(await file.text());
      const { added } = await store.importAll(backup);
      setStatus(added
        ? `Imported ${added} new entries.`
        : "Nothing new — this backup was already applied.");
      onChanged();
    } catch {
      setStatus("That file could not be read as a backup.");
    }
  }

  return (
    <div>
      <header className="bar">
        <button className="ghost" onClick={onBack} aria-label="Back"><Icon name="back" size={20} /></button>
        <h1>Settings</h1>
      </header>

      <div className="card">
        <h2>Ambition</h2>
        <p className="hint">
          How hard the suggestions push items that keep selling out. It only
          acts on an item that has sold out on several of its last 8 days —
          one sell-out on a slow item never sets it off — and only adds a roll
          when it's sure enough that roll pays for itself.
        </p>
        <div className="tabs ambition-levels" role="group" aria-label="Ambition level">
          {[1, 2, 3, 4, 5].map((a) => (
            <button key={a} aria-pressed={draft.ambition === a} onClick={() => setAmbition(a)}>
              {AMBITION_NAMES[a]}
            </button>
          ))}
        </div>
        <p className="hint ambition-says">{ambitionSays(draft.ambition)}</p>
        <p className="hint">
          Today's screen tells you whether the level is paying — and if the
          extra rolls start coming back, it will say so and suggest a step down.
        </p>
      </div>

      <div className="card" id="theme">
        <h2>Theme</h2>
        <p className="hint">
          How the app looks on this phone. Every screen stays where it is —
          only colours, type and edges change — and colours keep their jobs in
          every theme: amber is owed, blue is the rule, green is saved, red is late.
        </p>
        <div className="looks" role="group" aria-label="Theme">
          {LOOKS.map((l) => (
            <button key={l.id} className="look-pick" aria-pressed={look === l.id}
                    onClick={() => setLook(l.id)}>
              <LookPreview info={l} mode={mode} />
              <span className="look-name">
                {look === l.id && <Icon name="check" size={14} className="ico" />}
                {l.name}
              </span>
            </button>
          ))}
        </div>
        <p className="hint look-says">{lookInfo(look).blurb}</p>

        <h3 className="subhead">Light or dark</h3>
        <div className="tabs" role="group" aria-label="Light or dark">
          {(["system", "dark", "light"] as const).map((t) => (
            <button key={t} aria-pressed={draft.theme === t}
                    onClick={() => setBrightness(t)}>
              {t === "system" ? "Match phone" : t === "dark" ? "Dark" : "Light"}
            </button>
          ))}
        </div>
        <p className="hint">
          Dark is built for a dim kiosk before the store lights come on; light
          is the same thing for daylight. Every theme has both. Both choices
          stay on this phone and aren't synced.
        </p>
      </div>

      <div className="card">
        <h2>Promotion days</h2>
        <p className="hint">
          Buy-2-get-1 lowers what each roll earns, so a roll needs a better
          chance of selling to be worth making — the suggestion can drop on
          these days even though more people buy.
        </p>
        <div className="tabs">
          {WEEKDAYS.map((label, i) => (
            <button key={label}
                    aria-pressed={draft.promoWeekdays.includes(i + 1)}
                    onClick={() => toggleWeekday(i)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>What a roll really costs you</h2>
        <p className="hint">
          The rule makes a roll when its chance of selling beats
          <strong> cost ÷ what you keep</strong>. Both numbers below start
          neutral because only you know them — and both matter more than
          anything else in the rule.
        </p>
        <label className="field">
          <span>Your time per roll ($)</span>
          <input type="number" inputMode="decimal" step="0.05" min="0"
                 value={draft.labourPerRoll}
                 onChange={(e) => set("labourPerRoll", Math.max(0, Number(e.target.value) || 0))} />
        </label>
        <p className="hint">
          Leave at <strong>0</strong> if an extra roll costs you nothing but
          ingredients. If you would rather value your time — say $15 an hour
          and 2 minutes a roll is <strong>0.50</strong> — enter it and the rule
          stops suggesting rolls that only just pay.
        </p>
        <label className="field">
          <span>Share of each sale you keep (%)</span>
          <input type="number" inputMode="numeric" step="1" min="1" max="100"
                 value={Math.round(draft.saleShare * 100)}
                 onChange={(e) => {
                   const v = Number(e.target.value);
                   set("saleShare", Number.isFinite(v) && v > 0 ? Math.min(100, v) / 100 : 1);
                 }} />
        </label>
        <p className="hint">
          <strong>100</strong> if every dollar at the register is yours. If
          ShopRite keeps a percentage, enter what is left — 75 for a 25% cut.
          A cut like that raises the bar for every roll by about a third.
        </p>
      </div>

      <div className="card">
        <h2>Leftovers</h2>
        <label className="field">
          <span>Value recovered per discarded unit ($)</span>
          <input type="number" inputMode="decimal" step="0.25" min="0"
                 value={draft.salvage}
                 onChange={(e) => set("salvage", Number(e.target.value) || 0)} />
        </label>
        <p className="hint">
          Keep this at <strong>0</strong> if you count waste the morning after.
          By then the markdown window has closed, so anything that sold at a
          discount is already counted as sold — crediting it again here would
          count that money twice and push every quantity up.
        </p>
      </div>

      <div className="card">
        <h2>Day rollover</h2>
        <label className="field">
          <span>Hour the business day flips (0 = midnight)</span>
          <input type="number" inputMode="numeric" min="0" max="12"
                 value={draft.rolloverHour}
                 onChange={(e) => set("rolloverHour",
                   Math.max(0, Math.min(12, Number(e.target.value) || 0)))} />
        </label>
        <p className="hint">
          Open the app after this hour and it treats it as a new day — so the
          leftovers you count belong to yesterday.
        </p>
      </div>

      <div className="card">
        <h2>Suggestions</h2>
        <label className="check">
          <input type="checkbox" checked={draft.showSuggestions}
                 onChange={(e) => set("showSuggestions", e.target.checked)} />
          Show the rule's suggestion beside your own number
        </label>
      </div>

      <div className="card">
        <h2>Opening history</h2>
        <p className="hint">
          {history
            ? `Loaded ${new Date(history).toLocaleDateString()}. These are the days from the spreadsheet, before the app existed.`
            : "The days from the spreadsheet have not been loaded on this device."}
        </p>
        <button className="ghost" disabled={loading} onClick={loadHistory}>
          {loading ? "Loading…" : history ? "Check for anything missing" : "Load the history"}
        </button>
        <p className="hint">
          Safe to run twice: every row carries an id derived from its date and
          item, so a repeat adds nothing.
        </p>
      </div>

      <div className="card">
        <h2>Backup</h2>
        <p className="hint">
          {counts.entries} entries · {counts.days} days · {counts.items} items,
          stored in this browser only. Export regularly until cloud sync is
          connected.
        </p>
        <div className="actions">
          <button className="primary" onClick={doExport}>Export a backup</button>
          <button className="ghost" onClick={() => fileRef.current?.click()}>
            Restore
          </button>
        </div>
        <input ref={fileRef} type="file" accept="application/json" hidden
               onChange={(e) => {
                 const file = e.target.files?.[0];
                 if (file) void doImport(file);
                 e.target.value = "";
               }} />
        <p className="hint">
          Restoring merges — it never deletes entries you already have, and
          importing the same file twice does nothing.
        </p>
        {status && <div className="banner"><Icon name="check" size={16} className="ico" /><span>{status}</span></div>}
      </div>
    </div>
  );
}
