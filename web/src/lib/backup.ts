/**
 * Save everything on this device to a file. Shared by Setup and by the
 * wrong-address banner, which is the one place it has to work first time.
 */

import * as store from "./store";

export async function downloadBackup(): Promise<number> {
  const backup = await store.exportAll();
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `kiosk-backup-${location.hostname.split(".")[0]}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  return backup.entries.length;
}
