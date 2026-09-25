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
 *   money         this week and this month: counted so far, projected to the
 *                 end, and where the sales went -- profit, the middle man,
 *                 ingredients, and what was thrown away
 *   everything    nine tiles, one per part of the app, each with its live
 *                 state, so nothing is ever more than one tap from here --
 *                 the calendar and its reports share one, since they share a
 *                 screen, and the plan ahead has the other
 *   the week      profit and leftovers for each of the last seven days
 *   coming up     the rule's estimated rolls for each of the next seven, and
 *                 what their ingredients cost -- always under the notice
 *                 that says they are estimates and will change
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
import { MoneyNote, PeriodCard } from "../components/Money";
import { monthOf, projectPeriod, share, usd, usdShort, weekOf } from "../lib/money";
import type { AmbitionCheck } from "../lib/ambition";
import type { DayPlan, Drift } from "../lib/plan";
import { PlanNotice } from "../components/Plan";

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
  /** Profit per day over the same window; null = not counted. */
  profitTrend: Array<number | null>;
}

export type HomeTarget =
  | "make" | "count" | "history" | "templates" | "items" | "weather" | "cloud" | "reconcile"
  | "settings" | "plan";

interface Props {
  today: BizDate;
  tasks: Task[];
  pending: number;
  summary: DaySummary | null;
  stats: DayStatIndex;
  outlook: TodayOutlook;
  settings: Settings;
  itemCount: number;
  /** Is the ambition level paying? Null while loading. */
  ambition: AmbitionCheck | null;
  /** The rule's estimated plan for the next seven days, tomorrow first. */
  plans: DayPlan[];
  /** How much such estimates have moved lately; null where too little to say. */
  drift: (Drift | null)[];
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

/**
 * The ambition marker: the level, one verdict, and the way to change it.
 * The icon and the words carry the verdict; colour only repeats it.
 */
function AmbitionCard({ check, onChange }: { check: AmbitionCheck; onChange: () => void }) {
  const icon: IconName = check.verdict === "too-high" ? "alert"
    : check.verdict === "paying" ? "check"
    : check.verdict === "room" ? "chart" : "clock";
  const e = check.extra;
  return (
    <section className={`card ambition v-${check.verdict}`} aria-label="Ambition">
      <div className="head-row">
        <div className="eyebrow">Ambition · {check.name}</div>
        <button className="link" onClick={onChange}>Change</button>
      </div>
      <p className="amb-line"><Icon name={icon} size={16} className="ico" /><span>{check.headline}</span></p>
      {e.made > 0 && (
        <p className="hint-inline amb-extra">
          Extra rolls, last {check.recent.days} counted days: made <strong className="num">{e.made}</strong>,
          sold <strong className="num">{e.sold}</strong>,{" "}
          <strong className="num">{e.dollars < 0 ? "\u2212" : "+"}${Math.abs(Math.round(e.dollars))}</strong> after costs
          {e.made < 8 ? " — too few to judge yet." : "."}
        </p>
      )}
    </section>
  );
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
  today, tasks, pending, summary, stats, outlook, settings, itemCount, ambition,
  plans, drift, onOpen, onGo, onPickDay,
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

  const [wFrom, wTo] = weekOf(today);
  const [mFrom, mTo] = monthOf(today);
  const weekMoney = projectPeriod(stats, today, wFrom, wTo);
  const monthMoney = projectPeriod(stats, today, mFrom, mTo);
  const keep = settings.saleShare ?? 1;
  const knownProfit = summary?.profitTrend.filter((v): v is number => v !== null) ?? [];
  const profitAvg = knownProfit.length
    ? knownProfit.reduce((a, b) => a + b, 0) / knownProfit.length : null;
  const lastCounted = [...stats.dates].reverse()
    .map((d) => stats.byDate.get(d)!)
    .find((d) => d.date < today && d.profit !== null && d.sales !== null);

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

      {ambition && <AmbitionCard check={ambition} onChange={() => onGo("settings")} />}

      <section aria-label="Money">
        <PeriodCard title="This week" p={weekMoney} keepShare={keep} />
        <PeriodCard showRange={false} p={monthMoney} keepShare={keep}
                    title={`This month · ${new Date(`${mFrom}T12:00:00`).toLocaleDateString(undefined, { month: "long" })}`} />
      </section>

      <nav className="tiles" aria-label="Everything">
        <Tile icon="list" label="Make"
              sub={owedMake ? "today's list" : todayStat?.made ? `${todayStat.made} made today` : "any day"}
              tone={owedMake ? "owed" : "ok"} onClick={() => onGo("make")} />
        <Tile icon="trash" label="Count"
              sub={owedCounts ? `${owedCounts} ${owedCounts === 1 ? "day" : "days"} owed` : "all counted"}
              tone={owedCounts ? "owed" : "ok"} onClick={() => onGo("count")} />
        <Tile icon="calendar" label="Calendar" sub="& reports: money, waste" onClick={() => onGo("history")} />
        <Tile icon="trend" label="Coming up"
              sub={plans[0] && !plans[0].closed ? `~${plans[0].total} tomorrow · est.` : "next 2 weeks · est."}
              tone="rule" onClick={() => onGo("plan")} />
        <Tile icon="clock" label="Usual amounts" sub="per weekday" onClick={() => onGo("templates")} />
        <Tile icon="settings" label="Menu & costs" sub={`${itemCount} items`} onClick={() => onGo("items")} />
        <Tile icon="cloud" label="Weather"
              sub={weatherOn ? `ZIP ${settings.location!.zip} · on` : "not set up"}
              onClick={() => onGo("weather")} />
        <Tile icon="upload" label="Sync & backup" sub={sync.label}
              tone={sync.live ? undefined : "owed"} onClick={() => onGo("cloud")} />
        <Tile icon="search" label="Sheet check" sub="vs paper sheet" onClick={() => onGo("reconcile")} />
      </nav>

      <section className="card week-card" aria-label="Profit and left over, last 7 days">
        <div className="head-row">
          <div className="eyebrow">Last 7 days · profit · left over</div>
          {trendAvg !== null && (
            <span className="hint-inline">
              avg{profitAvg !== null && <> <strong className="num">{usd(profitAvg)}</strong> ·</>}
              {" "}<strong className="num">{trendAvg}</strong> left
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
                <span className="wp num">
                  {d.profit !== null ? usdShort(d.profit)
                    : d.phase === "outage" ? "closed"
                    : d.date === today ? "today"
                    : d.phase === "open" ? "?" : ""}
                </span>
                <span className="wv num">
                  {d.phase === "outage" ? ""
                    : d.wasted !== null ? `${d.wasted} left`
                    : d.phase === "open" && d.date !== today ? "not counted" : ""}
                </span>
              </button>
            );
          })}
        </div>
        {lastCounted && lastCounted.sales !== null && lastCounted.profit !== null && (
          <p className="hint-inline week-last">
            {weekdayName(lastCounted.date).slice(0, 3)} {formatShort(lastCounted.date)}:
            {" "}sold <strong className="num">{usd(lastCounted.sales)}</strong>,
            profit <strong className="num">{usd(lastCounted.profit)}</strong>
            {" "}({share(lastCounted.profit, lastCounted.sales)}),
            thrown away <strong className="num">{usd(lastCounted.wasteCost ?? 0)}</strong>
            {" "}({share(lastCounted.wasteCost ?? 0, lastCounted.sales)} of sales). Tap a day for the receipt.
          </p>
        )}
      </section>

      <MoneyNote keepShare={keep} />

      {plans.length > 0 && (
        <section className="card week-card ahead-card" aria-label="Coming up, estimated">
          <div className="head-row">
            <div className="eyebrow">Coming up · est. rolls · ingredients</div>
            <button className="link" onClick={() => onGo("plan")}>By item</button>
          </div>
          <div className="week">
            {plans.map((p) => (
              <button key={p.date}
                      className={`week-day p-future${p.closed ? " closed" : ""}`}
                      onClick={() => onPickDay(p.date)}
                      aria-label={`${weekdayName(p.date)} ${formatShort(p.date)}: ` +
                        (p.closed ? "closed" : `about ${p.total} rolls, estimate`)}>
                <span className="wd">{weekdayName(p.date).slice(0, 1)} {Number(p.date.slice(-2))}</span>
                <span className="wp num">{p.closed ? "closed" : `~${p.total}`}</span>
                <span className="wv num">{p.closed ? "" : `~${usdShort(p.ingredients)}`}</span>
              </button>
            ))}
          </div>
          <PlanNotice drift={drift} suggestions={settings.showSuggestions} compact />
        </section>
      )}

      {known.length >= 3 && summary && (
        <section className="card" aria-label="Left over, last 14 days">
          <div className="head-row">
            <div className="eyebrow">Profit · last 14 days</div>
            <span className="hint-inline">gaps = never counted</span>
          </div>
          <Sparkline values={summary.profitTrend} width={330} height={40} className="trend-spark cost" />
          <div className="head-row" style={{ marginTop: 12 }}>
            <div className="eyebrow">Left over</div>
          </div>
          <Sparkline values={summary.trend} width={330} height={40} className="trend-spark" />
          {costAvg !== null && costAvg > 0 && (
            <>
              <div className="head-row" style={{ marginTop: 12 }}>
                <div className="eyebrow">Thrown away, $</div>
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
