/**
 * Themes.
 *
 * What is protected:
 *   - every look defines every colour token Default does, in dark AND light,
 *     so no token silently falls through to another look's value;
 *   - the two copies of each light palette (the phone's preference, and the
 *     explicit choice) are identical, and each block says which scheme it is;
 *   - every pair of text and ground in every look and mode reads at 4.5:1 --
 *     the dark week card and Bento's tab bar included;
 *   - the picker's previews show the real colours;
 *   - every face a look uses is cached for offline, and the pre-paint script
 *     in index.html reads the same keys the app writes.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Look } from "./types";
import {
  LOOKS, LOOK_KEY, THEME_KEY, chromeColors, lookOf, rootAttributes,
} from "./theme";

// Read as files: Vitest hands a stylesheet import back empty, even as ?raw.
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const sw = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");

type Tokens = Record<string, string>;

/** The declarations of the block whose selector is exactly `selector`. */
function block(selector: string): { tokens: Tokens; text: string } {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no block for ${selector}`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  const text = css.slice(open + 1, close);
  const tokens: Tokens = {};
  // Whitespace inside a value is layout, not meaning: the texture spans lines.
  for (const m of text.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[m[1]] = m[2].replace(/\s+/g, " ").trim();
  }
  return { tokens, text };
}

const sel = (look: Look) => (look === "default" ? ":root" : `:root[data-look="${look}"]`);
const blocks = (look: Look) => ({
  dark: block(sel(look)),
  lightMedia: block(`${sel(look)}:where(:not([data-theme="dark"]))`),
  light: block(`${sel(look)}[data-theme="light"]`),
});

/** What a look resolves to on screen: Default's tokens, then the look's own. */
function effective(look: Look, mode: "dark" | "light"): Tokens {
  const base = { ...blocks("default").dark.tokens,
                 ...(mode === "light" ? blocks("default").light.tokens : {}) };
  if (look === "default") return base;
  const own = blocks(look);
  return { ...base, ...own.dark.tokens, ...(mode === "light" ? own.light.tokens : {}) };
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
const isHex = (v: string | undefined): v is string => !!v && /^#[0-9a-f]{6}$/i.test(v);

/** Text on the grounds it sits on, anywhere in the app. */
const PAIRS: [string, string][] = [
  ["text-primary", "bg"], ["text-primary", "surface-1"], ["text-primary", "surface-2"],
  ["text-primary", "surface-3"],
  ["text-secondary", "bg"], ["text-secondary", "surface-1"], ["text-secondary", "surface-2"],
  ["accent-ink", "bg"], ["accent-ink", "surface-1"], ["accent-ink", "owed-soft"],
  ["rule-ink", "bg"], ["rule-ink", "surface-1"], ["rule-ink", "rule-soft"],
  ["good-ink", "surface-1"], ["good-ink", "good-soft"],
  ["critical-ink", "surface-1"], ["critical-ink", "critical-soft"],
  ["on-accent", "accent"],
];

function failures(t: Tokens, pairs: [string, string][]): string[] {
  const out: string[] = [];
  for (const [fg, bg] of pairs) {
    const a = t[fg], b = t[bg];
    if (!isHex(a) || !isHex(b)) throw new Error(`--${fg} or --${bg} is not a plain hex colour`);
    const c = contrast(a, b);
    if (c < 4.5) out.push(`--${fg} on --${bg}: ${c.toFixed(2)}`);
  }
  return out;
}

const OTHER_LOOKS: Look[] = ["washi", "bento"];
const ALL_LOOKS: Look[] = ["default", ...OTHER_LOOKS];

describe("the looks in the stylesheet", () => {
  it("define every colour token Default does, in dark and in light", () => {
    const needed = Object.keys(blocks("default").light.tokens);
    expect(needed.length).toBeGreaterThan(25);
    for (const look of OTHER_LOOKS) {
      const own = blocks(look);
      for (const [mode, b] of [["dark", own.dark], ["light", own.light]] as const) {
        const missing = needed.filter((k) => !(k in b.tokens));
        expect(missing, `${look} ${mode} is missing`).toEqual([]);
      }
    }
  });

  it("keep the two copies of each light palette identical, and say which scheme they are", () => {
    for (const look of ALL_LOOKS) {
      const b = blocks(look);
      expect(b.lightMedia.tokens, look).toEqual(b.light.tokens);
      expect(b.dark.text, look).toMatch(/color-scheme:\s*dark/);
      expect(b.light.text, look).toMatch(/color-scheme:\s*light/);
      expect(b.lightMedia.text, look).toMatch(/color-scheme:\s*light/);
    }
  });

  it("read at 4.5:1 for every pair of text and ground, in every look and mode", () => {
    for (const look of ALL_LOOKS) {
      for (const mode of ["dark", "light"] as const) {
        expect(failures(effective(look, mode), PAIRS), `${look} ${mode}`).toEqual([]);
      }
    }
  });

  it("read at 4.5:1 on the dark week card, in both modes", () => {
    const island = [
      ["text-primary", "surface-1"], ["text-secondary", "surface-1"], ["text-secondary", "surface-2"],
      ["accent-ink", "surface-1"], ["rule-ink", "surface-1"], ["good-ink", "surface-1"],
      ["critical-ink", "surface-1"],
    ] as [string, string][];
    for (const look of OTHER_LOOKS) {
      const card = block(`:where(:root[data-look="${look}"]) .card.period.hero`).tokens;
      for (const mode of ["dark", "light"] as const) {
        expect(failures({ ...effective(look, mode), ...card }, island), `${look} ${mode}`).toEqual([]);
      }
    }
  });

  it("read at 4.5:1 on Bento's tab bar", () => {
    for (const mode of ["dark", "light"] as const) {
      const t = effective("bento", mode);
      expect(failures(t, [["bar-ink", "bar-bg"], ["bar-active-ink", "bar-active-bg"]]), mode).toEqual([]);
    }
  });
});

describe("the theme picker", () => {
  it("previews each look in its real colours", () => {
    for (const info of LOOKS) {
      for (const mode of ["dark", "light"] as const) {
        const t = effective(info.id, mode);
        const s = info.swatch[mode];
        expect({ bg: s.bg, surface: s.surface, ink: s.ink, muted: s.muted, accent: s.accent,
                 rule: s.rule, line: s.line }, `${info.id} ${mode}`)
          .toEqual({ bg: t.bg, surface: t["surface-1"], ink: t["text-primary"],
                     muted: t["text-secondary"], accent: t.accent, rule: t["rule-ink"], line: t.line });
      }
    }
  });

  it("offers exactly the looks the stylesheet has", () => {
    expect(LOOKS.map((l) => l.id)).toEqual(ALL_LOOKS);
  });
});

describe("putting a look on the page", () => {
  it("leaves Default and 'match phone' as no attribute at all", () => {
    expect(rootAttributes("default", "system")).toEqual({ look: null, theme: null });
    expect(rootAttributes("washi", "dark")).toEqual({ look: "washi", theme: "dark" });
    expect(rootAttributes("bento", "light")).toEqual({ look: "bento", theme: "light" });
  });

  it("colours the phone's bars with the look's ground", () => {
    expect(chromeColors("default", "system")).toEqual({ dark: "#0f0f0e", light: "#f4f2ec" });
    expect(chromeColors("washi", "light")).toEqual({ dark: "#f2ede3", light: "#f2ede3" });
    expect(chromeColors("bento", "dark")).toEqual({ dark: "#121714", light: "#121714" });
  });

  it("reads anything unknown as Default", () => {
    expect(lookOf("washi")).toBe("washi");
    expect(lookOf("sakura")).toBe("default");
    expect(lookOf(undefined)).toBe("default");
  });

  it("is read back before the first paint with the keys the app writes", () => {
    const script = indexHtml.slice(indexHtml.indexOf("<script>"), indexHtml.indexOf("</script>"));
    expect(script).toContain(`"${LOOK_KEY}"`);
    expect(script).toContain(`"${THEME_KEY}"`);
    for (const look of OTHER_LOOKS) expect(script).toContain(`"${look}"`);
  });

  it("can be switched to offline: every face is in the service worker's shell", () => {
    const faces = [...css.matchAll(/url\("(\/fonts\/[^"]+)"\)/g)].map((m) => m[1]);
    expect(faces.length).toBe(9);
    for (const f of faces) expect(sw, f).toContain(`"${f}"`);
  });
});
