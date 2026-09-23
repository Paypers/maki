/**
 * Stamp the build into dist/sw.js.
 *
 * A browser re-installs a service worker only when that file's bytes change.
 * Without this step sw.js is identical on every deploy, so the browser never
 * looks twice, `updatefound` never fires, and an installed PWA -- which has no
 * reload button and does not re-navigate when resumed -- keeps serving an old
 * build until someone types a different URL.
 *
 * The stamp is a hash of the emitted asset FILENAMES, which are themselves
 * content hashes. So sw.js changes exactly when the app changes, and stays
 * byte-identical when it does not -- rebuilding the same source twice does not
 * nag the operator about an update that isn't one.
 *
 *   node scripts/stamp-sw.mjs [distDir]
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dist = process.argv[2] ?? "dist";
const swPath = join(dist, "sw.js");

if (!existsSync(swPath)) {
  console.error(`stamp-sw: ${swPath} not found — did the build run?`);
  process.exit(1);
}

const assetDir = join(dist, "assets");
const names = existsSync(assetDir) ? readdirSync(assetDir).sort() : [];
if (!names.length) {
  console.error("stamp-sw: no assets found to hash; refusing to stamp a build id that means nothing");
  process.exit(1);
}

const build = createHash("sha256").update(names.join("\n")).digest("hex").slice(0, 12);

const sw = readFileSync(swPath, "utf8");
if (!sw.includes("__BUILD__")) {
  console.error("stamp-sw: no __BUILD__ placeholder in sw.js — the update prompt will never fire");
  process.exit(1);
}

writeFileSync(swPath, sw.replace(/__BUILD__/g, build));
console.log(`stamp-sw: ${swPath} -> build ${build} (${names.length} assets)`);
