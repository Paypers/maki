import { useCallback, useEffect, useState } from "react";
import type { BizDate, DayState, Task } from "./lib/businessDay";
import { addDays, daysBetween, outstandingTasks, previousDay } from "./lib/businessDay";
import { toObservations } from "./lib/model";
import * as store from "./lib/store";
import type { Item, Settings, Template, TemplateAssignment } from "./lib/types";
import type { DaySummary } from "./screens/Home";
import { Home } from "./screens/Home";
import { Insights } from "./screens/Insights";
import { Items } from "./screens/Items";
import { Production } from "./screens/Production";
import { Recipes } from "./screens/Recipes";
import { Cloud } from "./screens/Cloud";
import { Reconcile } from "./screens/Reconcile";
import { Settings as SettingsScreen } from "./screens/Settings";
import { Templates } from "./screens/Templates";
import { WasteEntry } from "./screens/WasteEntry";
import { WasteReview } from "./screens/WasteReview";
import { Icon, type IconName } from "./components/Icon";

type View =
  | { name: "home" }
  | { name: "waste"; date: BizDate }
  | { name: "review"; date: BizDate }
  | { name: "production"; date: BizDate }
  | { name: "templates" }
  | { name: "items" }
  | { name: "recipes"; itemId?: number }
  | { name: "insights" }
  | { name: "settings" }
  | { name: "cloud" }
  | { name: "reconcile" };

/** Which tab a view belongs under, so the bar highlights correctly. */
const TAB_OF: Record<View["name"], string> = {
  home: "today", waste: "today", review: "today", production: "today",
  templates: "plan", items: "menu", recipes: "menu",
  insights: "insights", reconcile: "insights", settings: "insights",
  cloud: "insights",
};

export default function App() {
  const [view, setView] = useState<View>({ name: "home" });
  const [items, setItems] = useState<Item[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [assignments, setAssignments] = useState<TemplateAssignment[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [pending, setPending] = useState(0);
  const [summary, setSummary] = useState<DaySummary | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [ready, setReady] = useState(false);

  const today = store.today(settings?.rolloverHour ?? 0);

  const refresh = useCallback(async () => {
    const [withCosts, tpls, asg, days, entries, queue, cfg] = await Promise.all([
      store.itemsWithCosts(), store.getTemplates(), store.getAssignments(),
      store.getDays(), store.getAllEntries(), store.getQueue(), store.getSettings(),
    ]);
    const production = new Set(
      entries.filter((e) => e.entryType === "made" || e.entryType === "refill")
             .map((e) => e.businessDate),
    );
    const state: DayState[] = [...new Set([...days.map((d) => d.businessDate), ...production])]
      .map((date) => {
        const rec = days.find((d) => d.businessDate === date);
        return {
          date,
          hasProduction: production.has(date),
          productionConfirmed: !!rec?.productionConfirmedAt,
          wasteConfirmed: !!rec?.wasteConfirmedAt,
          isOutage: !!rec?.isOutage,
        };
      });

    setItems(withCosts.filter((i) => i.active).sort((a, b) => a.sortOrder - b.sortOrder));
    setTemplates(tpls);
    setAssignments(asg);
    setSettings(cfg);
    setTasks(outstandingTasks(state, store.today(cfg.rolloverHour)));
    setPending(queue.length);

    // The last day on record at a glance, so the home screen is not mostly
    // blank. Deliberately NOT "yesterday": after importing a year from the
    // spreadsheet the most recent day can be weeks back, and a card hard-wired
    // to yesterday's date silently reports "no data" while sitting on all of
    // it. Home labels whatever day this turns out to be.
    const todayDate = store.today(cfg.rolloverHour);
    const all = toObservations(entries);
    const latest = all.map((o) => o.date).filter((d) => d < todayDate)
                      .sort().pop() ?? null;
    const obs = latest ? all.filter((o) => o.date === latest) : [];
    // Only report leftovers once they have actually been counted. Before that
    // every item reads as censored, which would show a real day as "0 left
    // over" -- an uncounted zero presented as an observed one.
    const counted = !!days.find((d) => d.businessDate === latest)?.wasteConfirmedAt;
    // Fourteen days of total leftovers ending on the latest day, for the trend
    // line under the recap. Only counted days contribute; an uncounted day is
    // a gap in the line, not a zero on it.
    const countedDays = new Set(days.filter((d) => d.wasteConfirmedAt).map((d) => d.businessDate));
    const trend: Array<number | null> = latest
      ? Array.from({ length: 14 }, (_, i) => {
          const d = addDays(latest, -(13 - i));
          if (!countedDays.has(d)) return null;
          const dayObs = all.filter((o) => o.date === d);
          return dayObs.length ? dayObs.reduce((s, o) => s + (o.supply - o.sold), 0) : null;
        })
      : [];
    setSummary(latest && obs.length ? {
      date: latest,
      ageDays: daysBetween(latest, todayDate),
      made: Math.round(obs.reduce((s, o) => s + o.supply, 0)),
      wasted: counted
        ? Math.round(obs.reduce((s, o) => s + (o.supply - o.sold), 0)) : null,
      soldOut: counted ? obs.filter((o) => o.censored).length : null,
      trend,
    } : null);
    setReady(true);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // The theme is a data attribute on <html>, which is what the stylesheet's
  // token blocks key on. "system" removes it so the media query decides.
  useEffect(() => {
    const t = settings?.theme ?? "system";
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  }, [settings?.theme]);

  useEffect(() => {
    const on = () => { setOnline(true); void store.sync().then(refresh); };
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    document.body.classList.add("has-tabbar");
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, [refresh]);

  if (!ready || !settings) {
    return <div className="app"><div className="card">Loading…</div></div>;
  }

  if (!items.length && view.name !== "items") {
    return (
      <div className="app">
        <header className="bar"><h1>Welcome</h1></header>
        <div className="card">
          <h2>Add your menu to get started</h2>
          <p className="hint">
            Add the items you make each day. You can set prices and recipes now
            or come back to them — the app works either way, it just gets more
            useful once it knows what things cost.
          </p>
          <button className="primary" onClick={() => setView({ name: "items" })}>
            Set up the menu
          </button>
        </div>
      </div>
    );
  }

  const openTask = (t: Task) =>
    setView(t.kind === "waste" ? { name: "waste", date: t.date }
                               : { name: "production", date: t.date });

  const done = async () => { await refresh(); setView({ name: "home" }); };
  const tab = TAB_OF[view.name];

  return (
    <>
      <div className="app">
        {view.name === "home" && (
          <Home today={today} tasks={tasks} pending={pending} online={online}
                summary={summary} onOpen={openTask} />
        )}

        {view.name === "waste" && (
          <WasteEntry date={view.date} items={items}
                      onDone={(date) => setView({ name: "review", date })}
                      onCancel={() => setView({ name: "home" })} />
        )}

        {view.name === "review" && (
          <WasteReview date={view.date} items={items}
                       onContinue={async () => {
                         await refresh();
                         const next = view.date === previousDay(today) ? today : view.date;
                         setView({ name: "production", date: next });
                       }} />
        )}

        {view.name === "production" && (
          <Production date={view.date} items={items} templates={templates}
                      assignments={assignments} settings={settings} onDone={done}
                      onBack={() => setView({ name: "home" })}
                      onEditTemplate={() => setView({ name: "templates" })} />
        )}

        {view.name === "templates" && (
          <Templates today={today} items={items} templates={templates}
                     assignments={assignments} onChanged={refresh}
                     onBack={() => setView({ name: "home" })} />
        )}

        {view.name === "items" && (
          <Items onBack={() => setView({ name: "home" })} onChanged={refresh}
                 onEditRecipe={(itemId) => setView({ name: "recipes", itemId })} />
        )}

        {view.name === "recipes" && (
          <Recipes initialItemId={view.itemId} items={items}
                   onChanged={refresh}
                   onBack={() => setView({ name: "items" })} />
        )}

        {view.name === "insights" && (
          <Insights today={today} items={items}
                    onBack={() => setView({ name: "home" })}
                    onSettings={() => setView({ name: "settings" })}
                    onCloud={() => setView({ name: "cloud" })}
                    onReconcile={() => setView({ name: "reconcile" })} />
        )}

        {view.name === "settings" && (
          <SettingsScreen onBack={() => setView({ name: "home" })}
                          onChanged={refresh} />
        )}

        {view.name === "cloud" && (
          <Cloud onBack={() => setView({ name: "insights" })} onChanged={refresh} />
        )}

        {view.name === "reconcile" && (
          <Reconcile today={today} items={items}
                     onBack={() => setView({ name: "home" })} />
        )}
      </div>

      <nav className="tabbar" aria-label="Sections">
        <TabButton active={tab === "today"} icon="check" label="Today"
                   badge={tasks.length}
                   onClick={() => setView({ name: "home" })} />
        <TabButton active={tab === "plan"} icon="calendar" label="Baseline"
                   onClick={() => setView({ name: "templates" })} />
        <TabButton active={tab === "menu"} icon="list" label="Menu"
                   onClick={() => setView({ name: "items" })} />
        <TabButton active={tab === "insights"} icon="chart" label="More"
                   onClick={() => setView({ name: "insights" })} />
      </nav>
    </>
  );
}

function TabButton({ active, icon, label, badge, onClick }: {
  active: boolean; icon: IconName; label: string; badge?: number;
  onClick: () => void;
}) {
  return (
    <button aria-current={active ? "page" : undefined} onClick={onClick}>
      <span className="glyph">
        <Icon name={icon} size={22} />
      </span>
      {!!badge && <span className="badge">{badge}</span>}
      {label}
    </button>
  );
}
