/**
 * What the operator sees when they open the app: everything, at once.
 *
 * This is a work tool opened at a counter with a case to fill, so the screen
 * is a board, not a feed. Top to bottom, all of it on one phone screen:
 *
 *   save status   is what I typed safe? (in the header, on every screen)
 *   weather       today's sky and what it points to, in one strip
 *   owed          every job still owed, oldest first; a row per job, standing
 *                 until it is done -- the failure mode is forgetting, not
 *                 getting it wrong
 *   everything    nine tiles, one per part of the app, each with its live
 *                 state, so nothing is ever more than one tap from here
 *   the week      what came back each of the last seven days
 *
 * Colour has one meaning each: amber is owed by you, blue is the rule's
 * number, green is saved, red is late.
 */

import type { BizDate, Task } from "../lib/businessDay";
import { addDays, formatShort, weekdayName } from "../lib/businessDay";
import type { DayStat, DayStatIndex } from "../lib/dayStats";
import { emptyDay } from "../lib/dayStats";
import type { TodayOutlook } from "../lib/todayOutlook";
import type { Settings } from "../lib/types";
import { Icon, type IconName } from "../components/Icon";
import { TodayCard } from "../components/TodayCard";
import { Sparkline } from "../components/Sparkline";
import { ScreenHeader } from "../components/ScreenHeader";
import { syncStatus } from "../lib/cloud";

export interface DaySummary {
  date: BizDate;
  ageDays: number;
  made: number;
  /** Null when the count has not been done. Absence is not zero. */
  wasted: number | null;
  soldOut: number | null;
  /** Total leftovers per day, fourteen days to `date`; null = not counted. */
  trend: Array<number | null>;
  /** Waste cost per day over the same window. */
  costTrend: Array<number | null>;
}

export type HomeTarget =
  | "make" | "count" | "history" | "templates" | "items" | "weather" | "cloud" | "reconcile";

interface Props {
  today: BizDate;
  tasks: Task[];
  pending: number;
  summary: DaySummary | null;
  stats: DayStatIndex;
  outlook: TodayOutlook;
  settings: Settings;
  itemCount: number;
  onOpen: (task: Task) => void;
  onGo: (target: HomeTarget) => void;
  onPickDay: (date: BizDate) => void;
}

function taskLabel(t: Task, today: BizDate): { what: string; when: string } {
  const when = t.date === today ? "today" : `${weekdayName(t.date).slice(0, 3)} ${formatShort(t.date)}`;
  return t.kind === "waste"
    ? { what: "Count leftovers", when }
    : { what: "Enter what you made", when };
}

function ageLabel(ageDays: number): string {
  if (ageDays === 0) return "today";
  if (ageDays === 1) return "yesterday";
  return `${ageDays} days ago`;
}

function Tile({ icon, label, sub, tone, onClick }: {
  icon: IconName; label: string; sub: string; tone?: "owed" | "rule" | "ok";
  onClick: () => void;
}) {
  return (
    <button className="tile" onClick={onClick}>
      <Icon name={icon} size={20} />
      <span className="tile-text">
        <strong>{label}</strong>
        <span className={tone ?? ""}>{sub}</span>
      </span>
    </button>
  );
}

export function Home({
  today, tasks, pending, summary, stats, outlook, settings, itemCount,
  onOpen, onGo, onPickDay,
}: Props) {
  const known = summary?.trend.filter((v): v is number => v !== null) ?? [];
  const trendAvg = known.length
    ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : null;
  const knownCost = summary?.costTrend.filter((v): v is number => v !== null) ?? [];
  const costAvg = knownCost.length
    ? knownCost.reduce((a, b) => a + b, 0) / knownCost.length : null;

  const week: DayStat[] = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(today, -(6 - i));
    return stats.byDate.get(d) ?? emptyDay(d, today);
  });

  const owedCounts = tasks.filter((t) => t.kind === "waste").length;
  const owedMake = tasks.some((t) => t.kind === "production" && t.date === today);
  const todayStat = stats.byDate.get(today);
  const weatherOn = !!settings.location && settings.weatherEnabled;
  const sync = syncStatus(pending);

  return (
    <div>
      <ScreenHeader title="Today" eyebrow={`${weekdayName(today).slice(0, 3)} · ${formatShort(today)}`} />

      <TodayCard outlook={outlook} weekday={weekdayName(today)}
                 configured={weatherOn} onOpenWeather={() => onGo("weather")} />

      {/* Standing, not dismissable. It disappears by being done. */}
      {tasks.length > 0 ? (
        <section className="waiting" aria-label="Owed">
          <div className="waiting-head">
            <span className="eyebrow accent">Owed</span>
            <span className="count num">{tasks.length}</span>
            <span className="spacer" />
            <span className="hint-inline">oldest first</span>
          </div>
          {tasks.map((t) => {
            const { what, when } = taskLabel(t, today);
            return (
              <button className="waiting-row" key={`${t.date}-${t.kind}`} onClick={() => onOpen(t)}>
                <Icon name={t.kind === "waste" ? "trash" : "list"} size={18} className="ico" />
                <span className="who"><strong>{what}</strong> <span>· {when}</span></span>
                {t.ageDays > 2
                  ? <span className="tag late">{t.ageDays} days late</span>
                  : t.ageDays > 0 && <span className="tag">{ageLabel(t.ageDays)}</span>}
                <Icon name="chevron" size={16} className="chev" />
              </button>
            );
          })}
        </section>
      ) : (
        <section className="waiting done" aria-label="Nothing owed">
          <div className="waiting-head">
            <Icon name="check" size={16} className="ico ok" />
            <span className="eyebrow">All caught up</span>
          </div>
          <p className="hint-inline">Today's production is in and every past day has been counted.</p>
        </section>
      )}

      <nav className="tiles" aria-label="Everything">
        <Tile icon="list" label="Make"
              sub={owedMake ? "today's list" : todayStat?.made ? `${todayStat.made} made today` : "any day"}
              tone={owedMake ? "owed" : "ok"} onClick={() => onGo("make")} />
        <Tile icon="trash" label="Count"
              sub={owedCounts ? `${owedCounts} ${owedCounts === 1 ? "day" : "days"} owed` : "all counted"}
              tone={owedCounts ? "owed" : "ok"} onClick={() => onGo("count")} />
        <Tile icon="calendar" label="Calendar" sub="any day" onClick={() => onGo("history")} />
        <Tile icon="chart" label="Reports" sub="waste · sell-outs" onClick={() => onGo("history")} />
        <Tile icon="clock" label="Usual amounts" sub="per weekday" onClick={() => onGo("templates")} />
        <Tile icon="settings" label="Menu & costs" sub={`${itemCount} items`} onClick={() => onGo("items")} />
        <Tile icon="cloud" label="Weather"
              sub={weatherOn ? `ZIP ${settings.location!.zip} · on` : "not set up"}
              onClick={() => onGo("weather")} />
        <Tile icon="upload" label="Sync & backup" sub={sync.label}
              tone={sync.live ? undefined : "owed"} onClick={() => onGo("cloud")} />
        <Tile icon="search" label="Sheet check" sub="vs paper sheet" onClick={() => onGo("reconcile")} />
      </nav>

      <section className="card week-card" aria-label="Left over, last 7 days">
        <div className="head-row">
          <div className="eyebrow">Left over · last 7 days</div>
          {trendAvg !== null && (
            <span className="hint-inline">
              avg <strong className="num">{trendAvg}</strong>/day
              {costAvg !== null && costAvg > 0 && <> · <strong className="num">${Math.round(costAvg)}</strong>/day</>}
            </span>
          )}
        </div>
        <div className="week">
          {week.map((d) => {
            const needs = d.needsWaste || d.needsProduction;
            return (
              <button key={d.date}
                      className={[
                        "week-day", `p-${d.phase}`,
                        needs ? "needs" : "",
                        d.date === today ? "is-today" : "",
                      ].filter(Boolean).join(" ")}
                      onClick={() => onPickDay(d.date)}
                      aria-label={`${weekdayName(d.date)} ${formatShort(d.date)}`}>
                <span className="wd">{weekdayName(d.date).slice(0, 1)} {Number(d.date.slice(-2))}</span>
                {/* "?" means never counted, which is a fault. Today is not a
                    fault -- its leftovers are still in the case. */}
                <span className="wv num">
                  {d.phase === "outage" ? "—"
                    : d.wasted !== null ? d.wasted
                    : d.date === today ? "today"
                    : d.phase === "open" ? "?" : ""}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {known.length >= 3 && summary && (
        <section className="card" aria-label="Left over, last 14 days">
          <div className="head-row">
            <div className="eyebrow">Left over · last 14 days</div>
            <span className="hint-inline">gaps = never counted</span>
          </div>
          <Sparkline values={summary.trend} width={330} height={40} className="trend-spark" />
          {costAvg !== null && costAvg > 0 && (
            <>
              <div className="head-row" style={{ marginTop: 12 }}>
                <div className="eyebrow">What it cost</div>
              </div>
              <Sparkline values={summary.costTrend} width={330} height={40}
                         className="trend-spark cost" hot />
            </>
          )}
        </section>
      )}
    </div>
  );
}
