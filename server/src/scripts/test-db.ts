import assert from "node:assert/strict";

// Set these before importing configuration so the test cannot touch a real database.
process.env.TURSO_DATABASE_URL = ":memory:";
process.env.TURSO_AUTH_TOKEN = "";
process.env.RENDER = "false";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const { config } = await import("../lib/config.ts");
const store = await import("../lib/db.ts");
const tokens = await import("../lib/oauth-token-store.ts");
const gmail = await import("../lib/gmail.ts");

try {
  assert.equal(config.database.url, ":memory:");
  await store.initializeDatabase();
  await store.initializeDatabase();

  const schema = await store.db.execute(
    `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  );
  assert.deepEqual(
    schema.rows.map((row) => row.name),
    ["applications", "events", "merge_dismissals", "messages", "meta", "oauth_credentials", "similarity_verdicts"],
  );

  const messages = [
    {
      id: "message-1",
      threadId: "thread-1",
      fromAddr: "jobs@acme.example",
      fromName: "Acme",
      subject: "Application received",
      snippet: "Thanks for applying",
      body: "Thanks for applying",
      internalDate: 100,
    },
    {
      id: "message-2",
      threadId: "thread-2",
      fromAddr: "jobs@acme.example",
      fromName: "Acme",
      subject: "Interview",
      snippet: "Interview invitation",
      body: "Interview invitation",
      internalDate: 200,
    },
  ];

  assert.equal(await store.saveMessages([...messages, messages[0]!]), 2);
  assert.equal(await store.saveMessages(messages), 0);
  assert.deepEqual(await store.knownMessageIds(["message-1", "missing"]), new Set(["message-1"]));
  assert.deepEqual((await store.pendingMessages(1)).map((message) => message.id), ["message-1"]);
  await store.markMessage("message-1", "classified", true);
  assert.deepEqual((await store.pendingMessages(10)).map((message) => message.id), ["message-2"]);

  await assert.rejects(
    store.upsertApplicationEvent({
      company: "Rollback Example",
      role: "Engineer",
      status: "applied",
      confidence: 0.8,
      summary: null,
      messageId: "bad-event",
      occurredAt: 50,
    } as unknown as Parameters<typeof store.upsertApplicationEvent>[0]),
  );
  assert.equal((await store.listApplications()).length, 0);

  const targetId = await store.upsertApplicationEvent({
    company: "Acme, Inc.",
    role: null,
    status: "applied",
    confidence: 0.8,
    summary: "Applied",
    messageId: "event-1",
    occurredAt: 100,
  });
  assert.equal(
    await store.upsertApplicationEvent({
      company: "Acme",
      role: "Senior Software Engineer",
      status: "interview",
      confidence: 0.9,
      summary: "Interview",
      messageId: "event-2",
      occurredAt: 200,
    }),
    targetId,
  );
  await store.upsertApplicationEvent({
    company: "Acme",
    role: "Software Engineer",
    status: "rejected",
    confidence: 0.7,
    summary: "Older rejection",
    messageId: "event-3",
    occurredAt: 150,
  });
  assert.equal((await store.getApplication(targetId))?.status, "interview");

  await store.setStatus(targetId, "offer");
  await store.setNotes(targetId, "target note");
  await store.upsertApplicationEvent({
    company: "Acme",
    role: "Software Engineer",
    status: "rejected",
    confidence: 0.95,
    summary: "Later model result",
    messageId: "event-4",
    occurredAt: 300,
  });
  assert.equal((await store.getApplication(targetId))?.status, "offer");
  const targetSummary = (await store.listApplicationSummaries()).find((application) => application.id === targetId);
  assert.equal(targetSummary?.event_count, 4);
  assert.equal(targetSummary?.latest_summary, "Later model result");

  const sourceId = await store.upsertApplicationEvent({
    company: "Acme",
    role: "Platform Engineer",
    status: "interview",
    confidence: 0.85,
    summary: "Duplicate row",
    messageId: "event-5",
    occurredAt: 250,
  });
  await store.setNotes(sourceId, "source note");
  await store.dismissPair(targetId, sourceId);
  assert.equal((await store.dismissedFor(sourceId)).has(targetId), true);

  await store.db.execute(`PRAGMA foreign_keys = OFF`);
  const merged = await store.mergeApplications(targetId, sourceId);
  assert.equal(merged?.status, "offer");
  assert.equal(merged?.notes, "target note\n\nsource note");
  assert.equal(await store.getApplication(sourceId), undefined);
  assert.equal((await store.listEvents(targetId)).length, 5);
  assert.equal((await store.dismissedFor(targetId)).has(sourceId), false);

  await store.putVerdict("pair", { similar: false, score: 0.2, reason: "different" });
  await store.putVerdict("pair", { similar: true, score: 0.9, reason: "same" });
  assert.deepEqual(await store.getVerdict("pair"), { similar: true, score: 0.9, reason: "same" });

  await store.setMeta("test", "one");
  await store.setMeta("test", "two");
  assert.equal(await store.getMeta("test"), "two");

  assert.equal(await store.deleteApplication(targetId), true);
  assert.equal(await store.deleteApplication(targetId), false);
  const orphanEvents = await store.db.execute(
    `SELECT COUNT(*) AS count FROM events e LEFT JOIN applications a ON a.id = e.application_id WHERE a.id IS NULL`,
  );
  const orphanDismissals = await store.db.execute(
    `SELECT COUNT(*) AS count
       FROM merge_dismissals d
       LEFT JOIN applications a ON a.id = d.app_a
       LEFT JOIN applications b ON b.id = d.app_b
      WHERE a.id IS NULL OR b.id IS NULL`,
  );
  assert.equal(orphanEvents.rows[0]?.count, 0);
  assert.equal(orphanDismissals.rows[0]?.count, 0);

  assert.deepEqual(await store.stats(), {
    messages: 2,
    pending: 1,
    prefiltered: 0,
    classified: 1,
    applications: 0,
    events: 0,
  });

  await tokens.initializeTokenStore();
  await tokens.saveToken({ refresh_token: "secret-refresh", access_token: "secret-access" });
  await tokens.initializeTokenStore();
  assert.equal(tokens.hasToken(), true);
  assert.equal(tokens.loadToken()?.refresh_token, "secret-refresh");
  const encrypted = await store.getEncryptedOAuthCredentials();
  assert.ok(encrypted);
  assert.equal(encrypted.includes("secret-refresh"), false);
  assert.equal(encrypted.includes("secret-access"), false);

  await store.setEncryptedOAuthCredentials(`${encrypted.slice(0, -1)}x`);
  await assert.rejects(tokens.initializeTokenStore(), /could not be decrypted/);
  await store.setEncryptedOAuthCredentials(encrypted);
  await tokens.initializeTokenStore();

  const staleGeneration = tokens.currentTokenGeneration();
  await tokens.deleteToken();
  assert.equal(tokens.hasToken(), false);
  assert.equal(await tokens.saveRefreshedToken(staleGeneration, { access_token: "late-refresh" }), false);
  assert.equal(await store.getEncryptedOAuthCredentials(), null);

  let oauthState: string | undefined;
  const fakeClient = {
    generateAuthUrl(options: { state?: string }) {
      oauthState = options.state;
      return "https://accounts.example/authorize";
    },
  } as unknown as Parameters<typeof gmail.authUrl>[0];
  gmail.authUrl(fakeClient);
  assert.ok(oauthState);
  assert.equal(gmail.consumeAuthState(oauthState), true);
  assert.equal(gmail.consumeAuthState(oauthState), false);

  console.log("Database integration tests passed.");
} finally {
  store.closeDatabase();
}
