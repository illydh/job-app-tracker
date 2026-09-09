import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { STAGE_LABELS, STATUSES, type AppEvent, type Application, type Status } from "../lib/types";

interface Props {
  app: Application;
  onClose: () => void;
  onChanged: () => void;
}

export function DetailPanel({ app, onClose, onChanged }: Props) {
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [notes, setNotes] = useState(app.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setNotes(app.notes ?? "");
    let cancelled = false;
    api
      .events(app.id)
      .then((r) => !cancelled && setEvents(r.events))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [app.id, app.notes]);

  async function act(fn: () => Promise<unknown>) {
    setSaving(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <aside className="detail">
      <div className="detail-head">
        <div>
          <h2>{app.company}</h2>
          {app.role && <p className="muted">{app.role}</p>}
        </div>
        <button className="btn btn-icon" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <div className="detail-section">
        <label htmlFor="stage-select">Stage</label>
        <select
          id="stage-select"
          value={app.status}
          disabled={saving}
          onChange={(e) => act(() => api.setStatus(app.id, e.target.value as Status))}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABELS[s]}
            </option>
          ))}
        </select>
        <p className="muted small">
          {app.statusSource === "manual"
            ? "Set by you — future syncs will not change it."
            : `Detected by the model (confidence ${Math.round(app.confidence * 100)}%).`}
          {app.stage === "ghosted" && " Currently shown as ghosted due to inactivity."}
        </p>
      </div>

      <div className="detail-section">
        <label htmlFor="notes">Notes</label>
        <textarea
          id="notes"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== (app.notes ?? "") && act(() => api.setNotes(app.id, notes))}
          placeholder="Anything worth remembering…"
        />
      </div>

      <div className="detail-section">
        <label>Timeline</label>
        <ol className="timeline">
          {events.map((e) => (
            <li key={e.id}>
              <div className="timeline-head">
                <span className={`badge badge-${e.status}`}>{STAGE_LABELS[e.status]}</span>
                <span className="muted small">{new Date(e.occurredAt).toLocaleDateString()}</span>
              </div>
              <p className="timeline-subject">{e.subject || "(no subject)"}</p>
              <p className="muted small">{e.summary}</p>
            </li>
          ))}
          {events.length === 0 && <p className="muted small">No events recorded.</p>}
        </ol>
      </div>

      {error && <p className="notice notice-bad">{error}</p>}

      <button
        className="btn btn-danger"
        disabled={saving}
        onClick={() => {
          if (confirm(`Remove ${app.company} from the tracker?`)) {
            act(async () => {
              await api.remove(app.id);
              onClose();
            });
          }
        }}
      >
        Remove application
      </button>
    </aside>
  );
}
