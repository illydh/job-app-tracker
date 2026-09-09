import { useCallback, useEffect, useMemo, useState } from "react";
import { Board } from "./components/Board";
import { DetailPanel } from "./components/DetailPanel";
import { Header } from "./components/Header";
import { Landing } from "./components/Landing";
import { Login } from "./components/Login";
import { SettingsPanel } from "./components/SettingsPanel";
import { ApiError, api, getAuthToken, setAuthToken } from "./lib/api";
import type { Application, Health, SyncProgress } from "./lib/types";

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [applications, setApplications] = useState<Application[]>([]);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Distinguishes "still asking the server" from "asked, and nobody is
  // connected" — without it the landing page flashes on every reload.
  const [ready, setReady] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [authed, setAuthed] = useState(Boolean(getAuthToken()));

  const refresh = useCallback(async () => {
    try {
      const [h, a] = await Promise.all([api.health(), api.applications()]);
      setHealth(h);
      setApplications(a.applications);
      setSyncing(h.syncing);
      setHealthError(null);
      setAuthed(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // The stored token was rejected — server restarted with a new
        // password, or there never was a valid one. Back to the login screen.
        setAuthToken(null);
        setAuthed(false);
        setHealth(null);
      } else {
        setHealthError((err as Error).message);
        setHealth(null);
      }
    } finally {
      setReady(true);
    }
  }, []);

  const logout = useCallback(() => {
    setAuthToken(null);
    setAuthed(false);
    setHealth(null);
    setApplications([]);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const status = await api.authStatus();
        setAuthRequired(status.required);
        if (status.required && !getAuthToken()) {
          setReady(true);
          return;
        }
      } catch (err) {
        setHealthError((err as Error).message);
        setReady(true);
        return;
      }
      void refresh();
    })();
  }, [refresh]);

  // While a sync runs, poll progress; refresh the board once it finishes.
  useEffect(() => {
    if (!syncing) return;
    const timer = setInterval(async () => {
      try {
        const { syncing: still, progress: p } = await api.syncStatus();
        setProgress(p);
        if (!still) {
          setSyncing(false);
          void refresh();
        }
      } catch {
        setSyncing(false);
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [syncing, refresh]);

  const startSync = useCallback(async () => {
    try {
      await api.startSync();
      setSyncing(true);
    } catch (err) {
      setHealthError((err as Error).message);
    }
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return applications;
    return applications.filter(
      (a) => a.company.toLowerCase().includes(q) || (a.role ?? "").toLowerCase().includes(q),
    );
  }, [applications, query]);

  const selected = applications.find((a) => a.id === selectedId) ?? null;

  // Hold the first paint until health has been answered once, so a returning
  // user goes straight to their board instead of blinking through onboarding.
  if (!ready) return <div className="app" />;

  if (authRequired && !authed) {
    return <Login onSuccess={() => void refresh()} />;
  }

  // No cached profile — never connected, disconnected, or the token lapsed.
  if (!health?.gmail.profile) {
    return <Landing health={health} healthError={healthError} onRefresh={refresh} />;
  }

  return (
    <div className="app">
      <Header
        health={health}
        healthError={healthError}
        syncing={syncing}
        progress={progress}
        onSync={startSync}
        onToggleSettings={() => setSettingsOpen((v) => !v)}
        settingsOpen={settingsOpen}
        query={query}
        onQuery={setQuery}
        onLogout={authRequired ? logout : undefined}
      />

      {settingsOpen && <SettingsPanel health={health} healthError={healthError} onSaved={refresh} />}

      <main className="main">
        {applications.length === 0 && !healthError ? (
          <div className="empty">
            <h2>No applications yet</h2>
            <p className="muted">
              Press <strong>Sync inbox</strong> to read your email since {health.gmail.syncSince} and find
              applications.
            </p>
          </div>
        ) : (
          <Board applications={filtered} selectedId={selectedId} onSelect={(a) => setSelectedId(a.id)} />
        )}

        {selected && (
          <DetailPanel
            app={selected}
            onClose={() => setSelectedId(null)}
            onChanged={refresh}
          />
        )}
      </main>
    </div>
  );
}
