import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { EVENTS_ENDPOINT, MAX_EVENT_BYTES, eventBatches, eventConsent, eventData, sendEvents, scrubEventText, type EventConsent, type RoundEvent } from "../src/core/events.ts";
import packageJson from "../package.json" with { type: "json" };

const sha = "a".repeat(40);
const consent = (share: EventConsent["share"] = "full"): EventConsent => ({ share, notice: "crimson-2026-11-v1", synthe_version: packageJson.version, source_sha: sha });
const event = (data: unknown = {}): RoundEvent => ({ id: randomUUID(), kind: "candidate", at: new Date().toISOString(), stage: "write", data });

async function fakeServer(context: TestContext) {
  const received: { headers: any; body: any; raw: string; at: number }[] = [];
  const responses: { status: number; retry?: string; body?: string }[] = [];
  const reads: string[] = [];
  let responseGate: Promise<void> | undefined;
  let oidc = 0, share: unknown = "full", notice: unknown = "crimson-2026-11-v1";
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/oidc?")) {
      assert.equal(new URL(request.url, "http://local").searchParams.get("audience"), "synthe-events");
      assert.equal(request.headers.authorization, "bearer runner-token");
      oidc++;
      return response.end(JSON.stringify({ value: "events-bearer" }));
    }
    if (request.url?.startsWith("/repos/o/r")) {
      reads.push(request.url);
      assert.equal(request.headers.authorization, "Bearer github-token");
      if (request.url === "/repos/o/r") return response.end(JSON.stringify({ default_branch: "main" }));
      if (request.url === "/repos/o/r/git/ref/heads/main") return response.end(JSON.stringify({ object: { sha } }));
      if (request.url === `/repos/o/r/contents/synthe.json?ref=${sha}`) return response.end(JSON.stringify({ share, share_notice: notice }));
      response.statusCode = 404; return response.end();
    }
    if (request.url !== "/api/events") { response.statusCode = 404; return response.end(); }
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      received.push({ headers: request.headers, body: JSON.parse(raw), raw, at: Date.now() });
      const next = responses.shift() ?? { status: 200 };
      response.statusCode = next.status;
      if (next.retry) response.setHeader("retry-after", next.retry);
      const finish = () => response.end(next.body ?? JSON.stringify({ ok: true, results: Object.fromEntries(JSON.parse(raw).events.map((e: RoundEvent) => [e.id, "stored"])) }));
      if (responseGate) void responseGate.then(finish); else finish();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  context.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const env = { ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/oidc?existing=1`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-token", GITHUB_API_URL: base,
    GITHUB_REPOSITORY: "o/r", GITHUB_EVENT_NAME: "workflow_dispatch", "INPUT_GITHUB-TOKEN": "github-token" };
  const fetcher: typeof fetch = (url, init) => fetch(String(url) === EVENTS_ENDPOINT ? `${base}/api/events` : url, init);
  return { received, responses, reads, env, fetcher, base, hold() { let release!: () => void; responseGate = new Promise<void>((done) => { release = done; }); return () => { responseGate = undefined; release(); }; }, get oidc() { return oidc; }, policy(level: unknown, version: unknown = "crimson-2026-11-v1") { share = level; notice = version; } };
}

test("events use their own OIDC audience, exact envelope and stable ids across all retry statuses", async (context) => {
  const server = await fakeServer(context);
  server.responses.push({ status: 409 }, { status: 429, retry: "3" }, { status: 502 }, { status: 503 }, { status: 200 });
  const delays: number[] = [];
  const e = event({ count: 2 });
  await sendEvents(consent(), [e], { ...server, sleep: async (ms) => { delays.push(ms); } });
  assert.equal(server.received.length, 5);
  assert.deepEqual(delays, [500, 3000, 2000, 4000]);
  for (const r of server.received) {
    assert.equal(r.headers.authorization, "Bearer events-bearer");
    assert.equal(r.headers["x-synthe-team"], undefined);
    assert.equal(r.headers["x-synthe-event"], undefined);
    assert.equal(r.headers["content-type"], "application/json");
    assert.deepEqual(r.body, { schema: 1, ...consent(), events: [e] });
    assert.match(e.id, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    assert.match(e.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  }
});

test("five attempts maximum; other errors, tombstones, network/OIDC failure and timeouts stay contained", async (context) => {
  const server = await fakeServer(context);
  for (const status of [409, 429, 502, 503, 400, 401, 403, 404, 410, 413, 500]) {
    const before = server.received.length;
    server.responses.push(...Array.from({ length: 6 }, () => ({ status })));
    await sendEvents(consent(), [event()], { ...server, sleep: async () => {} });
    assert.equal(server.received.length - before, [409, 429, 502, 503].includes(status) ? 5 : 1);
    server.responses.length = 0;
  }
  await sendEvents(consent(), [event()], { env: {}, fetcher: async () => { throw new Error("offline secret"); } });
  await sendEvents(consent(), [event()], { ...server, fetcher: async () => new Response("refused", { status: 401 }) });
  await sendEvents(consent(), [event()], { ...server, timeoutMs: 20, fetcher: (_url, init) => new Promise((_done, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("hung")), { once: true });
  }) });
});

test("Retry-After supports dates and abandons delays past the background deadline", async (context) => {
  const server = await fakeServer(context);
  const now = Date.parse("2026-11-06T00:00:00Z");
  const delays: number[] = [];
  server.responses.push({ status: 429, retry: "Fri, 06 Nov 2026 00:00:04 GMT" }, { status: 200 });
  await sendEvents(consent(), [event()], { ...server, now: () => now, sleep: async (ms) => { delays.push(ms); } });
  assert.deepEqual(delays, [4000]);
  const before = server.received.length;
  server.responses.push({ status: 429, retry: "3600" });
  await sendEvents(consent(), [event()], { ...server, sleep: async () => { assert.fail("must not shorten retry-after"); } });
  assert.equal(server.received.length, before + 1);
});

test("full refusal resends numbers with the same ids, and never downgrades unrelated 403s", async (context) => {
  const server = await fakeServer(context);
  const e = event({ prompt: "be helpful", candidate_id: "candidate-1", score: 42, outcome: "skipped", message: "private text" });
  for (const refusal of ["full collection has ended; send numbers only", "full sharing needs a currently accepted sharing notice"]) {
    server.responses.push({ status: 403, body: JSON.stringify({ error: refusal }) }, { status: 200 });
    let downgraded = false;
    await sendEvents(consent(), [e], { ...server, onDowngrade: () => { downgraded = true; } });
    assert.ok(downgraded);
    const [first, second] = server.received.slice(-2).map((r) => r.body);
    assert.equal(first.share, "full"); assert.equal(second.share, "numbers");
    assert.equal(second.events[0].id, e.id);
    assert.deepEqual(second.events[0].data, { prompt: null, candidate_id: null, score: 42, outcome: "skipped", message: null });
  }
  server.responses.push({ status: 403, body: '{"error":"wrong workflow identity"}' });
  const before = server.received.length;
  await sendEvents(consent(), [e], server);
  assert.equal(server.received.length, before + 1);
});

test("a full-content refusal downgrades every remaining batch even when the worker updates its consent", async (context) => {
  const server = await fakeServer(context);
  server.responses.push({ status: 403, body: '{"error":"full collection has ended; send numbers only"}' });
  const allowed = consent();
  const events = Array.from({ length: 51 }, () => event({ prompt: "be helpful", count: 1 }));
  await sendEvents(allowed, events, { ...server, onDowngrade: () => { allowed.share = "numbers"; } });
  assert.equal(server.received.length, 3);
  assert.deepEqual(server.received.map((r) => r.body.share), ["full", "numbers", "numbers"]);
  assert.ok(server.received.slice(1).flatMap((r) => r.body.events).every((e) => e.data.prompt === null));
  assert.deepEqual(server.received.slice(1).flatMap((r) => r.body.events).map((e) => e.id), events.map((e) => e.id));
});

test("numbers/detail drop ids and content; full scrubs credentials, snake_case keys and excess depth", () => {
  const sensitive = "crim-abcd-1234-efgh-5678 sk-ant-12345678901234567890 ghp_123456789012345678901234 Authorization: Bearer something-private\nEVENT_CODE=customcode\nsecret=unknown_secret\nhttps://x.test/a?X-Amz-Signature=private_signature\n-----BEGIN PRIVATE KEY-----\nprivate key\n-----END PRIVATE KEY-----";
  const env = { SYNTHE_EVENT_CODE: "customcode", "INPUT_TEAM-CODE": "other-team-secret", "INPUT_ANTHROPIC-API-KEY": "arbitrary-private-key", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-secret" };
  const cleaned = scrubEventText(`${sensitive}\nother-team-secret arbitrary-private-key runner-secret`, env);
  for (const secret of ["crim-abcd", "sk-ant-123", "ghp_123", "something-private", "customcode", "unknown_secret", "private_signature", "private key\n", "other-team-secret", "arbitrary-private-key", "runner-secret"]) assert.ok(!cleaned.includes(secret), secret);
  const data = { score: 3, bad_number: Infinity, accepted: true, absent: null, split: "train", words: "one two three four", digit: "c1", long: "a".repeat(17), prose: "Private!", prompt: "be helpful", candidate_id: "candidate", team_code: "hidden", api_key: "hidden", BadKey: "hidden", deep: { a: { b: { c: { d: { e: { f: "too deep" } } } } } } };
  for (const level of ["numbers", "detail"] as const) {
    const body = JSON.parse(eventBatches(consent(level), [event(data)])[0]);
    assert.equal(body.events[0].data.prompt, null);
    assert.equal(body.events[0].data.candidate_id, null);
    assert.equal(body.events[0].data.words, "one two three four");
    assert.equal(body.events[0].data.digit, null);
    assert.equal(body.events[0].data.long, null);
    assert.equal(body.events[0].data.prose, null);
    assert.equal(body.events[0].data.bad_number, null);
    assert.ok(!("team_code" in body.events[0].data));
    assert.ok(!("BadKey" in body.events[0].data));
    assert.equal(body.events[0].data.deep.a.b.c.d.e, null);
  }
  const full = eventData({ content: sensitive, bearer_token: "private", nested: data }, true, env) as any;
  assert.equal(full.bearer_token, undefined);
  assert.equal(full.nested.prompt, "be helpful");
  assert.doesNotMatch(JSON.stringify(full), /crim-abcd|customcode|unknown_secret/);
});

test("batches obey event count and UTF-8 byte caps, with oversized content omitted", async (context) => {
  const server = await fakeServer(context);
  const many = Array.from({ length: 121 }, () => event({ score: 1 }));
  const batches = eventBatches(consent(), many);
  assert.deepEqual(batches.map((b) => JSON.parse(b).events.length), [50, 50, 21]);
  const big = [...Array.from({ length: 4 }, () => event({ prompt: "😊".repeat(25_000) })), event({ prompt: "é".repeat(MAX_EVENT_BYTES) })];
  await sendEvents(consent(), big, server);
  assert.equal(server.received.flatMap((r) => r.body.events).length, 5);
  assert.ok(server.received.every((r) => Buffer.byteLength(r.raw) <= MAX_EVENT_BYTES && r.body.events.length <= 50));
  assert.deepEqual(server.received.at(-1)!.body.events.at(-1).data, { content_omitted: true });
});

test("consent comes from the default branch at its immutable SHA; none, missing notice, forks and failed reads send nothing", async (context) => {
  const server = await fakeServer(context);
  assert.deepEqual(await eventConsent(server.env, server.fetcher), consent());
  assert.equal(server.reads.at(-1), `/repos/o/r/contents/synthe.json?ref=${sha}`);
  for (const level of ["none", undefined, "all"]) {
    server.policy(level);
    assert.equal(await eventConsent(server.env, server.fetcher), null);
  }
  server.policy("full", null);
  assert.equal(await eventConsent(server.env, server.fetcher), null);
  server.policy("full");
  assert.equal(await eventConsent(server.env, async () => { throw new Error("offline"); }), null);
  const dir = mkdtempSync(join(tmpdir(), "synthe-event-consent-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "event.json");
  writeFileSync(path, JSON.stringify({ pull_request: { head: { repo: { full_name: "fork/repo" } } } }));
  assert.equal(await eventConsent({ ...server.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: path }, server.fetcher), null);
  writeFileSync(path, "not json");
  assert.equal(await eventConsent({ ...server.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: path }, server.fetcher), null);
  let called = false;
  await sendEvents({ ...consent(), share: "none" as any }, [event()], { ...server, fetcher: async () => { called = true; throw new Error(); } });
  assert.equal(called, false);
  assert.equal(server.oidc, 0);
});

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise((done) => setTimeout(done, 20)); }
  assert.ok(check(), "background events did not arrive");
}

// Exercise the same child/IPC entry point the bundled action uses, with all HTTP kept on loopback.
async function observerFixture(context: TestContext, server: Awaited<ReturnType<typeof fakeServer>>, mode = "round") {
  const dir = mkdtempSync(join(tmpdir(), "synthe-event-worker-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = join(dir, "action.mjs");
  writeFileSync(fixture, `
import { startEventsWorker, observeRoundStep, captureFailure, captureCancel, EVENTS_ENDPOINT } from ${JSON.stringify(pathToFileURL(resolve("src/core/events.ts")).href)};
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => realFetch(String(url) === EVENTS_ENDPOINT ? process.env.TEST_BASE + '/api/events' : url, init);
if (!startEventsWorker()) {
  const candidate = { id: 'candidate-1', text: 'private prompt', edits: [{ find: 'old', replace: 'new' }] };
  const mode = process.env.TEST_MODE;
  if (mode === 'signal') {
    await observeRoundStep('write', {}, () => new Promise(() => { setInterval(() => {}, 1000); process.stdout.write('ready'); }));
  } else if (mode === 'failure') { captureFailure('write', new Error('runner-token secret')); process.exitCode = 1; }
  else if (mode === 'cancel') captureCancel();
  else {
    await observeRoundStep('write', { prompt: 'old' }, async () => ({ candidates: [candidate], rejected: ['candidate-2: invalid edit'], costUsd: 0 }));
    await observeRoundStep('score', {}, async () => ({ scores: { baselineTrain: [{ id: 's1', score: 50, violation: false, reply: 'before' }], baselineHoldout: [{ id: 'h1', score: 50, violation: false }], candidates: [{ id: candidate.id, train: [{ id: 's1', score: 100, violation: false, reply: 'after' }], holdout: [{ id: 'h1', score: 100, violation: false }] }] } }));
    await observeRoundStep('decide', { candidates: [candidate] }, async () => ({ round: 1, outcome: 'merged', reasons: ['passed'], costUsd: 0.1, pr: 7, edits: candidate.edits }));
  }
}
`);
  const child = spawn(process.execPath, [fixture], { env: { PATH: process.env.PATH, ...server.env, TEST_BASE: server.base, TEST_MODE: mode }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stderr.on("data", (d) => { log += d; });
  const closed = new Promise<number | null>((done) => child.on("exit", (code) => done(code)));
  if (mode === "signal") { await new Promise<void>((done) => child.stdout.once("data", () => done())); child.kill("SIGINT"); }
  const code = await closed;
  assert.equal(code, mode === "failure" ? 1 : mode === "signal" ? 130 : 0, log);
}

test("step observers emit all boundaries without changing results, retaining holdout isolation", async (context) => {
  const server = await fakeServer(context);
  await observerFixture(context, server);
  await waitFor(() => server.received.flatMap((r) => r.body.events).some((e) => e.kind === "round_end"));
  const events = server.received.flatMap((r) => r.body.events);
  assert.deepEqual(events.map((e) => e.kind), ["round_start", "candidate", "candidate", "case_result", "case_result", "decision", "round_end"]);
  const held = events.find((e) => e.data.split === "holdout");
  assert.equal(held.data.candidate_output, null);
  assert.equal(held.data.baseline_output, null);
  assert.equal(events.find((e) => e.kind === "decision").data.candidate_id, "candidate-1");
  assert.equal(events.find((e) => e.kind === "round_end").data.pr, 7);
});

test("background retries cannot delay action exit, and failure/cancellation are best effort events", async (context) => {
  const server = await fakeServer(context);
  const release = server.hold();
  context.after(release);
  const start = Date.now();
  await observerFixture(context, server, "failure");
  assert.ok(Date.now() - start < 2500, "round waited for sharing retry");
  await waitFor(() => server.received.some((r) => r.body.events.some((e: RoundEvent) => e.kind === "failure")));
  assert.doesNotMatch(server.received[0].raw, /runner-token/);
  release();
  for (const mode of ["cancel", "signal"]) {
    const before = server.received.length;
    await observerFixture(context, server, mode);
    await waitFor(() => server.received.slice(before).some((r) => r.body.events.some((e: RoundEvent) => e.kind === "cancel")));
  }
});

test("the shipped action bundle starts its worker and shares a cancellation without running models", async (context) => {
  const server = await fakeServer(context);
  const dir = mkdtempSync(join(tmpdir(), "synthe-event-bundle-"));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const preload = join(dir, "loopback.mjs");
  writeFileSync(preload, `const realFetch = globalThis.fetch; globalThis.fetch = (url, init) => realFetch(String(url) === ${JSON.stringify(EVENTS_ENDPOINT)} ? process.env.TEST_BASE + '/api/events' : url, init);`);
  const child = spawn(process.execPath, [resolve("dist/action.mjs")], { cwd: dir, env: {
    PATH: process.env.PATH, ...server.env, TEST_BASE: server.base, INPUT_STEP: "cancel", NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
  }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stderr.on("data", (chunk) => { log += chunk; });
  assert.equal(await new Promise((done) => child.on("exit", done)), 0, log);
  await waitFor(() => server.received.length > 0);
  assert.equal(server.received[0].body.events[0].kind, "cancel");
  assert.equal(server.received[0].headers.authorization, "Bearer events-bearer");
});
