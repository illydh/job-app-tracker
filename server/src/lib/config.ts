import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Anchored to the server package rather than process.cwd(), so `node
// server/src/index.ts` from the repo root behaves the same as `npm run
// dev:server` from the workspace. Loading it by cwd silently dropped every
// credential when the server was started from anywhere else.
dotenv.config({ path: path.join(serverRoot, ".env") });

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: int("PORT", 4000),
  /**
   * Loopback only by default. This API serves parsed email content with no
   * authentication, so it must not be reachable from the local network.
   */
  host: process.env.HOST ?? "127.0.0.1",

  /** Origins allowed to call this API. The GitHub Pages URL must be listed here. */
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    // Must match the redirect URI registered on the OAuth client exactly.
    redirectUri: process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:4000/api/auth/callback",
  },

  /** Where the OAuth refresh token is cached. Never commit this file. */
  tokenPath: process.env.TOKEN_PATH ?? path.join(serverRoot, "data", "token.json"),
  dbPath: process.env.DB_PATH ?? path.join(serverRoot, "data", "tracker.db"),

  /** Earliest email to consider, YYYY-MM-DD. */
  syncSince: process.env.SYNC_SINCE ?? "2026-08-01",
  /** Safety valve so a first sync on a busy inbox cannot run unbounded. */
  maxMessagesPerSync: int("MAX_MESSAGES_PER_SYNC", 400),
  /** Auto-sync cadence once the server is running unattended. 0 disables it. */
  syncIntervalMinutes: int("SYNC_INTERVAL_MINUTES", 30),

  ollama: {
    host: process.env.OLLAMA_HOST ?? "http://localhost:11434",
    model: process.env.OLLAMA_MODEL ?? "qwen3.5:4b",
    timeoutMs: int("OLLAMA_TIMEOUT_MS", 120_000),
    /**
     * Hybrid reasoning models (Qwen3.x and friends) think before answering.
     * Extraction does not benefit from it and it costs seconds per email.
     *
     * Left `undefined` unless explicitly set, so the field is omitted from the
     * request entirely — Ollama rejects an explicit `think` on models that do
     * not support it.
     */
    think: process.env.OLLAMA_THINK === undefined ? undefined : process.env.OLLAMA_THINK === "true",
  },

  /** Days of silence after which an open application is shown as ghosted. */
  ghostAfterDays: int("GHOST_AFTER_DAYS", 30),
  /** Classifications below this are recorded but not surfaced as applications. */
  minConfidence: Number.parseFloat(process.env.MIN_CONFIDENCE ?? "0.6"),
} as const;

export { serverRoot };
