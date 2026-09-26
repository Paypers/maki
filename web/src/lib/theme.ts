/**
 * Themes ("looks"): Default, Washi and Bento, each in light and dark.
 *
 * A look is colour, faces, corners and depth -- never layout, so every screen
 * stays where your hands expect it. The stylesheet carries all of it as
 * tokens keyed on <html data-look="...">; this file only says which look is
 * on, remembers it, and describes each one for the picker in Settings.
 *
 * Where the choice lives: in Settings, with this phone's other preferences
 * (IndexedDB), and never synced -- like light and dark, it belongs to the
 * device in your hand, not to the business. It is ALSO mirrored into
 * localStorage, because IndexedDB answers only after the first paint:
 * index.html reads the mirror before anything is drawn, so a Washi phone
 * never flashes Default on launch. Settings is the record; the mirror is a
 * convenience, and the app works the same if the mirror is lost.
 */

import type { Look, Settings } from "./types";

/** Match the phone, or always dark, or always light. */
export type Brightness = Settings["theme"];
export type Mode = "dark" | "light";

/** A look's colours, as the picker's preview draws them. */
export interface Swatch {
  bg: string;
  surface: string;
  ink: string;
  muted: string;
  /** What is owed: amber in every look, tuned to its ground. */
  accent: string;
  /** The rule's number: blue in every look. */
  rule: string;
  line: string;
}

export interface LookInfo {
  id: Look;
  name: string;
  /** One line for the picker: what the look is. */
  blurb: string;
  /** The look's display face, for the preview's numeral. */
  display: string;
  /** Corner of the preview card, px. */
  radius: number;
  /** Equal to the stylesheet's tokens for this look; theme.test.ts checks. */
  swatch: Record<Mode, Swatch>;
}

export const LOOKS: readonly LookInfo[] = [
  {
    id: "default",
    name: "Default",
    blurb: "Dense and quiet, dark first — the app as it has always looked.",
    display: '"Space Grotesk", sans-serif',
    radius: 5,
    swatch: {
      dark: { bg: "#0f0f0e", surface: "#1a1a18", ink: "#f2efe8", muted: "#9c978c",
              accent: "#f2a93b", rule: "#8db4ea", line: "#2a2a27" },
      light: { bg: "#f4f2ec", surface: "#ffffff", ink: "#14130f", muted: "#5f5b53",
               accent: "#f2a93b", rule: "#1f5aa6", line: "#dcd9d0" },
    },
  },
  {
    id: "washi",
    name: "Washi",
    blurb: "Paper and ink — serif numbers, square inked edges, gold for what's owed.",
    display: '"Shippori Mincho", serif',
    radius: 1,
    swatch: {
      dark: { bg: "#15130f", surface: "#1e1b16", ink: "#efe8da", muted: "#b1a792",
              accent: "#e0a83e", rule: "#92b4db", line: "#4d4538" },
      light: { bg: "#f2ede3", surface: "#fbf8f2", ink: "#1c1a16", muted: "#5e5648",
               accent: "#e2a72e", rule: "#1d4b7a", line: "#5a5044" },
    },
  },
  {
    id: "bento",
    name: "Bento",
    blurb: "Soft tiles — rounded cards lifted by shadow, and a dark card for the week.",
    display: '"Sora", sans-serif',
    radius: 10,
    swatch: {
      dark: { bg: "#121714", surface: "#1c231f", ink: "#f0ece3", muted: "#a5afa7",
              accent: "#f5a855", rule: "#9dbbe8", line: "#2b342e" },
      light: { bg: "#eeeae3", surface: "#ffffff", ink: "#1d2621", muted: "#5b665f",
               accent: "#f5a855", rule: "#2d5a98", line: "#e2dcd1" },
    },
  },
];

/** Where the pre-paint mirror lives. index.html reads these same two keys. */
export const LOOK_KEY = "kiosk-look";
export const THEME_KEY = "kiosk-theme";

export function lookInfo(look: Look): LookInfo {
  return LOOKS.find((l) => l.id === look) ?? LOOKS[0];
}

/** Anything that is not a known look -- an old setting, a typo -- is Default. */
export function lookOf(value: unknown): Look {
  return LOOKS.some((l) => l.id === value) ? (value as Look) : "default";
}

/**
 * The attributes <html> carries. Null means absent: no data-look is Default,
 * and no data-theme lets the phone's own light or dark decide.
 */
export function rootAttributes(look: Look, theme: Brightness): { look: Look | null; theme: Mode | null } {
  return {
    look: look === "default" ? null : lookOf(look),
    theme: theme === "dark" || theme === "light" ? theme : null,
  };
}

/**
 * The colour of the phone's own bars around the app: the look's ground, for
 * whichever mode will show. Following the phone, both are needed, one per
 * <meta name="theme-color" media="...">.
 */
export function chromeColors(look: Look, theme: Brightness): Record<Mode, string> {
  const { swatch } = lookInfo(look);
  if (theme === "dark" || theme === "light") {
    return { dark: swatch[theme].bg, light: swatch[theme].bg };
  }
  return { dark: swatch.dark.bg, light: swatch.light.bg };
}

export function systemMode(): Mode {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "dark";
  }
}

/** The mode actually on screen. */
export function effectiveMode(theme: Brightness): Mode {
  return theme === "dark" || theme === "light" ? theme : systemMode();
}

/** Put a look on the page, and remember it for the next launch's first paint. */
export function applyLook(look: Look, theme: Brightness): void {
  const root = document.documentElement;
  const a = rootAttributes(look, theme);
  if (a.look) root.dataset.look = a.look;
  else delete root.dataset.look;
  if (a.theme) root.dataset.theme = a.theme;
  else delete root.dataset.theme;

  const chrome = chromeColors(look, theme);
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    m.content = m.media.includes("light") ? chrome.light : chrome.dark;
  });

  // Private windows and cleared storage throw or forget. Either way the app
  // is right after its first read of Settings; only the launch paint differs.
  try {
    localStorage.setItem(LOOK_KEY, look);
    localStorage.setItem(THEME_KEY, theme);
  } catch { /* not kept: fine */ }
}
