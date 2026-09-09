import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import fs from "node:fs";
import { z } from "zod";
import { config } from "../lib/config.ts";
import * as store from "../lib/db.ts";
import {
  authUrl,
  authorizedClient,
  clearAuthError,
  fetchProfile,
  gmailAuthError,
  hasToken,
  isAuthError,
  noteAuthError,
  oauthClient,
  saveToken,
  type GmailProfile,
} from "../lib/gmail.ts";
import { health as ollamaHealth } from "../lib/ollama.ts";
import { findDuplicates } from "../lib/similarity.ts";
import { daysSince, deriveStage } from "../lib/stage.ts";
import { isSyncing, runSync, syncProgress } from "../lib/sync.ts";
import { STATUSES } from "../lib/types.ts";

export const api = Router();

/**
 * Express 4 does not await handlers, so a rejected promise escapes as an
 * unhandled rejection and takes the whole process down — a local daemon dying
 * on one bad request is the worst possible failure mode. Route errors here
 * instead, where the error middleware turns them into a 500.
 */
function asyncRoute(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    void fn(req, res).catch(next);
  };
}

/* --------------------------------------------------------------- profile --- */

const PROFILE_KEY = "gmail_profile";

/**
 * A non-auth reason the mailbox could not be read — most often the Gmail API
 * not being enabled on the Cloud project. Held separately from the auth error
 * because reconnecting does not fix it, and the landing page must say so rather
 * than looping the user through consent.
 */
let profileError: string | null = null;
let profileAttemptedAt = 0;
const PROFILE_RETRY_MS = 30_000;

/** Reduce Google's paragraph-long API errors to one actionable line. */
function describeProfileError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);

  if (/has not been used in project|is disabled/i.test(msg)) {
    const project = /project (\d+)/.exec(msg)?.[1];
    return (
      `The Gmail API is not enabled${project ? ` on Google Cloud project ${project}` : ""}. ` +
      "Enable it at console.cloud.google.com/apis/library/gmail.googleapis.com, " +
      "give it a minute to propagate, then reload."
    );
  }
  if (/insufficient|scope/i.test(msg)) {
    return "The granted permissions do not include Gmail read access. Reconnect and accept the Gmail scope.";
  }
  return msg;
}

function cachedProfile(): GmailProfile | null {
  const raw = store.getMeta(PROFILE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GmailProfile;
  } catch {
    return null;
  }
}

/**
 * Resolve the connected account, fetching and caching it the first time.
 *
 * Doubles as a liveness check: if the refresh token has lapsed, this is where
 * it surfaces — at page load, rather than several minutes into a sync. The
 * recorded auth error also gates the retry, so a dead token is not re-probed on
 * every health poll.
 */
async function resolveProfile(): Promise<GmailProfile | null> {
  const cached = cachedProfile();
  if (cached) return cached;
  if (!hasToken() || gmailAuthError()) return null;

  // The UI polls health; without this a standing config fault would mean a
  // request to Google on every poll.
  if (profileError && Date.now() - profileAttemptedAt < PROFILE_RETRY_MS) return null;

  const client = authorizedClient();
  if (!client) return null;

  profileAttemptedAt = Date.now();
  try {
    const profile = await fetchProfile(client);
    store.setMeta(PROFILE_KEY, JSON.stringify(profile));
    profileError = null;
    return profile;
  } catch (err) {
    if (isAuthError(err)) {
      noteAuthError();
      profileError = null;
    } else {
      profileError = describeProfileError(err);
      console.error("Failed to read Gmail profile:", profileError);
    }
    return null;
  }
}

/* ------------------------------------------------------------ diagnostics --- */

api.get(
  "/health",
  asyncRoute(async (_req, res) => {
    const lastSync = store.getMeta("last_sync_at");
    const profile = await resolveProfile();
    const authProblem = gmailAuthError();
    res.json({
      ok: true,
      gmail: {
        // A working profile is the real proof of connection; a token file alone
        // may be expired or revoked.
        connected: Boolean(profile) && !authProblem,
        needsReauth: Boolean(authProblem),
        authError: authProblem,
        error: profileError,
        profile,
        syncSince: config.syncSince,
      },
      ollama: await ollamaHealth(),
      stats: store.stats(),
      lastSyncAt: lastSync ? Number(lastSync) : null,
      syncing: isSyncing(),
    });
  }),
);

/* ------------------------------------------------------------------ auth --- */

api.get("/auth/start", (_req, res) => {
  try {
    res.redirect(authUrl(oauthClient()));
  } catch (err) {
    res.status(500).send((err as Error).message);
  }
});

api.get(
  "/auth/callback",
  asyncRoute(async (req, res) => {
    const code = typeof req.query.code === "string" ? req.query.code : null;
    if (!code) {
      res
        .status(400)
        .send(page("Authorisation failed", "No code was returned by Google."));
      return;
    }
    try {
      const client = oauthClient();
      const { tokens } = await client.getToken(code);
      saveToken(tokens);
      clearAuthError();

      const authed = authorizedClient();
      if (authed) {
        try {
          store.setMeta(
            PROFILE_KEY,
            JSON.stringify(await fetchProfile(authed)),
          );
        } catch (err) {
          console.error(
            "Connected, but could not read profile:",
            (err as Error).message,
          );
        }
      }
      res.send(
        page(
          "Gmail connected",
          "You can close this tab and return to the tracker.",
        ),
      );
    } catch (err) {
      res
        .status(500)
        .send(page("Authorisation failed", (err as Error).message));
    }
  }),
);

api.post("/auth/disconnect", (_req, res) => {
  if (fs.existsSync(config.tokenPath)) fs.unlinkSync(config.tokenPath);
  store.setMeta(PROFILE_KEY, "");
  clearAuthError();
  profileError = null;
  res.json({ connected: false });
});

/** Minimal standalone HTML for the two OAuth redirect landings. */
function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:15vh auto;max-width:28rem;padding:0 1.5rem;color:#1a1a1a}
h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#555;margin:0}</style>
<h1>${title}</h1><p>${body}</p>`;
}

/* ------------------------------------------------------------------ sync --- */

api.post("/sync", (_req, res) => {
  if (isSyncing()) {
    res
      .status(409)
      .json({ error: "A sync is already running", progress: syncProgress() });
    return;
  }
  if (!hasToken()) {
    res.status(400).json({ error: "Not connected to Gmail" });
    return;
  }
  // Fire and forget: classification takes minutes, the client polls GET /sync.
  void runSync();
  res.status(202).json({ started: true, progress: syncProgress() });
});

api.get("/sync", (_req, res) => {
  res.json({ syncing: isSyncing(), progress: syncProgress() });
});

/* ---------------------------------------------------------- applications --- */

api.get("/applications", (_req, res) => {
  const now = Date.now();
  const apps = store.listApplications().map((app) => {
    const events = store.listEvents(app.id);
    const latest = events[0];
    return {
      id: app.id,
      company: app.company,
      role: app.role,
      status: app.status,
      stage: deriveStage(app, now),
      statusSource: app.status_source,
      confidence: app.confidence,
      firstSeenAt: app.first_seen_at,
      lastEventAt: app.last_event_at,
      daysSinceLastEvent: daysSince(app.last_event_at, now),
      notes: app.notes,
      eventCount: events.length,
      latestSummary: latest?.summary ?? null,
    };
  });
  res.json({ applications: apps, ghostAfterDays: config.ghostAfterDays });
});

api.get("/applications/:id/events", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  res.json({
    events: store.listEvents(id).map((e) => ({
      id: e.id,
      status: e.status,
      confidence: e.confidence,
      summary: e.summary,
      subject: e.subject,
      from: e.from_addr,
      occurredAt: e.occurred_at,
    })),
  });
});

const PatchSchema = z.object({
  status: z.enum(STATUSES).optional(),
  notes: z.string().max(4000).optional(),
});

api.patch("/applications/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = PatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res
      .status(400)
      .json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    return;
  }

  let row;
  if (parsed.data.status) row = store.setStatus(id, parsed.data.status);
  if (parsed.data.notes !== undefined)
    row = store.setNotes(id, parsed.data.notes);
  if (!row) {
    res.status(404).json({ error: "Application not found" });
    return;
  }
  res.json({ application: { ...row, stage: deriveStage(row) } });
});

api.delete("/applications/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  res.json({ deleted: store.deleteApplication(id) });
});

/* ------------------------------------------------------------ duplicates --- */

/** Shared by the three duplicate routes; `null` means a response was sent. */
function applicationId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid id" });
    return null;
  }
  return id;
}

const PairSchema = z.object({ otherId: z.number().int() });

function otherId(req: Request, res: Response): number | null {
  const parsed = PairSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Expected a numeric otherId" });
    return null;
  }
  return parsed.data.otherId;
}

/**
 * Applications that look like duplicates of this one.
 *
 * Read-only and safe to call on every selection: results the user has already
 * rejected are filtered server-side, and model verdicts are cached, so a second
 * look at the same card costs one query.
 */
api.get(
  "/applications/:id/similar",
  asyncRoute(async (req, res) => {
    const id = applicationId(req, res);
    if (id === null) return;

    // Clicking through the board cancels the previous fetch. Asking the model
    // costs seconds each, so give up as soon as nobody is listening.
    const abort = new AbortController();
    res.on("close", () => abort.abort());

    const candidates = await findDuplicates(id, abort.signal);
    // `close` also fires on a normal send, but only after this line has run —
    // so an abort seen here means the client really did hang up.
    if (!abort.signal.aborted) res.json({ candidates });
  }),
);

/** Fold another application into this one; this one survives. */
api.post("/applications/:id/merge", (req, res) => {
  const id = applicationId(req, res);
  if (id === null) return;
  const source = otherId(req, res);
  if (source === null) return;

  if (source === id) {
    res.status(400).json({ error: "An application cannot be merged into itself" });
    return;
  }

  const row = store.mergeApplications(id, source);
  if (!row) {
    res.status(404).json({ error: "Application not found" });
    return;
  }
  res.json({ application: { ...row, stage: deriveStage(row) } });
});

/** Remember that these two are different, so the suggestion never returns. */
api.post("/applications/:id/dismiss-similar", (req, res) => {
  const id = applicationId(req, res);
  if (id === null) return;
  const other = otherId(req, res);
  if (other === null) return;

  if (!store.getApplication(id) || !store.getApplication(other)) {
    res.status(404).json({ error: "Application not found" });
    return;
  }
  store.dismissPair(id, other);
  res.json({ dismissed: true });
});
