/**
 * The menu.
 *
 * The roster churned six times in 117 days of the seed data -- items renamed,
 * split in two, dropped. So this screen has to make adding, renaming and
 * retiring an item a ten-second job, and retiring must ARCHIVE rather than
 * delete: the history that item generated is still what the recommendation
 * rule learns from, and deleting it would silently rewrite the past.
 */

import { useEffect, useMemo, useState } from "react";
import * as store from "../lib/store";
import type { Ingredient, Item, Recipe } from "../lib/types";
import { Icon } from "../components/Icon";

interface Props {
  onBack: () => void;
  onChanged: () => void;
  onEditRecipe: (itemId: number) => void;
}

export function Items({ onChanged, onEditRecipe }: Props) {
  const [items, setItems] = useState<Item[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [editing, setEditing] = useState<Item | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [query, setQuery] = useState("");

  const reload = async () => {
    const [i, g, r] = await Promise.all(
      [store.getItems(), store.getIngredients(), store.getRecipes()]);
    setItems(i.sort((a, b) => a.sortOrder - b.sortOrder));
    setIngredients(g);
    setRecipes(r);
  };

  useEffect(() => { void reload(); }, []);

  const recipeByItem = useMemo(
    () => new Map(recipes.map((r) => [r.itemId, r])), [recipes]);

  const visible = items.filter((i) => showArchived || i.active);

  async function persist(item: Item) {
    await store.saveItem(item);
    setEditing(null);
    await reload();
    onChanged();
  }

  async function addItem() {
    const id = await store.nextItemId();
    setEditing({
      itemId: id, itemKey: "", displayName: "", price: null, unitCost: null,
      sortOrder: items.length, active: true,
    });
  }

  const costOf = (item: Item) =>
    store.unitCostFrom(recipeByItem.get(item.itemId), ingredients);
  const someCosted = visible.some((i) => costOf(i) !== null);
  const noneCosted = !someCosted;
  const uncosted = visible.filter((i) => costOf(i) === null).length;
  const shown = query.trim()
    ? visible.filter((i) => (i.displayName || i.itemKey).toLowerCase().includes(query.trim().toLowerCase()))
    : visible;

  return (
    <div>
      <header className="bar">
        <h1>
          Menu
          <span className="sub">
            {visible.length} items{uncosted > 0 ? ` · ${uncosted} need a recipe` : ""}
          </span>
        </h1>
        {!editing && (
          <button className="ghost addbtn" onClick={addItem}>
            <Icon name="plus" size={16} />
            Add
          </button>
        )}
      </header>

      {editing && (
        <ItemEditor
          item={editing}
          onCancel={() => setEditing(null)}
          onSave={persist}
        />
      )}

      {!editing && (
        <>
          {/* An outlined add-row rather than a solid blue button in its own
              card: adding an item is occasional, and a full-strength primary
              at the top of every visit outranked the list it introduces. */}
          {noneCosted && visible.length > 0 && (
            <div className="banner">
              <Icon name="sparkle" size={16} className="ico" />
              <span>
                None of these have a recipe yet. Adding one turns a price into a
                margin — and with no salvage, that margin <em>is</em> the share of
                days the item should sell out.
              </span>
            </div>
          )}

          <label className="search">
            <Icon name="search" size={16} />
            <span className="sr-only">Search the menu</span>
            <input type="search" placeholder="Search" value={query}
                   onChange={(e) => setQuery(e.target.value)} />
          </label>

          <div className="cols" style={{ gridTemplateColumns: "minmax(0,1fr) 62px 56px 24px" }}>
            <div>Item</div>
            <div className="r">Price</div>
            <div className="r">Margin</div>
            <div></div>
          </div>
          <div>
            {shown.map((item) => {
              const cost = costOf(item);
              const margin = item.price && cost !== null
                ? 1 - cost / item.price : null;
              return (
                <div className="row itemrow" key={item.itemId}>
                  <button className="namebtn" onClick={() => setEditing(item)}>
                    <strong>{item.displayName || item.itemKey}</strong>
                    {/* "no recipe" was printed on thirty-one rows as a fault. The
                        sub-line now says what to do; highlighted only once a
                        missing recipe is the exception rather than the rule. */}
                    <small className={cost === null && someCosted ? "wants" : undefined}>
                      {cost !== null ? `costs $${cost.toFixed(2)}`
                        : item.price ? "Add a recipe" : "No price yet"}
                      {!item.active && " · archived"}
                    </small>
                  </button>
                  <a href="#" onClick={(e) => { e.preventDefault(); onEditRecipe(item.itemId); }}
                     aria-label={`${cost === null ? "Add" : "Edit"} recipe for ${item.displayName}`}>
                    <span className="price">{item.price ? item.price.toFixed(2) : "—"}</span>
                    <span className={`margin${margin === null ? " none" : ""}`}>
                      {margin !== null ? `${Math.round(margin * 100)}%` : "—"}
                    </span>
                    <span className="chev"><Icon name="chevron" size={18} /></span>
                  </a>
                </div>
              );
            })}
            {!shown.length && <p className="hint" style={{ padding: "16px 4px" }}>
              {query ? "Nothing matches." : "No items yet."}</p>}
          </div>

          <div className="card">
            <label className="check">
              <input type="checkbox" checked={showArchived}
                     onChange={(e) => setShowArchived(e.target.checked)} />
              Show archived items
            </label>
          </div>
        </>
      )}
    </div>
  );
}

function ItemEditor({ item, onSave, onCancel }: {
  item: Item;
  onSave: (item: Item) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(item);
  const set = <K extends keyof Item>(k: K, v: Item[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const name = draft.displayName.trim();
  // The key is what history is joined on, so it is derived once from the first
  // name and then left alone. Renaming an item must not orphan its past.
  const key = draft.itemKey || name.toLowerCase().replace(/\s+/g, " ");

  return (
    <div className="card">
      <h2>{item.itemKey ? "Edit item" : "New item"}</h2>

      <label className="field">
        <span>Name</span>
        <input value={draft.displayName} autoFocus
               placeholder="e.g. spicy tuna roll"
               onChange={(e) => set("displayName", e.target.value)} />
      </label>

      <label className="field">
        <span>Menu price ($)</span>
        <input type="number" inputMode="decimal" step="0.01"
               value={draft.price ?? ""}
               placeholder="6.99"
               onChange={(e) => set("price", e.target.value === ""
                 ? null : Number(e.target.value))} />
      </label>

      {item.itemKey && (
        <label className="check">
          <input type="checkbox" checked={!draft.active}
                 onChange={(e) => set("active", !e.target.checked)} />
          Archive — stops it appearing on the daily screens
        </label>
      )}
      {item.itemKey && (
        <p className="hint">
          Archiving keeps every past entry. The rule still learns from this
          item's history; it just stops asking you about it.
        </p>
      )}

      <div className="actions">
        <button className="primary" disabled={!name}
                onClick={() => onSave({ ...draft, displayName: name, itemKey: key })}>
          Save
        </button>
        <button className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
