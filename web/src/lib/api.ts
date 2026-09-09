import type { Application, AppEvent, Health, Status, SyncProgress } from "./types";

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getApiBase()}/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((detail as { error?: string }).error ?? `HTTP ${res.status}`);
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
  disconnect: () => request<{ connected: boolean }>("/auth/disconnect", { method: "POST" }),
  authUrl: () => `${getApiBase()}/api/auth/start`,
};
