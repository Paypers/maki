/* Offline shell.
 *
 * Cache-first for the built assets so the app opens with no network at all --
 * which at a kiosk on store wifi is the normal case, not the exception. Data
 * never touches this cache: it lives in IndexedDB and syncs separately, so a
 * stale cache can never serve stale numbers.
 *
 * ---------------------------------------------------------------------------
 * THE BUILD STAMP IS LOAD-BEARING. Do not remove it.
 *
 * A browser re-installs a service worker only when this file's BYTES change.
 * This file used to be identical on every deploy, so `updatefound` never
 * fired, the app was never told a new build existed, and an installed PWA --
 * which has no reload button and does not re-navigate when you resume it --
 * would sit on an old build indefinitely. The only way out was typing a
 * different URL, which forces a fresh navigation.
 *
 * `scripts/stamp-sw.mjs` replaces __BUILD__ after every build with a hash of
 * the emitted assets, so this file differs whenever the app differs and is
 * identical whenever it is not.
 * ---------------------------------------------------------------------------
 */
const BUILD = "__BUILD__";
const CACHE = `kiosk-${BUILD}`;
// The looks' faces too, so a theme can be switched to with no signal.
const SHELL = ["/", "/index.html", "/manifest.webmanifest",
               "/fonts/space-grotesk-latin.woff2", "/fonts/manrope-latin.woff2",
               "/fonts/shippori-mincho-500-latin.woff2", "/fonts/shippori-mincho-700-latin.woff2",
               "/fonts/shippori-mincho-800-latin.woff2", "/fonts/zen-kaku-gothic-new-400-latin.woff2",
               "/fonts/zen-kaku-gothic-new-500-latin.woff2", "/fonts/zen-kaku-gothic-new-700-latin.woff2",
               "/fonts/sora-latin.woff2"];

self.addEventListener("install", (event) => {
  // No skipWaiting here. The new worker waits until the page asks for it, so
  // a deploy can never swap the assets under someone half-way through
  // counting a case of leftovers. The app prompts; the operator chooses.
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The page asks to be taken over once the operator has accepted the update.
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  // Navigations: network first so a deploy is picked up, cache as the fallback
  // so a dead connection still opens the app. `no-store` keeps the browser's
  // own HTTP cache out of it -- without that, a shell cached before the
  // headers were right can still be served back and look like a stale deploy.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request, { cache: "no-store" })
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/index.html", copy));
          return res;
        })
        .catch(() => caches.match("/index.html").then((r) => r || Response.error())),
    );
    return;
  }

  // The trading history is NOT a hashed asset: the same URL gets new days and
  // corrected ones on every sheet import, often with no code change and so no
  // new build stamp. Cache-first here served a phone its first copy forever.
  // Network first, cached copy only when offline.
  if (new URL(request.url).pathname === "/history.json") {
    event.respondWith(
      fetch(request, { cache: "no-store" })
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match(request).then((r) => r || Response.error())),
    );
    return;
  }

  // Hashed assets never change under a given URL, so cache-first is safe.
  event.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy));
      }
      return res;
    })),
  );
});
