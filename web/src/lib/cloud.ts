/**
 * Optional cloud sync.
 *
 * The app is fully usable with none of this configured -- IndexedDB is the
 * source of truth on the device and always will be. Supabase is a backup and a
 * second screen, not a dependency. If it is unreachable the app does not notice.
 *
 * No SDK. Supabase's REST and auth endpoints are plain HTTPS, and `fetch` is
 * already in the browser; pulling in a client library to POST JSON would add
 * ~40kB to a bundle that has to load on store wifi.
 *
 * Conflict resolution is free, and that is not an accident. The log is
 * append-only and every row carries the UUID the device minted, so:
 *   - pushing the same mutation twice collides on the primary key -> no-op
 *   - pulling a row you already have is matched by mutationId -> ignored
 *   - two devices editing the same day both append; latest recordedAt wins
 * There is no merge algorithm because there is nothing to merge.
 */

import * as store from "./store";
import type { Entry } from "./types";

export interface CloudConfig {
  url: string;
  anonKey: string;
}

const CONFIG_KEY = "cloud-config";
const SESSION_KEY = "cloud-session";
const CURSOR_KEY = "cloud-cursor";

export interface Session {
  accessToken: string;
  refreshToken: string;
  email: string;
  expiresAt: number;
}

// Build-time defaults, so a deploy can ship configured. Both are public by
// design: the anon key grants nothing without a session, and RLS is what
// actually protects the rows.
const DEFAULT_CONFIG: CloudConfig | null =
  import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY
    ? { url: import.meta.env.VITE_SUPABASE_URL as string,
        anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY as string }
    : null;

function readLocal<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode, quota -- sync degrades, the app does not */
  }
}

export const getConfig = (): CloudConfig | null =>
  readLocal<CloudConfig>(CONFIG_KEY) ?? DEFAULT_CONFIG;
export const setConfig = (c: CloudConfig | null) =>
  c ? writeLocal(CONFIG_KEY, c) : localStorage.removeItem(CONFIG_KEY);
export const getSession = (): Session | null => readLocal<Session>(SESSION_KEY);
export const isConfigured = () => !!getConfig();
export const isSignedIn = () => !!getSession();

/**
 * One answer to "is this backed up?", used everywhere it is asked -- the
 * header chip, the Today tile, the Setup row. They used to answer separately
 * and disagreed: the tile said "up to date" while sync was signed out. After
 * a morning's entries went missing, the app does not get to imply a cloud
 * copy that is not being made.
 */
export function syncStatus(pending: number): { label: string; live: boolean } {
  if (!isConfigured()) return { label: "cloud not set up", live: false };
  if (!isSignedIn()) return { label: "cloud signed out", live: false };
  return pending ? { label: `${pending} to sync`, live: true } : { label: "backed up", live: true };
}

export function signOut(): void {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(CURSOR_KEY);
}

// ------------------------------------------------------------------ auth ---

/**
 * Send a magic link. No password to forget at 5am, and none to leak.
 *
 * `redirect_to` is a QUERY PARAMETER on this endpoint, not a body field. The
 * `options: { email_redirect_to }` shape is supabase-js sugar that the client
 * library turns into this query param -- sent in the body to the REST endpoint
 * it is silently ignored, and the link in the email then lands on the
 * project's default Site URL instead of the app.
 */
export async function requestMagicLink(email: string): Promise<void> {
  const cfg = getConfig();
  if (!cfg) throw new Error("Cloud sync is not configured.");
  const redirect = encodeURIComponent(location.origin + location.pathname);
  const res = await fetch(`${cfg.url}/auth/v1/otp?redirect_to=${redirect}`, {
    method: "POST",
    headers: { apikey: cfg.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, create_user: true }),
  });
  if (!res.ok) throw new Error(await friendlyError(res));
}

/**
 * Finish sign-in from the link. Supabase returns tokens in the URL fragment,
 * which is stripped immediately so the access token never lands in history or
 * in a screenshot of the address bar.
 */
export function completeSignInFromUrl(): Session | null {
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  if (!hash.includes("access_token")) return null;
  const params = new URLSearchParams(hash);
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (!accessToken || !refreshToken) return null;

  const expiresIn = Number(params.get("expires_in") ?? 3600);
  let email = "";
  try {
    email = JSON.parse(atob(accessToken.split(".")[1])).email ?? "";
  } catch { /* a malformed token still signs in; the server decides */ }

  const session: Session = {
    accessToken, refreshToken, email,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  writeLocal(SESSION_KEY, session);
  history.replaceState(null, "", location.pathname + location.search);
  return session;
}

async function refresh(): Promise<Session | null> {
  const cfg = getConfig();
  const session = getSession();
  if (!cfg || !session) return null;
  const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: cfg.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: session.refreshToken }),
  });
  if (!res.ok) {
    // The refresh token is dead. Drop the session so the UI prompts a fresh
    // sign-in rather than retrying forever against a 401.
    signOut();
    return null;
  }
  const data = await res.json();
  const next: Session = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    email: session.email,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  writeLocal(SESSION_KEY, next);
  return next;
}

async function authorised(): Promise<{ cfg: CloudConfig; token: string } | null> {
  const cfg = getConfig();
  let session = getSession();
  if (!cfg || !session) return null;
  // Refresh a minute early rather than discovering expiry mid-push.
  if (session.expiresAt - Date.now() < 60_000) session = await refresh();
  return session ? { cfg, token: session.accessToken } : null;
}

// ------------------------------------------------------------------ sync ---

async function friendlyError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body.msg || body.message || body.error_description || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/**
 * Push queued mutations. Wired into the store as its `Pusher`, so nothing else
 * in the app knows the network exists.
 *
 * `Prefer: resolution=ignore-duplicates` is what makes a replay safe: a batch
 * delivered twice inserts nothing the second time.
 */
export async function push(batch: Array<{ mutationId: string; kind: string;
                                          payload: unknown; createdAt: string }>) {
  const auth = await authorised();
  if (!auth) throw new Error("not signed in");
  const rows = batch.map((m) => ({
    mutation_id: m.mutationId,
    kind: m.kind,
    payload: m.payload,
    client_time: m.createdAt,
  }));
  const res = await fetch(`${auth.cfg.url}/rest/v1/app_mutations`, {
    method: "POST",
    headers: {
      apikey: auth.cfg.anonKey,
      Authorization: `Bearer ${auth.token}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(await friendlyError(res));
}

/**
 * Pull anything this device has not seen and fold it in.
 *
 * Entries are matched on mutationId, so a row that originated here is ignored
 * rather than duplicated -- which is what makes a second device safe to add.
 */
export async function pull(): Promise<{ applied: number }> {
  const auth = await authorised();
  if (!auth) return { applied: 0 };
  const cursor = readLocal<string>(CURSOR_KEY) ?? "1970-01-01T00:00:00Z";

  const res = await fetch(`${auth.cfg.url}/rest/v1/rpc/pull_since`, {
    method: "POST",
    headers: {
      apikey: auth.cfg.anonKey,
      Authorization: `Bearer ${auth.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ cursor_ts: cursor }),
  });
  if (!res.ok) throw new Error(await friendlyError(res));

  const rows: Array<{ mutation_id: string; kind: string; payload: unknown;
                      received_at: string }> = await res.json();
  if (!rows.length) return { applied: 0 };

  const known = new Set((await store.getAllEntries()).map((e) => e.mutationId));
  let applied = 0;
  for (const row of rows) {
    try {
      applied += await apply(row.kind, row.payload, known);
    } catch {
      // One malformed row must not stop the rest of the batch, and must not
      // stop the cursor advancing past it -- otherwise it blocks sync forever.
    }
  }
  writeLocal(CURSOR_KEY, rows[rows.length - 1].received_at);
  return { applied };
}

async function apply(kind: string, payload: unknown,
                     known: Set<string>): Promise<number> {
  switch (kind) {
    case "entries": {
      const entries = (payload as Entry[]).filter((e) => !known.has(e.mutationId));
      for (const e of entries) {
        await store.putEntry(e);
        known.add(e.mutationId);
      }
      return entries.length;
    }
    case "confirm": {
      const { date, what } = payload as { date: string; what: "production" | "waste" };
      await store.confirmDay(date, what, { queue: false });
      return 1;
    }
    case "template":
      await store.saveTemplate(payload as never, { queue: false });
      return 1;
    // The menu, the recipes and the shared settings. Last write wins, which is
    // right for these: unlike the entry log they are current state, not a
    // history, and there is one person editing them.
    case "item":
      await store.saveItem(payload as never, { queue: false });
      return 1;
    case "ingredient":
      await store.saveIngredient(payload as never, { queue: false });
      return 1;
    case "recipe":
      await store.saveRecipe(payload as never, { queue: false });
      return 1;
    case "settings": {
      // `theme` stays whatever this device has -- it is never sent, and must
      // not be clobbered by a pull from a device that prefers the other one.
      const current = await store.getSettings();
      await store.saveSettings(
        { ...current, ...(payload as object), theme: current.theme } as never,
        { queue: false });
      return 1;
    }
    default:
      return 0;
  }
}

/** Connect sync to the store. Safe to call when nothing is configured. */
export function install(): void {
  if (!isConfigured()) return;
  store.configureSync(async (batch) => { await push(batch as never); });
}
