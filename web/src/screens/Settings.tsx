/**
 * Settings, plus backup.
 *
 * Two of these change what the recommendation rule computes, so they are
 * labelled with what they do rather than what they are called:
 *
 *   salvage         raises it above zero and every recommendation rises with it
 *   promo weekdays  lowers the target quantile on those days
 *
 * Backup is here rather than buried because IndexedDB lives in one browser on
 * one phone. Until the cloud sync is connected, an export is the only thing
 * standing between a lost phone and a lost year of history.
 */

import { useEffect, useRef, useState } from "react";
import * as store from "../lib/store";
import type { Settings as SettingsType } from "../lib/types";
import { Icon } from "../components/Icon";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface Props {
  onBack: () => void;
  onChanged: () => void;
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

  const set = <K extends keyof SettingsType>(k: K, v: SettingsType[K]) => {
    const next = { ...draft, [k]: v };
    setDraft(next);
    void store.saveSettings(next).then(onChanged);
  };

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
      setStatus(added.entries
        ? `Loaded ${added.entries} entries across ${added.days} days.`
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
    const backup = await store.exportAll();
    const blob = new Blob([JSON.stringify(backup, null, 2)],
                          { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `kiosk-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`Exported ${backup.entries.length} entries.`);
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
        <h2>Appearance</h2>
        <p className="hint">
          Dark is the design — it's built for a dim kiosk before the store
          lights come on. Light is the same thing for daylight.
        </p>
        <div className="tabs" role="group" aria-label="Theme">
          {(["system", "dark", "light"] as const).map((t) => (
            <button key={t} aria-pressed={draft.theme === t}
                    onClick={() => set("theme", t)}>
              {t === "system" ? "Match phone" : t === "dark" ? "Dark" : "Light"}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        <h2>Promotion days</h2>
        <p className="hint">
          Buy-2-get-1 lowers the margin per unit, so the target quantity drops
          on these days even though volume rises.
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
