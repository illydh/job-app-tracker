import { z } from "zod";
import { config } from "./config.ts";
import { STATUSES, type Classification, type GmailMessage, type Status } from "./types.ts";

/**
 * JSON schema handed to Ollama for constrained decoding, so the model is
 * physically unable to emit malformed JSON or an out-of-taxonomy status.
 *
 * Nullable fields are modelled as plain strings with a sentinel ("" / "none")
 * rather than `["string","null"]` unions: llama.cpp's grammar conversion handles
 * flat types far more reliably than unions.
 */
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    is_job_application: { type: "boolean" },
    company: { type: "string" },
    role: { type: "string" },
    status: { type: "string", enum: [...STATUSES, "none"] },
    confidence: { type: "number" },
    summary: { type: "string" },
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

export interface OllamaHealth {
  reachable: boolean;
  model: string;
  modelAvailable: boolean;
  models: string[];
  error?: string;
}

/**
 * Whether the configured model reasons before answering, cached for the process.
 *
 * This matters a lot: a reasoning model spends hundreds of tokens deliberating
 * about an email before emitting the JSON, which on a 4B model turns a
 * sub-second extraction into a ten-second one and can blow the request timeout
 * outright. Extraction gains nothing from it, so thinking is switched off when
 * the model supports it.
 *
 * It has to be detected rather than assumed: Ollama rejects an explicit `think`
 * on models that cannot think, so the field must be omitted for those.
 */
let thinkingCapable: boolean | null = null;

async function supportsThinking(): Promise<boolean> {
  if (thinkingCapable !== null) return thinkingCapable;
  try {
    const res = await fetch(`${config.ollama.host}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.ollama.model }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return (thinkingCapable = false);
    const data = (await res.json()) as { capabilities?: string[] };
    return (thinkingCapable = (data.capabilities ?? []).includes("thinking"));
  } catch {
    // Unknown: omit the field rather than risk rejecting every request.
    return (thinkingCapable = false);
  }
}

export async function health(): Promise<OllamaHealth> {
  try {
    const res = await fetch(`${config.ollama.host}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      return { reachable: false, model: config.ollama.model, modelAvailable: false, models: [], error: `HTTP ${res.status}` };
    }
    const data = (await res.json()) as { models?: { name: string }[] };
    const models = (data.models ?? []).map((m) => m.name);
    // Ollama reports tags as "name:tag"; accept a bare name as a match too.
    const modelAvailable = models.some(
      (m) => m === config.ollama.model || m.split(":")[0] === config.ollama.model.split(":")[0],
    );
    return { reachable: true, model: config.ollama.model, modelAvailable, models };
  } catch (err) {
    return {
      reachable: false,
      model: config.ollama.model,
      modelAvailable: false,
      models: [],
      error: (err as Error).message,
    };
  }
}

/**
 * The schema constrains decoding, so `content` is normally clean JSON. This is
 * belt-and-braces for reasoning models, whose thinking can bleed into the
 * content field on some Ollama builds: drop any <think> block, then take the
 * outermost object.
 */
function extractJson(raw: string): string {
  const withoutThinking = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const start = withoutThinking.indexOf("{");
  const end = withoutThinking.lastIndexOf("}");
  if (start === -1 || end <= start) return withoutThinking;
  return withoutThinking.slice(start, end + 1);
}

/**
 * Shared by every caller, deliberately: Ollama keeps a model resident against
 * one context size and reloads it — several seconds — whenever a request asks
 * for a different one, so two callers with two window sizes would thrash the
 * model in and out on every alternation. Covers the system prompt plus a
 * trimmed email with room to spare.
 */
const NUM_CTX = 4096;

/** One schema-constrained, deterministic exchange with the local model. */
async function chatJson(
  system: string,
  user: string,
  schema: unknown,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<unknown> {
  // `think` is only meaningful — and only accepted — on capable models.
  const canThink = await supportsThinking();
  const think = canThink ? (config.ollama.think ?? false) : undefined;

  const res = await fetch(`${config.ollama.host}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.ollama.model,
      stream: false,
      format: schema,
      // Deterministic: this is extraction, not writing.
      options: { temperature: 0, num_ctx: NUM_CTX },
      // Omitted entirely when undefined — JSON.stringify drops undefined.
      think,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: opts.signal
      ? AbortSignal.any([AbortSignal.timeout(opts.timeoutMs), opts.signal])
      : AbortSignal.timeout(opts.timeoutMs),
  });

  if (!res.ok) {
    throw new Error(`Ollama returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const payload = (await res.json()) as { message?: { content?: string } };
  const raw = payload.message?.content?.trim() ?? "";
  if (!raw) throw new Error("Ollama returned an empty response");

  return JSON.parse(extractJson(raw));
}

export async function classify(msg: GmailMessage): Promise<Classification> {
  const parsed = ResponseSchema.safeParse(
    await chatJson(SYSTEM_PROMPT, buildUserPrompt(msg), RESPONSE_SCHEMA, {
      timeoutMs: config.ollama.timeoutMs,
    }),
  );
  if (!parsed.success) {
    throw new Error(`Ollama response failed validation: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
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
  type: "object",
  properties: {
    same_application: { type: "boolean" },
    confidence: { type: "number" },
    reason: { type: "string" },
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
      timeoutMs: Math.min(config.ollama.timeoutMs, 30_000),
      signal,
    }),
  );
  if (!parsed.success) {
    throw new Error(`Ollama duplicate check failed validation: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }

  return {
    same: parsed.data.same_application,
    confidence: Math.max(0, Math.min(1, parsed.data.confidence)),
    reason: parsed.data.reason.trim(),
  };
}
