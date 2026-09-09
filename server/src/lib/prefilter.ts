import type { GmailMessage } from "./types.ts";

/**
 * A cheap keyword gate that runs before the model.
 *
 * The local model is by far the slowest part of a sync (seconds per email), so
 * this exists purely to keep it from being handed obvious noise. It is tuned for
 * recall, not precision: anything remotely plausible is passed through and the
 * model makes the real call. Only two classes of mail are rejected outright —
 * messages with no hiring vocabulary at all, and job-board *alert* blasts, which
 * are voluminous and always keyword-rich.
 */

const SIGNAL_PATTERNS: RegExp[] = [
  /\bapplication\b/i,
  /\bapplied\b/i,
  /\bapplying\b/i,
  /\bthank you for your interest\b/i,
  /\bwe received your\b/i,
  /\binterview\b/i,
  /\brecruit(er|ing|ment)\b/i,
  /\bhiring\b/i,
  /\bcandidate\b/i,
  /\btalent (team|acquisition)\b/i,
  /\bassessment\b/i,
  /\bcoding challenge\b/i,
  /\btake[- ]home\b/i,
  /\bhackerrank|codesignal|coderpad|karat|codility|woven\b/i,
  /\bphone screen\b/i,
  /\bnext steps?\b/i,
  /\boffer letter\b/i,
  /\bnot (moving|move) forward\b/i,
  /\bmoving forward with other\b/i,
  /\bwe (regret|are unable)\b/i,
  /\bposition\b/i,
  /\bthe role\b/i,
  /\bjob (title|id|req|requisition)\b/i,
];

/** Applicant-tracking systems: near-certain signal regardless of wording. */
const ATS_SENDERS: RegExp[] = [
  /greenhouse\.io$/i,
  /lever\.co$/i,
  /hire\.lever\.co$/i,
  /ashbyhq\.com$/i,
  /myworkday(jobs)?\.com$/i,
  /workday(suite)?\.com$/i,
  /smartrecruiters\.com$/i,
  /jobvite\.com$/i,
  /icims\.com$/i,
  /taleo\.net$/i,
  /bamboohr\.com$/i,
  /workable(mail)?\.com$/i,
  /breezy\.hr$/i,
  /teamtailor(mail)?\.com$/i,
  /rippling\.com$/i,
  /dover\.com$/i,
  /wellfound\.com$/i,
  /angel\.co$/i,
  /paylocity\.com$/i,
  /successfactors\.com$/i,
];

/**
 * Job-board digests. These mention "job" dozens of times but never describe an
 * application *you* made, so they are the single biggest source of wasted model
 * calls on a typical inbox.
 */
const ALERT_SENDERS: RegExp[] = [
  /jobalerts-noreply@linkedin\.com/i,
  /jobs-listings@linkedin\.com/i,
  /^alert@indeed\.com/i,
  /invitetoapply@indeed\.com/i,
  /@glassdoor\.com$/i,
  /@ziprecruiter\.com$/i,
  /@dice\.com$/i,
  /noreply@.*\bjobalert/i,
];

const ALERT_SUBJECTS: RegExp[] = [
  /\bjob alert\b/i,
  /\bjobs? (you may|might) be interested in\b/i,
  /\bnew jobs? (for|matching|at)\b/i,
  /\b\d+ new jobs?\b/i,
  /\brecommended (jobs|for you)\b/i,
  /\bapply now\b/i,
  /\bjobs? similar to\b/i,
  /\byour job search\b/i,
  /\bhiring now\b/i,
];

export interface PrefilterResult {
  keep: boolean;
  reason: string;
}

export function prefilter(msg: GmailMessage): PrefilterResult {
  const sender = `${msg.fromName} <${msg.fromAddr}>`;
  const subject = msg.subject;
  // The first slice of the body carries the verdict in virtually every case.
  const haystack = `${subject}\n${msg.snippet}\n${msg.body.slice(0, 1500)}`;

  const fromATS = ATS_SENDERS.some((re) => re.test(msg.fromAddr));

  const isAlert =
    ALERT_SENDERS.some((re) => re.test(msg.fromAddr)) || ALERT_SUBJECTS.some((re) => re.test(subject));
  // An ATS address outranks the alert heuristic: a real Greenhouse rejection can
  // legitimately contain phrases like "apply now" in its footer.
  if (isAlert && !fromATS) return { keep: false, reason: `job-board alert (${sender})` };

  if (fromATS) return { keep: true, reason: "known ATS sender" };

  const hits = SIGNAL_PATTERNS.filter((re) => re.test(haystack));
  if (hits.length === 0) return { keep: false, reason: "no hiring vocabulary" };

  return { keep: true, reason: `${hits.length} signal(s)` };
}
