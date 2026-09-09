import { config } from "./config.ts";
import { hasToken } from "./gmail.ts";
import { isSyncing, runSync } from "./sync.ts";

/**
 * Keeps the tracker current without a person remembering to click "Sync" —
 * the point once this runs unattended after deployment rather than on a
 * laptop someone opens by hand.
 */
export function startPeriodicSync(): void {
  const minutes = config.syncIntervalMinutes;
  if (minutes <= 0) return;

  const tick = async () => {
    if (isSyncing() || !hasToken()) return;
    const result = await runSync();
    if (result.phase === "error") {
      console.error(`  ! periodic sync failed: ${result.message}`);
    } else {
      console.log(`  Periodic sync done — ${result.matched} update(s) from ${result.classified} email(s) reviewed`);
    }
  };

  setInterval(() => void tick(), minutes * 60_000);
  console.log(`  Auto-sync every ${minutes} minute(s)`);
}
