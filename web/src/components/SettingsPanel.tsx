import { useState } from "react";
import { api, getApiBase, setApiBase } from "../lib/api";
import type { Health } from "../lib/types";

interface Props {
  health: Health | null;
  healthError: string | null;
  onSaved: () => void;
}

/**
 * Setup lives in the UI rather than a build-time constant because the static
 * site is served from GitHub Pages while the API runs on the user's machine.
 */
export function SettingsPanel({ health, healthError, onSaved }: Props) {
  const [base, setBase] = useState(getApiBase());

  return (
    <section className="settings">
      <div className="setting">
        <label htmlFor="api-base">Backend address</label>
        <div className="setting-row">
          <input
            id="api-base"
            value={base}
            onChange={(e) => setBase(e.target.value)}
            placeholder="http://localhost:4000"
            spellCheck={false}
          />
          <button
            className="btn"
            onClick={() => {
              setApiBase(base.trim());
              onSaved();
            }}
          >
            Save
          </button>
        </div>
        <p className="muted small">
          The server runs locally: <code>npm run dev:server</code> in the project folder.
        </p>
      </div>

      <div className="setting">
        <label>Gmail</label>
        <div className="setting-row">
          <button
            className="btn btn-danger"
            onClick={() => {
              if (confirm("Disconnect Gmail? Tracked applications are kept.")) {
                void api.disconnect().then(onSaved);
              }
            }}
          >
            Disconnect
          </button>
          <span className="muted small">
            {health?.gmail.profile
              ? `Read-only access to ${health.gmail.profile.emailAddress}.`
              : "Not connected."}
          </span>
        </div>
      </div>


      {healthError && (
        <p className="notice notice-bad">
          Cannot reach the backend at <code>{getApiBase()}</code>. Start it with <code>npm run dev:server</code>,
          then Save above. {healthError}
        </p>
      )}

      {health && !health.ollama.reachable && (
        <p className="notice notice-bad">
          Ollama is not responding. Run <code>ollama serve</code>.
        </p>
      )}

      {health && health.ollama.reachable && !health.ollama.modelAvailable && (
        <p className="notice notice-bad">
          Model not installed. Run <code>ollama pull {health.ollama.model}</code>.
        </p>
      )}

      {health && (
        <div className="setting">
          <label>Pipeline</label>
          <p className="muted small">
            {health.stats.messages} emails seen · {health.stats.prefiltered} filtered out ·{" "}
            {health.stats.classified} reviewed by the model · {health.stats.events} events recorded
          </p>
        </div>
      )}
    </section>
  );
}
