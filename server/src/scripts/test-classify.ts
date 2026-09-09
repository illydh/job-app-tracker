/**
 * Runs the prefilter + model over a set of representative emails so the prompt
 * can be tuned without touching a real inbox. Prints a pass/fail table.
 *
 *   npm run test:classify --workspace server
 */
import { classify, health } from "../lib/ollama.ts";
import { prefilter } from "../lib/prefilter.ts";
import { companyKey } from "../lib/db.ts";
import type { GmailMessage, Status } from "../lib/types.ts";

interface Fixture {
  name: string;
  msg: Omit<GmailMessage, "id" | "threadId" | "internalDate">;
  /** null = should be rejected as not a job application. */
  expect: { status: Status | null; company?: string };
}

const FIXTURES: Fixture[] = [
  {
    name: "Greenhouse application received",
    msg: {
      fromAddr: "no-reply@greenhouse.io",
      fromName: "Stripe",
      subject: "Thanks for applying to Stripe",
      snippet: "We received your application for Software Engineer, Payments.",
      body: `Hi Illy,\n\nThanks for applying to Stripe! We've received your application for the Software Engineer, Payments role and our recruiting team is reviewing it.\n\nIf your background looks like a match we'll be in touch about next steps.\n\n— The Stripe Recruiting Team`,
    },
    expect: { status: "applied", company: "Stripe" },
  },
  {
    name: "Online assessment assigned",
    msg: {
      fromAddr: "no-reply@hackerrank.com",
      fromName: "HackerRank",
      subject: "Your coding assessment for Datadog is ready",
      snippet: "Complete your assessment within 5 days.",
      body: `Hello,\n\nDatadog has invited you to complete an online coding assessment as part of your application for the Backend Engineer position.\n\nThe assessment takes approximately 90 minutes and must be completed within 5 days.\n\nStart assessment: https://hackerrank.com/test/xxxxx`,
    },
    expect: { status: "assessment", company: "Datadog" },
  },
  {
    name: "Interview scheduling",
    msg: {
      fromAddr: "maya.chen@figma.com",
      fromName: "Maya Chen",
      subject: "Figma — scheduling your first round",
      snippet: "Would love to set up a 45 minute technical screen.",
      body: `Hi Illy,\n\nThanks for your patience. The team reviewed your application for the Product Engineer role and would like to move ahead with a first-round technical interview.\n\nCould you share a few 45-minute windows next week?\n\nBest,\nMaya\nTechnical Recruiter, Figma`,
    },
    expect: { status: "interview", company: "Figma" },
  },
  {
    name: "Rejection",
    msg: {
      fromAddr: "careers@notion.so",
      fromName: "Notion Talent",
      subject: "Update on your Notion application",
      snippet: "We've decided to move forward with other candidates.",
      body: `Hi Illy,\n\nThank you for taking the time to interview for the Software Engineer, Growth role at Notion.\n\nAfter careful consideration we've decided to move forward with other candidates whose experience more closely matches what the team needs right now.\n\nWe genuinely appreciate your interest and wish you the best.\n\n— Notion Talent`,
    },
    expect: { status: "rejected", company: "Notion" },
  },
  {
    name: "Offer",
    msg: {
      fromAddr: "people@linear.app",
      fromName: "Linear",
      subject: "Offer — Software Engineer at Linear",
      snippet: "We're thrilled to extend you an offer.",
      body: `Hi Illy,\n\nWe're thrilled to extend you an offer to join Linear as a Software Engineer.\n\nAttached is the formal offer letter with details on compensation, equity, and start date. We'd love to have you on the team — let us know if you'd like to talk anything through.\n\n— Linear People Team`,
    },
    expect: { status: "offer", company: "Linear" },
  },
  {
    name: "LinkedIn job alert (noise)",
    msg: {
      fromAddr: "jobalerts-noreply@linkedin.com",
      fromName: "LinkedIn Job Alerts",
      subject: "30+ new jobs for Software Engineer",
      snippet: "Senior Software Engineer at Airbnb and 29 others.",
      body: `Jobs you may be interested in\n\nSenior Software Engineer — Airbnb — San Francisco\nBackend Engineer — Coinbase — Remote\nApply now\n\nUnsubscribe from job alerts`,
    },
    expect: { status: null },
  },
  {
    name: "Recruiter cold outreach (noise)",
    msg: {
      fromAddr: "dan@talentpartners.io",
      fromName: "Dan Reeves",
      subject: "Exciting opportunity for a Senior Engineer",
      snippet: "I came across your profile and thought of a role.",
      body: `Hi Illy,\n\nI came across your GitHub profile and was impressed. I'm working with a well-funded Series B client hiring senior backend engineers.\n\nWould you be open to a quick chat this week to hear more?\n\nBest,\nDan`,
    },
    expect: { status: null },
  },
  {
    name: "Newsletter (noise)",
    msg: {
      fromAddr: "newsletter@bytebytego.com",
      fromName: "ByteByteGo",
      subject: "How Netflix scales its recommendation system",
      snippet: "A deep dive into the architecture.",
      body: `This week we look at how Netflix's recommendation pipeline handles billions of events per day, and what that means for your own system design interviews.`,
    },
    expect: { status: null },
  },
];

const h = await health();
if (!h.reachable) {
  console.error(`\n  Ollama is not reachable at its configured host. Run \`ollama serve\`.\n`);
  process.exit(1);
}
if (!h.modelAvailable) {
  console.error(`\n  Model "${h.model}" is not pulled. Run: ollama pull ${h.model}\n`);
  process.exit(1);
}

console.log(`\n  Model: ${h.model}\n`);

let passed = 0;
const started = Date.now();

for (const [i, fx] of FIXTURES.entries()) {
  const msg: GmailMessage = {
    id: `fixture-${i}`,
    threadId: `thread-${i}`,
    internalDate: Date.now(),
    ...fx.msg,
  };

  const gate = prefilter(msg);
  let actualStatus: Status | null = null;
  let actualCompany: string | null = null;
  let detail = "";

  if (!gate.keep) {
    detail = `filtered: ${gate.reason}`;
  } else {
    const t0 = Date.now();
    const result = await classify(msg);
    actualStatus = result.is_job_application ? result.status : null;
    actualCompany = result.company;
    detail = `${((Date.now() - t0) / 1000).toFixed(1)}s · ${
      actualStatus ? `${actualCompany} · ${Math.round(result.confidence * 100)}%` : "not an application"
    }`;
  }

  const statusOk = actualStatus === fx.expect.status;
  const companyOk =
    !fx.expect.company || (actualCompany !== null && companyKey(actualCompany) === companyKey(fx.expect.company));
  const ok = statusOk && companyOk;
  if (ok) passed++;

  console.log(`  ${ok ? "PASS" : "FAIL"}  ${fx.name.padEnd(34)} ${detail}`);
  if (!ok) {
    console.log(
      `        expected ${fx.expect.status ?? "not an application"}${fx.expect.company ? ` / ${fx.expect.company}` : ""}` +
        ` — got ${actualStatus ?? "not an application"}${actualCompany ? ` / ${actualCompany}` : ""}`,
    );
  }
}

console.log(`\n  ${passed}/${FIXTURES.length} passed in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
process.exit(passed === FIXTURES.length ? 0 : 1);
