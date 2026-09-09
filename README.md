# Job Application Tracker

A self-hosted tool that reads your Gmail, uses a **local** LLM to identify
job-application emails, and tracks each application through its interview
stage on a simple board.

It is built to run entirely on your machine: email is fetched read-only,
classified by Ollama on localhost, and stored in a local SQLite file. Nothing
is sent to a third-party server. If you deploy the UI to GitHub Pages, that
static page is the only piece that leaves your machine — it still talks to
your local API and database, as described [below](#a-note-on-github-pages).

This is a personal, MVP-stage project rather than a polished product. It
requires a Gmail OAuth client and a running Ollama instance to be useful — see
[Setup](#setup) below before deciding if it's worth the install. Known gaps
are listed under [Not in the MVP](#not-in-the-mvp).

---

## How it is put together

```
Gmail API ──▶ SQLite ──▶ keyword gate ──▶ Ollama ──▶ applications + events
  (read-only)   (local)    (free, fast)    (local)         │
                                                           ▼
                                            React UI (GitHub Pages or localhost)
```

| Piece | Choice | Why |
| --- | --- | --- |
| Backend | Node + Express + TypeScript | Runs natively via `--experimental-strip-types`; no build step in dev |
| Storage | SQLite (`better-sqlite3`) | One file, zero setup, real relational queries. Swappable later |
| Model | Ollama, JSON-schema constrained | Runs locally; the schema makes malformed output impossible |
| Frontend | React + TypeScript + Vite | Static build, deployable to Pages |

### A note on GitHub Pages

Pages serves **static files only** — it cannot host the Node server, and Ollama
is local by design. So the split is:

- **GitHub Pages** hosts the React UI.
- **Your machine** runs the API, the database, and the model.

The hosted page calls `http://localhost:4000`. Chrome, Edge, and Firefox all
treat `http://localhost` as a trusted origin and allow this from an HTTPS page;
**Safari blocks it**, so use another browser for the hosted version, or just run
the UI locally with `npm run dev` — which works everywhere and is the simpler
path day to day.

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Pull a model

```bash
ollama pull qwen3.5:4b
```

Any instruction-tuned model Ollama supports will work; set `OLLAMA_MODEL` in
`server/.env` to change it. Verify a swap against the sample emails before
trusting it on your inbox:

```bash
npm run test:classify --workspace server
```

`qwen3.5:4b` scores 8/8 on those.

### 3. Create Google OAuth credentials

In the [Google Cloud console](https://console.cloud.google.com/apis/credentials):

1. Create a project, then **enable the Gmail API** for it — open
   [the Gmail API page](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
   and press **Enable**. Skipping this is the most common setup failure: OAuth
   will succeed and every mailbox read will then fail.
2. Go to **APIs & Services → Google Auth Platform** (this is where the old
   "OAuth consent screen" settings now live) and set up **Branding** with any
   app name.
3. On the **Audience** tab, set the user type to **External**.
4. Still on **Audience**, under **Test users**, click **+ Add users** and add
   **your own Gmail address**. This step is not optional — until you are on
   that list, Google blocks your own sign-in with *"can only be accessed by
   developer-approved testers"*.
5. On the **Clients** tab, **Create client → Web application**, and add this
   authorised redirect URI exactly:

   ```
   http://localhost:4000/api/auth/callback
   ```

6. Copy the client ID and secret.

When you run `npm run auth`, Google will warn that the app is unverified. Click
**Advanced → Go to <your app name> (unsafe)**. That warning is expected: it is
your own app, asking for read-only access to your own mailbox.

> **Testing-status tokens expire after 7 days.** While the app's publishing
> status is *Testing*, Google issues refresh tokens that die after a week, so
> you would need to re-run `npm run auth` every 7 days. The tracker detects this
> and prompts you to reconnect rather than failing silently. To avoid it
> entirely, set the publishing status to **In production** on the Audience tab —
> the app stays unverified and still shows the warning screen, but its tokens
> stop expiring on the weekly clock.

### 4. Configure

```bash
cp server/.env.example server/.env
```

Fill in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. The defaults for
everything else are sensible; `SYNC_SINCE=2026-08-01` sets how far back to read.

### 5. Run

```bash
npm run dev    # API on :4000, UI on :5173
```

Open <http://localhost:5173>. The site checks whether it already knows your
mailbox; the first time it will not, so it shows a landing page with a readiness
checklist and a **Connect Gmail** button that runs the consent flow for you.
Finish consent in the tab that opens and the page moves itself on to the board.

Once connected, the account is remembered — later visits skip straight to your
applications. **Setup → Disconnect** clears it and returns you to the landing
page.

There is also a terminal equivalent, if you would rather not use the browser:

```bash
npm run auth
```

---

## How classification works

**1. Fetch.** Gmail is queried for messages after `SYNC_SINCE`. Message IDs
already in the database are skipped, so syncs after the first are incremental
and cheap.

**2. Keyword gate** (`server/src/lib/prefilter.ts`). The model is the slow part
— seconds per email — so an obvious-noise filter runs first. It is tuned for
*recall*: it only rejects mail with no hiring vocabulary at all, plus job-board
alert blasts, which are high-volume and always keyword-rich. Everything else
goes to the model.

**3. Classify** (`server/src/lib/ollama.ts`). Each surviving email is sent to
Ollama with a JSON schema, which constrains decoding so the model *cannot* emit
malformed JSON or an invalid stage. It returns company, role, stage, confidence,
and a one-line summary.

**4. Store.** Results are keyed on a normalised `(company, role)` pair, so
"Acme, Inc." and "Acme" land on the same application. Each email becomes an
immutable **event**; the application's current stage is the most recent event's.
Older mail arriving late cannot rewrite a newer verdict.

### Speed

Roughly **4-5 seconds per email** reaching the model on an M4 with `qwen3.5:4b`,
so sync time is dominated by how many emails clear the keyword gate, not by how
many you have. A first run over a month of mail typically takes a few minutes;
later runs only look at what is new.

Reasoning models are detected and their thinking is switched **off** — Qwen3.x
otherwise spends hundreds of tokens deliberating before answering, which made
extraction roughly 10x slower for no gain in accuracy.

### Stages

| Stage | Meaning |
| --- | --- |
| Waiting to hear back | Application submitted or under review |
| Technical assessment | An OA, take-home, or coding challenge was assigned |
| Interview | A screen or interview round is scheduled or underway |
| Offer | An offer was extended |
| Rejected | No longer under consideration |
| Ghosted | *Derived* — open for more than `GHOST_AFTER_DAYS` (default 30) with no email |

Ghosting is the absence of email, so no classifier can report it. It is computed
at read time instead of stored, which means it corrects itself the moment a
reply arrives.

**Manual overrides win.** Setting a stage in the UI marks the application
`manual`, and later syncs will not move it.

---

## Commands

```bash
npm run dev          # API + UI together
npm run dev:server   # API only, watch mode
npm run auth         # (re-)authorise Gmail
npm run sync         # run one sync from the terminal
npm run typecheck    # typecheck both workspaces
npm run build        # compile server, build static UI
```

Handy for tuning without touching your inbox:

```bash
npm run test:classify --workspace server   # run the model over sample emails
```

---

## Deploying the UI to Pages

Push to `main`. The workflow in `.github/workflows/deploy.yml` builds `web/` and
publishes it. Enable it once under **Settings → Pages → Source: GitHub Actions**.

Then, in `server/.env`, allow the hosted origin to call your local API:

```
ALLOWED_ORIGINS=http://localhost:5173,https://<your-username>.github.io
```

On the hosted page, open **Setup** and confirm the backend address is
`http://localhost:4000`. It is remembered in `localStorage`.

---

## Troubleshooting

**"...can only be accessed by developer-approved testers"** — your Google
account is not in the **Test users** list. See step 3.4 above.

**"Gmail authorisation expired" in the UI** — the refresh token lapsed (7 days,
in Testing status) or access was revoked. Press **Reconnect Gmail**, or run
`npm run auth`.

**"redirect_uri_mismatch"** — the URI on the OAuth client must match
`GOOGLE_REDIRECT_URI` in `server/.env` character for character, port included.

**"The Gmail API is not enabled on Google Cloud project ..."** — exactly what it
says; the landing page links straight to the page that fixes it. Enable it, wait
a minute for it to propagate, then press **Retry**.

**Sync says the model is not pulled** — `ollama pull qwen3.5:4b`, and check
`ollama serve` is running. You can connect Gmail before pulling the model;
only syncing needs it.

## Privacy

- Gmail scope is `gmail.readonly` — the app cannot send, modify, or delete mail.
- The OAuth token (`server/data/token.json`) and database (`server/data/tracker.db`)
  are local and gitignored.
- Email bodies are stored locally, truncated to 4 000 characters, and sent only
  to `localhost:11434`.
- To revoke access entirely: **Setup → Disconnect**, then remove the app at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

---

## Not in the MVP

Deliberately left out, in rough priority order:

- Gmail push notifications (currently sync is manual)
- Re-running the classifier over already-processed mail after a prompt change
- Merging duplicate applications in the UI
- Reminders for applications going quiet
- Export
