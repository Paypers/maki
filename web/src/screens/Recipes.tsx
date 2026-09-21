/**
 * Recipe builder.
 *
 * Drag an ingredient from the shelf onto the recipe, or tap it. Both work,
 * deliberately: HTML5 drag-and-drop does not fire on touch at all, so this uses
 * pointer events, and tapping is kept because on a phone it is simply faster
 * than dragging.
 *
 * Why this screen matters more than it looks: with no salvage the newsvendor
 * critical ratio collapses to the gross margin, 1 - cost/price. The recipe IS
 * the cost, so every quantity the app recommends traces back to these numbers.
 * The seed spreadsheet used a flat $2.75 for everything, which hid a 4x spread
 * from $1.17 to $4.80 -- and with it, the fact that cheap high-margin rolls
 * should be made far more aggressively than expensive fish.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import * as store from "../lib/store";
import type { Ingredient, Item, Recipe, RecipeLine } from "../lib/types";
import { Icon } from "../components/Icon";

interface Props {
  initialItemId?: number;
  items: Item[];
  onChanged: () => void;
  onBack: () => void;
}

export function Recipes({ initialItemId, items, onChanged, onBack }: Props) {
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [itemId, setItemId] = useState<number | null>(initialItemId ?? null);
  const [editingIngredient, setEditingIngredient] = useState<Ingredient | null>(null);
  const [dragging, setDragging] = useState<Ingredient | null>(null);
  const [overDrop, setOverDrop] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);

  const reload = async () => {
    const [g, r] = await Promise.all([store.getIngredients(), store.getRecipes()]);
    setIngredients(g.filter((i) => !i.archived).sort((a, b) => a.name.localeCompare(b.name)));
    setRecipes(r);
  };
  useEffect(() => { void reload(); }, []);
  useEffect(() => {
    if (itemId === null && items.length) setItemId(items[0].itemId);
  }, [items, itemId]);

  const item = items.find((i) => i.itemId === itemId) ?? null;
  const recipe = useMemo(
    () => recipes.find((r) => r.itemId === itemId) ?? null, [recipes, itemId]);
  const lines = recipe?.lines ?? [];

  const byId = useMemo(
    () => new Map(ingredients.map((i) => [i.ingredientId, i])), [ingredients]);

  const perUnit = (ing: Ingredient) => (ing.packQty ? ing.packCost / ing.packQty : 0);
  const lineCost = (line: RecipeLine) => {
    const ing = byId.get(line.ingredientId);
    return ing ? line.qtyPerUnit * perUnit(ing) : 0;
  };
  const total = lines.reduce((s, l) => s + lineCost(l), 0);
  // No lines is an UNKNOWN cost, not a zero one. Treating it as zero showed
  // a 100% margin and told the operator the item should sell out every day.
  const margin = item?.price && lines.length ? 1 - total / item.price : null;

  async function writeLines(next: RecipeLine[]) {
    if (itemId === null) return;
    const updated: Recipe = { itemId, lines: next, updatedAt: new Date().toISOString() };
    await store.saveRecipe(updated);
    setRecipes((rs) => [...rs.filter((r) => r.itemId !== itemId), updated]);
    onChanged();
  }

  const addIngredient = (ing: Ingredient) => {
    if (lines.some((l) => l.ingredientId === ing.ingredientId)) return;
    void writeLines([...lines, { ingredientId: ing.ingredientId, qtyPerUnit: 1 }]);
  };

  // ---- pointer drag, so it works on a phone -----------------------------
  function startDrag(ing: Ingredient, event: React.PointerEvent) {
    // Only left mouse / touch / pen. Ignore right-click and middle-click.
    if (event.button !== 0) return;
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    setDragging(ing);
    moveGhost(event.clientX, event.clientY);
  }

  function moveGhost(x: number, y: number) {
    const ghost = ghostRef.current;
    if (ghost) {
      ghost.style.left = `${x}px`;
      ghost.style.top = `${y}px`;
    }
    const box = dropRef.current?.getBoundingClientRect();
    setOverDrop(!!box && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom);
  }

  function endDrag() {
    if (dragging && overDrop) addIngredient(dragging);
    setDragging(null);
    setOverDrop(false);
  }

  return (
    <div
      onPointerMove={(e) => dragging && moveGhost(e.clientX, e.clientY)}
      onPointerUp={endDrag}
      onPointerCancel={() => { setDragging(null); setOverDrop(false); }}
    >
      <header className="bar">
        <h1>
          {item?.displayName ?? "Recipe"}
          <span className="sub">Recipe{item?.price ? ` · $${item.price.toFixed(2)}` : ""}</span>
        </h1>
        <button className="ghost" onClick={onBack} aria-label="Back to menu">
          <Icon name="back" size={20} />
        </button>
      </header>

      {dragging && (
        <div className="dragghost" ref={ghostRef}>{dragging.name}</div>
      )}

      <div style={{ padding: "0 4px" }}>
        <label className="field">
          <span>Item</span>
          <select value={itemId ?? ""}
                  onChange={(e) => setItemId(Number(e.target.value))}>
            {items.map((i) => (
              <option key={i.itemId} value={i.itemId}>{i.displayName}</option>
            ))}
          </select>
        </label>

      </div>

      {/* The three tiles are the result of what is being edited below them.
          Margin is the only outlined one: it is the number the whole screen
          exists to produce. */}
      <div className="stats boxed" style={{ gridTemplateColumns: "1fr 1fr 1.3fr" }}>
        <div className="stat">
          <div className="label">Cost each</div>
          <div className="value">{lines.length ? `$${total.toFixed(2)}` : "—"}</div>
        </div>
        <div className="stat">
          <div className="label">Price</div>
          <div className="value">{item?.price ? `$${item.price.toFixed(2)}` : "—"}</div>
        </div>
        <div className={`stat${margin !== null ? " accent" : ""}`}>
          <div className="label">Margin</div>
          <div className="value">
            {margin === null ? "—" : `${Math.round(margin * 100)}%`}
          </div>
        </div>
      </div>
      {margin !== null && (
        <p className="hint" style={{ margin: "10px 4px 0", fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          That margin <strong style={{ color: "var(--text-primary)" }}>is</strong> the target —
          this item should sell out on {Math.round(margin * 100)}% of days. A cheaper
          recipe raises it and the app will make more.
        </p>
      )}

      <div className={`card drop ${overDrop ? "over" : ""}`} ref={dropRef}>
        <div className="head-row" style={{ marginBottom: 6 }}>
          <h2 style={{ fontSize: 15 }}>In one {item?.displayName ?? "unit"}</h2>
          <span className="eyebrow small">drop here</span>
        </div>
        {!lines.length && (
          <p className="hint">
            Empty. Drag an ingredient up from the shelf below, or just tap it.
            Until there's a recipe, this item has no known cost and the app
            won't guess one.
          </p>
        )}
        {lines.map((line) => {
          const ing = byId.get(line.ingredientId);
          if (!ing) return null;
          return (
            <div className="row reciperow" key={line.ingredientId}>
              <input id={`q-${line.ingredientId}`} className="qty" type="number"
                     inputMode="decimal" step="any" min="0" value={line.qtyPerUnit}
                     aria-label={`${ing.name} per unit`}
                     onFocus={(e) => e.currentTarget.select()}
                     onChange={(e) => writeLines(lines.map((l) =>
                       l.ingredientId === line.ingredientId
                         ? { ...l, qtyPerUnit: Math.max(0, Number(e.target.value) || 0) }
                         : l))} />
              <span className="unit">{ing.unit}</span>
              <label className="name" htmlFor={`q-${line.ingredientId}`}
                     title={`$${perUnit(ing).toFixed(4)} per ${ing.unit}`}>
                {ing.name}
              </label>
              <span className="cost">${lineCost(line).toFixed(2)}</span>
              <button className="x" aria-label={`Remove ${ing.name}`}
                      onClick={() => writeLines(
                        lines.filter((l) => l.ingredientId !== line.ingredientId))}>
                <Icon name="plus" size={14} className="rot45" />
              </button>
            </div>
          );
        })}
      </div>

      <div style={{ padding: "4px 4px 0" }}>
        <div className="eyebrow" style={{ marginBottom: 8 }}>Ingredients — drag up, or tap</div>
        <div className="shelf">
          {ingredients.map((ing) => {
            const used = lines.some((l) => l.ingredientId === ing.ingredientId);
            return (
              <button key={ing.ingredientId}
                      className={`chip ${used ? "used" : ""}`}
                      onPointerDown={(e) => startDrag(ing, e)}
                      onClick={() => addIngredient(ing)}>
                {ing.name}
                <small>${perUnit(ing).toFixed(3)}/{ing.unit}</small>
              </button>
            );
          })}
          <button className="chip add"
                  onClick={() => void store.nextIngredientId().then((id) =>
                    setEditingIngredient({ ingredientId: id, name: "", unit: "g",
                                           packCost: 0, packQty: 1 }))}>
            + New ingredient
          </button>
        </div>
      </div>

      {editingIngredient && (
        <IngredientEditor
          ingredient={editingIngredient}
          onCancel={() => setEditingIngredient(null)}
          onSave={async (next) => {
            await store.saveIngredient(next);
            setEditingIngredient(null);
            await reload();
            onChanged();
          }} />
      )}

      {!editingIngredient && ingredients.length > 0 && (
        <details className="card">
          <summary>What you pay per pack ({ingredients.length})</summary>
          <p className="hint">
            Change one and every recipe using it reprices, along with every
            quantity the app recommends.
          </p>
          {ingredients.map((ing) => (
            <div className="row itemrow" key={ing.ingredientId}>
              <button className="namebtn" onClick={() => setEditingIngredient(ing)}>
                <strong>{ing.name}</strong>
                <small>
                  ${ing.packCost.toFixed(2)} per {ing.packQty} {ing.unit}
                  {" · "}${perUnit(ing).toFixed(4)}/{ing.unit}
                </small>
              </button>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

function IngredientEditor({ ingredient, onSave, onCancel }: {
  ingredient: Ingredient;
  onSave: (i: Ingredient) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(ingredient);
  const set = <K extends keyof Ingredient>(k: K, v: Ingredient[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));
  const perUnit = draft.packQty ? draft.packCost / draft.packQty : 0;

  return (
    <div className="card">
      <h2>{ingredient.name ? "Edit ingredient" : "New ingredient"}</h2>

      <label className="field">
        <span>Name</span>
        <input value={draft.name} autoFocus placeholder="e.g. salmon"
               onChange={(e) => set("name", e.target.value)} />
      </label>

      <div className="grid3">
        <label className="field">
          <span>Pack cost ($)</span>
          <input type="number" inputMode="decimal" step="0.01" min="0"
                 value={draft.packCost}
                 onFocus={(e) => e.currentTarget.select()}
                 onChange={(e) => set("packCost", Number(e.target.value) || 0)} />
        </label>
        <label className="field">
          <span>Pack size</span>
          <input type="number" inputMode="decimal" step="any" min="0.0001"
                 value={draft.packQty}
                 onFocus={(e) => e.currentTarget.select()}
                 onChange={(e) => set("packQty", Number(e.target.value) || 1)} />
        </label>
        <label className="field">
          <span>Unit</span>
          <select value={draft.unit} onChange={(e) => set("unit", e.target.value)}>
            {["g", "ml", "each", "sheet", "oz", "lb"].map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
        </label>
      </div>

      <p className="hint">
        e.g. a $9.50 pound of salmon is <strong>9.50</strong> per{" "}
        <strong>454</strong> <strong>g</strong> — that's ${perUnit.toFixed(4)}/g.
      </p>

      <div className="actions">
        <button className="primary" disabled={!draft.name.trim()}
                onClick={() => onSave({ ...draft, name: draft.name.trim() })}>
          Save
        </button>
        <button className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
