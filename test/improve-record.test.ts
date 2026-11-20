import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { candidateDiff, cleanText, GIVE_UP_AFTER, MAX_BATCH_BYTES, MAX_DIFF_CHARS, RECORD_NOTICE, recorded, RunRecord, SEND_TIMEOUT_MS, startRecord, unifiedDiff, type RecordIo } from "../src/improve/receipt.ts";
import type { Exec } from "../src/improve/exec.ts";
import type { Model } from "../src/model/client.ts";

const EVENT = "crimson-demo-event", TEAM = "crim-abcd-efgh-jkmn-pqrs", INSTALL = "c6b54614-2e7c-46a8-895f-63ab2299fd45";
const env = { SYNTHE_EVENT_CODE: EVENT, SYNTHE_TEAM_CODE: TEAM, SYNTHE_PROXY_URL: "http://127.0.0.1:1/api/claude" };

// A fetch that records every batch and answers as the proxy would; `mode` can refuse, hang or disconnect.
function fakeProxy(mode: "ok" | "refuse" | "hang" | "down" = "ok") {
  const batches: { url: string; headers: Record<string, string>; body: any }[] = [];
  let calls = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls++;
    if (mode === "down") throw new TypeError("fetch failed");
    if (mode === "hang") return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }))));
    batches.push({ url: String(url), headers: init!.headers as Record<string, string>, body: JSON.parse(init!.body as string) });
    return Response.json(mode === "refuse" ? { error: "no" } : { ok: true }, { status: mode === "refuse" ? 403 : 200 });
  }) as typeof fetch;
  return { fetcher, batches, calls: () => calls };
}
const record = (proxy = fakeProxy(), over: Record<string, string | undefined> = {}) => new RunRecord({ env: { ...env, ...over }, command: "improve", agent: false, fetcher: proxy.fetcher, installId: () => INSTALL, version: "1.9.1" });

test("a record exists only for event-credit runs: own key or no team code means nothing is ever sent", () => {
  assert.equal(startRecord({ env: { ...env, SYNTHE_ANTHROPIC_KEY: "sk-ant-own" }, command: "improve", agent: false, installId: () => INSTALL }), null);
  assert.equal(startRecord({ env: { SYNTHE_EVENT_CODE: EVENT }, command: "improve", agent: false, installId: () => INSTALL }), null);
  assert.equal(startRecord({ env: { SYNTHE_EVENT_CODE: EVENT, SYNTHE_TEAM_CODE: "team-7" }, command: "improve", agent: false, installId: () => INSTALL }), null);
  assert.equal(startRecord({ env: {}, command: "submit", agent: true, installId: () => INSTALL }), null);
  assert.ok(startRecord({ env, command: "improve", agent: false, installId: () => INSTALL }) instanceof RunRecord);
  assert.match(RECORD_NOTICE, /^Event credit: the organizers receive a record of this run/);
});

test("planted secrets, codes and control characters never leave: redacted in events, summary and run fields", async () => {
  const proxy = fakeProxy(), r = record(proxy);
  const planted = `key sk-ant-api03-${"a".repeat(40)} ghp_${"b".repeat(36)} ${TEAM} ${EVENT} bearer abcdefghijklmnop eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)} \u001b[31mred‮ end`;
  const io = r.wrap<RecordIo>({ say: () => {}, ask: async () => planted, exec: (async () => ({ ok: false, stdout: planted, stderr: "", ms: 3, timedOut: false })) as Exec });
  io.say(planted);
  await io.ask(planted);
  await io.exec("/", `echo ${planted}`, 1000);
  r.event("candidate", { round: 1, summary: planted, diff: `+const k = "${planted}"`, cut: false, files: [planted], changed_lines: 1, refused: null });
  r.round({ round: 1, kept: false, summary: planted, value: null, why: planted, costUsd: null }, null);
  r.finished("no-win", { stopReason: planted });
  r.setRepo("acme/signup", planted, "f".repeat(40));
  await r.close();
  const wire = JSON.stringify(proxy.batches.map((b) => b.body));
  for (const leak of ["sk-ant-", "ghp_", TEAM, EVENT, "crim-abcd", "abcdefghijklmnop", "eyJ", "\\u001b", "‮"]) assert.ok(!wire.includes(leak), `leaked ${JSON.stringify(leak)} in ${wire.slice(0, 300)}`);
  assert.match(wire, /\[secret removed\]/);
  assert.match(wire, /\[team code removed\]/);
  assert.match(wire, /\[event code removed\]/);
  assert.match(wire, /\[token removed\]/);
  // The codes travel only as headers, to the proxy, never in the body.
  assert.equal(proxy.batches[0].headers["x-synthe-event"], EVENT);
  assert.equal(proxy.batches[0].headers["x-synthe-team"], TEAM);
  assert.equal(proxy.batches[0].headers["x-synthe-install"], INSTALL);
  assert.equal(proxy.batches[0].url, "http://127.0.0.1:1/api/claude/improve");
  assert.equal(cleanText("x".repeat(10), env, 4), "xxxx…");
});

test("batches stay under the proxy's limit and arrive in order; the last one is marked final with the summary", async () => {
  const proxy = fakeProxy(), r = record(proxy);
  for (let i = 0; i < 60; i++) r.event("say", { text: `line ${i} ${"x".repeat(3000)}` });
  r.round({ round: 1, kept: true, summary: "better", value: 12, why: "kept", costUsd: 0.04 }, 12);
  r.finished("win", { prUrl: "https://github.com/acme/signup/pull/7", costUsd: 0.04 });
  await r.close();
  assert.ok(proxy.batches.length >= 4, `${proxy.batches.length} batches`);
  const seqs = proxy.batches.map((b) => b.body.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1));
  for (const b of proxy.batches) assert.ok(JSON.stringify(b.body).length <= MAX_BATCH_BYTES, `batch ${b.body.seq} is ${JSON.stringify(b.body).length} bytes`);
  const all = proxy.batches.flatMap((b) => b.body.events);
  assert.deepEqual(all.map((e: { i: number }) => e.i), all.map((_: unknown, i: number) => i + 1));
  const last = proxy.batches.at(-1)!.body;
  assert.equal(last.final, true);
  assert.equal(last.run_id, r.runId);
  assert.deepEqual(last.summary.rounds, [{ n: 1, kept: true, summary: "better", value: 12, why: "kept", cost_usd: 0.04 }]);
  assert.equal(last.summary.pr_url, "https://github.com/acme/signup/pull/7");
  assert.equal(last.summary.status, "finished");
  assert.equal(last.run.version, "1.9.1");
  assert.ok(proxy.batches.slice(0, -1).every((b) => b.body.final === false));
});

test("a dead, hanging or refusing proxy never slows or fails the run, and sends stop after two failures", async () => {
  for (const mode of ["down", "hang", "refuse"] as const) {
    const proxy = fakeProxy(mode), r = record(proxy), started = Date.now();
    for (let n = 1; n <= 5; n++) { r.event("say", { text: `round ${n}` }); r.flush(); }
    r.finished("win");
    await r.close();
    const took = Date.now() - started;
    // A proxy that never answers: each send gives up after SEND_TIMEOUT_MS in the background; the exit waits at most 6 s.
    if (mode === "hang") assert.ok(took >= SEND_TIMEOUT_MS && took < SEND_TIMEOUT_MS + 1500 && !r.dead, `hang: ${took} ms, dead ${r.dead}`);
    else if (mode === "down") assert.ok(took < 500 && r.dead && proxy.calls() === GIVE_UP_AFTER * 2, `down: ${took} ms, ${proxy.calls()} calls`);
    else assert.ok(took < 500 && !r.dead && proxy.calls() === 6, `refuse: ${took} ms, ${proxy.calls()} calls`);
    if (mode !== "hang") assert.ok(r.sent.length >= 5);
  }
});

test("a timed-out send is not retried; a failed connection is retried exactly once", async () => {
  let calls = 0;
  const flaky = (async (_url: unknown, init?: RequestInit) => { calls++; if (calls === 1) throw new TypeError("fetch failed"); return Response.json({ ok: true }); }) as typeof fetch;
  const r = new RunRecord({ env, command: "improve", agent: false, fetcher: flaky, installId: () => INSTALL });
  r.event("say", { text: "hi" });
  await r.close();
  assert.equal(calls, 2);
  assert.deepEqual(r.sent.map((s) => s.status), [200]);
});

test("wrapped io, exec and model record what the person saw, answered and ran, with tokens, cost and stop reason", async () => {
  const proxy = fakeProxy(), r = record(proxy), said: string[] = [];
  const io = r.wrap<RecordIo>({ say: (t) => said.push(t), ask: async () => "2", exec: (async (_cwd, command) => ({ ok: command !== "npm test", stdout: "12\n", stderr: command === "npm test" ? "1 failing\n" : "", ms: 40, timedOut: false })) as Exec });
  io.say("Hello");
  assert.equal(await io.ask("Type 1-3: "), "2");
  await io.exec("/", "node metrics/score.js", 1000);
  await io.exec("/", "npm test", 1000);
  const inner: Model = { ask: async (a) => (a.model === "fail" ? Promise.reject(new Error("Anthropic's API is busy right now.\nmore")) : { text: "{}", costUsd: 0.01, usage: { input: 3000, output: 150 }, stopReason: "end_turn" }) };
  const model = r.model(inner);
  await model.ask({ model: "claude-sonnet-5-5", user: "x", maxTokens: 2000, schema: { properties: { paths: {} } } });
  await model.ask({ model: "claude-sonnet-5-5", user: "x", maxTokens: 12000, schema: { properties: { edits: {} } } });
  await assert.rejects(model.ask({ model: "fail", user: "x", maxTokens: 10 }));
  await r.close();
  const events = proxy.batches.flatMap((b) => b.body.events);
  assert.deepEqual(events.map((e: { type: string }) => e.type), ["say", "ask", "command", "command", "model", "model", "model"]);
  assert.deepEqual(said, ["Hello"]);
  assert.equal(events[1].answer, "2");
  assert.equal(events[2].tail, null);
  assert.equal(events[3].tail, "12\n1 failing");
  assert.equal(events[4].purpose, "pick"); assert.equal(events[4].input_tokens, 3000); assert.equal(events[4].stop_reason, "end_turn"); assert.equal(events[4].max_tokens, 2000);
  assert.equal(events[5].purpose, "propose");
  assert.equal(events[6].ok, false); assert.equal(events[6].error, "Anthropic's API is busy right now.");
});

test("candidate diffs come from the files as the model saw them, as a unified diff, cut at 20 KB and never beyond", () => {
  const shown = [{ path: "validate.js", text: "const a = 1;\nconst b = 2;\nmodule.exports = (email) => /^[a-z]+@[a-z]+\\.com$/.test(email);\nconst z = 9;\n" }];
  const one = candidateDiff(shown, [{ path: "validate.js", search: "/^[a-z]+@[a-z]+\\.com$/", replace: "/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/" }, { path: "new.js", search: "", replace: "export const x = 1;\n" }]);
  assert.deepEqual(one.files, ["validate.js", "new.js"]);
  assert.equal(one.cut, false);
  assert.match(one.diff, /^--- a\/validate\.js\n\+\+\+ b\/validate\.js\n@@ -1,4 \+1,4 @@\n const a = 1;\n const b = 2;\n-module\.exports = \(email\) => \/\^\[a-z\]\+@\[a-z\]\+\\\.com\$\/\.test\(email\);\n\+module\.exports = \(email\) => \/\^\[\^\\s@\]\+@/);
  assert.match(one.diff, /--- \/dev\/null\n\+\+\+ b\/new\.js\n@@ -0,0 \+1,1 @@\n\+export const x = 1;/);
  const huge = candidateDiff([{ path: "big.js", text: "a\n" }], [{ path: "big.js", search: "a", replace: "b".repeat(30_000) }]);
  assert.equal(huge.cut, true);
  assert.ok(huge.diff.length <= MAX_DIFF_CHARS + 30 && huge.diff.endsWith("... cut at 20 KB"));
  const missing = candidateDiff(shown, [{ path: "validate.js", search: "not in the file", replace: "x" }]);
  assert.match(missing.diff, /\+@@ edit not applied: search text not found @@\n\+-not in the file\n\+\+x/);
  assert.equal(unifiedDiff("f", "same\n", "same\n"), "--- a/f\n+++ b/f\n@@ -1,1 +1,1 @@\n same");
});

test("recorded() marks a crash and still sends the final batch, within the close wait, through a real socket", async () => {
  const received: any[] = [];
  const server = createServer((req, res) => { let raw = ""; req.on("data", (c) => { raw += c; }); req.on("end", () => { received.push(JSON.parse(raw)); res.end("{}"); }); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/claude`;
  const r = new RunRecord({ env: { ...env, SYNTHE_PROXY_URL: url }, command: "improve", agent: true, installId: () => INSTALL });
  await assert.rejects(recorded(r, async () => { r.event("say", { text: "before the crash" }); throw new Error(`boom ${TEAM}`); }), /boom/);
  server.close();
  assert.equal(received.length, 1);
  const types = received[0].events.map((e: { type: string }) => e.type);
  assert.deepEqual(types, ["say", "crash"]);
  assert.equal(received[0].summary.outcome, "crashed");
  assert.equal(received[0].summary.stop_reason, "boom [team code removed]");
  assert.equal(received[0].final, true);
  assert.equal(received[0].run.agent, true);
  // Nothing after close is recorded or sent.
  r.event("say", { text: "late" });
  await r.close();
  assert.equal(received.length, 1);
});
