/**
 * A phone that loaded an OLD history file gets the corrected days just by
 * reopening the app.
 *
 * Sep 20 first shipped as a placeholder sheet: a stock "made" column, no
 * leftover count, the day marked uncounted. Ids are deterministic, so the old
 * import path skipped the corrected rows forever. This rebuilds that exact
 * state in a real browser -- placeholder production under the original seed
 * ids, waste rows gone, the day open, an old history version -- reloads, and
 * requires the real sheet to be what the app now reads.
 *
 *   node histcheck.mjs      (needs `vite preview` on :4173)
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const hist = JSON.parse(readFileSync("public/history.json", "utf8"));
const DAY = "2026-09-20";
const di = hist.dates.indexOf(DAY);
const want = new Map(hist.rows.filter((r) => r[0] === di).map((r) => [r[1], { made: r[2], waste: r[4] }]));
const madeWant = [...want.values()].reduce((s, r) => s + (r.made ?? 0), 0);
const wasteWant = [...want.values()].reduce((s, r) => s + (r.waste ?? 0), 0);

const b = await chromium.launch();
const p = await (await b.newContext({ baseURL: "http://localhost:4173" })).newPage();
let bad = 0;
const need = (ok, m) => { console.log(`  ${ok ? "ok  " : "FAIL"} ${m}`); if (!ok) bad++; };

await p.goto("/"); await p.waitForSelector(".tabbar"); await p.waitForTimeout(1500);

// Rewind Sep 20 to the placeholder state an old install is in.
await p.evaluate(({ day }) => new Promise((res) => {
  const q = indexedDB.open("maki-kiosk");
  q.onsuccess = () => {
    const t = q.result.transaction(["entries", "days", "meta", "items"], "readwrite");
    const es = t.objectStore("entries");
    es.index("byDate").getAll(day).onsuccess = (ev) => {
      for (const e of ev.target.result) {
        if (e.entryType === "waste") es.delete(e.mutationId);
        // The old placeholder: 2 of the rolls, 1 of everything else.
        else es.put({ ...e, quantity: e.quantity >= 4 ? 2 : 1 });
      }
    };
    // The placeholder also had poke made; the real Sep 20 sheet has none.
    t.objectStore("items").getAll().onsuccess = (ev) => {
      const poke = ev.target.result.find((i) => i.itemKey === "poke");
      es.put({ businessDate: day, itemId: poke.itemId, entryType: "made", quantity: 2,
               mutationId: `seed:${day}:${poke.itemId}:made`, recordedAt: `${day}T10:00:00.000Z` });
    };
    t.objectStore("days").put({ businessDate: day, isOutage: false,
      productionConfirmedAt: `${day}T10:00:00.000Z`, wasteConfirmedAt: null });
    t.objectStore("meta").put({ key: "history-version", value: "2026-09-22T06:13:00Z" });
    t.oncomplete = () => res(true);
  };
}), { day: DAY });

const state = () => p.evaluate(({ day }) => new Promise((res) => {
  const q = indexedDB.open("maki-kiosk");
  q.onsuccess = () => {
    const t = q.result.transaction(["entries", "days"]);
    t.objectStore("entries").index("byDate").getAll(day).onsuccess = (ev) => {
      const latest = new Map();
      for (const e of ev.target.result) {
        const k = `${e.itemId}|${e.entryType}`;
        const prev = latest.get(k);
        if (!prev || e.recordedAt >= prev.recordedAt) latest.set(k, e);
      }
      let made = 0, waste = 0; const byItem = {};
      for (const e of latest.values()) {
        if (e.entryType === "made") { made += e.quantity; (byItem[e.itemId] ??= {}).made = e.quantity; }
        if (e.entryType === "waste") { waste += e.quantity; (byItem[e.itemId] ??= {}).waste = e.quantity; }
      }
      t.objectStore("days").get(day).onsuccess = (d) =>
        res({ made, waste, counted: !!d.target.result?.wasteConfirmedAt, byItem });
    };
  };
}), { day: DAY });

const before = await state();
console.log(`  placeholder state: made ${before.made}, left ${before.waste}, counted ${before.counted}`);

await p.reload(); await p.waitForSelector(".tabbar"); await p.waitForTimeout(2500);
const after = await state();
console.log(`  after reopening  : made ${after.made}, left ${after.waste}, counted ${after.counted}`);

need(after.made === madeWant, `made matches the filled-in sheet (${after.made} = ${madeWant})`);
need(after.waste === wasteWant, `leftovers match the filled-in sheet (${after.waste} = ${wasteWant})`);
need(after.counted, "the day is no longer owed");
const wrong = [...want].filter(([id, r]) => (after.byItem[id]?.made ?? 0) !== (r.made ?? 0));
need(wrong.length === 0, `every item's made figure is the sheet's (${wrong.length} wrong)`);
const owedRows = await p.locator(".waiting-row").allInnerTexts();
need(!owedRows.some((t) => t.includes("Sep 20")), "Sep 20 is gone from the owed list");

await b.close();
console.log(bad ? `\n  ${bad} check(s) failed` : "\n  all checks passed");
process.exit(bad ? 1 : 0);
