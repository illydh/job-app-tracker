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
 * UI and API can be served from different origins.
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
          Use <code>http://localhost:4000</code> locally, or your Render HTTPS URL.
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
          Cannot reach the backend at <code>{getApiBase()}</code>. Check the address and service status,
          then Save above. {healthError}
        </p>
      )}

      {health && !health.ollama.reachable && (
        <p className="notice notice-bad">
          Ollama endpoint is not responding. Check <code>OLLAMA_HOST</code>.
        </p>
      )}

      {health && health.ollama.reachable && !health.ollama.modelAvailable && (
        <p className="notice notice-bad">
          Configured model unavailable. Check <code>OLLAMA_MODEL</code> on the model host.
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
