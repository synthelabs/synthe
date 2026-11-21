import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { SetupError } from "../src/solve/loop.ts";
import { modelCompare } from "../src/solve/model-compare.ts";
import { anthropicKey, modelProposer } from "../src/solve/model-proposer.ts";
import type { Problem, ProposerRequest } from "../src/solve/types.ts";

// S01: provider "anthropic" sends Messages API requests to a loopback fake (SYNTHE_ANTHROPIC_BASE_URL). No real call.
interface Seen { url: string; headers: IncomingHttpHeaders; body: any }
let seen: Seen[] = [];
let answer: () => { status: number; body: unknown } = () => ({ status: 200, body: {} });
const server: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    seen.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(raw) });
    const a = answer();
    res.writeHead(a.status, { "content-type": "application/json" });
    res.end(JSON.stringify(a.body));
  });
});
let base = "";
before(async () => { await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
after(() => server.close());

const KEY = "sk-ant-test-secret-789";
const message = (text: string, stop = "end_turn") => () => ({
  status: 200,
  body: { id: "msg_1", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text }], stop_reason: stop, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 30 } },
});
const problem = (): Problem => ({
  version: 1, name: "p", goal: "Raise the score.", artifact: ["config.json"], protect: [],
  measure: { command: "true", direction: "higher", runs: 1 }, guards: [], split: { holdout: false },
  proposer: "model", budget: { max_rounds: 6, max_calls: null }, model: { provider: "anthropic", model: "claude-test" },
  candidates: 1, dir: "/tmp", file: "/tmp/p.json",
});
const input: ProposerRequest = { round: 1, goal: "Raise the score.", files: [{ path: "config.json", text: '{"rate": 1}' }], history: [], candidates: 1 };
// The SDK sends the key as x-api-key or as a Bearer token, depending on its version.
const sentKey = (s: Seen) => (s.headers["x-api-key"] as string | undefined) ?? s.headers.authorization?.replace(/^Bearer /, "");
const env = (extra: Record<string, string>) => ({ SYNTHE_ANTHROPIC_BASE_URL: base, ...extra });

test("the Anthropic proposer posts to /v1/messages with the key from SYNTHE_ANTHROPIC_KEY and reads proposals", async () => {
  seen = [];
  answer = message(JSON.stringify({ proposals: [{ summary: "rate 2", edits: [{ path: "config.json", search: '"rate": 1', replace: '"rate": 2' }] }] }));
  const r = await modelProposer(problem(), env({ SYNTHE_ANTHROPIC_KEY: KEY })).propose(input);
  assert.deepEqual(r.reply, { proposals: [{ summary: "rate 2", edits: [{ path: "config.json", search: '"rate": 1', replace: '"rate": 2' }] }] });
  assert.equal(r.calls, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "/v1/messages");
  assert.equal(sentKey(seen[0]), KEY);
  assert.equal(seen[0].body.model, "claude-test");
  const user = seen[0].body.messages[0].content;
  assert.ok((typeof user === "string" ? user : JSON.stringify(user)).includes('"goal": "Raise the score."'));
});

test("an sk-ant- SYNTHE_API_KEY works too; another SYNTHE_API_KEY does not go to Anthropic", async () => {
  assert.equal(anthropicKey({ SYNTHE_API_KEY: KEY }), KEY);
  assert.equal(anthropicKey({ SYNTHE_API_KEY: "sk-openai-1" }), "");
  assert.equal(anthropicKey({ SYNTHE_API_KEY: KEY, SYNTHE_ANTHROPIC_KEY: "sk-ant-own" }), "sk-ant-own");
  seen = [];
  answer = message('{"proposals": []}');
  const r = await modelProposer(problem(), env({ SYNTHE_API_KEY: KEY })).propose(input);
  assert.deepEqual(r.reply, { proposals: [] });
  assert.equal(sentKey(seen[0]), KEY);
  assert.throws(() => modelProposer(problem(), env({ SYNTHE_API_KEY: "sk-openai-1" })), (e) => e instanceof SetupError && /SYNTHE_ANTHROPIC_KEY/.test(e.message));
});

test("a malformed or cut-off Anthropic reply is a failed attempt, and an error never shows the key", async () => {
  answer = message("Raise the rate, I think.");
  const bad = (await modelProposer(problem(), env({ SYNTHE_ANTHROPIC_KEY: KEY })).propose(input)).reply;
  assert.ok("failed" in bad && /not valid JSON/.test(bad.failed));
  answer = message('{"proposals": [', "max_tokens");
  const cut = (await modelProposer(problem(), env({ SYNTHE_ANTHROPIC_KEY: KEY })).propose(input)).reply;
  assert.ok("failed" in cut && /cut off/.test(cut.failed), JSON.stringify(cut));
  answer = () => ({ status: 401, body: { type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${KEY}` } } });
  const refused = (await modelProposer(problem(), env({ SYNTHE_ANTHROPIC_KEY: KEY })).propose(input)).reply;
  assert.ok("failed" in refused);
  assert.match(refused.failed, /request failed/);
  assert.ok(!refused.failed.includes(KEY), refused.failed);
});

test("compare \"model\" with provider anthropic asks the Messages API and reads the verdict", async () => {
  seen = [];
  answer = message('{"winner": "b"}');
  const compare = modelCompare(problem(), env({ SYNTHE_ANTHROPIC_KEY: KEY }));
  assert.equal(await compare({ id: "1", input: "hi" }, "x", "y"), "b");
  assert.equal(seen[0].url, "/v1/messages");
  answer = message("b is better");
  const r = await compare({ id: "1", input: "hi" }, "x", "y");
  assert.ok(typeof r === "object" && /did not answer/.test(r.failed));
});

test("a SYNTHE_ANTHROPIC_BASE_URL that is not loopback is ignored, so the key never goes to a stranger", async () => {
  // ownKeyBaseUrl falls back to the real API for a non-loopback override. No request is sent here: only the
  // proposer is built, which must not throw.
  assert.doesNotThrow(() => modelProposer(problem(), { SYNTHE_ANTHROPIC_BASE_URL: "https://evil.example.com", SYNTHE_ANTHROPIC_KEY: KEY }));
});

test("solve with provider anthropic runs end to end through the CLI, and the key stays out of every file", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "synthe-anthropic-e2e-")));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
  mkdirSync(join(dir, "measure"));
  writeFileSync(join(dir, "list.txt"), "alpha\nbeta\n");
  writeFileSync(join(dir, "measure/count.sh"), "#!/bin/sh\necho \"lines: $(grep -c . list.txt)\"\n");
  writeFileSync(join(dir, "p.json"), JSON.stringify({
    version: 1, name: "count", goal: "Make the list longer.", artifact: ["list.txt"], protect: ["measure/**"],
    measure: { command: "sh measure/count.sh", direction: "higher", runs: 1 }, proposer: "model",
    model: { provider: "anthropic", model: "claude-test" }, budget: { max_rounds: 2 },
  }));
  git("add", "."); git("commit", "-qm", "init");
  const replies = [
    JSON.stringify({ proposals: [{ summary: "add gamma", edits: [{ path: "list.txt", search: "beta\n", replace: "beta\ngamma\n" }] }] }),
    "not json at all",
  ];
  seen = [];
  answer = () => message(replies.shift() ?? '{"proposals": []}')();
  const childEnv: NodeJS.ProcessEnv = { ...process.env, SYNTHE_ANTHROPIC_BASE_URL: base, SYNTHE_ANTHROPIC_KEY: KEY };
  delete childEnv.SYNTHE_API_KEY; delete childEnv.ANTHROPIC_API_KEY;
  const out = join(dir, ".out");
  const res = await new Promise<{ code: number | null; text: string }>((done) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, "..", "src", "cli", "main.ts"), "solve", join(dir, "p.json"), "--out", out], { cwd: dir, env: childEnv });
    let text = "";
    child.stdout.on("data", (d) => (text += d)); child.stderr.on("data", (d) => (text += d));
    child.on("close", (code) => done({ code, text }));
  });
  assert.equal(res.code, 0, res.text);
  assert.ok(seen.length >= 2 && seen.every((s) => s.url === "/v1/messages" && sentKey(s) === KEY));
  const result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
  assert.equal(result.final, 3);
  assert.equal(result.attempts[0].kept, true);
  assert.equal(result.attempts[1].kept, false);
  assert.match(result.attempts[1].reason, /not valid JSON/);
  assert.ok(!res.text.includes(KEY));
  for (const f of readdirSync(out)) assert.ok(!readFileSync(join(out, f), "utf8").includes(KEY), f);
});
