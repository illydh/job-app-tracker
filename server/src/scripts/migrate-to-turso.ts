import { createClient, type InValue, type Transaction } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";
import type { Credentials } from "google-auth-library";
import { config, serverRoot } from "../lib/config.ts";
import { closeDatabase, db as target, getMeta, initializeDatabase, setMeta } from "../lib/db.ts";
import { hasToken, initializeTokenStore, saveToken } from "../lib/oauth-token-store.ts";

const MIGRATION_KEY = "local_sqlite_migration_v1";
const legacyTokenPath = process.env.TOKEN_PATH ?? path.join(serverRoot, "data", "token.json");

const TABLES = [
  {
    name: "messages",
    columns: [
      "id", "thread_id", "from_addr", "from_name", "subject", "snippet", "body", "internal_date",
      "state", "is_job_related", "processed_at",
    ],
  },
  {
    name: "applications",
    columns: [
      "id", "company", "company_key", "role", "role_key", "status", "status_source", "confidence",
      "first_seen_at", "last_event_at", "notes",
    ],
  },
  {
    name: "events",
    columns: [
      "id", "application_id", "message_id", "status", "confidence", "summary", "occurred_at", "created_at",
    ],
  },
  { name: "merge_dismissals", columns: ["app_a", "app_b", "created_at"] },
  { name: "similarity_verdicts", columns: ["pair_key", "similar", "score", "reason", "created_at"] },
  { name: "meta", columns: ["key", "value"] },
] as const;

type Reader = Pick<Transaction, "execute">;

async function count(client: Reader, table: string, omitMarker = false): Promise<number> {
  const where = omitMarker ? ` WHERE key != ?` : "";
  const result = await client.execute({
    sql: `SELECT COUNT(*) AS count FROM ${table}${where}`,
    args: omitMarker ? [MIGRATION_KEY] : [],
  });
  return Number(result.rows[0]?.count ?? 0);
}

async function copyTable(source: Reader, table: (typeof TABLES)[number]): Promise<number> {
  const sourceRows = (await source.execute(`SELECT ${table.columns.join(", ")} FROM ${table.name}`)).rows;
  const placeholders = table.columns.map(() => "?").join(", ");

  for (let i = 0; i < sourceRows.length; i += 50) {
    await target.batch(
      sourceRows.slice(i, i + 50).map((row) => ({
        sql: `INSERT OR IGNORE INTO ${table.name} (${table.columns.join(", ")}) VALUES (${placeholders})`,
        args: table.columns.map((column) => row[column] as InValue),
      })),
      "write",
    );
  }
  return sourceRows.length;
}

async function migrate(): Promise<void> {
  if (
    !process.env.TURSO_DATABASE_URL?.trim() ||
    !process.env.TURSO_AUTH_TOKEN?.trim() ||
    config.database.url.startsWith("file:") ||
    config.database.url === ":memory:"
  ) {
    throw new Error("Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN before running this migration.");
  }
  if (!fs.existsSync(config.database.localPath)) {
    throw new Error(`Local database not found at ${config.database.localPath}`);
  }

  const source = createClient({ url: `file:${config.database.localPath}`, intMode: "number", timeout: 5_000 });
  try {
    await initializeDatabase();
    await initializeTokenStore();

    const marker = await getMeta(MIGRATION_KEY);
    if (marker === "complete") {
      console.log("Local SQLite data has already been migrated to this Turso database.");
      return;
    }
    if (marker && marker !== "in_progress") {
      throw new Error(`Unexpected migration marker: ${marker}`);
    }

    if (!marker) {
      const targetRows = await Promise.all([
        ...TABLES.map((table) => count(target, table.name)),
        count(target, "oauth_credentials"),
      ]);
      if (targetRows.some((value) => value > 0)) {
        throw new Error("Turso already contains tracker data. Migration stopped to avoid combining unrelated records.");
      }
      await setMeta(MIGRATION_KEY, "in_progress");
    }

    const snapshot = await source.transaction("read");
    try {
      for (const table of TABLES) {
        const copied = await copyTable(snapshot, table);
        const sourceCount = await count(snapshot, table.name);
        const targetCount = await count(target, table.name, table.name === "meta");
        if (targetCount !== sourceCount) {
          throw new Error(`${table.name} verification failed: local=${sourceCount}, Turso=${targetCount}`);
        }
        console.log(`${table.name}: ${copied} row(s)`);
      }

      for (const table of TABLES) {
        const sourceCount = await count(snapshot, table.name);
        const targetCount = await count(target, table.name, table.name === "meta");
        if (sourceCount !== targetCount) {
          throw new Error("Final row-count verification failed; the migration remains resumable.");
        }
      }
      await snapshot.commit();
    } catch (error) {
      if (!snapshot.closed) await snapshot.rollback();
      throw error;
    } finally {
      snapshot.close();
    }

    if (fs.existsSync(legacyTokenPath) && !hasToken()) {
      const credentials = JSON.parse(fs.readFileSync(legacyTokenPath, "utf8")) as Credentials;
      if (!credentials.refresh_token && !credentials.access_token) {
        throw new Error("Legacy token.json does not contain Gmail credentials.");
      }
      await saveToken(credentials);
      console.log("oauth_credentials: imported and encrypted");
    }

    await setMeta(MIGRATION_KEY, "complete");
    console.log("Migration complete. The local files were left unchanged as a backup.");
  } finally {
    source.close();
  }
}

try {
  await migrate();
} catch (error) {
  console.error("Migration failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  closeDatabase();
}
