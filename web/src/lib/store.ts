/**
 * Offline-first data layer.
 *
 * Everything the app does writes to IndexedDB first and returns immediately, so
 * the form never waits on the store wifi. A background queue replays mutations
 * to the server when one is configured; until then the app is fully functional
 * standalone, which is also exactly what it must do when the wifi drops.
 *
 * Swapping in Supabase means implementing `pushMutations` -- nothing else in the
 * app talks to the network.
 */

import type { BizDate } from "./businessDay";
import { addDays, currentBizDate } from "./businessDay";
import type {
  DayRecord, Entry, Ingredient, Item, QueuedMutation, Recipe, Settings,
  Template, TemplateAssignment,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";

const DB_NAME = "maki-kiosk";
const DB_VERSION = 2;

type StoreName = "items" | "entries" | "days" | "templates" | "assignments"
  | "queue" | "meta" | "ingredients" | "recipes";

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("items")) db.createObjectStore("items", { keyPath: "itemId" });
      if (!db.objectStoreNames.contains("entries")) {
        const s = db.createObjectStore("entries", { keyPath: "mutationId" });
        s.createIndex("byDate", "businessDate");
      }
      if (!db.objectStoreNames.contains("days")) db.createObjectStore("days", { keyPath: "businessDate" });
      if (!db.objectStoreNames.contains("templates")) db.createObjectStore("templates", { keyPath: "templateId" });
      if (!db.objectStoreNames.contains("assignments")) db.createObjectStore("assignments", { keyPath: ["weekday", "effectiveFrom"] });
      if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "mutationId" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
      if (!db.objectStoreNames.contains("ingredients")) db.createObjectStore("ingredients", { keyPath: "ingredientId" });
      if (!db.objectStoreNames.contains("recipes")) db.createObjectStore("recipes", { keyPath: "itemId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx<T>(name: StoreName, mode: IDBTransactionMode,
                     fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(name, mode);
    const req = fn(t.objectStore(name));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const all = <T>(name: StoreName) => tx<T[]>(name, "readonly", (s) => s.getAll() as IDBRequest<T[]>);
const put = <T>(name: StoreName, value: T) => tx(name, "readwrite", (s) => s.put(value as never));

export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `m-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ------------------------------------------------------------------ items --

export const getItems = () => all<Item>("items");

export async function seedIfEmpty(items: Item[], templates: Template[],
                                  assignments: TemplateAssignment[]): Promise<void> {
  const existing = await getItems();
  if (existing.length) return;
  for (const i of items) await put("items", i);
  for (const t of templates) await put("templates", t);
  for (const a of assignments) await put("assignments", a);
}

// ---------------------------------------------------------------- entries --

export const getAllEntries = () => all<Entry>("entries");

export async function getEntries(date: BizDate): Promise<Entry[]> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction("entries").objectStore("entries")
      .index("byDate").getAll(IDBKeyRange.only(date));
    req.onsuccess = () => resolve(req.result as Entry[]);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Record quantities. Append-only: a correction is a new row with a later
 * recordedAt, never an edit, so the original stays readable and the server's
 * (source_ref, value_hash) constraint keeps replays idempotent.
 */
export async function saveEntries(
  date: BizDate,
  entryType: Entry["entryType"],
  quantities: Record<number, number | null>,
): Promise<Entry[]> {
  const now = new Date().toISOString();
  const written: Entry[] = [];
  for (const [itemId, qty] of Object.entries(quantities)) {
    if (qty === null || qty === undefined) continue; // absence is not zero
    const entry: Entry = {
      businessDate: date, itemId: Number(itemId), entryType,
      quantity: qty, mutationId: newId(), recordedAt: now,
    };
    await put("entries", entry);
    written.push(entry);
  }
  await enqueue({ mutationId: newId(), kind: "entries", payload: written,
                  createdAt: now, attempts: 0 });
  return written;
}

/** Latest value per (date, item, type) -- how corrections take effect. */
export function currentQuantities(entries: Entry[], entryType: Entry["entryType"]) {
  const out = new Map<number, Entry>();
  for (const e of entries) {
    if (e.entryType !== entryType) continue;
    const prev = out.get(e.itemId);
    if (!prev || e.recordedAt >= prev.recordedAt) out.set(e.itemId, e);
  }
  return out;
}

// ------------------------------------------------------------------- days --

export const getDays = () => all<DayRecord>("days");

export async function getDay(date: BizDate): Promise<DayRecord> {
  const found = await tx<DayRecord | undefined>("days", "readonly", (s) => s.get(date));
  return found ?? { businessDate: date, isOutage: false,
                    productionConfirmedAt: null, wasteConfirmedAt: null };
}

/**
 * Mark a screen as counted. This is what separates "counted, nothing left"
 * from "never opened it" -- roughly half of all item-days are zero-waste, so
 * an unattested zero is not a usable observation.
 */
/** Write an entry that came from elsewhere (a pull) without re-queueing it. */
export async function putEntry(entry: Entry): Promise<void> {
  await put("entries", entry);
}

export async function confirmDay(
  date: BizDate,
  what: "production" | "waste",
  opts: { queue?: boolean } = {},
): Promise<DayRecord> {
  const day = await getDay(date);
  const now = new Date().toISOString();
  const next: DayRecord = {
    ...day,
    productionConfirmedAt: what === "production" ? now : day.productionConfirmedAt,
    wasteConfirmedAt: what === "waste" ? now : day.wasteConfirmedAt,
  };
  await put("days", next);
  if (opts.queue !== false) {
    await enqueue({ mutationId: newId(), kind: "confirm",
                    payload: { date, what, at: now }, createdAt: now, attempts: 0 });
  }
  return next;
}

export async function markOutage(date: BizDate, note: string): Promise<void> {
  const day = await getDay(date);
  await put("days", { ...day, isOutage: true, note });
}

// -------------------------------------------------------------- templates --

export const getTemplates = () => all<Template>("templates");
export const getAssignments = () => all<TemplateAssignment>("assignments");

export async function saveTemplate(t: Template,
                                   opts: { queue?: boolean } = {}): Promise<void> {
  await put("templates", t);
  if (opts.queue !== false) {
    await enqueue({ mutationId: newId(), kind: "template", payload: t,
                    createdAt: new Date().toISOString(), attempts: 0 });
  }
}

/**
 * Assign a template to a weekday from a date forward. Past days keep whatever
 * they actually ran under, so changing your baseline never rewrites history --
 * the scorecard can say "you changed this here" instead of quietly re-scoring.
 */
export async function assignTemplate(weekday: number, effectiveFrom: BizDate,
                                     templateId: number): Promise<void> {
  await put("assignments", { weekday, effectiveFrom, templateId });
}

export function resolveTemplate(
  assignments: TemplateAssignment[], templates: Template[],
  weekday: number, date: BizDate,
): Template | null {
  const candidates = assignments
    .filter((a) => a.weekday === weekday && a.effectiveFrom <= date)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  if (!candidates.length) return null;
  return templates.find((t) => t.templateId === candidates[0].templateId) ?? null;
}

// ------------------------------------------------------------------ queue --

export const getQueue = () => all<QueuedMutation>("queue");
const enqueue = (m: QueuedMutation) => put("queue", m);

async function drop(mutationId: string) {
  await tx("queue", "readwrite", (s) => s.delete(mutationId));
}

export type Pusher = (batch: QueuedMutation[]) => Promise<void>;

let pusher: Pusher | null = null;
export function configureSync(p: Pusher | null) { pusher = p; }

/**
 * Replay queued mutations. Safe to call at any time and safe to fail: nothing
 * is dropped until the server has accepted it, and the server dedupes on
 * mutationId, so a batch delivered twice is a no-op.
 */
/** Rows per request. A month offline is a few hundred; this is headroom. */
const PUSH_BATCH = 200;

export async function sync(): Promise<{ pushed: number; pending: number }> {
  const queue = await getQueue();
  if (!pusher || !navigator.onLine || !queue.length) {
    return { pushed: 0, pending: queue.length };
  }
  // In batches, dropping each as it lands. Sending the whole queue as one
  // request means a queue that has grown past the server's body limit can
  // never drain -- it fails, is re-queued whole, and fails again forever.
  // Partial progress is also the right behaviour on a flaky connection at a
  // kiosk: what got through stays through.
  let pushed = 0;
  for (let i = 0; i < queue.length; i += PUSH_BATCH) {
    const batch = queue.slice(i, i + PUSH_BATCH);
    try {
      await pusher(batch);
      for (const m of batch) await drop(m.mutationId);
      pushed += batch.length;
    } catch {
      for (const m of batch) await put("queue", { ...m, attempts: m.attempts + 1 });
      break; // the next batch would fail the same way; stop and retry later
    }
  }
  return { pushed, pending: (await getQueue()).length };
}

export const today = (rolloverHour = 0) => currentBizDate(new Date(), rolloverHour);


// ------------------------------------------------------------- settings ---

export async function getSettings(): Promise<Settings> {
  const row = await tx<{ key: string; value: Settings } | undefined>(
    "meta", "readonly", (s) => s.get("settings"));
  // Merge over defaults so a setting added in a later version does not come
  // back undefined for someone who saved their preferences before it existed.
  return { ...DEFAULT_SETTINGS, ...(row?.value ?? {}) };
}

export async function saveSettings(settings: Settings,
                                   opts: { queue?: boolean } = {}): Promise<void> {
  await put("meta", { key: "settings", value: settings });
  if (opts.queue !== false) {
    // `theme` is deliberately not synced: it is a property of the device you
    // are holding, not of the business. Dark on the phone at 5am and light on
    // a laptop at noon is the correct outcome, not a conflict to resolve.
    const { theme: _theme, ...shared } = settings;
    await enqueue({ mutationId: newId(), kind: "settings", payload: shared,
                    createdAt: new Date().toISOString(), attempts: 0 });
  }
}

// ----------------------------------------------------------------- items ---

export async function saveItem(item: Item,
                               opts: { queue?: boolean } = {}): Promise<void> {
  await put("items", item);
  if (opts.queue !== false) {
    await enqueue({ mutationId: newId(), kind: "item", payload: item,
                    createdAt: new Date().toISOString(), attempts: 0 });
  }
}

export async function nextItemId(): Promise<number> {
  const all = await getItems();
  return Math.max(0, ...all.map((i) => i.itemId)) + 1;
}

// ----------------------------------------------------- ingredients / BOM ---

export const getIngredients = () => all<Ingredient>("ingredients");
export const getRecipes = () => all<Recipe>("recipes");

export async function saveIngredient(ingredient: Ingredient,
                                    opts: { queue?: boolean } = {}): Promise<void> {
  await put("ingredients", ingredient);
  if (opts.queue !== false) {
    await enqueue({ mutationId: newId(), kind: "ingredient", payload: ingredient,
                    createdAt: new Date().toISOString(), attempts: 0 });
  }
}

export async function nextIngredientId(): Promise<number> {
  const rows = await getIngredients();
  return Math.max(0, ...rows.map((i) => i.ingredientId)) + 1;
}

export async function saveRecipe(recipe: Recipe,
                                 opts: { queue?: boolean } = {}): Promise<void> {
  await put("recipes", recipe);
  if (opts.queue !== false) {
    await enqueue({ mutationId: newId(), kind: "recipe", payload: recipe,
                    createdAt: new Date().toISOString(), attempts: 0 });
  }
}

/**
 * Cost of one unit of an item, from its recipe. Returns null when the recipe is
 * empty -- an item with no recipe has an UNKNOWN cost, which must not be
 * confused with a cost of zero. Zero would make the critical ratio 1.0 and tell
 * the operator to make unlimited stock.
 */
export function unitCostFrom(recipe: Recipe | undefined,
                             ingredients: Ingredient[]): number | null {
  if (!recipe || !recipe.lines.length) return null;
  const byId = new Map(ingredients.map((i) => [i.ingredientId, i]));
  let total = 0;
  for (const line of recipe.lines) {
    const ing = byId.get(line.ingredientId);
    if (!ing || !ing.packQty) continue;
    total += line.qtyPerUnit * (ing.packCost / ing.packQty);
  }
  return total;
}

/** Items with their recipe cost applied, ready for the recommendation rule. */
export async function itemsWithCosts(): Promise<Item[]> {
  const [items, ingredients, recipes] = await Promise.all(
    [getItems(), getIngredients(), getRecipes()]);
  const byItem = new Map(recipes.map((r) => [r.itemId, r]));
  return items.map((item) => {
    const cost = unitCostFrom(byItem.get(item.itemId), ingredients);
    return cost === null ? item : { ...item, unitCost: cost };
  });
}

// ---------------------------------------------------------------- backup ---

export interface Backup {
  version: number;
  exportedAt: string;
  items: Item[];
  entries: Entry[];
  days: DayRecord[];
  templates: Template[];
  assignments: TemplateAssignment[];
  ingredients: Ingredient[];
  recipes: Recipe[];
  settings: Settings;
}

export async function exportAll(): Promise<Backup> {
  const [items, entries, days, templates, assignments, ingredients, recipes, settings] =
    await Promise.all([
      getItems(), getAllEntries(), getDays(), getTemplates(), getAssignments(),
      getIngredients(), getRecipes(), getSettings(),
    ]);
  return { version: DB_VERSION, exportedAt: new Date().toISOString(),
           items, entries, days, templates, assignments, ingredients, recipes, settings };
}

/**
 * Restore a backup. Entries are MERGED rather than replaced: the log is
 * append-only and keyed on mutationId, so importing the same file twice is a
 * no-op and importing an older backup never destroys newer entries.
 */
export async function importAll(backup: Backup): Promise<{ added: number }> {
  let added = 0;
  const existing = new Set((await getAllEntries()).map((e) => e.mutationId));
  for (const e of backup.entries ?? []) {
    if (existing.has(e.mutationId)) continue;
    await put("entries", e);
    added++;
  }
  for (const i of backup.items ?? []) await put("items", i);
  for (const d of backup.days ?? []) await put("days", d);
  for (const t of backup.templates ?? []) await put("templates", t);
  for (const a of backup.assignments ?? []) await put("assignments", a);
  for (const g of backup.ingredients ?? []) await put("ingredients", g);
  for (const r of backup.recipes ?? []) await put("recipes", r);
  if (backup.settings) {
    await saveSettings({ ...DEFAULT_SETTINGS, ...backup.settings }, { queue: false });
  }
  return { added };
}

// ------------------------------------------------------- opening history ---

/**
 * The columnar file written by tools/export_web_history.py: the trading
 * history the workbook already held, loaded once so the app does not open on
 * an empty axis.
 *
 * Rows are [dateIdx, itemId, made, refill, waste] with null for "no figure".
 * A null waste is genuinely uncounted; a zero is a counted sell-out. The
 * exporter has already applied the workbook's own convention for telling those
 * apart, and this must not second-guess it -- disagreeing here would put the
 * app's numbers quietly out of step with every model that was fitted.
 */
export interface HistoryFile {
  generatedAt: string;
  fromDate: BizDate;
  toDate: BizDate;
  archivedItems: Item[];
  dates: BizDate[];
  outages: BizDate[];
  rows: Array<[number, number, number | null, number | null, number | null]>;
}

const HISTORY_KEY = "history-imported";

/** When the opening history was loaded, or null if it never has been. */
export async function historyImportedAt(): Promise<string | null> {
  const rec = await tx<{ key: string; value: string } | undefined>(
    "meta", "readonly", (s) => s.get(HISTORY_KEY));
  return rec?.value ?? null;
}

export async function forgetHistoryImport(): Promise<void> {
  await tx("meta", "readwrite", (s) => s.delete(HISTORY_KEY));
}

/**
 * Load the opening history. Idempotent, and deliberately NOT queued for sync.
 *
 * Every row's mutationId is derived from (date, item, type), so running this
 * on a second device produces byte-identical rows rather than duplicates. The
 * history therefore replicates by construction and does not need to be pushed
 * -- which is just as well, since shoving 6,800 mutations through the queue on
 * first connect would be a slow way to reach the same state.
 */
export async function importHistory(
  file: HistoryFile,
): Promise<{ entries: number; days: number; items: number }> {
  const existing = new Set((await getAllEntries()).map((e) => e.mutationId));
  const knownItems = new Set((await getItems()).map((i) => i.itemId));
  const knownDays = new Set((await getDays()).map((d) => d.businessDate));

  const expanded = expandHistory(file, existing);
  const entries = expanded.entries;
  // A day the app has already recorded wins over the seed. The seed's
  // confirmation stamps are synthesised, and overwriting a real one with a
  // made-up one would lose the only evidence of when the count actually
  // happened.
  const days = expanded.days.filter((d) => !knownDays.has(d.businessDate));
  const newItems = (file.archivedItems ?? []).filter((i) => !knownItems.has(i.itemId));

  // One transaction for the lot. Several thousand single-row transactions is
  // seconds of first-run stall on a phone.
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(["entries", "days", "items", "meta"], "readwrite");
    for (const i of newItems) t.objectStore("items").put(i);
    for (const e of entries) t.objectStore("entries").put(e);
    for (const d of days) t.objectStore("days").put(d);
    t.objectStore("meta").put({ key: HISTORY_KEY, value: new Date().toISOString() });
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });

  return { entries: entries.length, days: days.length, items: newItems.length };
}

/**
 * The whole of the import except the writing, kept pure so it can be tested
 * without a database. Every judgement that could silently corrupt a year of
 * history lives in here: which figures are real, which date a row belongs to,
 * and when waste was counted relative to production.
 */
export function expandHistory(
  file: HistoryFile,
  existing: Set<string> = new Set(),
): { entries: Entry[]; days: DayRecord[] } {
  const outages = new Set(file.outages ?? []);
  // A local copy: the caller's set is an input, and a duplicated row inside a
  // single file has to dedupe against this run as well as against the store.
  const seen = new Set(existing);

  const entries: Entry[] = [];
  const touched = new Set<BizDate>();
  const KINDS: Array<[Entry["entryType"], number]> = [
    ["made", 2], ["refill", 3], ["waste", 4],
  ];

  for (const row of file.rows ?? []) {
    const date = file.dates[row[0]];
    if (!date) continue;
    const itemId = row[1];
    for (const [entryType, col] of KINDS) {
      const quantity = row[col];
      if (quantity === null || quantity === undefined) continue;
      const mutationId = `seed:${date}:${itemId}:${entryType}`;
      if (seen.has(mutationId)) continue;
      seen.add(mutationId);
      entries.push({
        businessDate: date, itemId, entryType, quantity, mutationId,
        // Waste is counted the morning after the day it belongs to; stamping
        // it on the same clock as production would invert that everywhere the
        // log is read in recordedAt order.
        recordedAt: entryType === "waste"
          ? `${addDays(date, 1)}T12:00:00.000Z`
          : `${date}T${entryType === "refill" ? "16" : "10"}:00:00.000Z`,
      });
    }
    touched.add(date);
  }

  // A closed day has no rows to import, but "we were shut" is itself a fact and
  // the only thing that stops the day being read as a catastrophic zero.
  for (const date of outages) if (file.dates.includes(date)) touched.add(date);

  const days: DayRecord[] = [...touched].sort().map((date) => ({
    businessDate: date,
    isOutage: outages.has(date),
    // The workbook is a closed record: both halves of every day in it were
    // done. Leaving them unconfirmed would fill the task list with 117 days
    // of homework that was finished months ago.
    productionConfirmedAt: `${date}T10:00:00.000Z`,
    wasteConfirmedAt: `${addDays(date, 1)}T12:00:00.000Z`,
  }));

  return { entries, days };
}
