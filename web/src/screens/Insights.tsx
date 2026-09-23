/**
 * What the history says. Also the way in to settings and the cutover check.
 *
 * Chart form: one measure per row, ranked, with a reference tick -- the same
 * bullet-row pattern as the waste review. Thirty items across a phone screen
 * rules out grouped bars, and a single series needs no legend because the
 * heading names it.
 *
 * The sell-out panel is the most important thing here and the least obvious.
 * An item that sells out most days has demand nobody has ever observed, so its
 * numbers are floors rather than estimates -- and the only way to find out what
 * it would really sell is to deliberately make more for a couple of weeks.
 */

import { useEffect, useMemo, useState } from "react";
import type { BizDate } from "../lib/businessDay";
import { addDays, daysBetween, formatShort, weekdayName } from "../lib/businessDay";
import { toObservations } from "../lib/model";
import * as store from "../lib/store";
import type { Item } from "../lib/types";
import { Icon } from "../components/Icon";
import type { WeatherEffect } from "../lib/weatherEffect";
import { WeatherBlock } from "../components/WeatherBlock";

interface Props {
  /** Null until a location is set and some history has been matched. */
  weather: WeatherEffect | null;
  today: BizDate;
  items: Item[];
  onBack?: () => void;
  onSettings?: () => void;
  onCloud?: () => void;
  onWeather?: () => void;
  onReconcile?: () => void;
  /** Drawn inside History: no header of its own, and no "More" links --
   *  everything they pointed at now lives on Setup. */
  embedded?: boolean;
}

const RANGES = [
  { label: "14 days", days: 14 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
];

export function Insights({ weather,
  today, items, onBack, onSettings, onCloud, onWeather, onReconcile, embedded = false,
}: Props) {
  const [entries, setEntries] = useState<Awaited<ReturnType<typeof store.getAllEntries>>>([]);
  const [days, setDays] = useState(30);
  const [tab, setTab] = useState<"waste" | "sellout" | "weekday">("waste");

  useEffect(() => { void store.getAllEntries().then(setEntries); }, []);

  const byItem = useMemo(() => new Map(items.map((i) => [i.itemId, i])), [items]);
  const since = addDays(today, -days);

  const rows = useMemo(() => {
    const obs = toObservations(entries).filter((o) => o.date >= since && o.date <= today);
    const acc = new Map<number, {
      made: number; wasted: number; sold: number; days: number; sellouts: number;
    }>();
    for (const o of obs) {
      const row = acc.get(o.itemId)
        ?? { made: 0, wasted: 0, sold: 0, days: 0, sellouts: 0 };
      row.made += o.supply;
      row.wasted += o.supply - o.sold;
      row.sold += o.sold;
      row.days += 1;
      if (o.censored) row.sellouts += 1;
      acc.set(o.itemId, row);
    }
    return [...acc.entries()]
      .map(([itemId, r]) => ({
        item: byItem.get(itemId),
        ...r,
        wasteRate: r.made ? r.wasted / r.made : 0,
        selloutRate: r.days ? r.sellouts / r.days : 0,
        cost: (r.wasted) * (byItem.get(itemId)?.unitCost ?? 0),
      }))
      .filter((r) => r.item);
  }, [entries, since, today, byItem]);

  const totals = useMemo(() => {
    const made = rows.reduce((s, r) => s + r.made, 0);
    const wasted = rows.reduce((s, r) => s + r.wasted, 0);
    const cost = rows.reduce((s, r) => s + r.cost, 0);
    const dayCount = new Set(
      toObservations(entries).filter((o) => o.date >= since && o.date <= today)
        .map((o) => o.date)).size;
    // The window runs back from today, but the data may not reach today. A
    // "last 30 days" that quietly stops a week ago is the kind of thing that
    // gets read as current and acted on -- so the screen names the last day it
    // actually has rather than leaving the reader to assume.
    const dates = toObservations(entries).map((o) => o.date).filter((d) => d <= today);
    const latest = dates.length ? dates.sort()[dates.length - 1] : null;
    // Daily waste cost across the window, for the trend under the hero. Days
    // with no observation are gaps, not zeros.
    const perDay = new Map<string, number>();
    for (const o of toObservations(entries)) {
      if (o.date < since || o.date > today) continue;
      const unit = byItem.get(o.itemId)?.unitCost ?? 0;
      perDay.set(o.date, (perDay.get(o.date) ?? 0) + (o.supply - o.sold) * unit);
    }
    const series: Array<number | null> = Array.from({ length: days }, (_, i) => {
      const d = addDays(since, i + 1);
      return perDay.has(d) ? perDay.get(d)! : null;
    });
    const dailyAvg = dayCount ? cost / dayCount : 0;
    return { made, wasted, cost, dayCount, latest, series, dailyAvg,
             staleBy: latest ? daysBetween(latest, today) : 0,
             rate: made ? wasted / made : 0 };
  }, [rows, entries, since, today, byItem, days]);

  const perWeekday = useMemo(() => {
    const acc = new Map<string, { sold: number; days: Set<string> }>();
    for (const o of toObservations(entries).filter((x) => x.date >= since && x.date <= today)) {
      const key = weekdayName(o.date);
      const row = acc.get(key) ?? { sold: 0, days: new Set<string>() };
      row.sold += o.sold;
      row.days.add(o.date);
      acc.set(key, row);
    }
    const order = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
                   "Saturday", "Sunday"];
    return order.map((name) => {
      const row = acc.get(name);
      return { name, mean: row && row.days.size ? row.sold / row.days.size : 0 };
    });
  }, [entries, since, today]);

  // Rank and bar-length must encode the SAME quantity. Sorting by cost while
  // drawing units produces bars whose order contradicts the list, which is
  // worse than no chart. Cost is used only when every row has a recipe;
  // otherwise everything falls back to units so the comparison stays fair.
  const haveAllCosts = rows.length > 0 && rows.every((r) => (r.item?.unitCost ?? 0) > 0);
  const measure = (r: typeof rows[number]) =>
    tab === "sellout" ? r.selloutRate : haveAllCosts ? r.cost : r.wasted;
  const ranked = tab === "weekday" ? []
    : [...rows].sort((a, b) => measure(b) - measure(a));
  const scale = Math.max(tab === "sellout" ? 0.01 : 1, ...ranked.map(measure));
  const weekdayScale = Math.max(1, ...perWeekday.map((w) => w.mean));

  const missingCosts = rows.filter((r) => !(r.item?.unitCost ?? 0)).length;
  const heavy = rows.filter((r) => r.selloutRate >= 0.6 && r.days >= 4);

  if (!entries.length) {
    return (
      <div>
        {!embedded && (
        <header className="bar">
          <button className="ghost" onClick={onBack} aria-label="Back"><Icon name="back" size={20} /></button>
          <h1>Insights</h1>
        </header>
        )}
        <div className="card">
          <h2>Nothing to show yet</h2>
          <p className="hint">
            Record a few days of production and leftovers and this fills in.
          </p>
        </div>

      {!embedded && (
      <div className="card">
        <h2>More</h2>
        <div className="actions">
          <button className="ghost" onClick={onSettings}>Settings &amp; backup</button>
          <button className="ghost" onClick={onCloud}>Cloud sync</button>
        </div>
        <div className="actions">
          <button className="ghost" onClick={onWeather}>Weather</button>
        </div>
        <div className="actions">
          <button className="ghost" onClick={onReconcile}>Spreadsheet check</button>
        </div>
      </div>
      )}
      </div>
    );
  }

  return (
    <div>
      {!embedded && (
      <header className="bar">
        <h1>
          Insights
          <span className="sub">
            {days} days{totals.latest ? ` · to ${weekdayName(totals.latest).slice(0, 3)} ${formatShort(totals.latest)}` : ""}
          </span>
        </h1>
        <button className="ghost" onClick={onBack} aria-label="Back">
          <Icon name="back" size={20} />
        </button>
      </header>
      )}

      {totals.staleBy > 1 && (
        <div className="banner">
          <Icon name="clock" size={16} className="ico" />
          <span>
            Everything below stops at {weekdayName(totals.latest!)}{" "}
            {formatShort(totals.latest!)} — {totals.staleBy} days ago. The
            ranges are counted back from today, so the most recent days in each
            one are empty.
          </span>
        </div>
      )}

      <div className="tabs" role="group" aria-label="Range">
        {RANGES.map((r) => (
          <button key={r.days} aria-pressed={days === r.days}
                  onClick={() => setDays(r.days)}>{r.label}</button>
        ))}
      </div>

      {/* One hero per view, and on this screen it is the money: units and a
          percentage are both ways of saying how much, but the dollar figure
          is the one that decides whether anything changes tomorrow. */}
      <div className="card">
        <div className="hero-row">
          <div className="stat hero accent">
            <div className="eyebrow">Thrown away</div>
            <div className="value">
              {totals.cost > 0 ? `$${Math.round(totals.cost).toLocaleString()}` : "—"}
            </div>
          </div>
          <div className="hero-side">
            <div className="num">
              {Math.round(totals.wasted).toLocaleString()}<span> units</span>
            </div>
            <div className="num">
              {Math.round(totals.rate * 100)}%<span> of {Math.round(totals.made).toLocaleString()} made</span>
            </div>
          </div>
        </div>
        {totals.series.some((v) => v !== null) && (
          <Trend series={totals.series} avg={totals.dailyAvg} />
        )}
        <p className="hint" style={{ marginTop: 10 }}>
          {totals.cost > 0 && `Dotted line is the daily average, $${Math.round(totals.dailyAvg)}. `}
          {/* A floor when some items have no recipe: their waste is real but
              uncosted, so this total is not the full bill. */}
          {!haveAllCosts && `Costs are at least this — ${missingCosts} item${missingCosts > 1 ? "s have" : " has"} no recipe yet.`}
        </p>
      </div>

      <div className="tabs" role="group" aria-label="View">
        <button aria-pressed={tab === "waste"} onClick={() => setTab("waste")}>
          Waste
        </button>
        <button aria-pressed={tab === "sellout"} onClick={() => setTab("sellout")}>
          Sell-outs
        </button>
        <button aria-pressed={tab === "weekday"} onClick={() => setTab("weekday")}>
          By weekday
        </button>
      </div>

      {tab === "weekday" ? (
        <div className="card">
          <h2>Units sold per day</h2>
          <p className="hint">Average across the period, by day of the week.</p>
          <div className="chart">
            {perWeekday.map((w) => (
              <div className="crow" key={w.name}>
                <div className="clabel">
                  <span className="cname">{w.name}</span>
                  <span className="cval">{w.mean.toFixed(1)}</span>
                </div>
                <div className="track" title={`${w.name}: ${w.mean.toFixed(1)} sold per day`}>
                  <div className="fill"
                       style={{ width: `${(w.mean / weekdayScale) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="head-row">
            <h2>{tab === "waste" ? (haveAllCosts ? "By item, by cost" : "By item, by units") : "How often it sells out"}</h2>
            <span className="eyebrow small">{tab === "waste" ? "binned · made · $" : "rate · days"}</span>
          </div>
          {(tab === "sellout" || !haveAllCosts) && (
            <p className="hint">
              {tab === "waste"
                ? "Add recipes to rank by cost instead."
                : "An item at the top sells out most days — you have never seen what it would really sell."}
            </p>
          )}
          <div className="chart">
            {ranked.slice(0, 20).map((r) => {
              const value = measure(r);
              return (
                <div className="crow" key={r.item!.itemId}>
                  <div className="clabel">
                    <span className="cname">{r.item!.displayName}</span>
                    <span className="cval">
                      {tab === "waste"
                        ? <>{Math.round(r.wasted)} · {Math.round(r.made)}{r.cost ? <> · <strong>${r.cost.toFixed(0)}</strong></> : null}</>
                        : <><strong>{Math.round(r.selloutRate * 100)}%</strong> of {r.days} days</>}
                    </span>
                  </div>
                  <div className="track">
                    <div className="fill"
                         style={{ width: `${(value / scale) * 100}%` }} />
                  </div>
                </div>
              );
            })}
            {!ranked.length && <p className="hint">No data in this range.</p>}
          </div>
        </div>
      )}

      {weather && <WeatherBlock effect={weather} />}

      {heavy.length > 0 && (
        <div className="card">
          <h2>Worth an experiment</h2>
          <p className="hint">
            These sold out most days. Nobody has seen what they'd really sell —
            make 2–3 extra for a fortnight and find out.
          </p>
          <div className="chips">
            {heavy.slice(0, 6).map((r) => (
              <span key={r.item!.itemId}>
                {r.item!.displayName} <em>{Math.round(r.selloutRate * 100)}%</em>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <h2>Since {formatShort(since)}</h2>
        <div className="scroll-x">
          <table className="grid">
            <thead>
              <tr><th>Item</th><th>Made</th><th>Binned</th><th>Waste</th><th>Sold out</th></tr>
            </thead>
            <tbody>
              {[...rows].sort((a, b) => b.made - a.made).map((r) => (
                <tr key={r.item!.itemId}>
                  <td>{r.item!.displayName}</td>
                  <td className="num">{Math.round(r.made)}</td>
                  <td className="num">{Math.round(r.wasted)}</td>
                  <td className="num">{Math.round(r.wasteRate * 100)}%</td>
                  <td className="num">{Math.round(r.selloutRate * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {!embedded && (
      <div className="card">
        <h2>More</h2>
        <div className="actions">
          <button className="ghost" onClick={onSettings}>Settings &amp; backup</button>
          <button className="ghost" onClick={onCloud}>Cloud sync</button>
        </div>
        <div className="actions">
          <button className="ghost" onClick={onWeather}>Weather</button>
        </div>
        <div className="actions">
          <button className="ghost" onClick={onReconcile}>Spreadsheet check</button>
        </div>
      </div>
      )}
    </div>
  );
}

/**
 * Daily cost across the window with the average as a dotted reference. Gaps
 * where there is no observation; the last point marked so the eye finds
 * "now" on a line that may end days before the right edge.
 */
function Trend({ series, avg }: { series: Array<number | null>; avg: number }) {
  const W = 330, H = 40, pad = 3;
  const known = series.filter((v): v is number => v !== null);
  if (known.length < 2) return null;
  const max = Math.max(...known, avg, 1);
  const x = (i: number) => pad + (i / (series.length - 1)) * (W - pad * 2);
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const runs: string[] = [];
  let cur: string[] = [];
  series.forEach((v, i) => {
    if (v === null) { if (cur.length) runs.push(cur.join(" ")); cur = []; }
    else cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  if (cur.length) runs.push(cur.join(" "));
  const lastIdx = series.length - 1 - [...series].reverse().findIndex((v) => v !== null);
  return (
    <svg className="trend" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
         aria-label="Daily waste cost across the period" style={{ marginTop: 14 }}>
      {runs.map((pts, i) => (
        <polyline key={i} points={pts} fill="none" className="line"
                  strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      ))}
      <line x1={0} y1={y(avg)} x2={W} y2={y(avg)} className="avg"
            strokeWidth={1} strokeDasharray="2 3" opacity={0.7} vectorEffect="non-scaling-stroke" />
      <circle cx={x(lastIdx)} cy={y(series[lastIdx]!)} r={3.5} className="dot" strokeWidth={2} />
    </svg>
  );
}
