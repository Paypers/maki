/**
 * Noticing that a new build is available, and never applying it by surprise.
 *
 * Two halves, and both are needed:
 *
 * 1. LOOKING. An installed PWA opens in standalone mode: no address bar, no
 *    reload button, and resuming it does not re-navigate. Left alone it will
 *    sit on the build it was installed with. So the app asks the browser to
 *    re-check the service worker on launch and every time it comes back to
 *    the foreground, which is the closest thing a standalone app has to a
 *    refresh.
 *
 * 2. WAITING. The new worker installs and then stops, deliberately. Swapping
 *    the assets under someone half-way through counting a case of leftovers
 *    would lose everything they had typed but not confirmed -- IndexedDB
 *    survives a reload, a half-filled form does not. So the update waits for
 *    an explicit tap.
 */

type Listener = (ready: boolean) => void;

let waiting: ServiceWorker | null = null;
let listeners: Listener[] = [];
let reloading = false;

function announce() {
  for (const fn of listeners) fn(!!waiting);
}

/** Subscribe to "an update is ready". Returns the unsubscribe. */
export function onUpdateReady(fn: Listener): () => void {
  listeners.push(fn);
  fn(!!waiting);
  return () => { listeners = listeners.filter((l) => l !== fn); };
}

/** Take the update: hand over to the new worker, which triggers one reload. */
export function applyUpdate(): void {
  if (!waiting) return;
  waiting.postMessage("skip-waiting");
}

function track(reg: ServiceWorkerRegistration) {
  // Already sitting there from a previous visit.
  if (reg.waiting && navigator.serviceWorker.controller) {
    waiting = reg.waiting;
    announce();
  }
  reg.addEventListener("updatefound", () => {
    const next = reg.installing;
    if (!next) return;
    next.addEventListener("statechange", () => {
      // `controller` is null on the very first install -- that is not an
      // update, it is the app arriving, and prompting for it would be absurd.
      if (next.state === "installed" && navigator.serviceWorker.controller) {
        waiting = next;
        announce();
      }
    });
  });
}

export function installUpdateWatcher(): void {
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // The new worker has taken over. Exactly one reload, guarded because this
    // event can fire more than once.
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  navigator.serviceWorker.register("/sw.js").then((reg) => {
    track(reg);

    // A standalone PWA has no reload button, so these are the moments that
    // stand in for one: launch, and coming back to the foreground.
    const check = () => { void reg.update().catch(() => {}); };
    check();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") check();
    });
    window.addEventListener("online", check);
    // And a slow heartbeat, for a device left open on the counter all day.
    setInterval(check, 60 * 60 * 1000);
  }).catch(() => {
    /* No service worker is survivable: the app just loses offline start. */
  });
}

/**
 * Ask right now, from the Setup screen. True when a newer build is on its way
 * or already waiting (the update bar then offers it), false when this is the
 * newest, null where there is no service worker to ask (dev, or a browser
 * without one).
 */
export async function checkForUpdate(): Promise<boolean | null> {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return null;
  await reg.update().catch(() => {});
  return !!(waiting || reg.waiting || reg.installing);
}
