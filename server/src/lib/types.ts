/**
 * Canonical pipeline status values.
 *
 * `ghosted` is deliberately NOT in this list: it is *derived* from silence, not
 * asserted by any email, so the classifier can never emit it. See `deriveStage`.
 */
export const STATUSES = [
  "applied",
  "assessment",
  "interview",
  "offer",
  "rejected",
] as const;

export type Status = (typeof STATUSES)[number];

/** What the UI displays: a stored status, or the derived `ghosted` state. */
export type Stage = Status | "ghosted";

export const STAGE_LABELS: Record<Stage, string> = {
  applied: "Waiting to hear back",
  assessment: "Technical assessment",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
  ghosted: "Ghosted",
};

/**
 * Ordering used to break ties when two events share a timestamp, and to keep a
 * terminal outcome from being clobbered by a stray automated follow-up.
 */
export const STATUS_RANK: Record<Status, number> = {
  applied: 0,
  assessment: 1,
  interview: 2,
  rejected: 3,
  offer: 4,
};

export interface GmailMessage {
  id: string;
  threadId: string;
  fromAddr: string;
  fromName: string;
  subject: string;
  snippet: string;
  body: string;
  internalDate: number;
}

/** Structured result returned by the local model for a single email. */
export interface Classification {
  is_job_application: boolean;
  company: string | null;
  role: string | null;
  status: Status | null;
  confidence: number;
  summary: string;
}

export interface ApplicationRow {
  id: number;
  company: string;
  company_key: string;
  role: string | null;
  role_key: string;
  status: Status;
  status_source: "model" | "manual";
  confidence: number;
  first_seen_at: number;
  last_event_at: number;
  notes: string | null;
}

export interface EventRow {
  id: number;
  application_id: number;
  message_id: string;
  status: Status;
  confidence: number;
  summary: string;
  subject: string;
  from_addr: string;
  occurred_at: number;
}
