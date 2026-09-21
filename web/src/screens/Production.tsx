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
import { delta, recommendFor, toObservations } from "../lib/model";
import * as store from "../lib/store";
import type {
  Entry, Item, Settings, Template, TemplateAssignment,
} from "../lib/types";
import { Icon } from "../components/Icon";
import { Sparkline } from "../components/Sparkline";
import { QuantityList, type RowSpec } from "./QuantityList";

interface Props {
  date: BizDate;
  items: Item[];
  templates: Template[];
  assignments: TemplateAssignment[];
  settings: Settings;
  onDone: () => void;
  onEditTemplate: () => void;
  onBack: () => void;
}

const SPARK_DAYS = 10;

export function Production({
  date, items, templates, assignments, settings, onDone, onEditTemplate, onBack,
}: Props) {
  const [qty, setQty] = useState<Record<number, number>>({});
  const [touched, setTouched] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
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
    }),
    [date, items, template, history, settings],
  );
  const recByItem = useMemo(
    () => new Map(recSet.recommendations.map((r) => [r.itemId, r])),
    [recSet],
  );

  // The last ten RECORDED days of this item, sold per day, drawn beside the
  // row so a number is never read without its recent shape. Recorded, not
  // calendar: after a gap in the log the last ten calendar days are empty and
  // the column looks broken, while the last ten days you actually sold it are
  // exactly what you want to see. Hot (accent) when it sold out on most of
  // them -- the line is then the ceiling, not the demand.
  const sparks = useMemo(() => {
    const out = new Map<number, { values: Array<number | null>; hot: boolean }>();
    if (!history) return out;
    const obs = toObservations(history).filter((o) => o.date < date);
    const byItem = new Map<number, typeof obs>();
    for (const o of obs) {
      const list = byItem.get(o.itemId) ?? [];
      list.push(o);
      byItem.set(o.itemId, list);
    }
    for (const item of items) {
      const recent = (byItem.get(item.itemId) ?? []).slice(-SPARK_DAYS);
      if (recent.length < 2) continue;
      const censored = recent.filter((o) => o.censored).length;
      out.set(item.itemId, {
        values: recent.map((o) => o.sold),
        hot: recent.length >= 4 && censored / recent.length >= 0.6,
      });
    }
    return out;
  }, [history, items, date]);

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

  const rows: RowSpec[] = items.map((item) => {
    const rec = settings.showSuggestions ? recByItem.get(item.itemId) : undefined;
    const d = rec ? delta(rec) : null;
    // Phase 5 requires the naive baseline to be visible on every line, so a
    // recommendation can always be compared against the dumbest alternative.
    const naive = rec?.naiveBaselineQty;
    // A reason on every one of forty rows is not forty reasons, it is wallpaper.
    // Explain a row only when the explanation would change what you do: the
    // suggestion disagrees with your number, or the number cannot be trusted.
    const worthExplaining = !!rec && (d !== null && d !== 0 || !!rec.caveat);
    const bits = worthExplaining
      ? [rec!.reason,
         naive !== null && naive !== undefined ? `baseline ${naive}` : null].filter(Boolean)
      : [];
    const spark = sparks.get(item.itemId);
    return {
      item,
      value: qty[item.itemId] ?? 0,
      hint: bits.length ? bits.join(" · ") : undefined,
      caveat: worthExplaining ? rec?.caveat : undefined,
      // Agreement is the default and needs no ink. Blank means "the rule
      // agrees"; an em dash still means "no opinion", which is different.
      deltaLabel: !settings.showSuggestions ? undefined
        : d === null ? "—" : d === 0 ? "" : `${d > 0 ? "+" : "−"}${Math.abs(d)}`,
      deltaDirection: d === null || d === 0 ? "none" : d > 0 ? "up" : "down",
      aside: spark ? <Sparkline values={spark.values} hot={spark.hot} /> : null,
    };
  });

  // Anything at zero with nothing suggested is off today's list. It stays one
  // tap away rather than adding a screen of empty rows to scroll past.
  const active = rows.filter((r) => r.value > 0
    || (recByItem.get(r.item.itemId)?.modelQty ?? 0) > 0);
  const idle = rows.filter((r) => !active.includes(r));

  const total = items.reduce((s, i) => s + (qty[i.itemId] ?? 0), 0);

  function change(itemId: number, value: number) {
    setQty((q) => ({ ...q, [itemId]: value }));
    setTouched((t) => new Set(t).add(itemId));
  }

  // What tapping "use the suggestion" would actually make: the rule's number
  // where it has one, your current number where it does not.
  const suggestedTotal = items.reduce((sum, item) => {
    const rec = recByItem.get(item.itemId);
    return sum + (rec?.modelQty ?? qty[item.itemId] ?? 0);
  }, 0);
  const suggestionDiffers = suggestedTotal !== total;

  /** Take every suggestion at once. Explicit -- the rule never self-applies. */
  function acceptAll() {
    const next: Record<number, number> = {};
    for (const item of items) {
      const rec = recByItem.get(item.itemId);
      next[item.itemId] = rec?.modelQty ?? qty[item.itemId] ?? 0;
    }
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
    const payload: Record<number, number> = {};
    for (const item of items) payload[item.itemId] = qty[item.itemId] ?? 0;
    await store.saveEntries(date, "made", payload);
    await store.confirmDay(date, "production");
    void store.sync();
    onDone();
  }

  if (!loaded) return <div className="card">Loading…</div>;

  const promo = settings.promoWeekdays.includes(isoWeekday(date));

  return (
    <div>
      <header className="bar">
        <h1>
          Production
          <span className="sub">
            {weekdayName(date).slice(0, 3)} · {formatShort(date)} · template{promo ? " · promo" : ""}
          </span>
        </h1>
        <button className="ghost" onClick={onBack} aria-label="Back">
          <Icon name="back" size={20} />
        </button>
      </header>

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

      {!template && (
        <div className="card">
          <h2>No {weekdayName(date)} template yet</h2>
          <p className="hint">
            Set one and this screen fills itself in — that's what makes it a
            one-minute job instead of a five-minute one.
          </p>
          <button className="primary" onClick={onEditTemplate}>
            Set up a {weekdayName(date)} template
          </button>
        </div>
      )}

      <div className="cols" style={{ gridTemplateColumns: "minmax(0,1fr) 56px 30px 132px" }}>
        <div>Item</div>
        <div>10d</div>
        <div className="r">Δ</div>
        <div className="c">Make</div>
      </div>
      <QuantityList rows={active} touched={touched} onChange={change} hasAside />

      {idle.length > 0 && (
        <details className="card">
          <summary>Not making today ({idle.length})</summary>
          <QuantityList rows={idle} touched={touched} onChange={change} hasAside />
        </details>
      )}

      <div className="card">
        <button className="link" onClick={acceptAll}
                disabled={!suggestionDiffers || !settings.showSuggestions}>
          {suggestionDiffers
            ? `Use the rule's ${suggestedTotal}`
            : "Already matches the rule"}
        </button>
        {" · "}
        <button className="link" onClick={resetToTemplate} disabled={!template}>
          Reset to template
        </button>
        {" · "}
        <button className="link" onClick={onEditTemplate}>Edit templates</button>
      </div>

      <div className="footer">
        <div className="inner">
          <div className="tally">
            <div className="value">{total}</div>
            <div className="label">
              {settings.showSuggestions && suggestionDiffers
                ? `rule ${suggestedTotal}` : `${touched.size} changed`}
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
