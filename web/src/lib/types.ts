/** Mirrors server/src/lib/types.ts — kept small and duplicated so the static
 *  frontend build has no dependency on the server workspace. */

export const STATUSES = ["applied", "assessment", "interview", "offer", "rejected"] as const;
export type Status = (typeof STATUSES)[number];
export type Stage = Status | "ghosted";

export const STAGE_ORDER: Stage[] = ["applied", "assessment", "interview", "offer", "rejected", "ghosted"];

export const STAGE_LABELS: Record<Stage, string> = {
  applied: "Waiting to hear back",
  assessment: "Technical assessment",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
  ghosted: "Ghosted",
};

export interface Application {
  id: number;
  company: string;
  role: string | null;
  status: Status;
  stage: Stage;
  statusSource: "model" | "manual";
  confidence: number;
  firstSeenAt: number;
  lastEventAt: number;
  daysSinceLastEvent: number;
  notes: string | null;
  eventCount: number;
  latestSummary: string | null;
}

/** Another application the server thinks is the same one recorded twice. */
export interface SimilarCandidate {
  id: number;
  company: string;
  role: string | null;
  eventCount: number;
  lastEventAt: number;
  score: number;
  reason: string;
  basis: "thread" | "lexical" | "model";
}

export interface AppEvent {
  id: number;
  status: Status;
  confidence: number;
  summary: string;
  subject: string;
  from: string;
  occurredAt: number;
}

export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  connectedAt: number;
}

export interface Health {
  ok: boolean;
  gmail: {
    connected: boolean;
    needsReauth: boolean;
    authError: string | null;
    /** A non-auth problem reading the mailbox, e.g. the Gmail API being disabled. */
    error: string | null;
    profile: GmailProfile | null;
    syncSince: string;
  };
  ollama: { reachable: boolean; model: string; modelAvailable: boolean; models: string[]; error?: string };
  stats: { messages: number; pending: number; prefiltered: number; classified: number; applications: number; events: number };
  lastSyncAt: number | null;
  syncing: boolean;
}

export interface SyncProgress {
  phase: "idle" | "fetching" | "classifying" | "done" | "error";
  fetched: number;
  prefiltered: number;
  classified: number;
  matched: number;
  total: number;
  errors: string[];
  message: string;
}
