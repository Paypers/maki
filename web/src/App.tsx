import { useCallback, useEffect, useMemo, useState } from "react";
import type { BizDate, DayState, Task } from "./lib/businessDay";
import { addDays, daysBetween, outstandingTasks, previousDay } from "./lib/businessDay";
import { toObservations } from "./lib/model";
import * as store from "./lib/store";
import type { Entry, Item, Settings, Template, TemplateAssignment } from "./lib/types";
import type { DaySummary, HomeTarget } from "./screens/Home";
import { Home } from "./screens/Home";
import { History } from "./screens/History";
import { Setup, type SetupTarget } from "./screens/Setup";
import { DaySheet } from "./components/DaySheet";
import { buildDayStats, emptyDay, type DayStatIndex } from "./lib/dayStats";
import { economicsOf, estimateDay } from "./lib/money";
import { estimateWeatherEffect, scoreDaysForWeather, type WeatherEffect } from "./lib/weatherEffect";
import { buildTodayOutlook } from "./lib/todayOutlook";
import { syncWeather } from "./lib/weatherSync";
import type { DayWeather } from "./lib/weather";
import { Items } from "./screens/Items";
import { Production } from "./screens/Production";
import { Recipes } from "./screens/Recipes";
import { Cloud } from "./screens/Cloud";
import { WeatherSettings } from "./screens/WeatherSettings";
import { Reconcile } from "./screens/Reconcile";
import { Settings as SettingsScreen } from "./screens/Settings";
import { Templates } from "./screens/Templates";
import { WasteEntry } from "./screens/WasteEntry";
import { WasteReview } from "./screens/WasteReview";
import { Icon, type IconName } from "./components/Icon";
import { SaveStatusContext } from "./components/ScreenHeader";
import { applyUpdate, onUpdateReady } from "./lib/appUpdate";
import { CANONICAL_HOST, CANONICAL_URL, isThrowawayCopy } from "./lib/canonical";
import { downloadBackup } from "./lib/backup";

/** Screens reached from Setup -- or straight from a tile on Today. Each
 *  remembers which, so Back returns to where you actually came from. */
type Sub = "templates" | "items" | "recipes" | "settings" | "cloud" | "weather" | "reconcile";

type View =
  | { name: "home" }
  | { name: "waste"; date: BizDate }
  | { name: "review"; date: BizDate }
  | { name: "production"; date: BizDate }
  | { name: "history" }
  | { name: "setup" }
  | { name: Sub; from: "home" | "setup"; itemId?: number };

type Tab = "today" | "make" | "count" | "history" | "setup";

/** Which tab a view belongs under, so the bar highlights correctly. */
function tabOf(view: View): Tab {
  switch (view.name) {
    case "home": return "today";
    case "production": return "make";
    case "waste": case "review": return "count";
    case "history": return "history";
    case "setup": return "setup";
    default: return view.from === "home" ? "today" : "setup";
  }
}

export default function App() {
  const [view, setView] = useState<View>({ name: "home" });
  const [items, setItems] = useState<Item[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [assignments, setAssignments] = useState<TemplateAssignment[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [pending, setPending] = useState(0);
  const [summary, setSummary] = useState<DaySummary | null>(null);
  const [stats, setStats] = useState<DayStatIndex>({ byDate: new Map(), dates: [] });
  const [allEntries, setAllEntries] = useState<Entry[]>([]);
  /** The day whose sheet is open, over whatever screen is behind it. */
  const [sheetDate, setSheetDate] = useState<BizDate | null>(null);
  const [weather, setWeather] = useState<Map<BizDate, DayWeather>>(new Map());
  const [weatherEffect, setWeatherEffect] = useState<WeatherEffect | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [ready, setReady] = useState(false);
  const [updateReady, setUpdateReady] = useState(false);

  const today = store.today(settings?.rolloverHour ?? 0);

  // The days whose leftovers were counted. The rule on Make uses these and
  // nothing else: an uncounted day reads as a sell-out otherwise.
  const counted = useMemo(
    () => new Set(stats.dates.filter((d) => stats.byDate.get(d)?.wasteConfirmed)),
    [stats],
  );

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
    const index = buildDayStats(entries, days, withCosts, todayDate, economicsOf(cfg));
    setStats(index);
    setAllEntries(entries);

    // Weather, if a location has been set. The effect is recomputed from
    // whatever is cached -- never fetched on this path, so a dead network
    // cannot slow the screen down.
    const wxRows = await store.getWeather();
    const wxByDate = new Map(wxRows.map((w) => [w.date, w]));
    setWeather(wxByDate);
    setWeatherEffect(cfg.location && cfg.weatherEnabled
      ? estimateWeatherEffect(scoreDaysForWeather(index, wxByDate, cfg.unusualDates, withCosts))
      : null);
    const window14 = latest
      ? Array.from({ length: 14 }, (_, i) => index.byDate.get(addDays(latest, -(13 - i))))
      : [];
    const trend: Array<number | null> = window14.map((d) => d?.wasted ?? null);
    const costTrend: Array<number | null> = window14.map((d) => d?.wasteCost ?? null);
    const profitTrend: Array<number | null> = window14.map((d) => d?.profit ?? null);
    setSummary(latest && obs.length ? {
      date: latest,
      ageDays: daysBetween(latest, todayDate),
      made: Math.round(obs.reduce((s, o) => s + o.supply, 0)),
      wasted: counted
        ? Math.round(obs.reduce((s, o) => s + (o.supply - o.sold), 0)) : null,
      soldOut: counted ? obs.filter((o) => o.censored).length : null,
      trend, costTrend, profitTrend,
    } : null);
    setReady(true);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => onUpdateReady(setUpdateReady), []);

  // Fetch weather after the first render, never before it. The app has to
  // open in under a second on store wifi; the weather can arrive whenever.
  //
  // ---------------------------------------------------------------------
  // THIS EFFECT USED TO LOOP FOREVER, and it did so silently -- the screen
  // looked right while the app hammered the weather API until it was rate
  // limited. Two things combined:
  //
  //   1. The deps were `settings.location` and `settings.hours`, which are
  //      OBJECTS. `refresh()` re-reads settings from IndexedDB and hands
  //      back a fresh object every time, so the identity changed on every
  //      refresh even when not one field did.
  //   2. `syncWeather` always re-fetches the forecast (a forecast for
  //      tomorrow is not tomorrow's weather), so it always reported rows
  //      written, so it always triggered a refresh.
  //
  // refresh -> new object -> effect -> fetch -> refresh. Both halves are
  // fixed: the deps below are PRIMITIVES, and putWeather now counts rows
  // that actually changed rather than rows written. Keep both. Either one
  // alone leaves a loop one small edit away.
  // ---------------------------------------------------------------------
  const loc = settings?.location ?? null;
  const wxKey = loc && settings?.weatherEnabled
    ? `${loc.latitude},${loc.longitude},${settings.hours.open},${settings.hours.close}`
    : null;
  useEffect(() => {
    if (!wxKey || !loc || !settings) return;
    let live = true;
    const earliest = stats.dates[0] ?? null;
    void syncWeather(loc, settings.hours, today, earliest)
      .then((r) => { if (live && r.fetched > 0) void refresh(); });
    return () => { live = false; };
    // Primitives only. Adding an object here reopens the loop above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wxKey, today, stats.dates[0], refresh]);

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
    // New or corrected history loaded in the background after launch.
    const changed = () => { void refresh(); };
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    window.addEventListener("kiosk:data-changed", changed);
    document.body.classList.add("has-tabbar");
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      window.removeEventListener("kiosk:data-changed", changed);
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
          <button className="primary" onClick={() => setView({ name: "items", from: "setup" })}>
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
  const tab = tabOf(view);

  // Owed leftover counts, oldest first. The Count tab opens on the most
  // recent one -- yesterday, on a normal morning -- and the screen itself
  // switches between the rest.
  const owedWaste = tasks.filter((t) => t.kind === "waste").map((t) => t.date).sort();
  const countDate = owedWaste[owedWaste.length - 1] ?? previousDay(today);
  const owedMake = tasks.filter((t) => t.kind === "production").length;

  const sub = (name: Sub, from: "home" | "setup") => setView({ name, from });
  const back = () => setView(view.name !== "home" && "from" in view && view.from === "home"
    ? { name: "home" } : { name: "setup" });

  const goFromHome = (target: HomeTarget) => {
    switch (target) {
      case "make": return setView({ name: "production", date: today });
      case "count": return setView({ name: "waste", date: countDate });
      case "history": return setView({ name: "history" });
      default: return sub(target, "home");
    }
  };
  const goFromSetup = (target: SetupTarget) => sub(target, "setup");

  // Running at a throwaway per-deploy address: this copy has its own data,
  // separate from the real app. Say so on every screen until they leave.
  const stranded = isThrowawayCopy(location.hostname);

  return (
    <SaveStatusContext.Provider value={{ pending, online }}>
      <div className="app">
        {stranded && (
          <div className="banner warn stranded" role="alert">
            <Icon name="alert" size={16} className="ico" />
            <div>
              <strong>This is a temporary copy of the app at {location.hostname}.</strong>{" "}
              Anything entered here is saved only here and won't appear in your real
              app. Your app is <strong>{CANONICAL_HOST}</strong>.
              <div className="actions">
                <button className="small" onClick={() => void downloadBackup()}>
                  Save a backup of this copy
                </button>
                <a className="button small primary" href={CANONICAL_URL}>Open the real app</a>
              </div>
            </div>
          </div>
        )}

        {view.name === "home" && (
          <Home today={today} tasks={tasks} pending={pending}
                summary={summary} stats={stats} onOpen={openTask}
                outlook={buildTodayOutlook(today, stats, weather.get(today), weatherEffect)}
                settings={settings} itemCount={items.length}
                onGo={goFromHome} onPickDay={setSheetDate} />
        )}

        {view.name === "waste" && (
          <WasteEntry key={view.date} date={view.date} today={today} items={items}
                      owed={owedWaste}
                      onPickDate={(date) => setView({ name: "waste", date })}
                      onDone={(date) => setView({ name: "review", date })} />
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
          <Production key={view.date} date={view.date} items={items} templates={templates}
                      assignments={assignments} settings={settings} onDone={done}
                      weather={weather.get(view.date)} weatherEffect={weatherEffect}
                      counted={counted}
                      onEditTemplate={() => sub("templates", "setup")} />
        )}

        {view.name === "history" && (
          <History today={today} stats={stats} items={items} weather={weatherEffect}
                   econ={economicsOf(settings)} onPick={setSheetDate} />
        )}

        {view.name === "setup" && (
          <Setup settings={settings} itemCount={items.length} pending={pending}
                 onOpen={goFromSetup} />
        )}

        {view.name === "templates" && (
          <Templates today={today} items={items} templates={templates}
                     assignments={assignments} onChanged={refresh} onBack={back} />
        )}

        {view.name === "items" && (
          <Items onBack={back} onChanged={refresh}
                 onEditRecipe={(itemId) => setView({ name: "recipes", from: view.from, itemId })} />
        )}

        {view.name === "recipes" && (
          <Recipes initialItemId={view.itemId} items={items} onChanged={refresh}
                   onBack={() => setView({ name: "items", from: view.from })} />
        )}

        {view.name === "settings" && (
          <SettingsScreen onBack={back} onChanged={refresh} />
        )}

        {view.name === "weather" && (
          <WeatherSettings today={today} earliest={stats.dates[0] ?? null}
                           onBack={back} onChanged={refresh} />
        )}

        {view.name === "cloud" && (
          <Cloud onBack={back} onChanged={refresh} />
        )}

        {view.name === "reconcile" && (
          <Reconcile today={today} items={items} onBack={back} />
        )}
      </div>

      {/* The sheet sits over whatever screen opened it, so tapping a day on
          the calendar and tapping one on the home strip behave identically. */}
      {sheetDate && (
        <DaySheet
          day={stats.byDate.get(sheetDate) ?? emptyDay(sheetDate, today)}
          today={today}
          items={items}
          entries={allEntries.filter((e) => e.businessDate === sheetDate)}
          econ={economicsOf(settings)}
          estimate={estimateDay(stats, today, sheetDate)}
          onClose={() => setSheetDate(null)}
          onCountWaste={(d) => { setSheetDate(null); setView({ name: "waste", date: d }); }}
          onEditProduction={(d) => { setSheetDate(null); setView({ name: "production", date: d }); }}
        />
      )}

      {/* Offered, never forced: a reload mid-count would lose whatever had
          been typed and not yet confirmed. */}
      {updateReady && (
        <div className="updatebar" role="status">
          <Icon name="download" size={18} className="ico" />
          <span>A newer version is ready.</span>
          <button className="small" onClick={applyUpdate}>Update now</button>
        </div>
      )}

      {/* Five places, named for the job. Badges count what is owed. */}
      <nav className="tabbar" aria-label="Sections">
        <TabButton active={tab === "today"} icon="check" label="Today"
                   onClick={() => setView({ name: "home" })} />
        <TabButton active={tab === "make"} icon="list" label="Make" badge={owedMake}
                   onClick={() => setView({ name: "production", date: today })} />
        <TabButton active={tab === "count"} icon="trash" label="Count" badge={owedWaste.length}
                   onClick={() => setView({ name: "waste", date: countDate })} />
        <TabButton active={tab === "history"} icon="calendar" label="History"
                   onClick={() => setView({ name: "history" })} />
        <TabButton active={tab === "setup"} icon="settings" label="Setup"
                   onClick={() => setView({ name: "setup" })} />
      </nav>
    </SaveStatusContext.Provider>
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
