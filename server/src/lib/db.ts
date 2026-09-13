import { createClient, type Client, type InArgs, type InStatement, type ResultSet, type Transaction } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import { STATUS_RANK, type ApplicationRow, type EventRow, type GmailMessage, type Status } from "./types.ts";

if (config.database.url.startsWith("file:")) {
  fs.mkdirSync(path.dirname(config.database.localPath), { recursive: true });
}

export const db = createClient({
  url: config.database.url,
  authToken: config.database.authToken,
  intMode: "number",
  timeout: 5_000,
});

const SCHEMA: InStatement[] = [
  `CREATE TABLE IF NOT EXISTS messages (
    id             TEXT PRIMARY KEY,
    thread_id      TEXT NOT NULL,
    from_addr      TEXT NOT NULL DEFAULT '',
    from_name      TEXT NOT NULL DEFAULT '',
    subject        TEXT NOT NULL DEFAULT '',
    snippet        TEXT NOT NULL DEFAULT '',
    body           TEXT NOT NULL DEFAULT '',
    internal_date  INTEGER NOT NULL,
    state          TEXT NOT NULL DEFAULT 'pending',
    is_job_related INTEGER,
    processed_at   INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_state ON messages(state)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(internal_date DESC)`,
  `CREATE TABLE IF NOT EXISTS applications (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    company       TEXT NOT NULL,
    company_key   TEXT NOT NULL,
    role          TEXT,
    role_key      TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL,
    status_source TEXT NOT NULL DEFAULT 'model',
    confidence    REAL NOT NULL DEFAULT 0,
    first_seen_at INTEGER NOT NULL,
    last_event_at INTEGER NOT NULL,
    notes         TEXT,
    UNIQUE(company_key, role_key)
  )`,
  `CREATE TABLE IF NOT EXISTS events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    message_id     TEXT NOT NULL,
    status         TEXT NOT NULL,
    confidence     REAL NOT NULL DEFAULT 0,
    summary        TEXT NOT NULL DEFAULT '',
    occurred_at    INTEGER NOT NULL,
    created_at     INTEGER NOT NULL,
    UNIQUE(application_id, message_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_app ON events(application_id, occurred_at DESC)`,
  `CREATE TABLE IF NOT EXISTS merge_dismissals (
    app_a      INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    app_b      INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (app_a, app_b)
  )`,
  `CREATE TABLE IF NOT EXISTS similarity_verdicts (
    pair_key   TEXT PRIMARY KEY,
    similar    INTEGER NOT NULL,
    score      REAL NOT NULL,
    reason     TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_credentials (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    encrypted_token TEXT NOT NULL,
    updated_at      INTEGER NOT NULL
  )`,
];

let initialization: Promise<void> | null = null;

/** Create missing tables before any request, scheduler tick, or CLI operation. */
export function initializeDatabase(): Promise<void> {
  initialization ??= (async () => {
    if (process.env.RENDER === "true" && config.database.url.startsWith("file:")) {
      throw new Error("TURSO_DATABASE_URL is required on Render; its local filesystem is not persistent.");
    }
    if (config.database.url.startsWith("libsql:") && !config.database.authToken) {
      throw new Error("TURSO_AUTH_TOKEN is required for a remote Turso database.");
    }
    await db.batch(SCHEMA, "write");
  })();
  return initialization;
}

export function closeDatabase(): void {
  db.close();
}

type Executor = {
  execute(statement: InStatement): Promise<ResultSet>;
};

function execute(executor: Executor, sql: string, args: InArgs = []): Promise<ResultSet> {
  return executor.execute({ sql, args });
}

function first<T>(result: ResultSet): T | undefined {
  return result.rows[0] as unknown as T | undefined;
}

function rows<T>(result: ResultSet): T[] {
  return result.rows as unknown as T[];
}

async function writeTransaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
  const tx = await db.transaction("write");
  try {
    const result = await work(tx);
    await tx.commit();
    return result;
  } catch (error) {
    if (!tx.closed) await tx.rollback();
    throw error;
  } finally {
    tx.close();
  }
}

/* ------------------------------------------------------------------ keys --- */

export function companyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|gmbh|plc|sa|ag|nv|bv|pty|labs|technologies|technology|holdings|group)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
}

export function roleKey(role: string | null): string {
  if (!role) return "";
  return role
    .toLowerCase()
    .replace(/\((remote|hybrid|onsite|contract|full[- ]time|part[- ]time)\)/g, "")
    .replace(/\b(senior|sr|junior|jr|staff|principal|lead)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
}

/* -------------------------------------------------------------- messages --- */

export async function saveMessages(messages: GmailMessage[]): Promise<number> {
  let inserted = 0;
  // Small batches keep email bodies below practical HTTP request limits.
  for (let i = 0; i < messages.length; i += 100) {
    const results = await db.batch(
      messages.slice(i, i + 100).map((message) => ({
        sql: `INSERT INTO messages
          (id, thread_id, from_addr, from_name, subject, snippet, body, internal_date, state)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
          ON CONFLICT(id) DO NOTHING`,
        args: [
          message.id,
          message.threadId,
          message.fromAddr,
          message.fromName,
          message.subject,
          message.snippet,
          message.body,
          message.internalDate,
        ],
      })),
      "write",
    );
    inserted += results.reduce((total, result) => total + result.rowsAffected, 0);
  }
  return inserted;
}

export async function knownMessageIds(ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db.execute({ sql: `SELECT id FROM messages WHERE id IN (${placeholders})`, args: chunk });
    for (const row of rows<{ id: string }>(result)) found.add(row.id);
  }
  return found;
}

export async function pendingMessages(limit: number): Promise<GmailMessage[]> {
  return rows<GmailMessage>(
    await db.execute({
      sql: `SELECT id, thread_id AS threadId, from_addr AS fromAddr, from_name AS fromName,
                   subject, snippet, body, internal_date AS internalDate
              FROM messages WHERE state = 'pending'
             ORDER BY internal_date ASC LIMIT ?`,
      args: [limit],
    }),
  );
}

export async function markMessage(
  id: string,
  state: "prefiltered" | "classified",
  isJobRelated: boolean,
): Promise<void> {
  await db.execute({
    sql: `UPDATE messages SET state = ?, is_job_related = ?, processed_at = ? WHERE id = ?`,
    args: [state, isJobRelated ? 1 : 0, Date.now(), id],
  });
}

/* ---------------------------------------------------------- applications --- */

export interface UpsertInput {
  company: string;
  role: string | null;
  status: Status;
  confidence: number;
  summary: string;
  messageId: string;
  occurredAt: number;
}

async function findApplication(executor: Executor, cKey: string, rKey: string): Promise<ApplicationRow | undefined> {
  const exact = first<ApplicationRow>(
    await execute(executor, `SELECT * FROM applications WHERE company_key = ? AND role_key = ?`, [cKey, rKey]),
  );
  if (exact) return exact;

  if (rKey === "") {
    return first<ApplicationRow>(
      await execute(
        executor,
        `SELECT * FROM applications WHERE company_key = ? ORDER BY last_event_at DESC LIMIT 1`,
        [cKey],
      ),
    );
  }

  return first<ApplicationRow>(
    await execute(executor, `SELECT * FROM applications WHERE company_key = ? AND role_key = '' LIMIT 1`, [cKey]),
  );
}

export async function upsertApplicationEvent(input: UpsertInput): Promise<number> {
  const cKey = companyKey(input.company);
  const rKey = roleKey(input.role);

  return writeTransaction(async (tx) => {
    const existing = await findApplication(tx, cKey, rKey);
    let appId: number;

    if (!existing) {
      const result = await execute(
        tx,
        `INSERT INTO applications
          (company, company_key, role, role_key, status, status_source, confidence, first_seen_at, last_event_at)
         VALUES (?, ?, ?, ?, ?, 'model', ?, ?, ?)`,
        [input.company, cKey, input.role, rKey, input.status, input.confidence, input.occurredAt, input.occurredAt],
      );
      if (result.lastInsertRowid === undefined) throw new Error("Database did not return the new application id.");
      appId = Number(result.lastInsertRowid);
    } else {
      appId = existing.id;
      const advance = input.occurredAt >= existing.last_event_at && existing.status_source !== "manual";
      const learnsRole = existing.role_key === "" && rKey !== "";

      await execute(
        tx,
        `UPDATE applications
            SET role = ?, role_key = ?, status = ?, confidence = ?,
                last_event_at = MAX(last_event_at, ?), first_seen_at = MIN(first_seen_at, ?)
          WHERE id = ?`,
        [
          learnsRole ? input.role : existing.role,
          learnsRole ? rKey : existing.role_key,
          advance ? input.status : existing.status,
          advance ? input.confidence : existing.confidence,
          input.occurredAt,
          input.occurredAt,
          appId,
        ],
      );
    }

    await execute(
      tx,
      `INSERT INTO events (application_id, message_id, status, confidence, summary, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(application_id, message_id) DO NOTHING`,
      [appId, input.messageId, input.status, input.confidence, input.summary, input.occurredAt, Date.now()],
    );
    return appId;
  });
}

async function getApplicationFrom(executor: Executor, id: number): Promise<ApplicationRow | undefined> {
  return first<ApplicationRow>(await execute(executor, `SELECT * FROM applications WHERE id = ?`, [id]));
}

export function getApplication(id: number): Promise<ApplicationRow | undefined> {
  return getApplicationFrom(db, id);
}

export async function listApplications(): Promise<ApplicationRow[]> {
  return rows<ApplicationRow>(await db.execute(`SELECT * FROM applications ORDER BY last_event_at DESC`));
}

export interface ApplicationSummaryRow extends ApplicationRow {
  event_count: number;
  latest_summary: string | null;
}

/** Board data in one remote query instead of one event query per card. */
export async function listApplicationSummaries(): Promise<ApplicationSummaryRow[]> {
  return rows<ApplicationSummaryRow>(
    await db.execute(`SELECT a.*,
      (SELECT COUNT(*) FROM events e WHERE e.application_id = a.id) AS event_count,
      (SELECT summary FROM events e WHERE e.application_id = a.id
        ORDER BY e.occurred_at DESC LIMIT 1) AS latest_summary
      FROM applications a ORDER BY a.last_event_at DESC`),
  );
}

export async function listEvents(applicationId: number): Promise<EventRow[]> {
  return rows<EventRow>(
    await db.execute({
      sql: `SELECT e.*, m.subject, m.from_addr
              FROM events e LEFT JOIN messages m ON m.id = e.message_id
             WHERE e.application_id = ? ORDER BY e.occurred_at DESC`,
      args: [applicationId],
    }),
  );
}

export async function setStatus(id: number, status: Status): Promise<ApplicationRow | undefined> {
  return first<ApplicationRow>(
    await db.execute({
      sql: `UPDATE applications SET status = ?, status_source = 'manual' WHERE id = ? RETURNING *`,
      args: [status, id],
    }),
  );
}

export async function setNotes(id: number, notes: string): Promise<ApplicationRow | undefined> {
  return first<ApplicationRow>(
    await db.execute({ sql: `UPDATE applications SET notes = ? WHERE id = ? RETURNING *`, args: [notes, id] }),
  );
}

export async function deleteApplication(id: number): Promise<boolean> {
  return writeTransaction(async (tx) => {
    await execute(tx, `DELETE FROM merge_dismissals WHERE app_a = ? OR app_b = ?`, [id, id]);
    await execute(tx, `DELETE FROM events WHERE application_id = ?`, [id]);
    const result = await execute(tx, `DELETE FROM applications WHERE id = ?`, [id]);
    return result.rowsAffected > 0;
  });
}

/* --------------------------------------------------------- de-duplication --- */

function orderedPair(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

export async function dismissPair(a: number, b: number): Promise<void> {
  const [lo, hi] = orderedPair(a, b);
  await db.execute({
    sql: `INSERT INTO merge_dismissals (app_a, app_b, created_at) VALUES (?, ?, ?)
          ON CONFLICT(app_a, app_b) DO NOTHING`,
    args: [lo, hi, Date.now()],
  });
}

export async function dismissedFor(id: number): Promise<Set<number>> {
  const result = await db.execute({
    sql: `SELECT app_a, app_b FROM merge_dismissals WHERE app_a = ? OR app_b = ?`,
    args: [id, id],
  });
  return new Set(
    rows<{ app_a: number; app_b: number }>(result).map((row) => (row.app_a === id ? row.app_b : row.app_a)),
  );
}

export interface Verdict {
  similar: boolean;
  score: number;
  reason: string;
}

export async function getVerdict(pairKey: string): Promise<Verdict | null> {
  const row = first<{ similar: number; score: number; reason: string }>(
    await db.execute({ sql: `SELECT similar, score, reason FROM similarity_verdicts WHERE pair_key = ?`, args: [pairKey] }),
  );
  return row ? { similar: row.similar === 1, score: row.score, reason: row.reason } : null;
}

export async function putVerdict(pairKey: string, verdict: Verdict): Promise<void> {
  await db.execute({
    sql: `INSERT INTO similarity_verdicts (pair_key, similar, score, reason, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(pair_key) DO UPDATE SET similar = excluded.similar, score = excluded.score,
            reason = excluded.reason, created_at = excluded.created_at`,
    args: [pairKey, verdict.similar ? 1 : 0, verdict.score, verdict.reason, Date.now()],
  });
}

export interface AppSignals {
  threads: Set<string>;
  domains: Set<string>;
}

const GENERIC_DOMAINS =
  /(^|\.)(greenhouse|greenhouse-mail|lever|hire\.lever|ashbyhq|myworkday|workday|icims|smartrecruiters|taleo|jobvite|breezy|breezy-?hr|workable|recruitee|bamboohr|successfactors|oraclecloud|paylocity|dayforce|jazzhr|teamtailor|rippling|gmail|googlemail|outlook|hotmail|yahoo|icloud|proton|protonmail)\./;

export async function applicationSignals(): Promise<Map<number, AppSignals>> {
  const result = await db.execute(
    `SELECT e.application_id AS id, m.thread_id AS threadId, m.from_addr AS fromAddr
       FROM events e JOIN messages m ON m.id = e.message_id`,
  );
  const out = new Map<number, AppSignals>();
  for (const row of rows<{ id: number; threadId: string; fromAddr: string }>(result)) {
    let entry = out.get(row.id);
    if (!entry) out.set(row.id, (entry = { threads: new Set(), domains: new Set() }));
    if (row.threadId) entry.threads.add(row.threadId);
    const domain = row.fromAddr.split("@")[1]?.toLowerCase().replace(/[>\s]/g, "");
    if (domain && !GENERIC_DOMAINS.test(`${domain}.`)) entry.domains.add(domain);
  }
  return out;
}

async function latestEvent(executor: Executor, applicationId: number): Promise<EventRow | undefined> {
  const result = await execute(executor, `SELECT * FROM events WHERE application_id = ?`, [applicationId]);
  return rows<EventRow>(result).sort(
    (a, b) => b.occurred_at - a.occurred_at || STATUS_RANK[b.status] - STATUS_RANK[a.status],
  )[0];
}

export async function mergeApplications(targetId: number, sourceId: number): Promise<ApplicationRow | undefined> {
  if (targetId === sourceId) return getApplication(targetId);

  return writeTransaction(async (tx) => {
    const target = await getApplicationFrom(tx, targetId);
    const source = await getApplicationFrom(tx, sourceId);
    if (!target || !source) return undefined;

    await execute(tx, `UPDATE OR IGNORE events SET application_id = ? WHERE application_id = ?`, [targetId, sourceId]);
    await execute(tx, `DELETE FROM events WHERE application_id = ?`, [sourceId]);
    await execute(tx, `DELETE FROM merge_dismissals WHERE app_a = ? OR app_b = ?`, [sourceId, sourceId]);
    await execute(tx, `DELETE FROM applications WHERE id = ?`, [sourceId]);

    const taken = first<{ found: number }>(
      await execute(
        tx,
        `SELECT 1 AS found FROM applications WHERE company_key = ? AND role_key = ? AND id != ?`,
        [target.company_key, source.role_key, targetId],
      ),
    );
    const adoptsRole = target.role_key === "" && source.role_key !== "" && !taken;
    const manual = target.status_source === "manual" ? target : source.status_source === "manual" ? source : null;
    const latest = await latestEvent(tx, targetId);
    const notes = [target.notes, source.notes].filter((note) => note?.trim()).join("\n\n") || null;

    await execute(
      tx,
      `UPDATE applications
          SET role = ?, role_key = ?, status = ?, status_source = ?, confidence = ?,
              first_seen_at = MIN(first_seen_at, ?), last_event_at = MAX(last_event_at, ?), notes = ?
        WHERE id = ?`,
      [
        adoptsRole ? source.role : target.role,
        adoptsRole ? source.role_key : target.role_key,
        manual ? manual.status : (latest?.status ?? target.status),
        manual ? "manual" : "model",
        manual ? manual.confidence : (latest?.confidence ?? target.confidence),
        source.first_seen_at,
        source.last_event_at,
        notes,
        targetId,
      ],
    );
    return getApplicationFrom(tx, targetId);
  });
}

/* -------------------------------------------------------------- metadata --- */

export async function getMeta(key: string): Promise<string | null> {
  const row = first<{ value: string }>(
    await db.execute({ sql: `SELECT value FROM meta WHERE key = ?`, args: [key] }),
  );
  return row?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO meta (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    args: [key, value],
  });
}

export async function getEncryptedOAuthCredentials(): Promise<string | null> {
  const row = first<{ encrypted_token: string }>(
    await db.execute(`SELECT encrypted_token FROM oauth_credentials WHERE id = 1`),
  );
  return row?.encrypted_token ?? null;
}

export async function setEncryptedOAuthCredentials(value: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO oauth_credentials (id, encrypted_token, updated_at) VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET encrypted_token = excluded.encrypted_token,
            updated_at = excluded.updated_at`,
    args: [value, Date.now()],
  });
}

export async function deleteOAuthCredentials(): Promise<void> {
  await db.execute(`DELETE FROM oauth_credentials WHERE id = 1`);
}

export interface DatabaseStats {
  messages: number;
  pending: number;
  prefiltered: number;
  classified: number;
  applications: number;
  events: number;
}

export async function stats(): Promise<DatabaseStats> {
  const result = await db.execute(`SELECT
    (SELECT COUNT(*) FROM messages) AS messages,
    (SELECT COUNT(*) FROM messages WHERE state = 'pending') AS pending,
    (SELECT COUNT(*) FROM messages WHERE state = 'prefiltered') AS prefiltered,
    (SELECT COUNT(*) FROM messages WHERE state = 'classified') AS classified,
    (SELECT COUNT(*) FROM applications) AS applications,
    (SELECT COUNT(*) FROM events) AS events`);
  const value = first<DatabaseStats>(result);
  if (!value) throw new Error("Database did not return statistics.");
  return value;
}
