import * as store from "./db.ts";
import { judgeDuplicate } from "./ollama.ts";
import type { ApplicationRow } from "./types.ts";

/**
 * Finding applications that are really the same application recorded twice.
 *
 * The classifier reads one email at a time and never sees the board, so two
 * emails about one job can name it "Software Engineer" and "Software Engineer
 * II, Platform" and land on separate rows. Rather than tightening the matching
 * rules — which trades duplicates for silent *mis*-merges, the worse failure —
 * this runs after the fact, when the user opens an application, and asks.
 *
 * Three signals, cheapest first:
 *   1. a shared Gmail thread, which is near-proof and costs one join;
 *   2. lexical similarity of the normalised company and role keys;
 *   3. the local model, but only for pairs (2) leaves genuinely ambiguous.
 *
 * Only (3) is slow, so it is bounded per request and its verdicts are cached.
 */

/** Below this company similarity, two rows are simply different employers. */
const COMPANY_FLOOR = 0.72;
/** Role similarity so high the model has nothing to add. */
const ROLE_CERTAIN = 0.85;
/**
 * Model calls per request. A verdict costs several seconds on a 4B model and is
 * cached forever after, so the budget only bounds the very first look at a card.
 */
const MODEL_BUDGET = 3;
/** A hesitant "yes" from a 4B model is not worth interrupting the user for. */
const MODEL_MIN_CONFIDENCE = 0.6;
/** Below this a pair is not worth a model call even when the employer matches. */
const ASK_FLOOR = 0.3;

/* ----------------------------------------------------------- string maths --- */

/** Words that decorate an employer or title without identifying it. */
const NOISE = new Set([
  "the", "a", "an", "and", "of", "at", "for", "to", "in",
  "team", "careers", "career", "recruiting", "recruitment", "talent", "hiring", "jobs",
]);

function tokens(key: string): Set<string> {
  return new Set(
    key
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0 && !NOISE.has(t)),
  );
}

function trigrams(s: string): Set<string> {
  const padded = ` ${s} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

function overlapCount<T>(a: Set<T>, b: Set<T>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

function dice<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 || b.size === 0) return 0;
  return (2 * overlapCount(a, b)) / (a.size + b.size);
}

/**
 * How alike two normalised keys are, 0–1.
 *
 * Token overlap carries most of the weight because it is what actually
 * distinguishes jobs: "backend" vs "frontend" is one token, but more than half
 * the characters. Character trigrams are kept as a minority vote so that
 * near-misses the tokeniser splits apart ("fullstack" / "full stack") still
 * score, without letting a shared suffix ("… engineer") carry a pair on its own.
 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;

  const shared = overlapCount(ta, tb);
  const containment = shared / Math.min(ta.size, tb.size);
  const jaccard = shared / (ta.size + tb.size - shared);
  const tokenScore = 0.6 * containment + 0.4 * jaccard;

  return 0.68 * tokenScore + 0.32 * dice(trigrams(a), trigrams(b));
}

/* -------------------------------------------------------------- candidates --- */

export interface SimilarCandidate {
  id: number;
  company: string;
  role: string | null;
  eventCount: number;
  lastEventAt: number;
  /** 0–1 confidence that this is the same application as the one asked about. */
  score: number;
  /** One short clause explaining the match, shown to the user. */
  reason: string;
  basis: "thread" | "lexical" | "model";
}

/** Cache key: the *content* of both sides, so a rename invalidates it by itself. */
function pairKey(a: ApplicationRow, b: ApplicationRow): string {
  const fingerprint = (x: ApplicationRow) => `${x.company_key}|${x.role_key}`;
  return [fingerprint(a), fingerprint(b)].sort().join("~");
}

function shareAny<T>(a: Set<T>, b: Set<T>): boolean {
  return overlapCount(a, b) > 0;
}

/** Ollama being down should not print a line per click. */
let lastWarnedAt = 0;

function warnOnce(message: string): void {
  if (Date.now() - lastWarnedAt < 60_000) return;
  lastWarnedAt = Date.now();
  console.error("  ! duplicate check unavailable —", message);
}

/**
 * Every application that looks like a duplicate of `id`, best match first.
 *
 * Pairs the user has already rejected are never returned again, and a failing
 * or absent Ollama degrades to the lexical signals rather than erroring: a
 * duplicate suggestion is a nicety, and must never break opening a card.
 *
 * `signal` aborts the adjudication when the caller stops caring — clicking
 * through the board must not leave a queue of model calls running behind it.
 */
export async function findDuplicates(id: number, signal?: AbortSignal): Promise<SimilarCandidate[]> {
  const target = store.getApplication(id);
  if (!target) return [];

  const dismissed = store.dismissedFor(id);
  const signals = store.applicationSignals();
  const mine = signals.get(id) ?? { threads: new Set<string>(), domains: new Set<string>() };

  const found: SimilarCandidate[] = [];
  const ambiguous: { row: ApplicationRow; score: number }[] = [];

  for (const other of store.listApplications()) {
    if (other.id === id || dismissed.has(other.id)) continue;

    const theirs = signals.get(other.id) ?? { threads: new Set<string>(), domains: new Set<string>() };

    // A shared Gmail thread is the one signal that does not depend on what the
    // model called anything, so it bypasses the rest of the ladder.
    if (shareAny(mine.threads, theirs.threads)) {
      found.push(describe(other, 0.97, "Both were built from the same email thread.", "thread"));
      continue;
    }

    const company = Math.max(
      similarity(target.company_key, other.company_key),
      shareAny(mine.domains, theirs.domains) ? 0.9 : 0,
    );
    if (company < COMPANY_FLOOR) continue;

    const bothUnknown = target.role_key === "" && other.role_key === "";
    const oneUnknown = target.role_key === "" || other.role_key === "";
    const role = bothUnknown ? 0.85 : oneUnknown ? 0.7 : similarity(target.role_key, other.role_key);

    // The employer is a prerequisite; the role is what actually decides.
    const score = 0.35 * company + 0.65 * role;

    if (role >= ROLE_CERTAIN) {
      found.push(describe(other, score, "Same employer, and the roles read as one job.", "lexical"));
    } else if (score >= ASK_FLOOR) {
      ambiguous.push({ row: other, score });
    }
  }

  /* --------------------------------------------- adjudicate what's unclear --- */

  // Best-looking pairs get the budget; a model that is down or slow costs one
  // failure, not one per candidate.
  ambiguous.sort((a, b) => b.score - a.score);
  let modelUsable = true;

  for (const { row } of ambiguous.slice(0, MODEL_BUDGET)) {
    const key = pairKey(target, row);
    let verdict = store.getVerdict(key);

    if (!verdict) {
      if (!modelUsable || signal?.aborted) break;
      try {
        const judged = await judgeDuplicate(target, row, signal);
        verdict = { similar: judged.same, score: judged.confidence, reason: judged.reason.slice(0, 120) };
        store.putVerdict(key, verdict);
      } catch (err) {
        // Not an error the user needs to see: fall back to the lexical answer,
        // which for these pairs is "probably not a duplicate".
        if (!signal?.aborted) warnOnce((err as Error).message);
        modelUsable = false;
        break;
      }
    }

    if (verdict.similar && verdict.score >= MODEL_MIN_CONFIDENCE) {
      found.push(describe(row, verdict.score, verdict.reason || "The model reads these as one application.", "model"));
    }
  }

  return found.sort((a, b) => b.score - a.score);
}

function describe(
  row: ApplicationRow,
  score: number,
  reason: string,
  basis: SimilarCandidate["basis"],
): SimilarCandidate {
  return {
    id: row.id,
    company: row.company,
    role: row.role,
    eventCount: store.listEvents(row.id).length,
    lastEventAt: row.last_event_at,
    score,
    reason,
    basis,
  };
}
