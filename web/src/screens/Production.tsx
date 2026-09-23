/**
 * Today's plan.
 *
 * Your template is the anchor and the number in the box. The model appears only
 * as a delta beside it and never writes itself in -- accepting it takes a tap.
 * All three numbers are kept (template, model, what you actually made), because
 * a scorecard that only knows the final number cannot tell whether the model
 * helped or you did.
 */

import { useEffect, useMemo, useState } from "react";
import type { BizDate } from "../lib/businessDay";
import { formatShort, weekdayName } from "../lib/businessDay";
import { isoWeekday } from "../lib/businessDay";
import { delta, explainRoll, recommendFor, toObservations } from "../lib/model";
import * as store from "../lib/store";
import type {
  Entry, Item, Settings, Template, TemplateAssignment,
} from "../lib/types";
import { describeSaveError } from "../lib/saveError";
import { Icon } from "../components/Icon";
import { ScreenHeader } from "../components/ScreenHeader";
import { QuantityList, type RowSpec } from "./QuantityList";
import { WET_INCHES, describe as describeWeather, type DayWeather } from "../lib/weather";
import { adviseFor, planFactor, scaleQuantities, type WeatherEffect } from "../lib/weatherEffect";

interface Props {
  date: BizDate;
  items: Item[];
  templates: Template[];
  assignments: TemplateAssignment[];
  settings: Settings;
  onDone: () => void;
  onEditTemplate: () => void;
  /** Today's weather, if a location is set and it has been fetched. */
  weather?: DayWeather;
  /** What the record says weather does here. Null until there is enough. */
  weatherEffect: WeatherEffect | null;
  /** Days whose leftovers were counted. Every other day is kept out of the
   *  rule -- an uncounted day reads as a sell-out otherwise. */
  counted: ReadonlySet<BizDate>;
}

/** Same-weekday days the per-item record line looks back over. */
const RECORD_DAYS = 8;

export function Production({
  date, items, templates, assignments, settings, onDone, onEditTemplate,
  weather, weatherEffect, counted,
}: Props) {
  /** The operator has to ask for the weather adjustment; it never self-applies. */
  const [applyWeather, setApplyWeather] = useState(false);
  const [qty, setQty] = useState<Record<number, number>>({});
  const [touched, setTouched] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const template = useMemo(
    () => store.resolveTemplate(assignments, templates, isoWeekday(date), date),
    [assignments, templates, date],
  );

  const [history, setHistory] = useState<Entry[] | null>(null);

  useEffect(() => {
    let live = true;
    void store.getAllEntries().then((e) => { if (live) setHistory(e); });
    return () => { live = false; };
  }, [date]);

  const recSet = useMemo(
    () => recommendFor(date, items, template, history ?? [], {
      promoWeekdays: settings.promoWeekdays,
      promoMultiplier: settings.promoMultiplier,
      salvage: settings.salvage,
      labourPerRoll: settings.labourPerRoll,
      saleShare: settings.saleShare,
      counted,
    }),
    [date, items, template, history, settings, counted],
  );
  const recByItem = useMemo(
    () => new Map(recSet.recommendations.map((r) => [r.itemId, r])),
    [recSet],
  );

  // The line of record under every item: what was made on the last day you
  // traded, and how often this weekday has sold out lately. A number is never
  // read without the two facts the operator actually decides on.
  //
  // What was MADE is known whether or not the leftovers were counted. How it
  // SOLD is not, so the sell-out count uses counted days only -- the same
  // rule the suggestion itself now follows.
  const record = useMemo(() => {
    const byItem = new Map<number, { prevMade: number; soldOut: number; days: number }>();
    if (!history) return { prevDate: null as BizDate | null, prevTotal: 0, byItem };
    const obs = toObservations(history).filter((o) => o.date < date);
    const prevDate = obs.length ? obs[obs.length - 1].date : null;
    const wd = isoWeekday(date);
    const sameDay = obs.filter((o) => counted.has(o.date) && isoWeekday(o.date) === wd);
    let prevTotal = 0;
    for (const item of items) {
      const mine = sameDay.filter((o) => o.itemId === item.itemId).slice(-RECORD_DAYS);
      const prev = prevDate
        ? obs.find((o) => o.date === prevDate && o.itemId === item.itemId) : undefined;
      prevTotal += prev?.supply ?? 0;
      byItem.set(item.itemId, {
        prevMade: prev?.supply ?? 0,
        soldOut: mine.filter((o) => o.censored && o.supply > 0).length,
        days: mine.length,
      });
    }
    return { prevDate, prevTotal, byItem };
  }, [history, items, date, counted]);

  useEffect(() => {
    let live = true;
    (async () => {
      const entries = await store.getEntries(date);
      if (!live) return;
      const existing = store.currentQuantities(entries, "made");
      const next: Record<number, number> = {};
      for (const item of items) {
        next[item.itemId] =
          existing.get(item.itemId)?.quantity ?? template?.quantities[item.itemId] ?? 0;
      }
      setQty(next);
      setTouched(new Set(existing.keys()));
      setLoaded(true);
    })();
    return () => { live = false; };
  }, [date, items, template]);

  // What the record says about today's weather. Null means "say nothing",
  // which is the common and correct answer outside the observed range.
  const advice = useMemo(
    () => (weatherEffect ? adviseFor(weather, weatherEffect) : null),
    [weather, weatherEffect],
  );
  // `offered`, not `multiplier`: a measured-but-noisy estimate can still be
  // reached for by hand, which is what the operator asked for.
  const offer = advice && advice.offered !== null ? advice : null;
  // RE-CENTRED. The band ratio is measured against dry days; the suggestion
  // below is built from recent days, rain included.
  // Applying the raw ratio would charge for the rain twice -- and it would
  // also disagree with the home screen, which quotes the re-centred figure.
  const wxPlan = offer && weatherEffect
    ? planFactor(offer.offered!, weatherEffect) : 1;
  const wxPct = Math.round((wxPlan - 1) * 1000) / 10;
  // Below half a percent there is nothing to apply and nothing to say.
  const canApplyWx = !!offer && Math.abs(wxPct) >= 0.5;
  const wxFactor = applyWeather && canApplyWx ? wxPlan : 1;

  // Scale ONCE, here, and let every consumer read the same map. The factor
  // used to be applied inside the row mapping only, so the rows moved while
  // the footer total and "use the rule's N" kept quoting the unscaled figure
  // -- three places computing the same thing and disagreeing on screen.
  const scaledRec = useMemo(() => {
    if (wxFactor === 1) return recByItem;
    // Scaled against the DAY's total, not item by item. At one to four units
    // an item, per-item rounding swallows the whole adjustment -- see
    // scaleQuantities.
    const qtys = new Map<number, number>();
    for (const [id, rec] of recByItem) {
      if (rec.modelQty !== null) qtys.set(id, rec.modelQty);
    }
    const { scaled } = scaleQuantities(qtys, wxFactor);
    const out = new Map(recByItem);
    for (const [id, rec] of recByItem) {
      const q = scaled.get(id);
      if (q !== undefined) out.set(id, { ...rec, modelQty: q });
    }
    return out;
  }, [recByItem, wxFactor]);

  const wdShort = weekdayName(date).slice(0, 3);
  const prevWd = record.prevDate ? weekdayName(record.prevDate).slice(0, 3) : null;

  const rows: RowSpec[] = items.map((item) => {
    // Scaled, never the operator's own number: the box keeps whatever they
    // put in it and only the suggestion beside it moves.
    const rec = settings.showSuggestions ? scaledRec.get(item.itemId) : undefined;
    const d = rec ? delta(rec) : null;
    // Phase 5 requires the naive baseline to be visible on every line, so a
    // recommendation can always be compared against the dumbest alternative.
    const naive = rec?.naiveBaselineQty;
    // A reason on every one of forty rows is not forty reasons, it is wallpaper.
    // Explain a row only when the explanation would change what you do: the
    // suggestion disagrees with your number, or the number cannot be trusted.
    const worthExplaining = !!rec && (d !== null && d !== 0 || !!rec.caveat);
    const r = record.byItem.get(item.itemId);
    const bits = [
      prevWd && r ? `${prevWd} ${r.prevMade}` : null,
      r && r.days > 0 ? `sold out ${r.soldOut}/${r.days} ${wdShort}`
        : `no counted ${wdShort} yet`,
      // The dumbest alternative stays visible wherever the rule disagrees, so
      // a suggestion can always be checked against it.
      worthExplaining && naive !== null && naive !== undefined ? `baseline ${naive}` : null,
    ].filter(Boolean);
    // The rule's own reason for disagreeing with the box, as the chance of the
    // roll in dispute against what it needs. Left out once weather has scaled
    // the suggestion: the chances describe the unscaled number.
    const why = settings.showSuggestions && rec && wxFactor === 1
      ? explainRoll(rec, qty[item.itemId] ?? 0) ?? undefined : undefined;
    return {
      item,
      value: qty[item.itemId] ?? 0,
      meta: bits.join(" · "),
      why,
      // Short, and appended to the record rather than replacing it: the long
      // form ("true demand is higher than anything recorded...") ran to three
      // lines on a phone and hid the very numbers it was qualifying.
      caveat: worthExplaining && rec?.isFallback ? "few on record" : undefined,
      // Blue, always: a number the rule produced. An em dash is "no opinion".
      ref: settings.showSuggestions
        ? { text: rec?.modelQty != null ? String(rec.modelQty) : "—", tone: "rule" as const }
        : undefined,
    };
  });

  const total = items.reduce((s, i) => s + (qty[i.itemId] ?? 0), 0);

  function change(itemId: number, value: number) {
    setQty((q) => ({ ...q, [itemId]: value }));
    setTouched((t) => new Set(t).add(itemId));
  }

  // What tapping "use the suggestion" would actually make: the rule's number
  // where it has one, your current number where it does not.
  const suggestedTotal = items.reduce((sum, item) => {
    const rec = scaledRec.get(item.itemId);
    return sum + (rec?.modelQty ?? qty[item.itemId] ?? 0);
  }, 0);
  const suggestionDiffers = suggestedTotal !== total;

  /** Take every suggestion at once. Explicit -- the rule never self-applies. */
  function acceptAll() {
    const next: Record<number, number> = {};
    for (const item of items) {
      const rec = scaledRec.get(item.itemId);
      next[item.itemId] = rec?.modelQty ?? qty[item.itemId] ?? 0;
    }
    setQty(next);
    setTouched(new Set(items.map((i) => i.itemId)));
  }

  /** Make what was made on the last trading day. The operator's own instinct
   *  has been beating the rule on Tuesdays, so it deserves one tap too. */
  function copyPrevious() {
    const next: Record<number, number> = {};
    for (const item of items) next[item.itemId] = record.byItem.get(item.itemId)?.prevMade ?? 0;
    setQty(next);
    setTouched(new Set(items.map((i) => i.itemId)));
  }

  function resetToTemplate() {
    if (!template) return;
    const next: Record<number, number> = {};
    for (const item of items) next[item.itemId] = template.quantities[item.itemId] ?? 0;
    setQty(next);
    setTouched(new Set());
  }

  async function confirm() {
    setSaving(true);
    setProblem(null);
    const payload: Record<number, number> = {};
    for (const item of items) payload[item.itemId] = qty[item.itemId] ?? 0;
    try {
      await store.saveEntries(date, "made", payload);
      await store.confirmDay(date, "production");
    } catch (err) {
      // Stay on this screen -- see WasteEntry.confirm for why leaving is how
      // the numbers get lost.
      setProblem(describeSaveError(err));
      setSaving(false);
      return;
    }
    void store.sync();
    onDone();
  }

  if (!loaded) return <div className="card">Loading…</div>;

  const promo = settings.promoWeekdays.includes(isoWeekday(date));
  const changed = items.filter((i) => (qty[i.itemId] ?? 0)
    !== (scaledRec.get(i.itemId)?.modelQty ?? qty[i.itemId] ?? 0)).length;

  return (
    <div>
      <ScreenHeader
        title="Make"
        eyebrow={`${wdShort} · ${formatShort(date)}${promo ? " · promo" : ""}`} />

      {settings.showSuggestions && (recSet.degraded || recSet.notes.length > 0) && (
        <details className="banner as-details">
          <summary>
            {recSet.notes[0]
              ? recSet.notes[0].split(/[.:]/)[0]
              : "About today's suggestions"}
          </summary>
          {recSet.degraded && <p>{recSet.degradedReason}</p>}
          {recSet.notes.map((note) => <p key={note}>{note}</p>)}
        </details>
      )}

      {advice && <WeatherAdvisory advice={advice} weather={weather}
                                  pct={wxPct} canApply={canApplyWx}
                                  applied={applyWeather}
                                  onToggle={() => setApplyWeather((v) => !v)} />}

      <section className="totals" aria-label="Totals">
        <div><span className="k">Making</span><span className="v num">{total}</span></div>
        {settings.showSuggestions && (
          <div><span className="k">Rule says</span><span className="v num rule">{suggestedTotal}</span></div>
        )}
        <div>
          <span className="k">{prevWd ? `${prevWd} made` : "Last made"}</span>
          <span className="v num dim">{record.prevDate ? record.prevTotal : "—"}</span>
        </div>
      </section>

      <div className="quick">
        {settings.showSuggestions && (
          <button className="rule" onClick={acceptAll} disabled={!suggestionDiffers}>
            {suggestionDiffers ? "Use rule for all" : "Matches rule"}
          </button>
        )}
        <button onClick={copyPrevious} disabled={!record.prevDate}>
          Copy {prevWd ?? "last day"}
        </button>
        <button onClick={template ? resetToTemplate : onEditTemplate}>
          {template ? "Usual amounts" : "Set usual amounts"}
        </button>
      </div>

      <div className={`cols qcols${settings.showSuggestions ? "" : " no-ref"}`}>
        <div>Item · sheet order</div>
        {settings.showSuggestions && <div className="c rule">Rule</div>}
        <div className="c">Make</div>
      </div>
      <QuantityList rows={rows} touched={touched} onChange={change} />

      <div className="footer">
        {problem && (
          <div className="banner warn save-failed" role="alert">
            <Icon name="alert" size={16} className="ico" />
            <span>{problem}</span>
          </div>
        )}
        <div className="inner">
          <div className="tally">
            <div className="value">{total}</div>
            <div className="label">
              {!settings.showSuggestions ? `${touched.size} changed`
                : changed === 0 ? "same as rule" : `${changed} off rule`}
            </div>
          </div>
          <button className="primary" disabled={saving} onClick={confirm}>
            {saving ? "Saving…" : `Confirm ${total} made`}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The weather advisory.
 *
 * Advisory by default and applied only on a tap, which is the same contract
 * as the rule's delta: the app never quietly changes a number the operator is
 * about to act on.
 *
 * The "not yet separable from chance" case still offers the apply button.
 * That is deliberate -- the operator asked to be able to take it, it is their
 * kiosk and their judgement, and the honest thing is to give them the number
 * AND its weakness rather than hiding one to protect them from the other.
 */
function WeatherAdvisory({ advice, weather, pct, canApply, applied, onToggle }: {
  advice: NonNullable<ReturnType<typeof adviseFor>>;
  weather?: DayWeather;
  /** Re-centred against a TYPICAL day of this weekday, not a dry one --
   *  because that is what the suggestion underneath is built from. */
  pct: number;
  canApply: boolean;
  applied: boolean;
  onToggle: () => void;
}) {
  const sky = weather ? describeWeather(weather) : "";

  let body: React.ReactNode;
  switch (advice.reason) {
    case "ok":
      body = canApply ? (
        <>
          <strong>{sky}</strong> today. Days like this have sold{" "}
          <strong>{Math.abs(pct)}% {pct < 0 ? "less" : "more"}</strong>{" "}
          than a typical day of the same weekday, across {advice.n} of them.
        </>
      ) : sky === "clear" || sky === "partly cloudy" || sky === "overcast" ? (
        // Careful not to claim "a normal day": the home screen puts a fair
        // day a couple of percent ABOVE a typical one, because typical days
        // include the rainy ones. This is a statement about the PLAN, which
        // is a different thing and stays true either way.
        <>
          <strong>{sky}</strong> today — nothing unusual for your record, so
          the suggestion stands as it is.
        </>
      ) : (
        // A trace of drizzle is not a wet day, and saying "nothing unusual"
        // next to the word "drizzle" reads like the app disagreeing with the
        // window. Name the threshold instead.
        <>
          <strong>{sky}</strong> today, but too little to count — your wet days
          start at {WET_INCHES}&#8243; during opening hours.
        </>
      );
      break;
    case "too-noisy":
      body = (
        <>
          <strong>{sky}</strong> today. Days like this look a little slower, but
          across {advice.n} of them it could still be chance. Apply it if you
          want to lean that way.
        </>
      );
      break;
    case "unseen-band":
      body = (
        <>
          <strong>{sky}</strong> today, which your record has barely seen. No
          adjustment — it will start suggesting one once there are enough days.
        </>
      );
      break;
    case "out-of-range":
      body = (
        <>
          <strong>{sky}</strong>, and colder or hotter than anything you have
          traded in
          {advice.tempRange && <> (your record runs {Math.round(advice.tempRange[0])}–
            {Math.round(advice.tempRange[1])}°F)</>}. No adjustment: a rule
          fitted to your summer has no claim on this.
        </>
      );
      break;
    default:
      body = (
        <>
          <strong>{sky}</strong> today. Not enough counted days yet to say what
          weather does here.
        </>
      );
  }

  return (
    <div className={`banner wx-advice${applied ? " wx-applied" : ""}`}>
      <Icon name={advice.endorsed && canApply ? "trend" : "clock"}
            size={16} className="ico" />
      <div className="body">
        <span>{body}</span>
        {canApply && (
          <div className="wx-advice-actions">
            <button className={applied ? "" : "small"} onClick={onToggle}
                    aria-pressed={applied}>
              {applied
                ? `Applied ${pct > 0 ? "+" : ""}${pct}% — undo`
                : `Apply ${pct > 0 ? "+" : ""}${pct}% to the suggestion`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
