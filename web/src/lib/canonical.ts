/**
 * The app's one real address, and how to tell when you are not on it.
 *
 * Every Cloudflare deploy is also published at a throwaway address of its own
 * (`6f5b0e9d.maki-kiosk.pages.dev`), and the deploy tool prints that one
 * first. It looks like the app because it IS the app -- but a browser keeps
 * data per address, so each throwaway address has its own empty copy of the
 * database. Entries made there are real and saved, and are invisible from
 * the real address. From the counter that is indistinguishable from "nothing
 * I entered was saved", which is exactly how it was reported.
 *
 * A throwaway address also freezes that one build forever: an installed
 * home-screen app pointed at one never updates.
 *
 * So the app says so, loudly, whenever it is running somewhere other than
 * the one address -- and offers a backup of what is there, because what was
 * typed in there is the operator's record and must not be stranded.
 */

export const CANONICAL_HOST = "maki-kiosk.pages.dev";
export const CANONICAL_URL = `https://${CANONICAL_HOST}/`;

/**
 * True on a per-deploy address (`<hash>.maki-kiosk.pages.dev`). False on the
 * real address, and false anywhere else -- localhost and the preview server
 * are development, not a stranded copy.
 */
export function isThrowawayCopy(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host !== CANONICAL_HOST && host.endsWith(`.${CANONICAL_HOST}`);
}
