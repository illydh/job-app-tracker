import { config } from "./config.ts";
import * as store from "./db.ts";
import { authorizedClient, effectiveSyncSince, fetchMessages, isAuthError, listMessageIds, noteAuthError } from "./gmail.ts";
import { classify, health } from "./ollama.ts";
import { prefilter } from "./prefilter.ts";

export type SyncPhase = "idle" | "fetching" | "classifying" | "done" | "error";

export interface SyncProgress {
  phase: SyncPhase;
  startedAt: number | null;
  finishedAt: number | null;
  /** Messages downloaded from Gmail this run. */
  fetched: number;
  /** Messages rejected by the cheap keyword gate (never sent to the model). */
  prefiltered: number;
  /** Messages the model looked at. */
  classified: number;
  /** Classifications that produced or updated an application. */
  matched: number;
  total: number;
  errors: string[];
  message: string;
}

/** A factory, not a constant: spreading a shared object would alias `errors`
 *  across runs and let it accumulate forever. */
function blank(): SyncProgress {
  return {
    phase: "idle",
    startedAt: null,
    finishedAt: null,
    fetched: 0,
    prefiltered: 0,
    classified: 0,
    matched: 0,
    total: 0,
    errors: [],
    message: "Idle",
  };
}

let progress: SyncProgress = blank();
let running = false;

export function syncProgress(): SyncProgress {
  return progress;
}

export function isSyncing(): boolean {
  return running;
}

/**
 * Full pipeline: Gmail -> SQLite -> keyword gate -> local model -> applications.
 *
 * Runs at most once at a time. Progress is exposed via `syncProgress()` so the
 * UI can poll; classification is slow enough (seconds per email) that the HTTP
 * request that starts a sync returns immediately instead of waiting.
 */
export async function runSync(): Promise<SyncProgress> {
  if (running) return progress;
  running = true;
  progress = { ...blank(), phase: "fetching", startedAt: Date.now(), message: "Starting sync…" };

  try {
    const client = authorizedClient();
    if (!client) throw new Error("Not connected to Gmail. Visit /api/auth/start to authorise.");

    const ollama = await health();
    if (!ollama.reachable) {
      throw new Error(`Cannot reach Ollama at ${config.ollama.host}. Is \`ollama serve\` running?`);
    }
    if (!ollama.modelAvailable) {
      throw new Error(`Model "${ollama.model}" is not pulled. Run: ollama pull ${ollama.model}`);
    }

    /* ------------------------------------------------- fetch new messages --- */
    const lastSyncAt = store.getMeta("last_sync_at");
    const since = effectiveSyncSince(lastSyncAt ? Number(lastSyncAt) : null);
    progress.message = `Listing messages since ${since}…`;
    const ids = await listMessageIds(client, config.maxMessagesPerSync, since);
    const known = store.knownMessageIds(ids);
    const fresh = ids.filter((id) => !known.has(id));

    progress.message = `${fresh.length} new message(s) to download`;
    if (fresh.length > 0) {
      const messages = await fetchMessages(client, fresh);
      progress.fetched = store.saveMessages(messages);
    }

    /* ------------------------------------------------- classify what's new --- */
    progress.phase = "classifying";
    const pending = store.pendingMessages(config.maxMessagesPerSync);
    progress.total = pending.length;

    for (const [index, msg] of pending.entries()) {
      progress.message = `Reviewing ${index + 1}/${pending.length}: ${msg.subject.slice(0, 70) || "(no subject)"}`;

      const gate = prefilter(msg);
      if (!gate.keep) {
        store.markMessage(msg.id, "prefiltered", false);
        progress.prefiltered++;
        continue;
      }

      try {
        const result = await classify(msg);
        progress.classified++;

        if (result.is_job_application && result.status && result.company && result.confidence >= config.minConfidence) {
          store.upsertApplicationEvent({
            company: result.company,
            role: result.role,
            status: result.status,
            confidence: result.confidence,
            summary: result.summary,
            messageId: msg.id,
            occurredAt: msg.internalDate,
          });
          progress.matched++;
          store.markMessage(msg.id, "classified", true);
        } else {
          store.markMessage(msg.id, "classified", false);
        }
      } catch (err) {
        // Leave the message pending so the next sync retries it.
        const detail = `${msg.subject.slice(0, 50)}: ${(err as Error).message}`;
        progress.errors.push(detail);
        console.error("  ! classification failed —", detail);
      }
    }

    store.setMeta("last_sync_at", String(Date.now()));
    progress.phase = "done";
    progress.finishedAt = Date.now();
    progress.message = `Done — ${progress.matched} application update(s) from ${progress.classified} email(s) reviewed`;
  } catch (err) {
    // A dead refresh token is a setup problem, not a transient fault: record it
    // so /api/health can tell the UI to prompt for reconnection.
    if (isAuthError(err)) noteAuthError();
    progress.phase = "error";
    progress.finishedAt = Date.now();
    progress.message = isAuthError(err)
      ? "Gmail authorisation has expired. Reconnect Gmail in Setup, or run `npm run auth`."
      : (err as Error).message;
    progress.errors.push(progress.message);
  } finally {
    running = false;
  }

  return progress;
}
