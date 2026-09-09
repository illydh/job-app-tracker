import { useEffect, useState } from "react";
import { api, getApiBase, setApiBase } from "../lib/api";
import type { Health } from "../lib/types";

interface Props {
  health: Health | null;
  healthError: string | null;
  /** Re-reads health; the landing page advances once a profile appears. */
  onRefresh: () => void;
}

/**
 * Server-supplied diagnostics often name the console page that fixes them.
 * Stopping at the first comma keeps trailing prose out of the href.
 */
const URL_SPLIT = /((?:https?:\/\/|console\.cloud\.google\.com\/)[^\s,)]+)/g;
// Separate and un-global on purpose: `.test()` on a /g regex advances lastIndex
// between calls, which would misclassify alternating fragments.
const IS_URL = /^(?:https?:\/\/|console\.cloud\.google\.com\/)/;

function withLinks(text: string): React.ReactNode[] {
  return text.split(URL_SPLIT).map((part, i) =>
    IS_URL.test(part) ? (
      <a key={i} href={part.startsWith("http") ? part : `https://${part}`} target="_blank" rel="noreferrer">
        {part}
      </a>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function Check({ state, children }: { state: "ok" | "bad" | "idle"; children: React.ReactNode }) {
  return (
    <li className={`check check-${state}`}>
      <span className="check-mark" aria-hidden="true">
        {state === "ok" ? "✓" : state === "bad" ? "!" : "·"}
      </span>
      <span>{children}</span>
    </li>
  );
}

/**
 * The unauthenticated entry point.
 *
 * Shown whenever there is no cached Gmail profile, which covers a first run, a
 * disconnect, and an expired token alike. It owns the whole setup path — server
 * address, model readiness, then consent — so the OAuth flow is something the
 * page initiates rather than something the user has to go find.
 */
export function Landing({ health, healthError, onRefresh }: Props) {
  const [waiting, setWaiting] = useState(false);
  const [base, setBase] = useState(getApiBase());
  const [showAdvanced, setShowAdvanced] = useState(false);

  const serverUp = Boolean(health) && !healthError;
  const modelReady = Boolean(health?.ollama.reachable && health.ollama.modelAvailable);
  const needsReauth = Boolean(health?.gmail.needsReauth);
  // A setup fault that reconnecting cannot fix — offering consent again would
  // just loop the user, so the CTA steps aside for the instruction.
  const configError = health?.gmail.error ?? null;

  // Google's consent screen runs in its own tab, so the only way back is to
  // watch for the profile to appear.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(onRefresh, 1500);
    return () => clearInterval(timer);
  }, [waiting, onRefresh]);

  // A dead server mid-wait means the poll can never succeed; stop pretending.
  useEffect(() => {
    if (healthError) setWaiting(false);
  }, [healthError]);

  function connect() {
    setWaiting(true);
    window.open(api.authUrl(), "_blank", "noopener,noreferrer");
  }

  return (
    <div className="landing">
      <div className="landing-card">
        <h1 className="landing-title">Job Application Tracker</h1>
        <p className="landing-lede">
          Reads your inbox, works out which emails are about jobs you applied to, and tracks each one
          through to an offer or a rejection.
        </p>

        <ul className="landing-points">
          <li>Finds applications, assessments, interviews, offers and rejections automatically</li>
          <li>Flags the ones that have gone quiet, so nothing sits forgotten</li>
          <li>Reading and classification happen entirely on this machine</li>
        </ul>

        <ul className="checklist">
          <Check state={serverUp ? "ok" : "bad"}>
            {serverUp ? (
              "Local server running"
            ) : (
              <>
                Local server not running — start it with <code>npm run dev:server</code>
              </>
            )}
          </Check>
          <Check state={!serverUp ? "idle" : modelReady ? "ok" : "bad"}>
            {!serverUp ? (
              "Local model"
            ) : modelReady ? (
              <>Local model {health?.ollama.model} ready</>
            ) : !health?.ollama.reachable ? (
              <>
                Ollama not running — start it with <code>ollama serve</code>
              </>
            ) : (
              <>
                Model missing — run <code>ollama pull {health.ollama.model}</code>
              </>
            )}
          </Check>
          <Check state={needsReauth || configError ? "bad" : "idle"}>
            {configError
              ? "Gmail unreachable — see below"
              : needsReauth
                ? "Gmail access expired — reconnect below"
                : "Gmail not connected"}
          </Check>
        </ul>

        {needsReauth && health?.gmail.authError && <p className="notice notice-bad">{health.gmail.authError}</p>}
        {configError && <p className="notice notice-bad">{withLinks(configError)}</p>}

        <button
          className="btn btn-primary btn-lg"
          onClick={configError ? onRefresh : connect}
          disabled={!serverUp || waiting}
        >
          {configError
            ? "Retry"
            : waiting
              ? "Waiting for Google…"
              : needsReauth
                ? "Reconnect Gmail"
                : "Connect Gmail"}
        </button>

        {configError ? null : waiting ? (
          <p className="muted small landing-foot">
            Finish the consent screen in the tab that opened, then come back here.{" "}
            <button className="linkish" onClick={() => setWaiting(false)}>
              Cancel
            </button>
          </p>
        ) : (
          <p className="muted small landing-foot">
            Grants <strong>read-only</strong> access. This app cannot send, change, or delete anything, and
            your email is never uploaded anywhere.
          </p>
        )}

        {!modelReady && serverUp && (
          <p className="muted small landing-foot">
            You can connect now and pull the model later — syncing needs it, signing in does not.
          </p>
        )}

        <button className="linkish landing-advanced" onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced ? "Hide" : "Server settings"}
        </button>

        {showAdvanced && (
          <div className="setting">
            <label htmlFor="landing-base">Backend address</label>
            <div className="setting-row">
              <input
                id="landing-base"
                value={base}
                onChange={(e) => setBase(e.target.value)}
                placeholder="http://localhost:4000"
                spellCheck={false}
              />
              <button
                className="btn"
                onClick={() => {
                  setApiBase(base.trim());
                  onRefresh();
                }}
              >
                Save
              </button>
            </div>
            <p className="muted small">
              The server runs on your own machine. This page only needs to know where to reach it.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
