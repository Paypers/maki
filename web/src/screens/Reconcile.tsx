/**
 * Parallel-run check, for the cutover.
 *
 * For one to two weeks both systems run. Each day you type what the spreadsheet
 * says; this shows where they disagree. The spreadsheet is frozen only once a
 * run of days agrees -- and until then the app is not the system of record.
 *
 * Deliberately a separate record from daily_entries: the comparison never writes
 * into the log it is checking.
 */

import { useEffect, useState } from "react";
import type { BizDate } from "../lib/businessDay";
import { addDays, formatShort, weekdayName } from "../lib/businessDay";
import * as store from "../lib/store";
import type { Item } from "../lib/types";
import { Icon } from "../components/Icon";

interface Props {
  today: BizDate;
  items: Item[];
  onBack: () => void;
}

interface DayCompare {
  date: BizDate;
  appMade: number;
  appWaste: number;
  sheetMade: number | null;
  sheetWaste: number | null;
}

const KEY = "parallel-run-sheet-values";

function loadSheet(): Record<string, { made: number; waste: number }> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function Reconcile({ today, items, onBack }: Props) {
  const [days, setDays] = useState<DayCompare[]>([]);
  const [sheet, setSheet] = useState(loadSheet);

  useEffect(() => {
    let live = true;
    (async () => {
      const out: DayCompare[] = [];
      for (let i = 1; i <= 14; i++) {
        const date = addDays(today, -i);
        const entries = await store.getEntries(date);
        if (!entries.length) continue;
        const made = store.currentQuantities(entries, "made");
        const refill = store.currentQuantities(entries, "refill");
        const waste = store.currentQuantities(entries, "waste");
        const sum = (m: Map<number, { quantity: number }>) =>
          [...m.values()].reduce((s, e) => s + e.quantity, 0);
        out.push({
          date,
          appMade: sum(made) + sum(refill),
          appWaste: sum(waste),
          sheetMade: sheet[date]?.made ?? null,
          sheetWaste: sheet[date]?.waste ?? null,
        });
      }
      if (live) setDays(out);
    })();
    return () => { live = false; };
  }, [today, sheet, items]);

  function set(date: BizDate, field: "made" | "waste", value: number) {
    const current = sheet[date] ?? { made: 0, waste: 0 };
    const next = { ...sheet, [date]: { ...current, [field]: value } };
    setSheet(next);
    localStorage.setItem(KEY, JSON.stringify(next));
  }

  const compared = days.filter((d) => d.sheetMade !== null);
  const agreeing = compared.filter(
    (d) => d.appMade === d.sheetMade && d.appWaste === d.sheetWaste,
  );
  const streak = (() => {
    let n = 0;
    for (const d of compared) {
      if (d.appMade === d.sheetMade && d.appWaste === d.sheetWaste) n++;
      else break;
    }
    return n;
  })();

  return (
    <div>
      <header className="bar">
        <button className="ghost" onClick={onBack} aria-label="Back"><Icon name="back" size={20} /></button>
        <h1>Spreadsheet check<span className="sub">cutover</span></h1>
      </header>

      <div className="banner info">
        <Icon name="search" size={16} className="ico" />
        <span>
          Type what the spreadsheet says for each day. Freeze the spreadsheet once
          you have <strong>7 days in a row</strong> agreeing — not before.
        </span>
      </div>

      <div className="stats">
        <div className="stat"><div className="label">Compared</div>
          <div className="value">{compared.length}</div></div>
        <div className="stat"><div className="label">Agreeing</div>
          <div className="value">{agreeing.length}</div></div>
        <div className="stat"><div className="label">Streak</div>
          <div className="value">{streak}/7</div></div>
      </div>

      <div className="card">
        <h2>Day by day</h2>
        <div className="scroll-x">
          <table className="grid">
            <thead>
              <tr>
                <th>Day</th><th>App made</th><th>Sheet</th>
                <th>App left</th><th>Sheet</th><th>Δ</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => {
                const dm = d.sheetMade === null ? null : d.appMade - d.sheetMade;
                const dw = d.sheetWaste === null ? null : d.appWaste - d.sheetWaste;
                const ok = dm === 0 && dw === 0;
                return (
                  <tr key={d.date}>
                    <td>{weekdayName(d.date).slice(0, 3)} {formatShort(d.date)}</td>
                    <td className="num">{d.appMade}</td>
                    <td>
                      <input type="number" inputMode="numeric" style={{ width: 60 }}
                             value={d.sheetMade ?? ""}
                             onChange={(e) => set(d.date, "made", Number(e.target.value || 0))} />
                    </td>
                    <td className="num">{d.appWaste}</td>
                    <td>
                      <input type="number" inputMode="numeric" style={{ width: 60 }}
                             value={d.sheetWaste ?? ""}
                             onChange={(e) => set(d.date, "waste", Number(e.target.value || 0))} />
                    </td>
                    <td className="num">
                      {dm === null ? "—" : ok ? "✓" : `${dm !== 0 ? `m${dm > 0 ? "+" : ""}${dm}` : ""}${dw ? ` w${dw > 0 ? "+" : ""}${dw}` : ""}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!days.length && <p className="hint">No app data yet to compare.</p>}
      </div>
    </div>
  );
}
