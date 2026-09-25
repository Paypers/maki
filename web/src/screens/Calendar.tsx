/**
 * The month, as a grid of numbers.
 *
 * Each day shows ONE number, and a switch above the grid says which: profit,
 * sales, what was thrown away, rolls left over, or rolls made -- and on the
 * days ahead, "made" is the rule's estimated plan. A number, not a shaded
 * bar: the bar this replaced ("how full is the square") had to be decoded
 * against the worst day on screen, and nobody could say what half-full meant.
 *
 * Every mark has one meaning, spelled out in the key under the grid:
 *   $148      counted -- what really happened
 *   ~$140     not happened yet -- projected from recent same weekdays
 *   ~41       (made) not happened yet -- the rule's plan, an estimate
 *   ?         traded but leftovers never counted -- unknown, and owed
 *   —         a past day with nothing entered -- counts as $0
 *   amber ring  needs something from you
 *   dashed      today
 *
 * Under the grid: the weeks of the month, then the month itself -- counted so
 * far, projected to the end, and where the money went.
 */

import { useMemo, useState } from "react";
import type { BizDate } from "../lib/businessDay";
import { addDays, formatShort, fromBizDate, isoWeekday, toBizDate } from "../lib/businessDay";
import type { DayStat, DayStatIndex } from "../lib/dayStats";
import { emptyDay } from "../lib/dayStats";
import {
  estimateDay, monthOf, projectPeriod, share, usd, usdShort,
} from "../lib/money";
import { MoneyNote, PeriodCard } from "../components/Money";
import type { DayPlan } from "../lib/plan";
import { Icon } from "../components/Icon";

interface Props {
  today: BizDate;
  stats: DayStatIndex;
  onPick: (date: BizDate) => void;
  onBack?: () => void;
  /** Drawn inside History, under that screen's own header. */
  embedded?: boolean;
  /** Share of each sale you keep, for the receipt. */
  keepShare?: number;
  /** The rule's estimated plan for the next two weeks, by date. */
  plans?: ReadonlyMap<BizDate, DayPlan>;
}

type Metric = "profit" | "sales" | "waste" | "left" | "made";
const METRICS: { key: Metric; label: string; says: string }[] = [
  { key: "profit", label: "Profit", says: "profit that day, after the middle man and ingredients" },
  { key: "sales", label: "Sales", says: "what customers paid that day" },
  { key: "waste", label: "Thrown away", says: "ingredients binned that day, in dollars" },
  { key: "left", label: "Left over", says: "rolls left over that day" },
  { key: "made", label: "Made", says: "rolls made that day — and ahead, the rule's estimated plan" },
];
const METRIC_KEY = "calendar-metric";

const WD = ["M", "T", "W", "T", "F", "S", "S"];

/** The Mondays-first grid covering the month that `anchor` falls in. */
function monthGrid(anchor: BizDate): { cells: BizDate[]; label: string } {
  const d = fromBizDate(anchor);
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const start = addDays(toBizDate(first), -(isoWeekday(toBizDate(first)) - 1));
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const end = addDays(toBizDate(last), 7 - isoWeekday(toBizDate(last)));
  const cells: BizDate[] = [];
  for (let c = start; c <= end; c = addDays(c, 1)) cells.push(c);
  return {
    cells,
    label: first.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
  };
}

function readMetric(): Metric {
  try {
    const v = localStorage.getItem(METRIC_KEY);
    if (v === "profit" || v === "sales" || v === "waste" || v === "left" || v === "made") return v;
  } catch { /* private window: the default is fine */ }
  return "profit";
}

/** The number a counted day shows, or null when it has none. */
function actualValue(d: DayStat, m: Metric): number | null {
  if (m === "left") return d.wasted;
  if (m === "made") return d.made;
  if (m === "profit") return d.profit;
  if (m === "sales") return d.sales;
  return d.wasteCost;
}

function fmt(v: number, m: Metric): string {
  return m === "left" || m === "made" ? String(Math.round(v)) : usdShort(v);
}

export function Calendar({
  today, stats, onPick, onBack, embedded = false, keepShare = 1, plans,
}: Props) {
  const [anchor, setAnchor] = useState<BizDate>(today);
  const [metric, setMetricState] = useState<Metric>(readMetric);
  const setMetric = (m: Metric) => {
    setMetricState(m);
    try { localStorage.setItem(METRIC_KEY, m); } catch { /* not kept; fine */ }
  };
  const { cells, label } = useMemo(() => monthGrid(anchor), [anchor]);
  const month = fromBizDate(anchor).getMonth();

  /** The 1st of the month n months away. Stepping by days skipped a month
   *  whenever the anchor landed after the 28th. */
  const shiftMonth = (n: number) => {
    const d = fromBizDate(anchor);
    return toBizDate(new Date(d.getFullYear(), d.getMonth() + n, 1));
  };

  const days = useMemo(
    () => cells.map((c) => stats.byDate.get(c) ?? emptyDay(c, today)),
    [cells, stats, today],
  );

  const inMonthDays = days.filter((d) => fromBizDate(d.date).getMonth() === month);
  const outstanding = inMonthDays.filter((d) => d.needsWaste || d.needsProduction).length;
  const anyRecords = inMonthDays.some((d) => d.phase === "open" || d.phase === "closed");

  const [mFrom, mTo] = monthOf(anchor);
  const monthMoney = useMemo(() => projectPeriod(stats, today, mFrom, mTo),
                             [stats, today, mFrom, mTo]);
  const weeks = useMemo(() => {
    const out: { from: BizDate; to: BizDate; p: ReturnType<typeof projectPeriod> }[] = [];
    for (let i = 0; i < cells.length; i += 7) {
      const from = cells[i], to = cells[i + 6];
      out.push({ from, to, p: projectPeriod(stats, today, from, to) });
    }
    return out;
  }, [cells, stats, today]);

  const units = inMonthDays.reduce(
    (a, d) => {
      if (d.wasted === null) return a;
      a.made += d.made; a.left += d.wasted; a.counted += 1;
      return a;
    },
    { made: 0, left: 0, counted: 0 },
  );

  const says = METRICS.find((m) => m.key === metric)!.says;

  return (
    <div>
      {!embedded && (
        <header className="bar">
          <h1>
            {label}
            <span className="sub">
              Calendar{outstanding ? ` · ${outstanding} outstanding` : ""}
            </span>
          </h1>
          <button className="ghost" onClick={onBack} aria-label="Back">
            <Icon name="back" size={20} />
          </button>
        </header>
      )}
      {embedded && <h2 className="section-title">{label}{outstanding ? ` · ${outstanding} to count` : ""}</h2>}

      <div className="cal-nav">
        <button className="ghost" aria-label="Previous month"
                onClick={() => setAnchor(shiftMonth(-1))}>
          <Icon name="back" size={18} />
        </button>
        <button className="link" onClick={() => setAnchor(today)}>Today</button>
        <button className="ghost" aria-label="Next month"
                onClick={() => setAnchor(shiftMonth(1))}>
          <Icon name="chevron" size={18} />
        </button>
      </div>

      <div className="tabs cal-metric" role="group" aria-label="What each day shows">
        {METRICS.map((m) => (
          <button key={m.key} aria-pressed={metric === m.key} onClick={() => setMetric(m.key)}>
            {m.label}
          </button>
        ))}
      </div>
      <p className="hint cal-says">Each day shows <strong>{says}</strong>.</p>

      <div className="cal">
        <div className="cal-wd" aria-hidden="true">
          {WD.map((w, i) => <span key={i}>{w}</span>)}
        </div>
        <div className="cal-grid">
          {days.map((d) => {
            const inMonth = fromBizDate(d.date).getMonth() === month;
            const needs = d.needsWaste || d.needsProduction;
            // What was made is known the moment it is entered; everything else
            // waits for the leftover count.
            const actual = d.phase === "closed" || (metric === "made" && d.phase === "open" && d.made > 0)
              ? actualValue(d, metric) : null;
            const plan = metric === "made" && d.phase === "future" && inMonth
              ? plans?.get(d.date) ?? null : null;
            const ahead = d.date >= today && d.phase !== "closed" && d.phase !== "outage";
            const est = ahead && inMonth ? estimateDay(stats, today, d.date) : null;
            const projected = est
              ? (metric === "left" ? est.mean.left
                : metric === "profit" ? est.mean.profit
                : metric === "sales" ? est.mean.sales : est.mean.wasteCost)
              : null;
            let value = "", kind = "";
            if (actual !== null) { value = fmt(actual, metric); kind = actual < 0 ? "neg" : "actual"; }
            else if (d.phase === "outage") { value = "closed"; kind = "closed"; }
            else if (d.phase === "open" && d.date < today) { value = "?"; kind = "unknown"; }
            else if (metric === "made") {
              if (plan && !plan.closed) { value = `~${plan.total}`; kind = "plan"; }
            }
            else if (d.phase === "empty" && inMonth && d.date < today && stats.dates.length
                     && d.date > stats.dates[0]) { value = "—"; kind = "blank"; }
            else if (projected !== null) { value = `~${fmt(projected, metric)}`; kind = "projected"; }
            const aria = [
              formatShort(d.date),
              actual !== null ? `${METRICS.find((m) => m.key === metric)!.label} ${fmt(actual, metric)}`
                : kind === "unknown" ? "leftovers not counted"
                : kind === "projected" ? `projected ${value.slice(1)}`
                : kind === "plan" ? `about ${value.slice(1)} rolls, estimated plan`
                : kind === "closed" ? "closed" : "",
              d.needsWaste ? "needs a leftover count" : "",
              d.needsProduction ? "needs today's production" : "",
            ].filter(Boolean).join(" — ");
            return (
              <button
                key={d.date}
                className={[
                  "cal-day", `p-${d.phase}`,
                  inMonth ? "" : "out",
                  needs ? "needs" : "",
                  d.date === today ? "is-today" : "",
                ].filter(Boolean).join(" ")}
                aria-label={aria}
                aria-current={d.date === today ? "date" : undefined}
                disabled={d.phase === "future" && !est && !plans?.has(d.date)}
                onClick={() => onPick(d.date)}
              >
                <span className="n">{fromBizDate(d.date).getDate()}</span>
                {value && <span className={`v ${kind}`}>{value}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="cal-key" aria-label="Key">
        {metric === "made" ? (
          <>
            <span><b className="kv">41</b> made</span>
            <span><b className="kv plan">~41</b> estimated plan — will change</span>
          </>
        ) : (
          <>
            <span><b className="kv">{metric === "left" ? "9" : "$148"}</b> counted</span>
            <span><b className="kv projected">{metric === "left" ? "~9" : "~$140"}</b> projected</span>
          </>
        )}
        {metric !== "made" && <span><b className="kv unknown">?</b> not counted</span>}
        <span><b className="kv blank">—</b> nothing entered</span>
        <span><i className="k-needs" />needs you</span>
        <span><i className="k-today" />today</span>
      </div>

      {weeks.some((w) => w.p.countedDays || w.p.aheadDays || w.p.uncountedDays) && (
        <section className="card weeks" aria-label="Week by week">
          <div className="weeks-head">
            <span>Week</span><span className="num">Sales</span>
            <span className="num">Thrown away</span><span className="num">Profit</span>
          </div>
          {weeks.map((w) => {
            const est = w.p.aheadDays + w.p.uncountedDays > 0;
            const t = w.p.total;
            if (!w.p.countedDays && !est) return null;
            const tilde = est ? "~" : "";
            const note = w.p.aheadDays
              ? (w.p.countedDays ? "so far + projected" : "projected")
              : w.p.uncountedDays
                ? `${w.p.uncountedDays} day${w.p.uncountedDays === 1 ? "" : "s"} estimated`
                : "";
            return (
              <div className={`weeks-row${est ? " est" : ""}`} key={w.from}>
                <span>{formatShort(w.from)} – {formatShort(w.to)}
                  {note && <small> {note}</small>}
                  {w.p.blankDays.length > 0 && <small> {w.p.blankDays.length} blank</small>}</span>
                <span className="num">{tilde}{usd(t.sales)}</span>
                <span className="num">{tilde}{usd(t.wasteCost)}
                  <small> {share(t.wasteCost, t.sales)}</small></span>
                <span className="num strong">{tilde}{usd(t.profit)}</span>
              </div>
            );
          })}
        </section>
      )}

      {anyRecords || monthMoney.aheadDays ? (
        <>
          <PeriodCard title={label} p={monthMoney} keepShare={keepShare} />
          {units.counted > 0 && (
            <div className="card">
              <div className="stats">
                <div className="stat">
                  <div className="label">rolls made</div>
                  <div className="value">{units.made.toLocaleString()}</div>
                </div>
                <div className="stat accent">
                  <div className="label">left over</div>
                  <div className="value">{units.left.toLocaleString()}</div>
                </div>
                <div className="stat">
                  <div className="label">of what you made</div>
                  <div className="value">{share(units.left, units.made)}</div>
                </div>
              </div>
              <p className="hint" style={{ marginTop: 12 }}>
                Across {units.counted} counted day{units.counted === 1 ? "" : "s"}.
                Tap any day for its receipt.
              </p>
            </div>
          )}
          <MoneyNote keepShare={keepShare} />
        </>
      ) : (
        <div className="card">
          <p className="hint">Nothing recorded this month.</p>
          <button onClick={() => setAnchor(today)}>Back to this month</button>
        </div>
      )}
    </div>
  );
}
