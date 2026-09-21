import type { BizDate } from "./businessDay";

export interface Item {
  itemId: number;
  itemKey: string;
  displayName: string;
  price: number | null;
  unitCost: number | null;
  sortOrder: number;
  active: boolean;
}

export type EntryType = "made" | "refill" | "waste";

export interface Entry {
  businessDate: BizDate;
  itemId: number;
  entryType: EntryType;
  quantity: number;
  /** Client-generated. Becomes source_ref, which is how replays dedupe. */
  mutationId: string;
  recordedAt: string;
  note?: string;
}

export interface DayRecord {
  businessDate: BizDate;
  isOutage: boolean;
  productionConfirmedAt: string | null;
  wasteConfirmedAt: string | null;
  note?: string;
}

export interface Template {
  templateId: number;
  name: string;
  /** itemId -> qty */
  quantities: Record<number, number>;
}

/** weekday (1..7) -> list of assignments, newest effectiveFrom wins. */
export interface TemplateAssignment {
  weekday: number;
  effectiveFrom: BizDate;
  templateId: number;
}

export interface Recommendation {
  itemId: number;
  /** What the operator's own template says. The anchor, always shown. */
  baselineQty: number;
  /** What the rule says. Null means no opinion -- never rendered as zero. */
  modelQty: number | null;
  /** What the NAIVE same-weekday mean would have said. Phase 5 requires this
   *  to be visible on every line, so a recommendation can always be compared
   *  against the dumbest thing that could have been done instead. */
  naiveBaselineQty: number | null;
  modelName: string;
  modelVersion: string;
  isFallback: boolean;
  fallbackReason?: string;
  reason?: string;
  caveat?: string;
  confidence?: "low" | "medium" | "high";
}

export interface QueuedMutation {
  mutationId: string;
  kind: "entries" | "confirm" | "template"
      | "item" | "ingredient" | "recipe" | "settings";
  payload: unknown;
  createdAt: string;
  attempts: number;
}

// ---------------------------------------------------------------- recipes --

export interface Ingredient {
  ingredientId: number;
  name: string;
  /** g | ml | each | sheet -- whatever the operator buys it in. */
  unit: string;
  /** What one purchase pack costs, and how many `unit` are in it. */
  packCost: number;
  packQty: number;
  archived?: boolean;
}

export interface RecipeLine {
  ingredientId: number;
  qtyPerUnit: number;
}

/** itemId -> the ingredients that go into one unit of it. */
export interface Recipe {
  itemId: number;
  lines: RecipeLine[];
  updatedAt: string;
}

// --------------------------------------------------------------- settings --

export interface Settings {
  /** Local hour the business day flips. 0 = midnight. */
  rolloverHour: number;
  /** ISO weekdays running buy-2-get-1. 3 = Wednesday. */
  promoWeekdays: number[];
  /** Realised price multiplier on a promo day. 2/3 for a proportional B2G1. */
  promoMultiplier: number;
  /** Recovered per DISCARDED unit. Zero when waste is counted the morning after. */
  salvage: number;
  /** Show the model's suggestion as a delta beside your own number. */
  showSuggestions: boolean;
  kioskName: string;
  /** Dark is the design; light is for when the store lights are on. */
  theme: "system" | "dark" | "light";
}

export const DEFAULT_SETTINGS: Settings = {
  rolloverHour: 0,
  promoWeekdays: [3],
  promoMultiplier: 2 / 3,
  salvage: 0,
  showSuggestions: true,
  theme: "system",
  kioskName: "Kiosk",
};
