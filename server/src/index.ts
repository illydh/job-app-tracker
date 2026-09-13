import cors from "cors";
import express from "express";
import { config } from "./lib/config.ts";
import { closeDatabase, initializeDatabase } from "./lib/db.ts";
import { hasToken, initializeTokenStore } from "./lib/gmail.ts";
import { health } from "./lib/ollama.ts";
import { startPeriodicSync } from "./lib/scheduler.ts";
import { authRequired } from "./lib/session.ts";
import { api } from "./routes/api.ts";

const app = express();

/**
 * The static UI can call either a local or hosted API, so its origin must be
 * allow-listed explicitly. Requests without an Origin header (curl, the OAuth
 * redirect) are allowed; anything else must match ALLOWED_ORIGINS.
 */
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || config.allowedOrigins.includes(origin)) cb(null, true);
      else cb(new Error(`Origin ${origin} is not allowed. Add it to ALLOWED_ORIGINS in server/.env`));
    },
  }),
);
app.use(express.json({ limit: "1mb" }));
app.use("/api", api);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // A blocked origin is a configuration problem, not a server fault.
  const status = err.message.includes("is not allowed") ? 403 : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message });
});

async function logStartup(): Promise<void> {
  const ollama = await health();
  console.log(`\n  Job Application Tracker API  →  http://localhost:${config.port}`);
  console.log(
    `  Gmail    ${hasToken() ? "connected" : "not connected — use Connect Gmail in the UI or run `npm run auth` while the server is stopped"}`,
  );
  console.log(
    `  Ollama   ${
      !ollama.reachable
        ? `unreachable at ${config.ollama.host} — run \`ollama serve\``
        : ollama.modelAvailable
          ? `${ollama.model} ready`
          : `model not pulled — run \`ollama pull ${ollama.model}\``
    }`,
  );
  console.log(`  Window   emails since ${config.syncSince}`);
  console.log(`  Login    ${authRequired() ? "password required" : "disabled — set APP_PASSWORD in server/.env to require one"}`);
  startPeriodicSync();
  console.log();
}

async function start(): Promise<void> {
  if (process.env.RENDER === "true" && config.appPassword.length < 16) {
    throw new Error("APP_PASSWORD must contain at least 16 characters on Render.");
  }
  await initializeDatabase();
  await initializeTokenStore();
  app.listen(config.port, config.host, () => void logStartup());
}

void start().catch((error) => {
  closeDatabase();
  console.error("Startup failed:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
