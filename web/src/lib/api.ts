import type { Application, AppEvent, Health, SimilarCandidate, Status, SyncProgress } from "./types";

const STORAGE_KEY = "jat.apiBase";
const DEFAULT_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:4000";

/**
 * The backend runs on the user's own machine, so its address cannot be baked
 * into a static build. It is configurable at runtime and remembered locally.
 */
export function getApiBase(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_BASE;
  } catch {
    return DEFAULT_BASE;
  }
}

export function setApiBase(base: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, base.replace(/\/$/, ""));
  } catch {
    /* private browsing — fall back to the default for this session */
  }
}

const TOKEN_KEY = "jat.authToken";

/**
 * A bearer token rather than a cookie: the UI and API are on different
 * origins even in the everyday case (localhost:5173 calling localhost:4000),
 * so a cookie would need SameSite=None, which browsers refuse to send back to
 * a plain http:// origin. A header sidesteps that entirely.
 */
export function getAuthToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAuthToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private browsing — the session just won't persist across reloads */
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAuthToken();
  const res = await fetch(`${getApiBase()}/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError((detail as { error?: string }).error ?? `HTTP ${res.status}`, res.status);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => request<Health>("/health"),
  applications: () => request<{ applications: Application[]; ghostAfterDays: number }>("/applications"),
  events: (id: number) => request<{ events: AppEvent[] }>(`/applications/${id}/events`),
  syncStatus: () => request<{ syncing: boolean; progress: SyncProgress }>("/sync"),
  startSync: () => request<{ started: boolean }>("/sync", { method: "POST" }),
  setStatus: (id: number, status: Status) =>
    request<unknown>(`/applications/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),
  setNotes: (id: number, notes: string) =>
    request<unknown>(`/applications/${id}`, { method: "PATCH", body: JSON.stringify({ notes }) }),
  remove: (id: number) => request<{ deleted: boolean }>(`/applications/${id}`, { method: "DELETE" }),
  similar: (id: number, signal?: AbortSignal) =>
    request<{ candidates: SimilarCandidate[] }>(`/applications/${id}/similar`, { signal }),
  /** Folds `otherId` into `id`; `id` survives, so the UI keeps its selection. */
  merge: (id: number, otherId: number) =>
    request<unknown>(`/applications/${id}/merge`, { method: "POST", body: JSON.stringify({ otherId }) }),
  dismissSimilar: (id: number, otherId: number) =>
    request<{ dismissed: boolean }>(`/applications/${id}/dismiss-similar`, {
      method: "POST",
      body: JSON.stringify({ otherId }),
    }),
  disconnect: () => request<{ connected: boolean }>("/auth/disconnect", { method: "POST" }),
  authStatus: () => request<{ required: boolean }>("/auth/status"),
  login: (password: string) =>
    request<{ token: string }>("/auth/login", { method: "POST", body: JSON.stringify({ password }) }),
  authUrl: () => {
    // window.open() navigates the browser directly, so it can't carry an
    // Authorization header — the token rides along as a query param instead.
    const token = getAuthToken();
    const url = `${getApiBase()}/api/auth/start`;
    return token ? `${url}?token=${encodeURIComponent(token)}` : url;
  },
};
