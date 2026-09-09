import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { SimilarCandidate } from "../lib/types";

interface Props {
  appId: number;
  /** Called after a merge, so the board and this panel reload. */
  onMerged: () => void;
}

/**
 * Arrowing through the board should not queue a model call per card, so the
 * check waits for the selection to settle before asking.
 */
const SETTLE_MS = 400;
/** More than a few at once stops being a hint and starts being a chore. */
const MAX_SHOWN = 3;

/**
 * Quietly offers to merge applications that look like the same job recorded
 * twice — the classifier reads one email at a time, so it has no way to notice.
 *
 * Deliberately undemanding: nothing renders until the server has something to
 * say, a failed check is silent, and "Not the same" is remembered server-side so
 * the same pair is never raised again.
 */
export function DuplicateSuggestions({ appId, onMerged }: Props) {
  const [candidates, setCandidates] = useState<SimilarCandidate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped after a merge: the surviving row is new evidence, and may well match
  // something the earlier check ruled out.
  const [round, setRound] = useState(0);

  useEffect(() => {
    // Aborting matters beyond this component: the server stops asking the model
    // about a card the user has already clicked past.
    const abort = new AbortController();
    setCandidates([]);
    setError(null);

    const timer = setTimeout(() => {
      api
        .similar(appId, abort.signal)
        .then((r) => !abort.signal.aborted && setCandidates(r.candidates))
        // A suggestion is a nicety. If the check is unavailable, say nothing.
        .catch(() => undefined);
    }, SETTLE_MS);

    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [appId, round]);

  const resolve = useCallback(
    async (other: number, merge: boolean) => {
      setBusy(true);
      setError(null);
      try {
        if (merge) {
          await api.merge(appId, other);
          onMerged();
          setRound((n) => n + 1);
        } else {
          await api.dismissSimilar(appId, other);
          setCandidates((list) => list.filter((c) => c.id !== other));
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [appId, onMerged],
  );

  if (candidates.length === 0) return null;

  return (
    <div className="dupes">
      {candidates.slice(0, MAX_SHOWN).map((c) => (
        <div className="dupe" key={c.id}>
          <p className="dupe-lead">
            Possibly the same application as <strong>{c.company}</strong>
            {c.role ? ` · ${c.role}` : ""}
          </p>
          <p className="muted small">{c.reason}</p>
          <div className="dupe-actions">
            <button
              className="btn btn-small"
              disabled={busy}
              title={`Fold ${c.company} into this application`}
              onClick={() => resolve(c.id, true)}
            >
              Merge into this
            </button>
            <button className="btn btn-small btn-quiet" disabled={busy} onClick={() => resolve(c.id, false)}>
              Not the same
            </button>
          </div>
        </div>
      ))}
      {error && <p className="notice notice-bad">{error}</p>}
    </div>
  );
}
