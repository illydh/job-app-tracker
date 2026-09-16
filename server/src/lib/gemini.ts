import { z } from "zod";
import { config } from "./config.ts";
import { STATUSES, type Classification, type GmailMessage, type Status } from "./types.ts";

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Gemini's Schema type uses uppercase type names (OBJECT, STRING, ...), unlike
 * plain JSON Schema — this is the REST wire format for `responseSchema`, not a
 * dialect choice.
 */
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    is_job_application: { type: "BOOLEAN" },
    company: { type: "STRING" },
    role: { type: "STRING" },
    status: { type: "STRING", enum: [...STATUSES, "none"] },
    confidence: { type: "NUMBER" },
    summary: { type: "STRING" },
  },
  required: ["is_job_application", "company", "role", "status", "confidence", "summary"],
} as const;

const ResponseSchema = z.object({
  is_job_application: z.boolean(),
  company: z.string(),
  role: z.string(),
  status: z.enum([...STATUSES, "none"]),
  confidence: z.number(),
  summary: z.string(),
});

const SYSTEM_PROMPT = `You classify emails for a personal job-application tracker.

You will be given one email. Decide whether it concerns a job application THIS USER submitted, then extract the details.

is_job_application = true ONLY when the email is from (or on behalf of) an employer or its applicant-tracking system about a specific application the user made.
Set it to false for: job-board alerts and digests, recruiter cold outreach about a role the user has not applied to, newsletters, job-search advice, course/bootcamp marketing, and anything unrelated to hiring.

status must be exactly one of:
- "applied"     - application received / confirmation of submission / "we are reviewing your application"
- "assessment"  - an online assessment, coding challenge, take-home, or test has been assigned
- "interview"   - an interview (phone screen, technical, onsite, final) is being scheduled, confirmed, or followed up on
- "offer"       - an employment offer is being extended
- "rejected"    - the user is no longer being considered
- "none"        - only when is_job_application is false

company: the employer's name. NOT the ATS vendor (Greenhouse, Lever, Workday, Ashby, iCIMS are tools, not employers). Use "" if genuinely unknown.
role: the job title as written, without seniority decoration or location suffixes. Use "" if not stated.
confidence: 0.0-1.0, your certainty in is_job_application and status together.
summary: one short factual sentence describing what the email says. No speculation.

Return JSON only.`;

function buildUserPrompt(msg: GmailMessage): string {
  const date = new Date(msg.internalDate).toISOString().slice(0, 10);
  return [
    `From: ${msg.fromName} <${msg.fromAddr}>`,
    `Date: ${date}`,
    `Subject: ${msg.subject}`,
    "",
    // Trimmed hard: signal lives at the top, and long bodies dominate latency.
    msg.body.slice(0, 2500) || msg.snippet,
  ].join("\n");
}

export interface GeminiHealth {
  reachable: boolean;
  model: string;
  modelAvailable: boolean;
  models: string[];
  error?: string;
}

export async function health(): Promise<GeminiHealth> {
  if (!config.gemini.apiKey) {
    return { reachable: false, model: config.gemini.model, modelAvailable: false, models: [], error: "GEMINI_API_KEY is not set" };
  }
  try {
    const res = await fetch(`${API_ROOT}/models`, {
      headers: { "x-goog-api-key": config.gemini.apiKey },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { reachable: false, model: config.gemini.model, modelAvailable: false, models: [], error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { models?: { name: string }[] };
    // Gemini lists models as "models/gemini-3.5-flash-lite"; the configured
    // name is bare, so strip the prefix before comparing.
    const models = (data.models ?? []).map((m) => m.name.replace(/^models\//, ""));
    const modelAvailable = models.includes(config.gemini.model);
    return { reachable: true, model: config.gemini.model, modelAvailable, models };
  } catch (err) {
    return {
      reachable: false,
      model: config.gemini.model,
      modelAvailable: false,
      models: [],
      error: (err as Error).message,
    };
  }
}

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

/** One schema-constrained, deterministic exchange with Gemini. */
async function chatJson(
  system: string,
  user: string,
  schema: unknown,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<unknown> {
  const res = await fetch(`${API_ROOT}/models/${config.gemini.model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": config.gemini.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        // Deterministic: this is extraction, not writing.
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: schema,
      },
    }),
    signal: opts.signal
      ? AbortSignal.any([AbortSignal.timeout(opts.timeoutMs), opts.signal])
      : AbortSignal.timeout(opts.timeoutMs),
  });

  if (!res.ok) {
    throw new Error(`Gemini returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const payload = (await res.json()) as GenerateContentResponse;
  const raw = payload.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  if (!raw) {
    const reason = payload.promptFeedback?.blockReason ?? payload.candidates?.[0]?.finishReason ?? "empty response";
    throw new Error(`Gemini returned no usable content (${reason})`);
  }

  return JSON.parse(raw);
}

export async function classify(msg: GmailMessage): Promise<Classification> {
  const parsed = ResponseSchema.safeParse(
    await chatJson(SYSTEM_PROMPT, buildUserPrompt(msg), RESPONSE_SCHEMA, {
      timeoutMs: config.gemini.timeoutMs,
    }),
  );
  if (!parsed.success) {
    throw new Error(`Gemini response failed validation: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }

  const d = parsed.data;
  const status: Status | null = d.status === "none" ? null : d.status;
  const company = d.company.trim();
  const role = d.role.trim();

  // A "job application" with no employer and no stage is not actionable; treat
  // it as a negative rather than creating a nameless row.
  const usable = d.is_job_application && status !== null && company.length > 0;

  return {
    is_job_application: usable,
    company: company || null,
    role: role || null,
    status,
    confidence: Math.max(0, Math.min(1, d.confidence)),
    summary: d.summary.trim(),
  };
}

/* ------------------------------------------------------ duplicate judging --- */

const DUPLICATE_SCHEMA = {
  type: "OBJECT",
  properties: {
    same_application: { type: "BOOLEAN" },
    confidence: { type: "NUMBER" },
    reason: { type: "STRING" },
  },
  required: ["same_application", "confidence", "reason"],
} as const;

const DuplicateSchema = z.object({
  same_application: z.boolean(),
  confidence: z.number(),
  reason: z.string(),
});

const DUPLICATE_PROMPT = `You de-duplicate a personal job-application tracker.

You will be given two tracked entries, each an employer and a job title. Decide whether they are ONE application recorded twice under slightly different names.

same_application = true when BOTH hold:
- the employers are the same organisation — including a former name, an abbreviation, a subsidiary written as its parent, or extra words like "Careers", "Recruiting", "Talent Team"
- the titles name the same position — including level suffixes (II, III, Senior), department or location decoration, requisition numbers, and common abbreviations (SWE = Software Engineer, PM = Product Manager, SRE = Site Reliability Engineer)

same_application = false when the employers are different organisations, or when the titles are genuinely different jobs at the same employer (Backend Engineer vs Frontend Engineer, Engineer vs Engineering Manager, Intern vs full-time).

A missing title ("(none)") does not by itself make two entries different: if the employer matches and nothing contradicts it, they are probably the same application.

confidence: 0.0-1.0 in your verdict. reason: one short clause, no more than 12 words.

Return JSON only.`;

export interface DuplicateVerdict {
  same: boolean;
  confidence: number;
  reason: string;
}

/**
 * Ask the model whether two tracked entries are the same application.
 *
 * Deliberately given only the two names, not their emails: the caller has
 * already established that the surrounding evidence is compatible, and the open
 * question is purely one of naming — which is short, cheap, and cacheable.
 */
export async function judgeDuplicate(
  a: { company: string; role: string | null },
  b: { company: string; role: string | null },
  signal?: AbortSignal,
): Promise<DuplicateVerdict> {
  const describe = (x: { company: string; role: string | null }) =>
    `employer: ${x.company}\ntitle: ${x.role?.trim() || "(none)"}`;

  const parsed = DuplicateSchema.safeParse(
    await chatJson(DUPLICATE_PROMPT, `Entry A\n${describe(a)}\n\nEntry B\n${describe(b)}`, DUPLICATE_SCHEMA, {
      // Someone is waiting on this, unlike a sync. Give up early rather than
      // holding a request open for two minutes.
      timeoutMs: Math.min(config.gemini.timeoutMs, 30_000),
      signal,
    }),
  );
  if (!parsed.success) {
    throw new Error(`Gemini duplicate check failed validation: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }

  return {
    same: parsed.data.same_application,
    confidence: Math.max(0, Math.min(1, parsed.data.confidence)),
    reason: parsed.data.reason.trim(),
  };
}
