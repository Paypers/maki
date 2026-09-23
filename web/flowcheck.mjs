/**
 * Walk the morning loop for real against the production build:
 * count leftovers -> "rest sold out" -> confirm -> review -> production -> confirm.
 *
 * Screenshots show what a screen looks like; this shows the loop still
 * closes, and that the rows written are the rows attested -- the zeros from
 * "rest sold out" must land as real waste entries, not be silently skipped.
 *
 *   npm run flow      (needs `vite preview` on :4173)
 */
import { chromium } from "playwright";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark",
                                 baseURL: "http://localhost:4173" });
const p = await ctx.newPage();
const log = (m) => console.log("  " + m);
await p.goto("/"); await p.waitForSelector(".tabbar"); await p.waitForTimeout(700);
// seed yesterday's production, unconfirmed waste (same as the harness)
await p.evaluate(() => new Promise((res) => {
  const q = indexedDB.open("maki-kiosk");
  q.onsuccess = () => {
    const db = q.result; const d = new Date(); d.setDate(d.getDate() - 1);
    const iso = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const t = db.transaction(["entries","days","items"], "readwrite");
    // Clear whatever the seeded history already holds for this date. The
    // opening history now reaches to yesterday, so without this the day has
    // thirty-odd real items on it and the row-by-row expectations below are
    // about a different day than the one they were written for.
    const es = t.objectStore("entries");
    es.index("byDate").getAllKeys(iso).onsuccess = (ev) =>
      ev.target.result.forEach((k) => es.delete(k));
    t.objectStore("items").getAll().onsuccess = (e) => {
      e.target.result.filter((i) => i.active).slice(0, 6).forEach((it, i) =>
        es.put({ businessDate: iso, itemId: it.itemId, entryType: "made",
          quantity: 2 + i, mutationId: `flow-${iso}-${it.itemId}`, recordedAt: `${iso}T10:00:00.000Z` }));
      t.objectStore("days").put({ businessDate: iso, isOutage: false,
        productionConfirmedAt: `${iso}T10:05:00.000Z`, wasteConfirmedAt: null });
    };
    t.oncomplete = () => res(true);
  };
}));
await p.reload(); await p.waitForSelector(".tabbar"); await p.waitForTimeout(600);

// The home screen leads with the standing "waiting on you" list. Older
// uncounted days from the opening history can sit above yesterday's, so the
// row is picked by name rather than by position.
const rows = await p.$$(".waiting-row");
log("waiting rows: " + rows.length);
for (const r of rows) log("  - " + (await r.textContent()).replace(/\s+/g, " "));
const target = p.locator('.waiting-row:has-text("Count leftovers"):has-text("yesterday")').first();
log("opening: " + (await target.textContent()).replace(/\s+/g, " "));
await target.click(); await p.waitForTimeout(400);
log("screen: " + await p.textContent("header.bar h1"));
log("footer: " + await p.textContent(".footer button.primary") + "  disabled=" + await p.isDisabled(".footer button.primary"));

// touch two rows: +1 on the first, +2 on the second
const plus = await p.$$(".stepper .step:last-child");
await plus[0].click(); await plus[1].click(); await plus[1].click();
log("after 2 touched -> tally: " + (await p.textContent(".footer .tally .value")).replace(/\s+/g," ")
    + " · button: " + await p.textContent(".footer button.primary"));

await p.click(".footer button.primary");   // Rest sold out (4)
await p.waitForTimeout(200);
log("after rest-sold-out -> tally: " + (await p.textContent(".footer .tally .value")).replace(/\s+/g," ")
    + " · button: " + await p.textContent(".footer button.primary"));

await p.click(".footer button.primary");   // Confirm 3 left over
await p.waitForTimeout(500);
log("screen: " + (await p.textContent("header.bar h1")).replace(/\s+/g," "));
await p.click("button:has-text('Continue to today')"); await p.waitForTimeout(500);
log("screen: " + (await p.textContent("header.bar h1")).replace(/\s+/g," "));
log("sparklines drawn: " + (await p.$$(".spark polyline")).length);
log("footer: " + await p.textContent(".footer button.primary"));
await p.click(".footer button.primary"); await p.waitForTimeout(600);
log("screen: " + (await p.textContent("header.bar h1")).replace(/\s+/g," "));
// Not "All caught up": the opening history carries its own uncounted days,
// and they are still owed. What matters is that YESTERDAY has left the list.
const left = await p.$$(".waiting-row");
const names = await Promise.all(left.map((r) => r.textContent()));
log("home state: " + (await p.textContent(".waiting .eyebrow")).trim()
    + " · rows " + left.length);
log("yesterday still outstanding: "
    + names.some((n) => n.includes("Count leftovers") && n.includes("yesterday")));

// the saved waste rows must be exactly the attested values, incl. zeros
const saved = await p.evaluate(() => new Promise((res) => {
  const q = indexedDB.open("maki-kiosk");
  q.onsuccess = () => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    const iso = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    q.result.transaction("entries").objectStore("entries").index("byDate").getAll(iso).onsuccess = (e) =>
      res(e.target.result.filter((x) => x.entryType === "waste").map((x) => x.quantity).sort());
  };
}));
log("waste rows saved: [" + saved.join(",") + "]  (expect 6 rows: 0,0,0,0,1,2)");
log(saved.join(",") === "0,0,0,0,1,2" ? "  >> the zeros landed" : "  >> MISMATCH");
await b.close();
