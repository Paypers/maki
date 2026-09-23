/**
 * Turn a failed write into something the operator can act on.
 *
 * Every save goes to IndexedDB first, and IndexedDB fails for several reasons
 * that are nobody's fault and look identical from the outside: the device is
 * out of space, an old tab is holding a newer database, or the browser
 * suspended the page mid-transaction. The two screens that record the day's
 * numbers used to swallow all of it -- the button read "Saving…" forever, and
 * the count was gone.
 *
 * Whatever the cause, the operator needs three things and only three: that it
 * did NOT save, whether tapping again is worth it, and that what they typed is
 * still on the screen. The wording says all three every time, because a save
 * failing at the kiosk is the one moment there is no slack to go and find out.
 */
export function describeSaveError(err: unknown): string {
  const name = (err as { name?: string } | null | undefined)?.name ?? "";

  // Out of room. Retrying changes nothing until space is freed, so say so
  // rather than inviting a tap that will fail the same way.
  if (name === "QuotaExceededError") {
    return "This device is out of storage, so nothing was saved. Free up some "
      + "space, then tap again — what you typed is still here.";
  }
  // The database on the device is newer than the code in this tab: an app left
  // open across an update. A reload is the whole fix.
  if (name === "VersionError") {
    return "This tab is older than the data on the device, so nothing was "
      + "saved. Close the app completely, open it again, and re-enter the day.";
  }
  // Suspended, backgrounded, or the transaction went away underneath us. This
  // is the common one on a phone and it usually works on the second tap.
  if (name === "AbortError" || name === "InvalidStateError"
      || name === "TransactionInactiveError" || name === "UnknownError") {
    return "The save was interrupted — usually the app being backgrounded "
      + "mid-write. Nothing was saved. Tap again — what you typed is still here.";
  }
  const detail = (err as { message?: string } | null | undefined)?.message?.trim();
  return detail
    ? `Nothing was saved: ${detail}. What you typed is still here, so tap again.`
    : "Nothing was saved. What you typed is still here, so tap again.";
}
