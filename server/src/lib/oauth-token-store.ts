import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Credentials } from "google-auth-library";
import { config } from "./config.ts";
import {
  deleteOAuthCredentials,
  getEncryptedOAuthCredentials,
  setEncryptedOAuthCredentials,
} from "./db.ts";

const AAD = Buffer.from("job-app-tracker:gmail-oauth:v1", "utf8");

interface Envelope {
  v: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

let initialized = false;
let cachedToken: Credentials | null = null;
let tokenGeneration = 0;
let mutationQueue: Promise<void> = Promise.resolve();

function encryptionKey(): Buffer {
  const key = Buffer.from(config.tokenEncryptionKey, "base64");
  if (!config.tokenEncryptionKey || key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key. Generate one with: openssl rand -base64 32");
  }
  return key;
}

function encrypt(tokens: Credentials): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
  const envelope: Envelope = {
    v: 1,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
  return JSON.stringify(envelope);
}

function decrypt(value: string): Credentials {
  try {
    const envelope = JSON.parse(value) as Partial<Envelope>;
    if (
      envelope.v !== 1 ||
      typeof envelope.iv !== "string" ||
      typeof envelope.tag !== "string" ||
      typeof envelope.ciphertext !== "string"
    ) {
      throw new Error("Invalid credential envelope");
    }

    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(envelope.iv, "base64url"));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as Credentials;
  } catch {
    throw new Error("Stored Gmail credentials could not be decrypted. Verify TOKEN_ENCRYPTION_KEY.");
  }
}

function requireInitialization(): void {
  if (!initialized) throw new Error("OAuth token store was used before initialization.");
}

function mutate<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

/** Hydrate one in-memory copy so ordinary health checks do not query Turso. */
export async function initializeTokenStore(): Promise<void> {
  encryptionKey();
  const stored = await getEncryptedOAuthCredentials();
  cachedToken = stored ? decrypt(stored) : null;
  initialized = true;
}

export function loadToken(): Credentials | null {
  requireInitialization();
  return cachedToken ? { ...cachedToken } : null;
}

export function hasToken(): boolean {
  const token = loadToken();
  return Boolean(token?.refresh_token || token?.access_token);
}

export async function saveToken(tokens: Credentials): Promise<void> {
  requireInitialization();
  await mutate(async () => {
    await setEncryptedOAuthCredentials(encrypt(tokens));
    cachedToken = { ...tokens };
    tokenGeneration++;
  });
}

export function currentTokenGeneration(): number {
  requireInitialization();
  return tokenGeneration;
}

/** Ignore refreshes from a client superseded by reconnect or disconnect. */
export async function saveRefreshedToken(generation: number, tokens: Credentials): Promise<boolean> {
  requireInitialization();
  return mutate(async () => {
    if (generation !== tokenGeneration) return false;
    await setEncryptedOAuthCredentials(encrypt(tokens));
    cachedToken = { ...tokens };
    return true;
  });
}

export async function deleteToken(): Promise<void> {
  requireInitialization();
  await mutate(async () => {
    await deleteOAuthCredentials();
    cachedToken = null;
    tokenGeneration++;
  });
}
