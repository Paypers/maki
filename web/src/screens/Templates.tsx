/**
 * Baseline editor.
 *
 * One template can serve every weekday, or each weekday can have its own --
 * Wednesday runs about 50% above every other day, so it almost certainly wants
 * its own. Assignments are effective-dated: changing a template applies going
 * forward and never rewrites what a past day actually ran under, so the
 * scorecard can say "you changed your baseline here" rather than silently
 * re-scoring history against a number that did not exist at the time.
 */

import { useMemo, useState } from "react";
import type { BizDate } from "../lib/businessDay";
import { isoWeekday } from "../lib/businessDay";
import * as store from "../lib/store";
import type { Item, Template, TemplateAssignment } from "../lib/types";
import { QuantityList, type RowSpec } from "./QuantityList";
import { Icon } from "../components/Icon";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

interface Props {
  today: BizDate;
  items: Item[];
  templates: Template[];
  assignments: TemplateAssignment[];
  onChanged: () => void;
  onBack: () => void;
}

export function Templates({
  today, items, templates, assignments, onChanged, onBack,
}: Props) {
  const [weekday, setWeekday] = useState(isoWeekday(today));
  const [draft, setDraft] = useState<Record<number, number> | null>(null);
  const [touched, setTouched] = useState<Set<number>>(new Set());
  const [applyToAll, setApplyToAll] = useState(false);

  const active = useMemo(
    () => store.resolveTemplate(assignments, templates, weekday, today),
    [assignments, templates, weekday, today],
  );

  const quantities = draft ?? active?.quantities ?? {};
  const rows: RowSpec[] = items.map((item) => ({
    item,
    value: quantities[item.itemId] ?? 0,
  }));
  const total = items.reduce((s, i) => s + (quantities[i.itemId] ?? 0), 0);

  function change(itemId: number, value: number) {
    setDraft({ ...quantities, [itemId]: value });
    setTouched((t) => new Set(t).add(itemId));
  }

  async function save() {
    const quantitiesToSave: Record<number, number> = {};
    for (const item of items) quantitiesToSave[item.itemId] = quantities[item.itemId] ?? 0;

    const name = applyToAll ? "Every day" : `${WEEKDAYS[weekday - 1]} baseline`;
    const templateId = active && !applyToAll
      ? active.templateId
      : Math.max(0, ...templates.map((t) => t.templateId)) + 1;

    await store.saveTemplate({ templateId, name, quantities: quantitiesToSave });

    // Effective from today: yesterday keeps whatever it actually ran under.
    const days = applyToAll ? [1, 2, 3, 4, 5, 6, 7] : [weekday];
    for (const d of days) await store.assignTemplate(d, today, templateId);

    setDraft(null);
    setTouched(new Set());
    onChanged();
  }

  return (
    <div>
      <header className="bar">
        <button className="ghost" onClick={onBack} aria-label="Back"><Icon name="back" size={20} /></button>
        <h1>Templates<span className="sub">your baseline</span></h1>
      </header>

      <div className="card">
        <h2>Which day?</h2>
        <div className="tabs" role="group" aria-label="Weekday">
          {WEEKDAYS.map((label, i) => (
            <button
              key={label}
              aria-pressed={weekday === i + 1}
              onClick={() => { setWeekday(i + 1); setDraft(null); setTouched(new Set()); }}
            >
              {label}
            </button>
          ))}
        </div>
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
          <input
            type="checkbox"
            checked={applyToAll}
            onChange={(e) => setApplyToAll(e.target.checked)}
            style={{ width: 20, height: 20 }}
          />
          Use these quantities for every day of the week
        </label>
      </div>

      <div className="card">
        <h2>{applyToAll ? "Every day" : `${WEEKDAYS[weekday - 1]}`} — {total} items</h2>
        <p className="hint">
          Applies from today forward. Past days keep the baseline they ran under.
        </p>
        <QuantityList rows={rows} touched={touched} onChange={change} />
      </div>

      <div className="footer">
        <div className="inner">
          <button className="primary" disabled={!draft} onClick={save}>
            {draft ? `Save baseline (${total} items)` : "No changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
