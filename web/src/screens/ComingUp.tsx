/**
 * Coming up: what the next two weeks are likely to need, by item.
 *
 * For ordering and prep -- "how much salmon for the week", "what does
 * Saturday look like" -- so it answers both: pick a single day for its list,
 * or the whole seven days for each item's total with its days laid out under
 * it. Every number on it is an estimate and the screen opens by saying so;
 * see lib/plan.ts for what an estimate is and how much they move.
 */

import { useState } from "react";
import type { BizDate } from "../lib/businessDay";
import { formatShort, weekdayName } from "../lib/businessDay";
import type { DayPlan, Drift } from "../lib/plan";
import type { Item } from "../lib/types";
import { ScreenHeader } from "../components/ScreenHeader";
import { PlanKey, PlanLines, PlanNotice, PlanStats, planMark } from "../components/Plan";

interface Props {
  /** The next fourteen days, tomorrow first. */
  plans: DayPlan[];
  items: Item[];
  drift: (Drift | null)[];
  suggestions: boolean;
  /** Open on this day, if it is in the plan. */
  initialDate?: BizDate;
  onBack: () => void;
}

const short = (d: BizDate) => `${weekdayName(d).slice(0, 1)} ${Number(d.slice(-2))}`;

export function ComingUp({ plans, items, drift, suggestions, initialDate, onBack }: Props) {
  const start = Math.max(0, plans.findIndex((p) => p.date === initialDate));
  const [half, setHalf] = useState(start >= 7 ? 1 : 0);
  // An index into the seven days on show, or "all" for the seven together.
  const [sel, setSel] = useState<number | "all">(initialDate ? start % 7 : "all");

  const days = plans.slice(half * 7, half * 7 + 7);
  if (!days.length) {
    return (
      <div>
        <ScreenHeader title="Coming up" eyebrow="Estimates" onBack={onBack} />
        <div className="card"><p className="hint">Nothing to plan yet.</p></div>
      </div>
    );
  }
  const picked = sel === "all" ? null : days[Math.min(sel, days.length - 1)];
  const range = `${formatShort(days[0].date)} – ${formatShort(days[days.length - 1].date)}`;

  // The seven days together: each item's total, and its days under it.
  const byId = new Map(items.map((i) => [i.itemId, i]));
  const rows = items
    .map((item) => {
      const cells = days.map((d) => d.items.find((p) => p.itemId === item.itemId) ?? null);
      return { item, cells, total: cells.reduce((s, c) => s + (c?.qty ?? 0), 0) };
    })
    .filter((r) => r.total > 0 && byId.has(r.item.itemId));

  return (
    <div>
      <ScreenHeader title="Coming up" eyebrow="Estimates" onBack={onBack} />

      <PlanNotice drift={drift} suggestions={suggestions} />

      <div className="tabs" role="group" aria-label="Which week">
        {[0, 1].map((h) => {
          const w = plans.slice(h * 7, h * 7 + 7);
          if (!w.length) return null;
          return (
            <button key={h} aria-pressed={half === h} onClick={() => { setHalf(h); setSel("all"); }}>
              {h === 0 ? "Next 7 days" : "The 7 after"}
              <small className="tab-sub">{formatShort(w[0].date)} – {formatShort(w[w.length - 1].date)}</small>
            </button>
          );
        })}
      </div>

      <div className="tabs plan-days" role="group" aria-label="Which day">
        <button aria-pressed={sel === "all"} onClick={() => setSel("all")}>All 7</button>
        {days.map((d, i) => (
          <button key={d.date} aria-pressed={sel === i} onClick={() => setSel(i)}
                  aria-label={`${weekdayName(d.date)} ${formatShort(d.date)}`}>
            {short(d.date)}
          </button>
        ))}
      </div>

      <section className="card plan-card">
        <div className="head-row">
          <div className="eyebrow">
            {picked ? `${weekdayName(picked.date)} ${formatShort(picked.date)} · estimate`
              : `${range} · estimate`}
          </div>
        </div>
        <PlanStats plans={picked ? [picked] : days} />

        {picked && picked.closed && <p className="hint">Marked closed — nothing planned.</p>}
        {picked && !picked.closed && <PlanLines plan={picked} items={items} />}

        {!picked && (
          <>
            <div className="plan-week">
              {rows.map(({ item, cells, total }, n) => (
                <div className="plan-week-row" key={item.itemId}>
                  {/* The days again every eight items, so a long list never
                      leaves you counting columns to find Saturday. */}
                  {n % 8 === 0 && (
                    <div className="plan-week-head" aria-hidden="true">
                      {days.map((d) => <span key={d.date}>{short(d.date)}</span>)}
                    </div>
                  )}
                  <div className="top">
                    <span className="nm">{item.displayName}</span>
                    <span className="num tot">~{total}</span>
                  </div>
                  <div className="cells">
                    {cells.map((c, i) => (
                      <span key={days[i].date}
                            className={`num ${c?.source ?? "none"}${days[i].closed ? " closed" : ""}`}
                            aria-label={`${weekdayName(days[i].date)}: ${c ? c.qty : "none"}`}>
                        {days[i].closed ? "—" : c ? <>{c.qty}{planMark(c) && <sup>{planMark(c)}</sup>}</> : "·"}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <PlanKey />
          </>
        )}
      </section>
    </div>
  );
}
