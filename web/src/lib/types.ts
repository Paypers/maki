import type { BizDate } from "./businessDay";
import type { StoreLocation, TradingHours } from "./weather";

export interface Item {
  itemId: number;
  itemKey: string;
  displayName: string;
  price: number | null;
  unitCost: number | null;
  sortOrder: number;
  /**
   * Which block of the paper prep sheet the item sits in (0, 1, 2…), so the
   * entry screens can draw the same groups the operator reads on paper.
   * Presentation only, like sortOrder. Absent for items the sheet does not
   * list; they are drawn as one block after the rest.
   */
  sheetGroup?: number | null;
  active: boolean;
  /**
   * Flat promotional price, e.g. 5.99 on Wednesdays. When set it REPLACES the
   * normal price on promo weekdays and also replaces the buy-2-get-1
   * multiplier for this item -- a $5.99 roll sells at $5.99, not at two
   * thirds of $5.99. That is an assumption about how the deals stack; if the
   * store runs both together this is the line to change.
   */
  promoPrice?: number | null;
  /** ISO weekdays the promo price applies. Empty or absent = never. */
  promoWeekdays?: number[];
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
  /** chances[k-1]: the rule's estimate that roll k sells. */
  chances?: number[];
  /** The chance a roll needs to be worth making: cost / price. */
  breakEven?: number | null;
  /** The suggestion is one above the most made lately: a test roll. */
  testing?: boolean;
  recentMax?: number;
  /** What the rule says before the climber adds anything. */
  ruleQty?: number | null;
  /** The climber's evidence, and how many rolls it kept after the budget. */
  climb?: import("./model").Climb | null;
  climbSteps?: number;
  /** Rolls rain took off this item, when a rain adjustment was asked for. */
  weatherCut?: number;
  /** Why, in the rule's terms: "rain 70%: a 4th would sell ~19%, needs 21%". */
  weatherNote?: string;
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

/** The app's visual themes. Layout is the same in each; see lib/theme.ts. */
export type Look = "default" | "washi" | "bento";

export interface Settings {
  /** Local hour the business day flips. 0 = midnight. */
  rolloverHour: number;
  /** ISO weekdays running buy-2-get-1. 3 = Wednesday. */
  promoWeekdays: number[];
  /** Realised price multiplier on a promo day. 2/3 for a proportional B2G1. */
  promoMultiplier: number;
  /** Recovered per DISCARDED unit. Zero when waste is counted the morning after. */
  salvage: number;
  /** What making one roll costs on top of its recipe, $ -- your time, if you
   *  count it. Zero until you say otherwise: only you know what an hour is. */
  labourPerRoll: number;
  /** Share of each sale that reaches you, 0-1. One unless the store takes a
   *  cut; a 25% cut is 0.75, and it raises every break-even by a third. */
  saleShare: number;
  /** How hard the rule pushes items that keep selling out: 1 (careful,
   *  never) to 5 (max). See model.ts AMBITION. */
  ambition: number;
  /** When the ambition level was last changed, so its effect can be judged
   *  against the days before. Null until it is first changed. */
  ambitionSince: string | null;
  /** Show the model's suggestion as a delta beside your own number. */
  showSuggestions: boolean;
  kioskName: string;
  /** Dark is the design; light is for when the store lights are on. */
  theme: "system" | "dark" | "light";
  /** Which theme: colours, faces, corners and depth. Like `theme`, a
   *  property of this phone, never synced. */
  look: Look;

  // ---- weather ----
  /** Where the kiosk is, resolved from a ZIP. Null until it is set. */
  location: StoreLocation | null;
  /** Local hours the kiosk trades. Weather outside these is ignored. */
  hours: TradingHours;
  /** Off until a location is set; the app never fetches without being asked. */
  weatherEnabled: boolean;
  /**
   * Things the operator believes move their sales, which must not be
   * credited to the weather. A checked factor holds its days out of the
   * weather baseline rather than trying to model them -- with one kiosk and
   * one year there is not enough data to estimate them, but there is enough
   * to stop them contaminating something else.
   */
  factors: {
    paydays: boolean;       // 1st and 15th
    schoolCalendar: boolean;
    storeEvents: boolean;
  };
  /** Dates the operator marked as unusual, held out of the baseline. */
  unusualDates: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  rolloverHour: 0,
  promoWeekdays: [3],
  promoMultiplier: 2 / 3,
  salvage: 0,
  labourPerRoll: 0,
  // The middle man takes 20% of all sales (operator, 2026-09-23). A default
  // rather than a hard-coded fact: it changes in Settings if the deal does.
  saleShare: 0.8,
  ambition: 3,
  ambitionSince: null,
  showSuggestions: true,
  theme: "system",
  look: "default",
  location: null,
  hours: { open: 8, close: 20 },
  weatherEnabled: false,
  factors: { paydays: false, schoolCalendar: false, storeEvents: false },
  unusualDates: [],
  kioskName: "Kiosk",
};
