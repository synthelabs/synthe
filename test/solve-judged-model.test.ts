import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

// `solve` with a judged measure whose compare is "model", against a loopback fake of an OpenAI-compatible server.
// The fake judge truly prefers answers that give a reason, and otherwise prefers the longer answer (length bias).
// No real model call.
const CLI = resolve(import.meta.dirname, "..", "src", "cli", "main.ts");
const KEY = "sk-judge-secret-789";

let asked = 0;
let auths = new Set<string | undefined>();
const server: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    asked++;
    auths.add(req.headers.authorization);
    const body = JSON.parse(raw);
    const user = [...body.messages].reverse().find((m: { role: string }) => m.role === "user");
    const q = JSON.parse(typeof user.content === "string" ? user.content : user.content.map((p: { text: string }) => p.text).join(""));
    const g = (s: string) => s.includes("because");
    // A length bias on some of the cases only: when neither reply gives a reason, the longer one wins for those cases.
    const follows = Number(/question (\d)/.exec(q.a)?.[1] ?? 1) % 3 === 0;
    const w = g(q.a) !== g(q.b) ? (g(q.a) ? "a" : "b") : !follows || q.a.length === q.b.length ? "tie" : q.a.length > q.b.length ? "a" : "b";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ winner: w }) }, finish_reason: "stop" }] }));
  });
});
let base = "";
before(async () => { await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`; });
after(() => server.close());

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function repo(budget: Record<string, number>): string {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "solve-judged-model-")));
  git(top, "init", "-q", "-b", "main");
  git(top, "config", "user.name", "T");
  git(top, "config", "user.email", "t@example.com");
  writeFileSync(join(top, "style.txt"), "Answer.");
  writeFileSync(join(top, "cases.jsonl"), Array.from({ length: 8 }, (_, i) => JSON.stringify({ id: `q${i}`, input: `question ${i}` })).join("\n") + "\n");
  writeFileSync(join(top, "run.mjs"), `import {readFileSync} from "node:fs"; const c = JSON.parse(readFileSync(0, "utf8")); console.log(c.input + ": " + readFileSync("style.txt", "utf8"));`);
  const proposals = [
    { summary: "Pad the answer", replace: "Answer, with many more words that add nothing new at all." },
    { summary: "Give the reason", replace: "Answer, because of the rule." },
  ];
  writeFileSync(join(top, "propose.mjs"), `import {readFileSync} from "node:fs"; const req = JSON.parse(readFileSync(0, "utf8"));
const list = ${JSON.stringify(proposals)}; const p = list[req.round - 1];
const text = req.files.find((f) => f.path === "style.txt").text;
console.log(JSON.stringify({ proposals: p ? [{ summary: p.summary, edits: [{ path: "style.txt", search: text, replace: p.replace }] }] : [] }));`);
  writeFileSync(join(top, "problem.json"), JSON.stringify({
    version: 1, name: "replies", goal: "Better replies.", artifact: ["style.txt"],
    measure: { judge: { cases: "cases.jsonl", run: "node run.mjs", compare: "model" } },
    proposer: { command: "node propose.mjs" }, model: { base_url: base, model: "fake-judge" }, budget,
  }));
  git(top, "add", "-A");
  git(top, "commit", "-qm", "init");
  return top;
}

function run(top: string, key: string | null): Promise<{ code: number | null; out: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (/_API_KEY$/.test(k) || k.startsWith("SYNTHE_")) delete env[k];
  if (key) env.SYNTHE_API_KEY = key;
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, "solve", join(top, "problem.json"), "--out", join(top, "out")], { cwd: top, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => done({ code, out }));
  });
}

test("compare model: the model judge keeps a real gain, refuses a longer-only change, and the key goes only to base_url", async () => {
  asked = 0;
  auths = new Set();
  const top = repo({ max_rounds: 4 });
  const r = await run(top, KEY);
  assert.equal(r.code, 0, r.out);
  const result = JSON.parse(readFileSync(join(top, "out", "result.json"), "utf8"));
  const [pad, reason] = result.attempts;
  assert.equal(pad.kept, false, pad.reason);
  assert.match(pad.reason, /did not clearly prefer/);
  assert.equal(reason.kept, true, reason.reason);
  assert.equal(git(top, "show", `${result.branch}:style.txt`), "Answer, because of the rule.");
  assert.ok(asked >= 16, `the model judge was asked each case in both orders (asked ${asked})`);
  assert.deepEqual([...auths], [`Bearer ${KEY}`]);
  for (const f of ["result.json", "report.md"]) assert.ok(!readFileSync(join(top, "out", f), "utf8").includes(KEY), `${f} holds no key`);
  assert.ok(!r.out.includes(KEY), "the output holds no key");
});

test("compare model: each judge question counts against max_calls", async () => {
  const top = repo({ max_rounds: 4, max_calls: 10 });
  const r = await run(top, KEY);
  assert.equal(r.code, 0, r.out);
  const result = JSON.parse(readFileSync(join(top, "out", "result.json"), "utf8"));
  assert.match(result.stopped, /call/i, result.stopped);
  assert.equal(result.attempts.length, 1, "the run stopped after the first round used more than 10 calls");
});

test("compare model with no key stops setup with exit 1 and a plain reason", async () => {
  const top = repo({ max_rounds: 4 });
  const r = await run(top, null);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /SYNTHE_API_KEY/);
});
