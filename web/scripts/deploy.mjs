/**
 * Deploy the built app and report ONE address: https://maki-kiosk.pages.dev
 *
 * `wrangler pages deploy` ends by printing a throwaway per-deploy address
 * (`https://6f5b0e9d.maki-kiosk.pages.dev`). It works, so it gets opened and
 * bookmarked -- and a browser keeps data per address, so every one of those is
 * a separate, empty copy of the app. Entries made there are saved there and
 * nowhere else, which from the counter looks exactly like "nothing I entered
 * was saved". It also pins that one build forever.
 *
 * So this script never shows that address. It deploys to the production
 * branch, then waits until the FIXED address is actually serving this build
 * (by the build stamp in sw.js) before saying so. "Deployed" here means "live
 * at the address you use", not "uploaded somewhere".
 *
 *   npm run deploy        (builds first)
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const PROJECT = "maki-kiosk";
const BRANCH = "main";                           // the project's production branch
const ADDRESS = "https://maki-kiosk.pages.dev";

const stamp = (text) => text.match(/BUILD\s*=\s*"([^"]+)"/)?.[1] ?? null;

const build = existsSync("dist/sw.js") ? stamp(readFileSync("dist/sw.js", "utf8")) : null;
if (!build || build === "__BUILD__") {
  console.error("deploy: dist/ has no stamped build. Run `npm run deploy`, which builds first.");
  process.exit(1);
}
if (!existsSync("dist/history.json")) {
  console.warn("deploy: dist/history.json is missing -- a fresh install will start with no history.\n"
    + "        Run `python tools/export_web_history.py` from d:\\maki, then deploy again.\n");
}

console.log(`Deploying build ${build}…`);
const r = spawnSync("npx", ["wrangler", "pages", "deploy", "dist",
  `--project-name=${PROJECT}`, `--branch=${BRANCH}`, "--commit-dirty=true"],
  { encoding: "utf8", shell: process.platform === "win32" });

if (r.status !== 0) {
  // On failure show everything: the throwaway address is irrelevant, the error is not.
  process.stdout.write(r.stdout ?? "");
  process.stderr.write(r.stderr ?? "");
  console.error("\ndeploy: upload failed -- nothing changed at " + ADDRESS);
  process.exit(1);
}

// Cloudflare swaps the production alias within seconds, but not instantly.
// Wait for the real address to serve this exact build rather than assuming.
let live = null;
for (let i = 0; i < 45; i++) {
  try {
    const res = await fetch(`${ADDRESS}/sw.js?deploy=${Date.now()}`, { cache: "no-store" });
    live = stamp(await res.text());
    if (live === build) break;
  } catch { /* offline for a moment; keep trying */ }
  await new Promise((ok) => setTimeout(ok, 2000));
}

if (live !== build) {
  console.error(`\ndeploy: uploaded, but ${ADDRESS} is still serving build ${live ?? "(unreachable)"}.`
    + "\n        Give it a minute and check again. Do NOT use any other address.");
  process.exit(1);
}

console.log(`
  Live at  ${ADDRESS}   (build ${build})

  That is the only address. If you ever see another one ending in
  .maki-kiosk.pages.dev, don't use it -- it keeps its own separate data.
  On the phone: close the app fully and reopen it to pick up this build.
`);
