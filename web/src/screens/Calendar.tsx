/**
 * The month, as a grid.
 *
 * Two things are encoded per day and they are deliberately separate channels,
 * because mixing them is how a calendar becomes unreadable:
 *
 *   STATUS  -- does this day need something from you? An amber ring. Rare by
 *              design: most days should be finished.
 *   WASTE   -- how much came back? A bar along the bottom of the cell, in ink,
 *              scaled against the worst day on screen.
 *
 * So a glance answers "what do I owe?" and a second glance answers "how has
 * the month gone?", without either question interfering with the other.
 */

import { useMemo, useState } from "react";
import type { BizDate } from "../lib/businessDay";
import { addDays, formatShort, fromBizDate, isoWeekday, toBizDate } from "../lib/businessDay";
import type { DayStatIndex } from "../lib/dayStats";
import { emptyDay, wasteRate } from "../lib/dayStats";
import { Icon } from "../components/Icon";

interface Props {
  today: BizDate;
  stats: DayStatIndex;
  onPick: (date: BizDate) => void;
  onBack?: () => void;
  /** Drawn inside History, under that screen's own header. */
  embedded?: boolean;
}

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

export function Calendar({ today, stats, onPick, onBack, embedded = false }: Props) {
  const [anchor, setAnchor] = useState<BizDate>(today);
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

  // Scale the waste bars against the worst day in THIS month, not all time:
  // the question a month view answers is "which days were bad for this month",
  // and a single catastrophic day last year would flatten everything here.
  const worst = Math.max(1, ...inMonthDays.map((d) => d.wasted ?? 0));
  const outstanding = inMonthDays.filter((d) => d.needsWaste || d.needsProduction).length;

  // A month with no records at all is almost certainly a mis-navigation, so
  // offer the way back rather than a wall of empty cells.
  const anyRecords = inMonthDays.some((d) => d.phase === "open" || d.phase === "closed");

  const totals = inMonthDays.reduce(
    (a, d) => {
      if (d.phase !== "open" && d.phase !== "closed") return a;
      a.made += d.made;
      if (d.wasted !== null) { a.wasted += d.wasted; a.counted += 1; }
      if (d.wasteCost !== null) a.cost += d.wasteCost;
      return a;
    },
    { made: 0, wasted: 0, cost: 0, counted: 0 },
  );

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

      <div className="cal">
        <div className="cal-wd" aria-hidden="true">
          {WD.map((w, i) => <span key={i}>{w}</span>)}
        </div>
        <div className="cal-grid">
          {days.map((d) => {
            const inMonth = fromBizDate(d.date).getMonth() === month;
            const needs = d.needsWaste || d.needsProduction;
            const rate = wasteRate(d);
            const bar = d.wasted !== null ? Math.max(3, (d.wasted / worst) * 100) : 0;
            const label = [
              formatShort(d.date),
              d.phase === "closed" ? `${d.made} made, ${d.wasted} left over`
                : d.phase === "open" ? `${d.made} made, not counted`
                : d.phase === "outage" ? "closed"
                : d.phase === "future" ? "" : "nothing recorded",
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
                aria-label={label}
                aria-current={d.date === today ? "date" : undefined}
                disabled={d.phase === "future"}
                onClick={() => onPick(d.date)}
              >
                <span className="n">{fromBizDate(d.date).getDate()}</span>
                {d.wasted !== null && (
                  <span className="bar" style={{ height: `${bar}%` }}
                        data-rate={rate !== null && rate >= 0.5 ? "high" : undefined} />
                )}
                {d.phase === "open" && <span className="dot" />}
              </button>
            );
          })}
        </div>
      </div>

      <div className="cal-key">
        <span><i className="k-needs" />needs you</span>
        <span><i className="k-open" />not counted</span>
        <span><i className="k-bar" />leftovers</span>
      </div>

      {anyRecords ? (
        <div className="card">
          <div className="eyebrow">This month</div>
          <div className="stats" style={{ marginTop: 12 }}>
            <div className="stat">
              <div className="label">made</div>
              <div className="value">{totals.made.toLocaleString()}</div>
            </div>
            <div className="stat accent">
              <div className="label">left over</div>
              <div className="value">{totals.wasted.toLocaleString()}</div>
            </div>
            <div className="stat">
              <div className="label">cost</div>
              <div className="value">
                {totals.cost > 0 ? `$${Math.round(totals.cost).toLocaleString()}` : "—"}
              </div>
            </div>
          </div>
          <p className="hint" style={{ marginTop: 12 }}>
            Across {totals.counted} counted day{totals.counted === 1 ? "" : "s"}.
            Tap any day to see what happened.
          </p>
        </div>
      ) : (
        <div className="card">
          <p className="hint">Nothing recorded this month.</p>
          <button onClick={() => setAnchor(today)}>Back to this month</button>
        </div>
      )}
    </div>
  );
}
