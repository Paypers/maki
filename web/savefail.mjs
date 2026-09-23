/**
 * A save that fails must SAY so, and the screen must survive it.
 *
 * This is the bug this harness exists for: the confirm button set "Saving…"
 * and awaited the write with no catch, so any rejection left it disabled with
 * that label forever. The morning's count was still on screen and still
 * unsaved, and nothing anywhere said either thing.
 *
 * So: break IndexedDB writes, count a day, confirm, and require that the app
 * (a) says nothing was saved, (b) gives the button back, (c) keeps the typed
 * numbers, and (d) actually saves once writes work again.
 *
 *   node savefail.mjs      (needs `vite preview` on :4173)
 */
import { chromium } from "playwright";

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark",
                                 baseURL: "http://localhost:4173" });
const p = await ctx.newPage();
const log = (m) => console.log("  " + m);
let bad = 0;
const need = (ok, m) => { log(`${ok ? "ok  " : "FAIL"} ${m}`); if (!ok) bad++; };

await p.goto("/"); await p.waitForSelector(".tabbar"); await p.waitForTimeout(700);

// Yesterday: production recorded, waste not yet counted -- the state the
// morning actually starts in.
await p.evaluate(() => new Promise((res) => {
  const q = indexedDB.open("maki-kiosk");
  q.onsuccess = () => {
    const db = q.result; const d = new Date(); d.setDate(d.getDate() - 1);
    const iso = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const t = db.transaction(["entries","days","items"], "readwrite");
    const es = t.objectStore("entries");
    es.index("byDate").getAllKeys(iso).onsuccess = (ev) =>
      ev.target.result.forEach((k) => es.delete(k));
    t.objectStore("items").getAll().onsuccess = (e) => {
      e.target.result.filter((i) => i.active).slice(0, 4).forEach((it, i) =>
        es.put({ businessDate: iso, itemId: it.itemId, entryType: "made",
          quantity: 3 + i, mutationId: `sf-${iso}-${it.itemId}`, recordedAt: `${iso}T10:00:00.000Z` }));
      t.objectStore("days").put({ businessDate: iso, isOutage: false,
        productionConfirmedAt: `${iso}T10:05:00.000Z`, wasteConfirmedAt: null });
    };
    t.oncomplete = () => res(true);
  };
}));
await p.reload(); await p.waitForSelector(".tabbar"); await p.waitForTimeout(600);

// Break writes to `entries` only -- a read-only failure would break loading
// too and prove something easier than what we care about.
await p.evaluate(() => {
  const real = IDBDatabase.prototype.transaction;
  window.__breakWrites = true;
  IDBDatabase.prototype.transaction = function (names, mode, ...rest) {
    const t = real.call(this, names, mode, ...rest);
    if (!window.__breakWrites || mode !== "readwrite") return t;
    const touches = [].concat(names).includes("entries");
    if (!touches) return t;
    const store = t.objectStore.bind(t);
    t.objectStore = (n) => {
      const s = store(n);
      const put = s.put.bind(s);
      s.put = (...a) => {
        const req = put(...a);
        // Fail it the way a real device does: an async error on the request.
        setTimeout(() => {
          Object.defineProperty(req, "error", {
            value: { name: "QuotaExceededError", message: "simulated full disk" },
            configurable: true,
          });
          req.onerror?.({ target: req });
        }, 0);
        return req;
      };
      return s;
    };
    return t;
  };
});

await p.locator('.waiting-row:has-text("Count leftovers"):has-text("yesterday")').first()
       .click();
await p.waitForTimeout(500);
log(`screen: ${(await p.locator("header.bar h1").first().innerText()).replace(/\n/g, " · ")}`);

// Answer every row, then confirm.
const confirmBtn = p.locator(".footer button.primary");
// "Rest sold out" and "Confirm" are the same button in two states; tap until
// every row is answered and it becomes the confirm.
while (/rest sold out/i.test(await confirmBtn.innerText())) {
  await confirmBtn.click(); await p.waitForTimeout(250);
}
const typed = await p.locator(".footer .tally .value").first().innerText();
await confirmBtn.click();
await p.waitForTimeout(900);

const banner = p.locator(".footer .banner.save-failed");
need(await banner.count() > 0, "a failed save shows a message");
if (await banner.count()) log(`   message: "${(await banner.innerText()).trim()}"`);
need(/out of storage/i.test(await banner.innerText().catch(() => "")),
     "the message names the actual cause (quota)");
need(!(await confirmBtn.isDisabled()), "the confirm button is usable again");
need(!/saving/i.test(await confirmBtn.innerText()), "the button is not stuck on 'Saving…'");
need(await p.locator("header.bar h1").first().innerText().then((t) => /Count/i.test(t)),
     "it stayed on the screen instead of navigating away");
need((await p.locator(".footer .tally .value").first().innerText()) === typed,
     "the counted rows are still on screen");

// And the real point: once writes work, the same tap saves.
await p.evaluate(() => { window.__breakWrites = false; });
await confirmBtn.click();
await p.waitForTimeout(1200);
need(await p.locator(".footer .banner.save-failed").count() === 0,
     "retrying after the fault clears the message");
const saved = await p.evaluate(() => new Promise((res) => {
  const q = indexedDB.open("maki-kiosk");
  q.onsuccess = () => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    const iso = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    q.result.transaction("entries").objectStore("entries").index("byDate")
      .getAll(iso).onsuccess = (e) =>
        res(e.target.result.filter((r) => r.entryType === "waste").length);
  };
}));
need(saved > 0, `the retry actually wrote the rows (${saved} waste rows)`);

await b.close();
console.log(bad ? `\n  ${bad} check(s) failed` : "\n  all checks passed");
process.exit(bad ? 1 : 0);
