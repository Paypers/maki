/**
 * Screenshot the real first-run path.
 *
 * The companion to shots.mjs, and deliberately not the same thing: shots.mjs
 * injects a fixture, so it can never catch a bug in the boot path itself. This
 * one opens an empty browser and lets the app seed and import for real, which
 * is how the phantom "Plan <yesterday>" task and the home screen that sat on
 * 117 days while showing none of them were both found.
 *
 *   npm run shots:real [outdir] [--dark]
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const OUT = process.argv[2] ?? "real";
// Dark is a selected mode, not an automatic flip of the light one -- its
// surfaces step the other way and shadows do nothing on it, so it has to be
// looked at rather than assumed.
const THEME = process.argv.includes("--dark") ? "dark" : "light";
mkdirSync(OUT, { recursive: true });

const SHOTS = [
  { name: "home", steps: async () => {} },
  { name: "waste", steps: async (p) => {
      // Seed a confirmed production for "yesterday" with no waste count, so the
      // morning task is real: the home screen leads with counting leftovers.
      await p.evaluate(() => new Promise((res) => {
        const q = indexedDB.open("maki-kiosk");
        q.onsuccess = () => {
          const db = q.result;
          const d = new Date(); d.setDate(d.getDate() - 1);
          const iso = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
          const t = db.transaction(["entries","days","items"], "readwrite");
          t.objectStore("items").getAll().onsuccess = (e) => {
            const items = e.target.result.filter((i) => i.active).slice(0, 12);
            items.forEach((it, i) => t.objectStore("entries").put({
              businessDate: iso, itemId: it.itemId, entryType: "made", quantity: 1 + (i % 4),
              mutationId: `shot-${iso}-${it.itemId}`, recordedAt: `${iso}T10:00:00.000Z` }));
            t.objectStore("days").put({ businessDate: iso, isOutage: false,
              productionConfirmedAt: `${iso}T10:05:00.000Z`, wasteConfirmedAt: null });
          };
          t.oncomplete = () => res(true);
        };
      }));
      await p.reload(); await p.waitForSelector(".tabbar"); await p.waitForTimeout(600);
      await p.click('button.primary:has-text("leftovers")'); await p.waitForTimeout(500);
      // touch three rows so the counted/blank states both show
      const plus = await p.$$(".stepper .step:last-child");
      for (const b of plus.slice(0, 3)) await b.click();
      await p.waitForTimeout(200);
    } },
  { name: "production", steps: async (p) => {
      await p.click('button.primary:has-text("production")'); await p.waitForTimeout(500); } },
  { name: "insights", steps: async (p) => { await p.click(".tabbar >> text=More"); await p.waitForTimeout(400); } },
  { name: "insights-sellout", steps: async (p) => {
      await p.click(".tabbar >> text=More");
      await p.click("button:has-text('Sell-outs')"); await p.waitForTimeout(400); } },
  { name: "settings", steps: async (p) => {
      await p.click(".tabbar >> text=More");
      await p.click("button:has-text('Settings')"); await p.waitForTimeout(400); } },
  { name: "menu", steps: async (p) => { await p.click(".tabbar >> text=Menu"); await p.waitForTimeout(400); } },
  { name: "recipe", steps: async (p) => {
      await p.click(".tabbar >> text=Menu"); await p.waitForTimeout(300);
      await p.click(".itemrow a >> nth=0"); await p.waitForTimeout(500); } },
];

const browser = await chromium.launch();
for (const shot of SHOTS) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    colorScheme: THEME, baseURL: "http://localhost:4173",
  });
  const page = await context.newPage();
  const t0 = Date.now();
  await page.goto("/");
  await page.waitForSelector(".tabbar", { timeout: 20000 });
  const boot = Date.now() - t0;
  await page.waitForTimeout(600);
  try { await shot.steps(page); await page.waitForTimeout(400); }
  catch (e) { console.log(`  ! ${shot.name}: ${e.message.split("\n")[0]}`); }
  const h = await page.evaluate(() => document.body.scrollHeight);
  await page.screenshot({ path: `${OUT}/${shot.name}.png`, fullPage: true });
  console.log(`  ${OUT}/${shot.name}.png   boot ${boot}ms  height ${h}px`);
  await context.close();
}
await browser.close();
