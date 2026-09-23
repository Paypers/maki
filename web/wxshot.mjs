/**
 * Screenshot the home screen's weather card against the real Open-Meteo API.
 *
 * Deliberately not a fixture: the whole card depends on a live forecast row
 * landing for today, being reduced to the trading-hour window, and matching a
 * band the record has actually seen. A stubbed response proves none of that.
 *
 *   node wxshot.mjs [outdir] [zip]      (needs `vite preview` on :4173)
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "wxshots";
const ZIP = process.argv[3] ?? "21201";
mkdirSync(OUT, { recursive: true });

const b = await chromium.launch();
for (const theme of ["dark", "light"]) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 },
                                   colorScheme: theme,
                                   baseURL: "http://localhost:4173" });
  const p = await ctx.newPage();
  p.on("console", (m) => { if (m.type() === "error") console.log("  console:", m.text()); });

  // First boot: the app seeds and imports the history for real.
  await p.goto("/");
  await p.waitForSelector(".tabbar");
  await p.waitForTimeout(1500);

  // Set the location the way the operator would, through the settings screen,
  // so the ZIP lookup and the backfill both actually run.
  await p.screenshot({ path: `${OUT}/${theme}-1-nolocation.png`, fullPage: true });
  console.log(`[${theme}] no location:`,
    (await p.locator(".wx-setup").first().innerText()).replace(/\s+/g, " ").slice(0, 80));

  await p.locator(".wx-setup").first().click();
  await p.waitForSelector("input[inputmode=numeric]");
  await p.fill("input[inputmode=numeric]", ZIP);
  await p.locator("button.primary").first().click();
  await p.waitForTimeout(6000);
  console.log(`[${theme}] settings says:`,
    (await p.locator(".banner").first().innerText()).replace(/\s+/g, " "));

  await p.locator("header.bar button.ghost").first().click();
  await p.waitForSelector(".wx-today");
  await p.waitForTimeout(1200);

  const card = p.locator(".wx-today").first();
  console.log(`[${theme}] card:`, (await card.innerText()).replace(/\s+/g, " "));
  await card.screenshot({ path: `${OUT}/${theme}-2-card.png` });
  await p.screenshot({ path: `${OUT}/${theme}-3-home.png`, fullPage: true });

  // Narrow: the projection row has to wrap rather than overflow.
  await p.setViewportSize({ width: 320, height: 844 });
  await p.waitForTimeout(300);
  await card.screenshot({ path: `${OUT}/${theme}-4-card-320.png` });
  const overflow = await p.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth);
  console.log(`[${theme}] horizontal overflow at 320px:`, overflow);

  await ctx.close();
}
await b.close();
console.log(`\nwrote ${OUT}/`);
