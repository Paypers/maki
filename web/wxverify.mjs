/**
 * A fresh install, end to end, against the real history file and the real API.
 *
 * Checks what the last round changed and what it must not have broken: the
 * hand-transcribed days arrive, the ones that were never counted arrive as
 * OPEN rather than as days that sold out, the weather card fills in, and the
 * weather sync SETTLES.
 *
 * That last one is here because it was invisible any other way. The effect
 * was keyed on an object that `refresh()` rebuilt every time, so the app
 * re-fetched the forecast several times a second while the screen looked
 * perfectly correct. Only a request count catches it.
 *
 *   node wxverify.mjs [zip]      (needs `vite preview` on :4173)
 */
import { chromium } from "playwright";

const ZIP = process.argv[2] ?? "21201";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 },
                                 colorScheme: "dark",
                                 baseURL: "http://localhost:4173" });
const p = await ctx.newPage();
let wxHits = 0;
p.on("request", (r) => { if (/open-meteo\.com/.test(r.url())) wxHits++; });

await p.goto("/");
await p.waitForSelector(".tabbar");
await p.waitForTimeout(2500);

/** Read the imported record straight out of IndexedDB. */
const facts = await p.evaluate(() => new Promise((res) => {
  const q = indexedDB.open("maki-kiosk");
  q.onsuccess = () => {
    const db = q.result;
    const t = db.transaction(["days", "entries"], "readonly");
    const days = t.objectStore("days").getAll();
    const entries = t.objectStore("entries").getAll();
    t.oncomplete = () => {
      const d = days.result, e = entries.result;
      const dates = d.map((x) => x.businessDate).sort();
      res({
        days: d.length,
        first: dates[0], last: dates[dates.length - 1],
        open: d.filter((x) => x.productionConfirmedAt && !x.wasteConfirmedAt && !x.isOutage)
               .map((x) => x.businessDate).sort(),
        entries: e.length,
        // A waste entry on a day that should have none is the failure this
        // whole change exists to prevent.
        wasteByDate: Object.fromEntries(
          ["2026-09-08", "2026-09-20", "2026-09-21", "2026-09-19"].map((dt) => [
            dt, e.filter((x) => x.businessDate === dt && x.entryType === "waste").length,
          ])),
        madeByDate: Object.fromEntries(
          ["2026-09-08", "2026-09-20", "2026-09-21", "2026-09-19"].map((dt) => [
            dt, e.filter((x) => x.businessDate === dt && x.entryType === "made")
                 .reduce((s, x) => s + x.quantity, 0),
          ])),
      });
    };
  };
}));

console.log(`history: ${facts.days} days, ${facts.first} .. ${facts.last}, ${facts.entries} entries`);
console.log("open (traded, never counted):", facts.open.join(", ") || "none");
console.log("waste entries:", JSON.stringify(facts.wasteByDate));
console.log("made totals:  ", JSON.stringify(facts.madeByDate));

const want = ["2026-09-08", "2026-09-20", "2026-09-21"];
const okOpen = JSON.stringify(facts.open) === JSON.stringify(want);
const okNoWaste = want.every((d) => facts.wasteByDate[d] === 0);
const okCounted = facts.wasteByDate["2026-09-19"] > 0;
console.log(`\n  open days correct:      ${okOpen ? "yes" : "NO -> " + facts.open}`);
console.log(`  no waste on those:      ${okNoWaste ? "yes" : "NO"}`);
console.log(`  9/19 still counted:     ${okCounted ? "yes" : "NO"}`);

console.log("\n-- home screen --");
console.log((await p.locator(".waiting").innerText()).replace(/\s+/g, " "));

// Weather still works on top of the longer record.
await p.locator(".wx-setup").first().click();
await p.waitForSelector("input[inputmode=numeric]");
await p.fill("input[inputmode=numeric]", ZIP);
await p.locator("button.primary").first().click();
await p.waitForTimeout(7000);
await p.locator("header.bar button.ghost").first().click();
await p.waitForSelector(".wx-today");
await p.waitForTimeout(800);
console.log("\n-- weather card --");
console.log((await p.locator(".wx-today").innerText()).replace(/\s+/g, " "));

// The sync must go quiet. Anything above a stray retry here is the loop back.
const IDLE_LIMIT = 2;
const before = wxHits;
console.log("\nidling for 30s to check the weather sync settles…");
await p.waitForTimeout(30000);
const idle = wxHits - before;
const okIdle = idle <= IDLE_LIMIT;
console.log(`  weather requests while idle: ${idle} -> ${okIdle ? "SETTLED" : "LOOPING"}`);

const pass = okOpen && okNoWaste && okCounted && okIdle;
console.log(`\n${pass ? "PASS" : "FAIL"}`);
await b.close();
process.exit(pass ? 0 : 1);
