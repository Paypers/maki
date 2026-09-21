/**
 * The task list. What the operator sees when they open the app.
 *
 * Computed from the data, not the clock: any day with production and no
 * confirmed waste count shows up here, so a missed day surfaces by itself and
 * backfill is the same screen rather than a mode you have to go find.
 */

import type { BizDate, Task } from "../lib/businessDay";
import { formatShort, weekdayName } from "../lib/businessDay";
import { Icon } from "../components/Icon";
import { Sparkline } from "../components/Sparkline";

export interface DaySummary {
  /** Which day this is. Not necessarily yesterday -- see App.refresh. */
  date: BizDate;
  /** How far back it is, so the card can say so instead of implying "recent". */
  ageDays: number;
  made: number;
  /** Null when the count has not been done. Absence is not zero -- rendering
   *  an uncounted day as "0 left over" is the exact mistake this app exists to
   *  stop, and it would be a lie on the one screen the operator trusts most. */
  wasted: number | null;
  soldOut: number | null;
  /** Total leftovers per day, fourteen days to `date`; null = not counted. */
  trend: Array<number | null>;
}

interface Props {
  today: BizDate;
  tasks: Task[];
  pending: number;
  online: boolean;
  /** The last day on record at a glance. Null until there is one. */
  summary: DaySummary | null;
  onOpen: (task: Task) => void;
}

function ageLabel(ageDays: number): string {
  if (ageDays === 0) return "Today";
  if (ageDays === 1) return "Yesterday";
  return `${ageDays} days ago`;
}

export function Home({
  today, tasks, pending, online, summary, onOpen,
}: Props) {
  const primary = tasks[0];
  const rest = tasks.slice(1);
  const known = summary?.trend.filter((v): v is number => v !== null) ?? [];
  const trendAvg = known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : null;

  return (
    <div>
      <header className="bar">
        <h1>
          Today
          <span className="sub">{weekdayName(today).slice(0, 3)} · {formatShort(today)}</span>
        </h1>
        <span className={`pill${pending ? " pending" : online ? "" : " offline"}`} title={
          pending ? "Waiting to reach the server"
                  : "Saved in this browser. Export a backup from More."}>
          {pending ? `${pending} to sync` : online ? "Saved" : "Offline"}
        </span>
      </header>

      {!tasks.length && (
        <div className="card">
          <div className="eyebrow">Now</div>
          <h2>All caught up</h2>
          <p className="hint">
            Today's production is confirmed and yesterday's leftovers are counted.
          </p>
        </div>
      )}

      {/* The one thing to do now. The eyebrow says NOW in the accent; the
          heading states where things stand; the button carries the verb. */}
      {primary && (
        <div className="card focal">
          <div className="eyebrow accent">Now</div>
          <h2>
            {primary.kind === "waste"
              ? `${weekdayName(primary.date)}'s leftovers aren't counted`
              : primary.date === today
                ? "Nothing made yet"
                : `${weekdayName(primary.date)} was never planned`}
          </h2>
          <p className="hint">
            {primary.kind === "waste"
              ? "Count them and today's plan opens automatically."
              : `${weekdayName(primary.date)} template loaded. Adjust anything that looks wrong, then confirm.`}
          </p>
          <button className="primary" onClick={() => onOpen(primary)}>
            <span style={{ flex: 1, textAlign: "left" }}>
              {primary.kind === "waste"
                ? `Count ${weekdayName(primary.date)}'s leftovers`
                : "Open production sheet"}
            </span>
            <Icon name="chevron" size={20} />
          </button>
        </div>
      )}

      {rest.length > 0 && (
        <div className="card">
          <div className="eyebrow">Also outstanding</div>
          <p className="hint" style={{ marginTop: 6 }}>Missed days stay here until they're filled in.</p>
          <div className="tasklist">
            {rest.map((t) => (
              <button className="task" key={`${t.date}-${t.kind}`} onClick={() => onOpen(t)}>
                <Icon name={t.kind === "waste" ? "trash" : "calendar"}
                      size={20} className="ico" />
                <div className="who">
                  <strong>
                    {t.kind === "waste" ? "Leftovers" : "Production"} ·{" "}
                    {weekdayName(t.date)} {formatShort(t.date)}
                  </strong>
                  <span>{ageLabel(t.ageDays)}</span>
                </div>
                {t.ageDays > 2 && <span className="pill late">Late</span>}
                <Icon name="chevron" size={18} className="chev" />
              </button>
            ))}
          </div>
        </div>
      )}

      {summary && (
        <div className="card">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
            <div className="eyebrow">Last recorded</div>
            <div className="num" style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              {weekdayName(summary.date).slice(0, 3)} {formatShort(summary.date)}
              {summary.ageDays > 1 ? ` · −${summary.ageDays}d` : summary.ageDays === 1 ? " · yesterday" : ""}
            </div>
          </div>
          <div className="stats" style={{ marginTop: 16 }}>
            <div className="stat"><div className="label">made</div>
              <div className="value">{summary.made}</div></div>
            <div className={`stat${summary.wasted !== null ? " accent" : ""}`}>
              <div className="label">left over</div>
              <div className="value">{summary.wasted ?? "—"}</div></div>
            <div className="stat"><div className="label">sold out</div>
              <div className="value">{summary.soldOut ?? "—"}</div></div>
          </div>
          {summary.wasted === null && (
            <p className="hint" style={{ marginTop: 12 }}>Leftovers not counted yet — that's the task above.</p>
          )}
          {known.length >= 3 && (
            <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                <span className="hint" style={{ fontSize: 12, color: "var(--text-secondary)" }}>Left over, last 14 days</span>
                <span className="num" style={{ fontSize: 12, fontWeight: 600 }}>avg {trendAvg}</span>
              </div>
              <Sparkline values={summary.trend} width={330} height={40} className="trend-spark" />
            </div>
          )}
          {summary.ageDays > 1 && (
            <p className="hint" style={{ marginTop: 12 }}>
              Nothing has been entered since.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
