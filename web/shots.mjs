/**
 * Screenshot the app for self-review.
 *
 * Seeds a realistic dataset straight into IndexedDB before rendering, because a
 * screenshot of empty states tells you nothing about whether the thing is
 * usable. Runs against the production build so what is captured is what ships.
 *
 *   node shots.mjs [outdir] [--theme dark] [--only home,items]
 */

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "shots";
const args = process.argv.slice(3).join(" ");
const THEME = /--theme dark/.test(args) ? "dark" : "light";
const ONLY = (args.match(/--only ([\w,]+)/) ?? [])[1]?.split(",");

mkdirSync(OUT, { recursive: true });

const ITEMS = [
  ["cali roll", 6.99], ["spicy tuna", 7.99], ["salmon avocado", 7.99],
  ["philly roll", 8.49], ["dragon roll", 11.99], ["spicy crab", 6.99],
  ["shrimp tempura roll", 8.99], ["avocado roll", 6.99], ["poke", 13.99],
  ["lobster roll", 7.99], ["vegetable roll", 6.99], ["tri volcano", 13.49],
];

/** Deterministic pseudo-random so screenshots are comparable across runs. */
function seedScript() {
  return ({ items }) => new Promise((resolve) => {
    const req = indexedDB.open("maki-kiosk", 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [n, k] of [["items", "itemId"], ["days", "businessDate"],
                            ["templates", "templateId"], ["queue", "mutationId"],
                            ["meta", "key"], ["ingredients", "ingredientId"],
                            ["recipes", "itemId"]]) {
        if (!db.objectStoreNames.contains(n)) db.createObjectStore(n, { keyPath: k });
      }
      if (!db.objectStoreNames.contains("entries")) {
        const s = db.createObjectStore("entries", { keyPath: "mutationId" });
        s.createIndex("byDate", "businessDate");
      }
      if (!db.objectStoreNames.contains("assignments")) {
        db.createObjectStore("assignments", { keyPath: ["weekday", "effectiveFrom"] });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      const stores = ["items", "entries", "days", "templates", "assignments",
                      "ingredients", "recipes"];
      const tx = db.transaction(stores, "readwrite");
      // The app seeds its own roster on first boot; clear it so the screenshot
      // shows this fixture and not both rosters merged.
      for (const n of stores) tx.objectStore(n).clear();
      const put = (s, v) => tx.objectStore(s).put(v);

      let seed = 42;
      const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

      const ings = [
        [1, "sushi rice", "g", 1.8, 454], [2, "nori", "sheet", 6, 50],
        [3, "salmon", "g", 9.5, 454], [4, "tuna", "g", 12, 454],
        [5, "imitation crab", "g", 3.2, 454], [6, "avocado", "each", 0.55, 1],
        [7, "cucumber", "each", 0.6, 1], [8, "spicy mayo", "g", 4, 454],
        [9, "tempura crunch", "g", 4.5, 454], [10, "container S15", "each", 0.22, 1],
      ];
      for (const [ingredientId, name, unit, packCost, packQty] of ings) {
        put("ingredients", { ingredientId, name, unit, packCost, packQty });
      }

      items.forEach(([name, price], i) => {
        put("items", {
          itemId: i + 1, itemKey: name, displayName: name, price,
          unitCost: null, sortOrder: i, active: true,
        });
        // A plausible recipe for the first few, so cost/margin is populated.
        if (i < 8) {
          put("recipes", {
            itemId: i + 1, updatedAt: new Date().toISOString(),
            lines: [
              { ingredientId: 1, qtyPerUnit: 60 },
              { ingredientId: 2, qtyPerUnit: 1 },
              { ingredientId: i % 2 ? 3 : 5, qtyPerUnit: 45 },
              { ingredientId: 6, qtyPerUnit: 0.4 },
              { ingredientId: 10, qtyPerUnit: 1 },
            ],
          });
        }
      });

      const today = new Date();
      const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

      // 70 days of history; yesterday's waste deliberately left uncounted so
      // the morning task list has something real in it.
      for (let back = 70; back >= 1; back--) {
        const d = new Date(today);
        d.setDate(d.getDate() - back);
        const date = iso(d);
        const wed = d.getDay() === 3;
        items.forEach(([name], i) => {
          const base = 2 + (i % 4) + (wed ? 2 : 0);
          const made = Math.max(1, Math.round(base + rnd() * 2));
          put("entries", {
            businessDate: date, itemId: i + 1, entryType: "made", quantity: made,
            mutationId: `m-${date}-${i}-made`, recordedAt: `${date}T06:00:00Z`,
          });
          const waste = rnd() < 0.45 ? 0 : Math.min(made, Math.round(rnd() * 3));
          if (back > 1 && waste > 0) {
            put("entries", {
              businessDate: date, itemId: i + 1, entryType: "waste", quantity: waste,
              mutationId: `m-${date}-${i}-waste`, recordedAt: `${date}T23:00:00Z`,
            });
          }
        });
        put("days", {
          businessDate: date, isOutage: false,
          productionConfirmedAt: `${date}T06:05:00Z`,
          wasteConfirmedAt: back > 1 ? `${date}T23:05:00Z` : null,
        });
      }

      const quantities = {};
      items.forEach((_, i) => { quantities[i + 1] = 3 + (i % 4); });
      put("templates", { templateId: 1, name: "Everyday", quantities });
      for (let wd = 1; wd <= 7; wd++) {
        put("assignments", { weekday: wd, effectiveFrom: "2020-01-01", templateId: 1 });
      }
      tx.oncomplete = () => resolve(true);
    };
  });
}

const SHOTS = [
  { name: "home", steps: async () => {} },
  { name: "waste", steps: async (p) => { await p.click("button.primary:has-text(\"leftovers\")"); } },
  { name: "review", steps: async (p) => {
      await p.click("button.primary:has-text(\"leftovers\")");
      await p.click(".footer button.primary");
      await p.waitForTimeout(400);
    } },
  { name: "production", steps: async (p) => {
      await p.click("button.primary:has-text(\"leftovers\")");
      await p.click(".footer button.primary");
      await p.waitForTimeout(300);
      await p.click("button:has-text(\"Continue to today\")");
      await p.waitForTimeout(400);
    } },
  { name: "templates", steps: async (p) => { await p.click(".tabbar >> text=Baseline"); } },
  { name: "items", steps: async (p) => { await p.click(".tabbar >> text=Menu"); } },
  { name: "recipes", steps: async (p) => {
      await p.click(".tabbar >> text=Menu");
      await p.click("button.small:has-text('Recipe') >> nth=0");
      await p.waitForTimeout(300);
    } },
  { name: "insights", steps: async (p) => { await p.click(".tabbar >> text=More"); } },
  { name: "insights-sellout", steps: async (p) => {
      await p.click(".tabbar >> text=More");
      await p.click("button:has-text('Sell-outs')");
    } },
  { name: "settings", steps: async (p) => {
      await p.click(".tabbar >> text=More");
      await p.click("button:has-text('Settings')");
      await p.waitForTimeout(300);
    } },
  { name: "cloud", steps: async (p) => {
      await p.click(".tabbar >> text=More");
      await p.click("button:has-text('Cloud sync')");
      await p.waitForTimeout(300);
    } },
];

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },   // iPhone 14 class
  deviceScaleFactor: 2,
  colorScheme: THEME,
  baseURL: "http://localhost:4173",
});

for (const shot of SHOTS) {
  if (ONLY && !ONLY.includes(shot.name)) continue;
  const page = await context.newPage();
  await page.goto("/");
  // Seed twice: the app's own first-run seeding is async and was still landing
  // rows after the first clear, leaving both rosters merged in the screenshot.
  await page.evaluate(seedScript(), { items: ITEMS });
  await page.reload();
  await page.waitForTimeout(300);
  await page.evaluate(seedScript(), { items: ITEMS });
  await page.reload();
  await page.waitForSelector(".tabbar", { timeout: 15000 });
  await page.waitForTimeout(500);
  try {
    await shot.steps(page);
    await page.waitForTimeout(500);
  } catch (err) {
    console.log(`  ! ${shot.name}: ${err.message.split("\n")[0]}`);
  }
  const file = `${OUT}/${shot.name}${THEME === "dark" ? "-dark" : ""}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  ${file}`);
  await page.close();
}

await browser.close();
