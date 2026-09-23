/**
 * The home card and the production sheet must quote the SAME percentage.
 *
 * They are computed on different screens from different baselines -- a
 * weekday mean on one, a weekday quantile on the other -- and the weather
 * estimate is measured against dry days rather than against either of them.
 * Before re-centring they disagreed, and nothing on either screen would have
 * looked wrong. This checks they agree, live, against the real API.
 *
 *   node wxagree.mjs [zip]        (needs `vite preview` on :4173)
 */
import { chromium } from "playwright";

const ZIP = process.argv[2] ?? "21201";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 },
                                 colorScheme: "dark",
                                 baseURL: "http://localhost:4173" });
const p = await ctx.newPage();
await p.goto("/");
await p.waitForSelector(".tabbar");
await p.waitForTimeout(1500);

await p.locator(".wx-setup").first().click();
await p.waitForSelector("input[inputmode=numeric]");
await p.fill("input[inputmode=numeric]", ZIP);
await p.locator("button.primary").first().click();
await p.waitForTimeout(6000);
await p.locator("header.bar button.ghost").first().click();
await p.waitForSelector(".wx-today");
await p.waitForTimeout(1000);

const home = (await p.locator(".wx-today").innerText()).replace(/\s+/g, " ");
const homePct = home.match(/([▲▼])\s*([\d.]+)%/);
console.log("HOME      :", home.slice(0, 180));

// Into TODAY'S production sheet specifically. The first waiting row is the
// OLDEST outstanding job, which since the September import is a leftover
// count from two weeks ago -- a different screen with no advisory on it.
await p.locator('.waiting-row:has-text("Enter what you made"):has-text("today")').first().click();
await p.waitForSelector(".cols");
await p.waitForTimeout(600);
const advisory = p.locator(".wx-advice");
if (!(await advisory.count())) {
  console.log("SHEET     : no advisory (dry day, or nothing measured)");
} else {
  const sheet = (await advisory.innerText()).replace(/\s+/g, " ");
  console.log("SHEET     :", sheet);
  const sheetPct = sheet.match(/Apply\s*([+-]?[\d.]+)%/);
  console.log("\nhome says :", homePct ? `${homePct[1]}${homePct[2]}%` : "(none)");
  console.log("sheet says:", sheetPct ? `${sheetPct[1]}%` : "(no apply button)");
  if (homePct && sheetPct) {
    const a = Number(homePct[2]) * (homePct[1] === "▼" ? -1 : 1);
    const c = Number(sheetPct[1]);
    console.log(Math.abs(a - c) < 0.05 ? "  >> AGREE" : "  >> DISAGREE");
  }

  // And applying it must actually move the total, not just say it did. Only
  // on a day that offers it: a dry day's advisory has nothing to apply, and
  // waiting for a button that is correctly absent is not a finding.
  if (await advisory.locator("button").count()) {
    const before = await p.locator(".footer .tally .value").innerText();
    await advisory.locator("button").click();
    await p.waitForTimeout(400);
    const label = await p.locator(".footer .tally .label").innerText();
    console.log(`\nfooter before apply: ${before} · after: ${label}`);
  } else {
    console.log("\n(nothing to apply today -- dry day)");
  }
  await p.screenshot({ path: "wxagree.png", fullPage: false });
}
await b.close();
