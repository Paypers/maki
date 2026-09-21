/* Minimal offline shell.
 *
 * Cache-first for the built assets so the app opens with no network at all --
 * which at a kiosk on store wifi is the normal case, not the exception. Data
 * never touches this cache: it lives in IndexedDB and syncs separately, so a
 * stale cache can never serve stale numbers.
 */
const CACHE = "kiosk-v2";
const SHELL = ["/", "/index.html", "/manifest.webmanifest",
               "/fonts/space-grotesk-latin.woff2", "/fonts/manrope-latin.woff2"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  // Navigations: network first so a deploy is picked up, cache as the fallback
  // so a dead connection still opens the app.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/index.html", copy));
          return res;
        })
        .catch(() => caches.match("/index.html").then((r) => r || Response.error())),
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
