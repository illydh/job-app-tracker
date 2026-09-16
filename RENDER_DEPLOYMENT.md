# Free Render + Turso deployment

The backend now keeps tracker state and encrypted Gmail credentials in Turso.
The Render service can therefore use the free instance type without a disk.

## 1. Confirm the Render service settings

Use these values under **Settings**:

| Setting | Value |
| --- | --- |
| Runtime | Node |
| Root Directory | Leave blank |
| Build Command | `npm ci && npm run build --workspace server` |
| Start Command | `npm run start --workspace server` |
| Health Check Path | `/api/auth/status` |
| Instance Type | Free |

Do not add a Render disk and do not set `PORT`; Render supplies the port.

## 2. Copy the Turso connection values

In the Turso web UI, open the database and its **Connect** page:

1. Copy the database URL. It normally starts with `libsql://`.
2. Create a database auth token and copy it immediately.
3. Store both values as secrets; do not commit them.

## 3. Generate the credential-encryption key

Run this once on your machine:

```bash
openssl rand -base64 32
```

Save the output securely. The backend uses it to encrypt the Gmail OAuth token
before writing it to Turso. Replacing or losing this key makes the stored Gmail
token unreadable and requires reconnecting Gmail.

## 4. Configure Render environment variables

Under **Environment**, add:

```dotenv
HOST=0.0.0.0
TURSO_DATABASE_URL=<libsql URL from Turso>
TURSO_AUTH_TOKEN=<database token from Turso>
TOKEN_ENCRYPTION_KEY=<output of openssl rand -base64 32>

GOOGLE_CLIENT_ID=<Google OAuth web client ID>
GOOGLE_CLIENT_SECRET=<Google OAuth web client secret>
GOOGLE_REDIRECT_URI=https://<your-render-hostname>/api/auth/callback

ALLOWED_ORIGINS=https://<your-username>.github.io
APP_PASSWORD=<strong unique password>

SYNC_SINCE=2026-08-01
MAX_MESSAGES_PER_SYNC=400
SYNC_INTERVAL_MINUTES=30
OLLAMA_HOST=<Ollama-compatible endpoint reachable from Render>
OLLAMA_MODEL=qwen3.5:4b
OLLAMA_TIMEOUT_MS=120000
MIN_CONFIDENCE=0.6
GHOST_AFTER_DAYS=30
```

Do not set `DB_PATH` or `TOKEN_PATH` on Render. Do not prefix any secret with
`VITE_`; `VITE_*` values are embedded in public frontend files.

For multiple frontends, use a comma-separated `ALLOWED_ORIGINS` value. Each
entry must be an origin only, with no path or trailing slash.

## 5. Migrate existing local data

If the local tracker already contains data, temporarily add the same three
Turso/encryption values to `server/.env`. Stop the local tracker and suspend
the Render service so neither database can change during the copy. Then run:

```bash
npm run migrate:turso --workspace server
```

Resume Render only after the migration reports success.

The migration:

- requires an empty Turso tracker database;
- copies messages, applications, events, duplicate decisions, and metadata;
- encrypts and imports `server/data/token.json` if Turso has no OAuth token;
- verifies row counts after every table;
- supports retrying an interrupted copy; and
- leaves the local database and token file unchanged as a backup.

After verification, remove the Turso values from `server/.env` if local runs
should continue using the local SQLite file.

## 6. Configure Google OAuth

In Google Cloud, edit the OAuth client:

1. Confirm its type is **Web application**.
2. Add the exact authorized redirect URI used by Render, for example:
   `https://job-app-tracker-api.onrender.com/api/auth/callback`.
3. Ensure that exact value is also in Render as `GOOGLE_REDIRECT_URI`.

If the OAuth app remains in Testing status, Google can expire the refresh token
after seven days. Move a personal app to In production when it is ready.

## 7. Redeploy and verify

Push these changes. If Auto-Deploy is disabled, use **Manual Deploy → Deploy
latest commit** in Render. Then verify:

1. Render logs show startup without a database or encryption-key error.
2. `https://<your-render-hostname>/api/auth/status` returns JSON.
3. On the hosted frontend, open **Server settings**, save the Render HTTPS URL,
   and log in with `APP_PASSWORD`.
4. Confirm the existing board counts, then edit one application's notes as a
   small persistence write. Complete Gmail OAuth only if no token was imported.
5. In the Turso shell, run:

   ```sql
   SELECT name
   FROM sqlite_schema
   WHERE type = 'table'
   ORDER BY name;

   SELECT COUNT(*) FROM oauth_credentials;
   SELECT COUNT(*) FROM applications;
   ```

6. Restart the Render service and confirm Gmail remains connected, the same
   applications remain visible, and the notes edit remains.

The `encrypted_token` value should be opaque ciphertext. Never paste it, the
Turso auth token, or `TOKEN_ENCRYPTION_KEY` into logs or support messages.
After this restart check succeeds, manually remove the legacy `token.json` if
you no longer need local OAuth access; the importer intentionally does not
delete the backup.

## Free-tier limitation

Render free services can sleep while idle. The in-process periodic sync runs
only while the service is awake, so treat the **Sync** button as the reliable
free-tier trigger.

For a hard zero-cost boundary, do not enable paid overages. Render currently
includes 750 free instance-hours per workspace each month and suspends service
instead of billing when no payment method is available. Turso's current free
allowance includes 5 GB storage, 500 million row reads, and 10 million row
writes per month, which is ample for a single-user tracker; monitor both
providers' usage dashboards because plan limits can change.

The database migration does not solve model hosting. `OLLAMA_HOST=localhost`
cannot reach an Ollama process on your computer from Render. Sync remains
blocked until `OLLAMA_HOST` points to a reachable Ollama-compatible service;
that is a separate deployment step.

References: [Render free-service limits](https://render.com/docs/free),
[Render web-service binding](https://render.com/docs/web-services), and
[Turso TypeScript client reference](https://docs.turso.tech/sdk/ts/reference),
[Turso pricing](https://turso.tech/pricing).
