// `measure draft`: the real CLI against a loopback fake of the Anthropic Messages API. No real model call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkJudge, compareEnv, readExamples } from "../src/solve/draft.ts";

const CLI = join(import.meta.dirname, "..", "src/cli/main.ts");
const KEY = "sk-ant-test-key-123456";

type Judge = (a: string, b: string) => string;

// The fake: the key may come as x-api-key or as a bearer token (the SDK sends the latter). The rubric request gets a rubric; a compare request gets the winner from `judge`. Records every request.
async function fakeAnthropic(judge: Judge) {
  const seen: { path: string; key: string | undefined; body: { system?: string; messages: { content: string }[] } }[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    seen.push({ path: req.url ?? "", key: (req.headers["x-api-key"] as string | undefined) ?? req.headers.authorization?.replace(/^Bearer /, ""), body });
    const user: string = body.messages[0].content;
    const compare = user.match(/Output A:\n([\s\S]*?)\n\nOutput B:\n([\s\S]*?)\n\nWhich output/);
    const text = compare ? JSON.stringify({ winner: judge(compare[1], compare[2]) }) : "# Rubric\n\n1. The reply answers the question that was asked.\n2. The reply is polite.";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function run(args: string[], cwd: string, env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("SYNTHE_") && k !== "ANTHROPIC_BASE_URL"));
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...clean, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => done({ code, out }));
  });
}

const EXAMPLES = [
  { input: "Where is my order?", good: "GOOD: It ships tomorrow; here is the tracking link.", bad: "Please wait." },
  { input: "Can I get a refund?", good: "GOOD: Yes, within 30 days. I started it for you.", bad: "Read the policy." },
  { input: "How do I reset my password?", good: "GOOD: Click 'Forgot password' on the sign-in page.", bad: "Contact support." },
  { input: "Do you ship to Canada?", good: "GOOD: Yes, in 5 to 7 days.", bad: "Maybe." },
  { input: "Is the store open on Sunday?", good: "GOOD: Yes, from 10 to 4.", bad: "Check the website." },
];

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "synthe-draft-"));
  writeFileSync(join(dir, "examples.jsonl"), EXAMPLES.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return dir;
}

test("measure draft writes the measure files, checks both orders, prints the agreement and exits 0", async () => {
  // A fair judge: it picks the output marked GOOD, wherever it is.
  const fake = await fakeAnthropic((a, b) => (a.startsWith("GOOD") ? "a" : b.startsWith("GOOD") ? "b" : "tie"));
  try {
    const dir = workspace();
    const r = await run(["measure", "draft", "--examples", "examples.jsonl", "--out", "judge", "--model", "claude-test"], dir, { SYNTHE_API_KEY: KEY, SYNTHE_ANTHROPIC_BASE_URL: fake.url });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /agreement 5\/5/);
    assert.ok(!r.out.includes(KEY), "the key never appears in output");
    assert.match(r.out, /"cases": "judge\/cases\.jsonl", .*"compare": "model", "rubric": "judge\/rubric\.md"/, "it prints the snippet for solve, with relative paths");

    const cases = readFileSync(join(dir, "judge/cases.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(cases, EXAMPLES.map((e, i) => ({ id: `ex-${i + 1}`, input: e.input })));
    assert.match(readFileSync(join(dir, "judge/rubric.md"), "utf8"), /answers the question/);
    assert.ok(existsSync(join(dir, "judge/compare.js")));
    assert.ok(!readFileSync(join(dir, "judge/compare.js"), "utf8").includes(KEY), "compare.js holds no key");

    // One rubric request, then two compare requests per example, all to the fake with the key.
    assert.equal(fake.seen.length, 1 + 2 * EXAMPLES.length);
    assert.deepEqual([...new Set(fake.seen.map((s) => `${s.path} ${s.key}`))], [`/v1/messages ${KEY}`]);
    assert.match(fake.seen[0].body.messages[0].content, /Better output:\nGOOD: It ships tomorrow/);
    const compares = fake.seen.slice(1).map((s) => s.body.messages[0].content);
    for (const e of EXAMPLES) {
      assert.ok(compares.some((c) => c.includes(`Output A:\n${e.good}\n\nOutput B:\n${e.bad}`)), "good first");
      assert.ok(compares.some((c) => c.includes(`Output A:\n${e.bad}\n\nOutput B:\n${e.good}`)), "good second");
    }
    assert.ok(compares.every((c) => c.includes("answers the question")), "each compare request carries the rubric");
  } finally { await fake.close(); }
});

test("measure draft exits 2 and names the examples when agreement is below 80%", async () => {
  // A judge with a position bias on two examples: it always picks a there, so it is right only one way round.
  const biased = ["Is the store open on Sunday?", "Do you ship to Canada?"].map((q) => EXAMPLES.find((e) => e.input === q)!);
  const fake = await fakeAnthropic((a, b) => (biased.some((e) => a === e.good || a === e.bad) ? "a" : a.startsWith("GOOD") ? "a" : "b"));
  try {
    const dir = workspace();
    const r = await run(["measure", "draft", "--examples", "examples.jsonl", "--out", "judge", "--model", "claude-test"], dir, { SYNTHE_ANTHROPIC_KEY: KEY, SYNTHE_ANTHROPIC_BASE_URL: fake.url });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /agreement 3\/5/);
    assert.match(r.out, /ex-4/);
    assert.match(r.out, /ex-5/);
    assert.match(r.out, /^    Do you ship to Canada\?$/m, "the full input of a disagreeing example is on its own line");
    assert.doesNotMatch(r.out, /ex-1\b/);
    assert.ok(existsSync(join(dir, "judge/rubric.md")), "the files stay, so the person can fix the rubric");
  } finally { await fake.close(); }
});

test("measure draft refuses bad input before any model call", async () => {
  const dir = workspace();
  writeFileSync(join(dir, "bad.jsonl"), '{"input":"x","good":"y"}\nnot json\n');
  const bad = await run(["measure", "draft", "--examples", "bad.jsonl", "--out", "j", "--model", "m"], dir, { SYNTHE_ANTHROPIC_KEY: KEY });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /line 1: needs "bad" as text/);
  assert.match(bad.out, /line 2: not valid JSON/);

  const noKey = await run(["measure", "draft", "--examples", "examples.jsonl", "--out", "j", "--model", "m"], dir, { SYNTHE_API_KEY: "not-anthropic" });
  assert.equal(noKey.code, 1);
  assert.match(noKey.out, /SYNTHE_ANTHROPIC_KEY/);

  const noModel = await run(["measure", "draft", "--examples", "examples.jsonl", "--out", "j"], dir, { SYNTHE_ANTHROPIC_KEY: KEY });
  assert.equal(noModel.code, 1);
  assert.equal((await run(["measure", "nope"], dir, {})).code, 1);
});

test("readExamples and checkJudge: a tie or a failed answer is not agreement", async () => {
  assert.equal(readExamples('{"input":"a","good":"same","bad":"same"}').ok, false);
  const ex = readExamples('{"input":"q1","good":"g","bad":"b"}\n\n{"input":"q2","good":"g2","bad":"b2"}\n');
  assert.ok(ex.ok);
  if (!ex.ok) return;
  const v = await checkJudge(ex.examples, async (q) => (q.case.id === "ex-1" ? (q.a === "g" ? "a" : "b") : "tie"));
  assert.deepEqual(v.map((x) => x.agrees), [true, false]);
});

test("measure draft uses the OpenAI-compatible model of a problem file, for the rubric and in compare.js", async () => {
  const seen: { path: string; auth: string | undefined }[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    seen.push({ path: req.url ?? "", auth: req.headers.authorization });
    const user: string = body.messages.at(-1).content;
    const m = user.match(/Output A:\n([\s\S]*?)\n\nOutput B:/);
    const content = m ? JSON.stringify({ winner: m[1].startsWith("GOOD") ? "a" : "b" }) : "# Rubric\n\n1. Answer the question.";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "c1", object: "chat.completion", model: body.model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const dir = workspace();
    spawnGitInit(dir);
    writeFileSync(join(dir, "problem.json"), JSON.stringify({
      version: 1, name: "replies", goal: "Better replies.", artifact: ["prompt.md"],
      model: { base_url: base, model: "m-1" },
    }));
    const r = await run(["measure", "draft", "--examples", "examples.jsonl", "--out", "judge", "--problem", "problem.json"], dir, { SYNTHE_API_KEY: "sk-other-999" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /agreement 5\/5/);
    assert.deepEqual([...new Set(seen.map((s) => `${s.path} ${s.auth}`))], ["/v1/chat/completions Bearer sk-other-999"]);
    assert.equal(seen.length, 1 + 2 * EXAMPLES.length);
  } finally { await new Promise<void>((r) => server.close(() => r())); }
});

function spawnGitInit(dir: string) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
}

test("compareEnv passes on only the provider's own key, never another provider's", () => {
  const anthropic = { provider: "anthropic" as const, model: "m" };
  const openai = { provider: "openai-compatible" as const, model: "m", base_url: "https://x.example/v1" };
  // A non-Anthropic SYNTHE_API_KEY is not an Anthropic key: compare.js gets nothing, not that key.
  assert.deepEqual(compareEnv(anthropic, { SYNTHE_API_KEY: "sk-other-1", SYNTHE_OTHER: "x" }), {});
  assert.deepEqual(compareEnv(anthropic, { SYNTHE_API_KEY: "sk-ant-1" }), { SYNTHE_ANTHROPIC_KEY: "sk-ant-1" });
  assert.deepEqual(compareEnv(anthropic, { SYNTHE_ANTHROPIC_KEY: "sk-ant-2", SYNTHE_API_KEY: "sk-other-1", SYNTHE_ANTHROPIC_BASE_URL: "http://127.0.0.1:9" }),
    { SYNTHE_ANTHROPIC_KEY: "sk-ant-2", SYNTHE_ANTHROPIC_BASE_URL: "http://127.0.0.1:9" });
  assert.deepEqual(compareEnv(openai, { SYNTHE_API_KEY: "sk-other-1", SYNTHE_ANTHROPIC_KEY: "sk-ant-2" }), { SYNTHE_API_KEY: "sk-other-1" });
  assert.deepEqual(compareEnv(openai, {}), {});
});

test("measure draft --problem reads only the model section and names a bad field", async () => {
  const dir = workspace();
  writeFileSync(join(dir, "p.json"), JSON.stringify({ version: 1, name: "x", model: { provider: "openai-compatible", model: "m" } }));
  const r = await run(["measure", "draft", "--examples", "examples.jsonl", "--out", "j", "--problem", "p.json"], dir, { SYNTHE_API_KEY: "k" });
  assert.equal(r.code, 1);
  assert.match(r.out, /p\.json: model\.base_url: the openai-compatible provider needs model\.base_url/);
  assert.doesNotMatch(r.out, /measure/i, "a missing measure is not an error here");
  writeFileSync(join(dir, "q.json"), JSON.stringify({ model: { model: "m", api_key: "sk-ant-leak" } }));
  const q = await run(["measure", "draft", "--examples", "examples.jsonl", "--out", "j", "--problem", "q.json"], dir, { SYNTHE_ANTHROPIC_KEY: "k" });
  assert.equal(q.code, 1);
  assert.match(q.out, /model\.api_key: never put a key/);
  assert.ok(!q.out.includes("sk-ant-leak"));
});
