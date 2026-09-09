import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import type { ApplicationRow, EventRow, GmailMessage, Status } from "./types.ts";

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  thread_id     TEXT NOT NULL,
  from_addr     TEXT NOT NULL DEFAULT '',
  from_name     TEXT NOT NULL DEFAULT '',
  subject       TEXT NOT NULL DEFAULT '',
  snippet       TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL DEFAULT '',
  internal_date INTEGER NOT NULL,
  -- 'pending' -> seen but not yet classified
  -- 'prefiltered' -> cheaply rejected, never sent to the model
  -- 'classified' -> model ran; see is_job_related
  state         TEXT NOT NULL DEFAULT 'pending',
  is_job_related INTEGER,
  processed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_state ON messages(state);
CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(internal_date DESC);

CREATE TABLE IF NOT EXISTS applications (
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
);

CREATE TABLE IF NOT EXISTS events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  message_id     TEXT NOT NULL,
  status         TEXT NOT NULL,
  confidence     REAL NOT NULL DEFAULT 0,
  summary        TEXT NOT NULL DEFAULT '',
  occurred_at    INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  UNIQUE(application_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_events_app ON events(application_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

/* ------------------------------------------------------------------ keys --- */

/**
 * Collapse a company name to a stable identity key so "Acme, Inc." and "Acme"
 * land on the same application rather than creating duplicates.
 */
export function companyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|gmbh|plc|sa|ag|nv|bv|pty|labs|technologies|technology|holdings|group)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
}

/** Roles are noisier than companies; normalise lightly and tolerate nulls. */
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

const insertMessage = db.prepare(`
  INSERT INTO messages (id, thread_id, from_addr, from_name, subject, snippet, body, internal_date, state)
  VALUES (@id, @threadId, @fromAddr, @fromName, @subject, @snippet, @body, @internalDate, 'pending')
  ON CONFLICT(id) DO NOTHING
`);

export function saveMessages(messages: GmailMessage[]): number {
  const tx = db.transaction((rows: GmailMessage[]) => {
    let inserted = 0;
    for (const m of rows) inserted += insertMessage.run(m).changes;
    return inserted;
  });
  return tx(messages);
}

export function knownMessageIds(ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const found = new Set<string>();
  // Chunked to stay well under SQLite's variable limit on large first syncs.
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(`SELECT id FROM messages WHERE id IN (${placeholders})`)
      .all(...chunk) as { id: string }[];
    for (const r of rows) found.add(r.id);
  }
  return found;
}

export function pendingMessages(limit: number): GmailMessage[] {
  const rows = db
    .prepare(
      `SELECT id, thread_id AS threadId, from_addr AS fromAddr, from_name AS fromName,
              subject, snippet, body, internal_date AS internalDate
       FROM messages WHERE state = 'pending'
       ORDER BY internal_date ASC LIMIT ?`,
    )
    .all(limit) as GmailMessage[];
  return rows;
}

export function markMessage(id: string, state: "prefiltered" | "classified", isJobRelated: boolean): void {
  db.prepare(`UPDATE messages SET state = ?, is_job_related = ?, processed_at = ? WHERE id = ?`).run(
    state,
    isJobRelated ? 1 : 0,
    Date.now(),
    id,
  );
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

/**
 * Resolve which application an email belongs to.
 *
 * Emails from one employer often disagree about the role: a confirmation names
 * it, while the rejection three weeks later just says "your application".
 * Matching strictly on (company, role) would split those into separate rows, so
 * an unknown role attaches to that company's most recent application, and a
 * newly-learned role adopts the row that was created without one.
 */
function findApplication(cKey: string, rKey: string): ApplicationRow | undefined {
  const exact = db
    .prepare(`SELECT * FROM applications WHERE company_key = ? AND role_key = ?`)
    .get(cKey, rKey) as ApplicationRow | undefined;
  if (exact) return exact;

  if (rKey === "") {
    return db
      .prepare(`SELECT * FROM applications WHERE company_key = ? ORDER BY last_event_at DESC LIMIT 1`)
      .get(cKey) as ApplicationRow | undefined;
  }

  return db
    .prepare(`SELECT * FROM applications WHERE company_key = ? AND role_key = '' LIMIT 1`)
    .get(cKey) as ApplicationRow | undefined;
}

/**
 * Record one classified email against its application, creating the application
 * if needed. Status only moves forward in time: an older email cannot rewrite a
 * newer verdict, and a manual override is never overwritten automatically.
 */
export function upsertApplicationEvent(input: UpsertInput): number {
  const cKey = companyKey(input.company);
  const rKey = roleKey(input.role);

  const tx = db.transaction((): number => {
    const existing = findApplication(cKey, rKey);

    let appId: number;
    if (!existing) {
      const info = db
        .prepare(
          `INSERT INTO applications
             (company, company_key, role, role_key, status, status_source, confidence, first_seen_at, last_event_at)
           VALUES (?, ?, ?, ?, ?, 'model', ?, ?, ?)`,
        )
        .run(input.company, cKey, input.role, rKey, input.status, input.confidence, input.occurredAt, input.occurredAt);
      appId = Number(info.lastInsertRowid);
    } else {
      appId = existing.id;
      const isNewer = input.occurredAt >= existing.last_event_at;
      const advance = isNewer && existing.status_source !== "manual";

      // Fill in a role we did not previously know; never overwrite a known one.
      const learnsRole = existing.role_key === "" && rKey !== "";
      const role = learnsRole ? input.role : existing.role;
      const roleK = learnsRole ? rKey : existing.role_key;

      db.prepare(
        `UPDATE applications
            SET role          = ?,
                role_key      = ?,
                status        = ?,
                confidence    = ?,
                last_event_at = MAX(last_event_at, ?),
                first_seen_at = MIN(first_seen_at, ?)
          WHERE id = ?`,
      ).run(
        role,
        roleK,
        advance ? input.status : existing.status,
        advance ? input.confidence : existing.confidence,
        input.occurredAt,
        input.occurredAt,
        appId,
      );
    }

    db.prepare(
      `INSERT INTO events (application_id, message_id, status, confidence, summary, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(application_id, message_id) DO NOTHING`,
    ).run(appId, input.messageId, input.status, input.confidence, input.summary, input.occurredAt, Date.now());

    return appId;
  });

  return tx();
}

export function listApplications(): ApplicationRow[] {
  return db
    .prepare(`SELECT * FROM applications ORDER BY last_event_at DESC`)
    .all() as ApplicationRow[];
}

export function listEvents(applicationId: number): EventRow[] {
  return db
    .prepare(
      `SELECT e.*, m.subject, m.from_addr
         FROM events e
         LEFT JOIN messages m ON m.id = e.message_id
        WHERE e.application_id = ?
        ORDER BY e.occurred_at DESC`,
    )
    .all(applicationId) as EventRow[];
}

export function setStatus(id: number, status: Status): ApplicationRow | undefined {
  db.prepare(`UPDATE applications SET status = ?, status_source = 'manual' WHERE id = ?`).run(status, id);
  return db.prepare(`SELECT * FROM applications WHERE id = ?`).get(id) as ApplicationRow | undefined;
}

export function setNotes(id: number, notes: string): ApplicationRow | undefined {
  db.prepare(`UPDATE applications SET notes = ? WHERE id = ?`).run(notes, id);
  return db.prepare(`SELECT * FROM applications WHERE id = ?`).get(id) as ApplicationRow | undefined;
}

export function deleteApplication(id: number): boolean {
  return db.prepare(`DELETE FROM applications WHERE id = ?`).run(id).changes > 0;
}

/* -------------------------------------------------------------- metadata --- */

export function getMeta(key: string): string | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    key,
    value,
  );
}

export function stats() {
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    messages: one(`SELECT COUNT(*) AS n FROM messages`),
    pending: one(`SELECT COUNT(*) AS n FROM messages WHERE state = 'pending'`),
    prefiltered: one(`SELECT COUNT(*) AS n FROM messages WHERE state = 'prefiltered'`),
    classified: one(`SELECT COUNT(*) AS n FROM messages WHERE state = 'classified'`),
    applications: one(`SELECT COUNT(*) AS n FROM applications`),
    events: one(`SELECT COUNT(*) AS n FROM events`),
  };
}
