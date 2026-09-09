import fs from "node:fs";
import path from "node:path";
import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { config } from "./config.ts";
import type { GmailMessage } from "./types.ts";

/** Read-only: this app never sends, deletes, or modifies mail. */
export const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

export function oauthClient(): OAuth2Client {
  if (!config.google.clientId || !config.google.clientSecret) {
    throw new Error(
      "Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. Copy server/.env.example to server/.env and fill them in.",
    );
  }
  return new google.auth.OAuth2(config.google.clientId, config.google.clientSecret, config.google.redirectUri);
}

export function authUrl(client: OAuth2Client): string {
  return client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    // Force a refresh token even if the user has authorised this client before.
    prompt: "consent",
  });
}

export function saveToken(tokens: unknown): void {
  fs.mkdirSync(path.dirname(config.tokenPath), { recursive: true });
  fs.writeFileSync(config.tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

export function loadToken(): Record<string, unknown> | null {
  if (!fs.existsSync(config.tokenPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(config.tokenPath, "utf8"));
  } catch {
    return null;
  }
}

export function hasToken(): boolean {
  const t = loadToken();
  return Boolean(t && (t.refresh_token || t.access_token));
}

/* -------------------------------------------------------- auth liveness --- */

/**
 * A cached token file proves nothing about whether Google still honours it.
 *
 * Refresh tokens issued while the OAuth app is in "Testing" status expire after
 * 7 days, and a user can revoke access at any time. Both surface only when an
 * API call is attempted, so the failure is recorded here and reported through
 * /api/health — otherwise the UI would keep claiming "Gmail connected" while
 * every sync failed with an opaque error.
 */
let authError: string | null = null;

export function gmailAuthError(): string | null {
  return authError;
}

export function clearAuthError(): void {
  authError = null;
}

/** Google reports an expired or revoked refresh token as `invalid_grant`. */
export function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /invalid_grant|invalid_client|unauthorized_client|token has been expired or revoked/i.test(msg);
}

export function noteAuthError(): void {
  authError =
    "Gmail authorisation has expired or been revoked. Reconnect Gmail to continue. " +
    "(Refresh tokens last only 7 days while the OAuth app is in Testing status.)";
}

/** An authorised client, or null when the user has not completed OAuth yet. */
export function authorizedClient(): OAuth2Client | null {
  const token = loadToken();
  if (!token) return null;

  // Best-effort accessor: unconfigured credentials are a state to report, not
  // an exception to throw at whichever request happened to arrive first.
  let client: OAuth2Client;
  try {
    client = oauthClient();
  } catch {
    return null;
  }
  client.setCredentials(token);
  // googleapis refreshes access tokens automatically; persist the new ones.
  // A successful refresh also means any previously recorded failure is stale.
  client.on("tokens", (fresh) => {
    saveToken({ ...token, ...fresh });
    clearAuthError();
  });
  return client;
}

/* -------------------------------------------------------------- profile --- */

export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  connectedAt: number;
}

/**
 * Identifies the connected mailbox. Cached so the landing page can tell
 * "signed in as you" from "never connected" without a network round trip on
 * every page load — and so a returning visit skips onboarding entirely.
 */
export async function fetchProfile(client: OAuth2Client): Promise<GmailProfile> {
  const gmail = google.gmail({ version: "v1", auth: client });
  const res = await gmail.users.getProfile({ userId: "me" });
  return {
    emailAddress: res.data.emailAddress ?? "",
    messagesTotal: Number(res.data.messagesTotal ?? 0),
    connectedAt: Date.now(),
  };
}

/* ------------------------------------------------------------- fetching --- */

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  const h = headers?.find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

function decode(data: string | null | undefined): string {
  if (!data) return "";
  return Buffer.from(data, "base64url").toString("utf8");
}

/**
 * Pull the plain-text body out of Gmail's nested MIME parts, falling back to
 * HTML with tags stripped. Truncated because the classifier only needs the top
 * of the message and long bodies slow the local model down considerably.
 */
function extractBody(payload: gmail_v1.Schema$MessagePart | undefined, limit = 4000): string {
  if (!payload) return "";
  let text = "";
  let html = "";

  const walk = (part: gmail_v1.Schema$MessagePart) => {
    const mime = part.mimeType ?? "";
    if (mime === "text/plain" && part.body?.data) text += decode(part.body.data) + "\n";
    else if (mime === "text/html" && part.body?.data) html += decode(part.body.data) + "\n";
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);

  const chosen =
    text.trim() ||
    html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");

  return chosen.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, limit);
}

function parseFrom(raw: string): { addr: string; name: string } {
  const match = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (match) return { name: (match[1] ?? "").replace(/^"|"$/g, ""), addr: (match[2] ?? "").toLowerCase() };
  return { name: "", addr: raw.trim().toLowerCase() };
}

/**
 * Gmail's search syntax wants YYYY/MM/DD. No category filter: `messages.list`
 * already spans every category, and spam/trash are excluded by default.
 */
export function buildQuery(since: string): string {
  const formatted = since.replace(/-/g, "/");
  return `after:${formatted} -in:chats -in:drafts`;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * SYNC_SINCE is a floor, not a moving target: once a sync has succeeded,
 * later runs only need messages from just before that point, not the whole
 * configured window every time. The 1-day buffer covers `after:`'s day-only
 * granularity so a message from earlier the same day isn't skipped —
 * knownMessageIds still dedupes anything re-listed because of it.
 */
export function effectiveSyncSince(lastSyncAt: number | null): string {
  if (!lastSyncAt) return config.syncSince;
  const buffered = new Date(lastSyncAt - ONE_DAY_MS).toISOString().slice(0, 10);
  return buffered > config.syncSince ? buffered : config.syncSince;
}

export async function listMessageIds(client: OAuth2Client, max: number, since: string): Promise<string[]> {
  const gmail = google.gmail({ version: "v1", auth: client });
  const query = buildQuery(since);
  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: Math.min(500, max - ids.length),
      pageToken,
    });
    for (const m of res.data.messages ?? []) if (m.id) ids.push(m.id);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && ids.length < max);

  return ids.slice(0, max);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Gmail reports quota exhaustion as HTTP 429, or occasionally a 403 with a
 *  rate-limit reason — the message text itself is the most reliable signal. */
function isQuotaError(err: unknown): boolean {
  const status = Number((err as { code?: number | string; response?: { status?: number } })?.response?.status ?? (err as { code?: number | string })?.code);
  if (status === 429 || status === 403) return true;
  return /quota exceeded|rate limit exceeded/i.test((err as Error)?.message ?? "");
}

/**
 * Bursts of `messages.get` calls can outrun Gmail's per-user quota window
 * (observed: "Units per minute per user"). Retrying with backoff lets the
 * window recover instead of dropping the message for this run.
 */
async function getMessageWithRetry(gmail: gmail_v1.Gmail, id: string): Promise<gmail_v1.Schema$Message> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await gmail.users.messages.get({ userId: "me", id, format: "full" });
      return res.data;
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS || !isQuotaError(err)) throw err;
      const delayMs = 1000 * 2 ** (attempt - 1) + Math.random() * 250;
      await sleep(delayMs);
    }
  }
}

export async function fetchMessages(client: OAuth2Client, ids: string[]): Promise<GmailMessage[]> {
  const gmail = google.gmail({ version: "v1", auth: client });
  const out: GmailMessage[] = [];

  // Modest concurrency: enough to be quick without needing very deep backoff
  // bookkeeping on top of getMessageWithRetry.
  const CONCURRENCY = 8;
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (id) => {
        try {
          const msg = await getMessageWithRetry(gmail, id);
          const headers = msg.payload?.headers ?? undefined;
          const from = parseFrom(header(headers, "From"));
          return {
            id: msg.id ?? id,
            threadId: msg.threadId ?? "",
            fromAddr: from.addr,
            fromName: from.name,
            subject: header(headers, "Subject"),
            snippet: msg.snippet ?? "",
            body: extractBody(msg.payload ?? undefined),
            internalDate: Number(msg.internalDate ?? Date.now()),
          } satisfies GmailMessage;
        } catch (err) {
          console.error(`  ! failed to fetch message ${id}:`, (err as Error).message);
          return null;
        }
      }),
    );
    for (const r of results) if (r) out.push(r);
  }

  return out;
}
