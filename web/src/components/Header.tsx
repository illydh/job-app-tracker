import type { Health, SyncProgress } from "../lib/types";

interface Props {
  health: Health | null;
  healthError: string | null;
  syncing: boolean;
  progress: SyncProgress | null;
  onSync: () => void;
  onToggleSettings: () => void;
  settingsOpen: boolean;
  query: string;
  onQuery: (q: string) => void;
}

function Pill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`pill ${ok ? "pill-ok" : "pill-bad"}`}>
      <span className="dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export function Header({
  health,
  healthError,
  syncing,
  progress,
  onSync,
  onToggleSettings,
  settingsOpen,
  query,
  onQuery,
}: Props) {
  const gmailOk = Boolean(health?.gmail.connected);
  const modelOk = Boolean(health?.ollama.reachable && health.ollama.modelAvailable);
  const canSync = gmailOk && modelOk && !syncing;

  return (
    <header className="header">
      <div className="header-row">
        <div className="brand">
          <h1>Job Applications</h1>
          {health && (
            <span className="muted small">
              {health.stats.applications} tracked · since {health.gmail.syncSince}
            </span>
          )}
        </div>

        <div className="header-actions">
          <input
            className="search"
            type="search"
            placeholder="Filter by company or role…"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
          <button className="btn btn-primary" onClick={onSync} disabled={!canSync}>
            {syncing ? "Syncing…" : "Sync inbox"}
          </button>
          <button className="btn" onClick={onToggleSettings} aria-expanded={settingsOpen}>
            Setup
          </button>
        </div>
      </div>

      <div className="header-row status-row">
        {healthError ? (
          <Pill ok={false} label={`Backend unreachable — ${healthError}`} />
        ) : (
          <>
            <Pill
              ok={gmailOk}
              label={
                health?.gmail.profile?.emailAddress ??
                (health?.gmail.needsReauth ? "Gmail authorisation expired" : "Gmail not connected")
              }
            />
            <Pill
              ok={modelOk}
              label={
                !health?.ollama.reachable
                  ? "Ollama offline"
                  : health.ollama.modelAvailable
                    ? `Model ${health.ollama.model}`
                    : `Model ${health.ollama.model} not pulled`
              }
            />
            {health?.lastSyncAt && (
              <span className="muted small">Last sync {new Date(health.lastSyncAt).toLocaleString()}</span>
            )}
          </>
        )}
      </div>

      {syncing && progress && (
        <div className="progress">
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{
                width: progress.total
                  ? `${Math.round(((progress.classified + progress.prefiltered) / progress.total) * 100)}%`
                  : "8%",
              }}
            />
          </div>
          <span className="muted small">{progress.message}</span>
        </div>
      )}
    </header>
  );
}
