import { config } from "./config.ts";
import type { ApplicationRow, Stage } from "./types.ts";

const DAY_MS = 86_400_000;

/**
 * Ghosting is the absence of email, so no classifier can report it. Derive it
 * at read time instead: an application still in an open stage with no activity
 * for `ghostAfterDays` is shown as ghosted. A manual status is always respected.
 */
export function deriveStage(app: ApplicationRow, now = Date.now()): Stage {
  const OPEN: string[] = ["applied", "assessment", "interview"];
  if (app.status_source === "manual") return app.status;
  if (!OPEN.includes(app.status)) return app.status;
  const silentDays = (now - app.last_event_at) / DAY_MS;
  return silentDays >= config.ghostAfterDays ? "ghosted" : app.status;
}

export function daysSince(ts: number, now = Date.now()): number {
  return Math.floor((now - ts) / DAY_MS);
}
