/**
 * One-shot Gmail authorisation from the terminal. Starts a throwaway server on
 * the OAuth redirect port, opens the consent screen, and stores the token.
 */
import http from "node:http";
import { exec } from "node:child_process";
import { config } from "../lib/config.ts";
import { initializeDatabase } from "../lib/db.ts";
import { authUrl, consumeAuthState, initializeTokenStore, oauthClient, saveToken } from "../lib/gmail.ts";

await initializeDatabase();
await initializeTokenStore();

const client = oauthClient();
const url = new URL(config.google.redirectUri);
const port = Number(url.port || 80);

const server = http.createServer(async (req, res) => {
  const incoming = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (incoming.pathname !== url.pathname) {
    res.writeHead(404).end("Not found");
    return;
  }
  const code = incoming.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("No authorisation code returned.");
    return;
  }
  if (!consumeAuthState(incoming.searchParams.get("state"))) {
    res.writeHead(400).end("Invalid or expired OAuth state. Start again.");
    return;
  }
  try {
    const { tokens } = await client.getToken(code);
    await saveToken(tokens);
    res.writeHead(200, { "Content-Type": "text/html" }).end(
      "<h1>Gmail connected</h1><p>You can close this tab.</p>",
    );
    console.log("\n  Gmail credentials saved securely to the database.\n");
  } catch (err) {
    res.writeHead(500).end((err as Error).message);
    console.error(err);
  } finally {
    server.close();
    setTimeout(() => process.exit(0), 200);
  }
});

server.listen(port, () => {
  const link = authUrl(client);
  console.log("\n  Opening Google consent screen. If it does not open, visit:\n");
  console.log(`  ${link}\n`);
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${opener} "${link}"`);
});
