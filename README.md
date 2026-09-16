# Job Application Tracker

A self-hosted tool that reads your Gmail, uses an LLM to identify
job-application emails, and tracks each application through its interview
stage on a simple board.

Email is fetched read-only and stored in a SQLite file locally, or Turso when
configured. Classification always calls the Gemini API — even in local
development, email content is sent to Google for classification. See
[the deployment guide](RENDER_DEPLOYMENT.md) and [Privacy](#privacy) below.

This is a personal, MVP-stage project rather than a polished product. It
requires a Gmail OAuth client and a Gemini API key to be useful — see
[Setup](#setup) below before deciding if it's worth the install. Known gaps
are listed under [Not in the MVP](#not-in-the-mvp).

---

## How it is put together

```
Gmail API ──▶ SQLite/Turso ──▶ keyword gate ──▶ Gemini ──▶ applications + events
  (read-only)   (storage)       (free, fast)    (model)          │
                                                           ▼
                                            React UI (GitHub Pages or localhost)
```

| Piece | Choice | Why |
| --- | --- | --- |
| Backend | Node + Express + TypeScript | Runs natively via `--experimental-strip-types`; no build step in dev |
| Storage | libSQL (`@libsql/client`) | Local SQLite by default; Turso when configured |
| Model | Gemini API, JSON-schema constrained | Free tier, no local hardware needed; the schema makes malformed output impossible |
| Frontend | React + TypeScript + Vite | Static build, deployable to Pages |

### A note on GitHub Pages

Pages serves **static files only** — it cannot host the Node server. By default,
the split is:

- **GitHub Pages** hosts the React UI.
- **Your machine** runs the API, the database, and the model.

The hosted page calls `http://localhost:4000`. Chrome, Edge, and Firefox all
treat `http://localhost` as a trusted origin and allow this from an HTTPS page;
**Safari blocks it**, so use another browser for the hosted version, or just run
the UI locally with `npm run dev` — which works everywhere and is the simpler
path day to day.

Alternatively, point the frontend at a Render-hosted backend as described in
[the Render + Turso guide](RENDER_DEPLOYMENT.md).

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Get a Gemini API key

Create a free key at [Google AI Studio](https://aistudio.google.com/apikey) —
no credit card required. Set it as `GEMINI_API_KEY` in `server/.env` (step 4).
`GEMINI_MODEL` defaults to `gemini-3.5-flash-lite`; any Gemini model your key
can access will work. Verify a swap against the sample emails before trusting
it on your inbox:

```bash
npm run test:classify --workspace server
```

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

Fill in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then generate the token
encryption key:

```bash
openssl rand -base64 32
```

Put that output in `TOKEN_ENCRYPTION_KEY`. Leave the Turso variables blank for
local SQLite, or fill them from Turso's Connect page for remote storage.
`SYNC_SINCE=2026-08-01` sets how far back to read.

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

Stop the server before using this command, or restart it afterward so it reloads
the stored credentials.

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

**3. Classify** (`server/src/lib/gemini.ts`). Each surviving email is sent to
the Gemini API with a JSON schema, which constrains decoding so the model
*cannot* emit malformed JSON or an invalid stage. It returns company, role,
stage, confidence, and a one-line summary.

**4. Store.** Results are keyed on a normalised `(company, role)` pair, so
"Acme, Inc." and "Acme" land on the same application. Each email becomes an
immutable **event**; the application's current stage is the most recent event's.
Older mail arriving late cannot rewrite a newer verdict.

### Speed

Sync time is dominated by how many emails clear the keyword gate and Gemini's
free-tier rate limit, not by how many you have. A first run over a month of
mail typically takes a few minutes; later runs only look at what is new.


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
npm run migrate:turso --workspace server  # one-time local-to-Turso import
npm run test:db --workspace server        # credential-free database tests
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

On the hosted page, open **Setup** and enter `http://localhost:4000` for a local
backend or the Render HTTPS URL for a hosted backend. It is remembered in
`localStorage`.

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

**Sync says the model is unavailable** — check `GEMINI_API_KEY` is set and
`GEMINI_MODEL` is a model your key can access. You can connect Gmail before
this is fixed; only syncing needs it.

## Privacy

- Gmail scope is `gmail.readonly` — the app cannot send, modify, or delete mail.
- Locally, the database stays in `server/data/tracker.db`, which is gitignored.
- With Turso configured, email data is stored remotely. Gmail credentials are
  encrypted before storage; keep `TOKEN_ENCRYPTION_KEY` separate and secret.
- Email bodies are truncated to 2,500 characters and sent to the Gemini API
  for classification — this happens whether you run locally or on Render.
  Google's free-tier terms permit using this content to improve its products;
  see [Google's Gemini API terms](https://ai.google.dev/gemini-api/terms) if
  that matters to you, or switch to a paid Gemini key for a no-training
  guarantee.
- To revoke access entirely: **Setup → Disconnect**, then remove the app at
  [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

### Login wall

By default the UI opens straight to your board — fine on a single-user
machine, less fine on one you share. Set `APP_PASSWORD` in `server/.env` to
require a password before any application data is served:

```
APP_PASSWORD=choose-something-only-you-know
```

Restart the server and the UI will show a lock screen until the right
password is entered. The browser then remembers a token in `localStorage`, so
you are not re-prompted on every visit; changing `APP_PASSWORD` invalidates
that token everywhere. Leave it blank only for local loopback use.

This protects the UI and API from anyone else with access to the endpoint. Use
`HOST=127.0.0.1` locally. For an internet-accessible Render service, set
`HOST=0.0.0.0` and always configure `APP_PASSWORD`.

---

## Not in the MVP

Deliberately left out, in rough priority order:

- Gmail push notifications (currently sync is manual)
- Re-running the classifier over already-processed mail after a prompt change
- Merging duplicate applications in the UI
- Reminders for applications going quiet
- Export
- Search bar above each category for quick company search
- 
