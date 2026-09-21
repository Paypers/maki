/**
 * What just happened, against the same weekday a week ago.
 *
 * Chart form: one measure (yesterday's leftovers) ranked by size, with last
 * week's value as a reference tick on the same row. One series, so no legend --
 * the heading names it -- and every bar is directly labelled. A grouped two-bar
 * chart across thirty items would be unreadable on a phone; a bullet row is the
 * same comparison in half the height.
 *
 * Delta chips carry an arrow glyph AND the number. The good/critical pair
 * measures ΔE 4.1 under deuteranopia, so colour alone would tell a red-green
 * colourblind reader nothing. Do not remove the arrows.
 */

import { useEffect, useMemo, useState } from "react";
import type { BizDate } from "../lib/businessDay";
import { formatShort, weekdayName, weeksBack } from "../lib/businessDay";
import * as store from "../lib/store";
import type { Item } from "../lib/types";
import { Icon } from "../components/Icon";

interface Props {
  date: BizDate;
  items: Item[];
  onContinue: () => void;
}

interface Line {
  item: Item;
  wasted: number;
  made: number;
  lastWeek: number;
}

export function WasteReview({ date, items, onContinue }: Props) {
  const [lines, setLines] = useState<Line[]>([]);
  const prior = weeksBack(date, 1);

  useEffect(() => {
    let live = true;
    (async () => {
      const [now, then] = await Promise.all([
        store.getEntries(date), store.getEntries(prior),
      ]);
      if (!live) return;
      const w = store.currentQuantities(now, "waste");
      const m = store.currentQuantities(now, "made");
      const r = store.currentQuantities(now, "refill");
      const wPrev = store.currentQuantities(then, "waste");
      setLines(
        items
          .map((item) => ({
            item,
            wasted: w.get(item.itemId)?.quantity ?? 0,
            made: (m.get(item.itemId)?.quantity ?? 0) + (r.get(item.itemId)?.quantity ?? 0),
            lastWeek: wPrev.get(item.itemId)?.quantity ?? 0,
          }))
          .filter((l) => l.made > 0 || l.wasted > 0 || l.lastWeek > 0)
          .sort((a, b) => b.wasted - a.wasted || b.lastWeek - a.lastWeek),
      );
    })();
    return () => { live = false; };
  }, [date, prior, items]);

  const totals = useMemo(() => {
    const wasted = lines.reduce((s, l) => s + l.wasted, 0);
    const made = lines.reduce((s, l) => s + l.made, 0);
    const lastWeek = lines.reduce((s, l) => s + l.lastWeek, 0);
    const cost = lines.reduce((s, l) => s + l.wasted * (l.item.unitCost ?? 0), 0);
    return { wasted, made, lastWeek, cost, rate: made ? wasted / made : 0 };
  }, [lines]);

  const scale = Math.max(1, ...lines.map((l) => Math.max(l.wasted, l.lastWeek)));
  const change = totals.wasted - totals.lastWeek;
  const dir = change > 0 ? "up" : change < 0 ? "down" : "none";
  const arrow = change > 0 ? "↑" : change < 0 ? "↓" : "→";

  return (
    <div>
      <header className="bar">
        <h1>
          How yesterday went
          <span className="sub">{weekdayName(date)} {formatShort(date)}</span>
        </h1>
      </header>

      <div className="stats">
        <div className="stat">
          <div className="label">Left over</div>
          <div className="value">{totals.wasted}</div>
        </div>
        <div className="stat">
          <div className="label">Of {totals.made} made</div>
          <div className="value">{Math.round(totals.rate * 100)}%</div>
        </div>
        <div className="stat">
          <div className="label">vs {formatShort(prior)}</div>
          <div className={`value delta ${dir}`} style={{ textAlign: "left" }}>
            {arrow} {change === 0 ? "same" : Math.abs(change)}
          </div>
        </div>
      </div>

      {totals.cost > 0 && (
        <div className="banner info">
          <Icon name="check" size={16} className="ico" />
          <span>
            About <strong>${totals.cost.toFixed(2)}</strong> of product discarded.
            Ingredient costs are still drafts, so treat this as a rough figure.
          </span>
        </div>
      )}

      <div className="card">
        <h2>Left over by item</h2>
        <p className="hint">
          Bar is yesterday. The tick is the same weekday last week.
        </p>
        <div className="chart">
          {lines.filter((l) => l.wasted > 0 || l.lastWeek > 0).map((l) => {
            const d = l.wasted - l.lastWeek;
            return (
              <div className="crow" key={l.item.itemId}>
                <div className="clabel">
                  <span>{l.item.displayName}</span>
                  <span className="cval">
                    {l.wasted} of {l.made}
                    {d !== 0 && (
                      <span className={`delta ${d > 0 ? "up" : "down"}`}>
                        {" "}{d > 0 ? "↑" : "↓"}{Math.abs(d)}
                      </span>
                    )}
                  </span>
                </div>
                <div className="track">
                  <div className="fill" style={{ width: `${(l.wasted / scale) * 100}%` }} />
                  {l.lastWeek > 0 && (
                    <div
                      className="ref"
                      style={{ left: `calc(${(l.lastWeek / scale) * 100}% - 1px)` }}
                      title={`${l.lastWeek} last ${weekdayName(prior)}`}
                    />
                  )}
                </div>
              </div>
            );
          })}
          {lines.every((l) => l.wasted === 0) && (
            <p className="hint">Nothing left over. Every item sold out.</p>
          )}
        </div>
      </div>

      <details className="card">
        <summary>Show as a table</summary>
        <div className="scroll-x">
          <table className="grid">
            <thead>
              <tr><th>Item</th><th>Made</th><th>Left</th><th>Last wk</th><th>Sold</th></tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.item.itemId}>
                  <td>{l.item.displayName}</td>
                  <td className="num">{l.made}</td>
                  <td className="num">{l.wasted}</td>
                  <td className="num">{l.lastWeek}</td>
                  <td className="num">{l.made - l.wasted}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <div className="footer">
        <div className="inner">
          <button className="primary" onClick={onContinue}>Continue to today →</button>
        </div>
      </div>
    </div>
  );
}
