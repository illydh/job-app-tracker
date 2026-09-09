import crypto from "node:crypto";
import { config } from "./config.ts";

/**
 * The app is single-user, so a "session" is just proof of knowing
 * APP_PASSWORD — a deterministic HMAC of it, not a stored/expiring session id.
 * That means the token survives server restarts (no surprise logouts while
 * `--watch` reloads the dev server) and is invalidated automatically the
 * moment the password is changed.
 */
function computeToken(password: string): string {
  return crypto.createHmac("sha256", "job-app-tracker-session").update(password).digest("hex");
}

/** Fixed-length digest comparison: avoids both a length-based timing leak and
 *  `timingSafeEqual` throwing on inputs of different lengths. */
function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = crypto.createHash("sha256").update(a).digest();
  const bufB = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(bufA, bufB);
}

/** The login wall is opt-in: leave APP_PASSWORD unset to run without one. */
export function authRequired(): boolean {
  return config.appPassword.length > 0;
}

/** Returns a bearer token for a correct password, `null` for an incorrect one. */
export function issueToken(password: string): string | null {
  if (!authRequired()) return null;
  if (!timingSafeStringEqual(password, config.appPassword)) return null;
  return computeToken(config.appPassword);
}

export function isValidToken(token: string | null | undefined): boolean {
  if (!authRequired()) return true;
  if (!token) return false;
  return timingSafeStringEqual(token, computeToken(config.appPassword));
}
