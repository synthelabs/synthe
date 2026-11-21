import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { after, before, test } from "node:test";

// `solve` with proposer "model" end to end, against a loopback fake of an OpenAI-compatible server. No real model call.
const CLI = join(import.meta.dirname, "..", "src", "cli", "main.ts");
const KEY = "sk-e2e-secret-456";

let bodies: any[] = [];
let replies: string[] = [];
const server: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    bodies.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
    const content = replies.shift() ?? '{"proposals": []}';
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }));
  });
});
let base = "";
before(async () => { await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`; });
after(() => server.close());

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
function repo(files: Record<string, string>) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "synthe-model-e2e-")));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env: GIT_ENV }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), t); }
  git("add", ".");
  git("commit", "-qm", "init");
  return { dir, git };
}

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => done({ code, out }));
  });
}

const env = (extra: Record<string, string>) => {
  const e: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of Object.keys(e)) if (/_API_KEY$/.test(k) && !(k in extra)) delete e[k];
  return e;
};

function problem(dir: string, extra: Record<string, unknown> = {}) {
  const p = {
    version: 1, name: "count", goal: "Make the list longer.", artifact: ["list.txt"], protect: ["measure/**"],
    measure: { command: "sh measure/count.sh", direction: "higher", runs: 1 },
    proposer: "model", model: { base_url: base, model: "fake-model" }, budget: { max_rounds: 3 }, ...extra,
  };
  writeFileSync(join(dir, "count.problem.json"), JSON.stringify(p, null, 2));
  return join(dir, "count.problem.json");
}

const FILES = { "list.txt": "alpha\nbeta\n", "measure/count.sh": "#!/bin/sh\necho \"lines: $(grep -c . list.txt)\"\n" };
const add = (word: string, after = "beta") => JSON.stringify({ proposals: [{ summary: `add ${word}`, edits: [{ path: "list.txt", search: `${after}\n`, replace: `${after}\n${word}\n` }] }] });

test("solve with proposer model sends the stdin object, keeps a gain, and turns a malformed reply into a failed attempt", async () => {
  const r = repo(FILES);
  const file = problem(r.dir);
  r.git("add", "."); r.git("commit", "-qm", "problem");
  bodies = [];
  replies = [add("gamma"), "Sorry, I cannot help with JSON today.", '{"proposals": []}'];
  const out = join(r.dir, ".out");
  const res = await run(["solve", file, "--out", out], r.dir, env({ SYNTHE_API_KEY: KEY }));
  assert.equal(res.code, 0, res.out);

  assert.ok(bodies.length >= 2, `the model was asked at least twice: ${bodies.length}`);
  assert.ok(bodies.every((b) => b.auth === `Bearer ${KEY}`));
  assert.equal(bodies[0].body.model, "fake-model");
  const user = bodies[0].body.messages.find((m: any) => m.role === "user").content as string;
  const sent = JSON.parse(user.slice(user.indexOf("{")));
  assert.equal(sent.round, 1);
  assert.equal(sent.goal, "Make the list longer.");
  assert.deepEqual(sent.files, [{ path: "list.txt", text: "alpha\nbeta\n" }]);
  assert.deepEqual(sent.history, []);
  assert.equal(sent.candidates, 1);
  // Round 2 sees round 1 in its history and the kept version of the file.
  const second = JSON.parse((bodies[1].body.messages.find((m: any) => m.role === "user").content as string).replace(/^[^{]*/, ""));
  assert.equal(second.history.length, 1);
  assert.equal(second.history[0].kept, true);
  assert.deepEqual(second.files, [{ path: "list.txt", text: "alpha\nbeta\ngamma\n" }]);

  const result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
  assert.equal(result.baseline, 2);
  assert.equal(result.final, 3);
  assert.equal(result.attempts[0].kept, true);
  const failed = result.attempts[1];
  assert.equal(failed.kept, false);
  assert.match(failed.reason, /not valid JSON/);

  // The key appears nowhere: not in output, result.json, report.md, or the working tree.
  assert.ok(!res.out.includes(KEY));
  for (const f of readdirSync(out)) assert.ok(!readFileSync(join(out, f), "utf8").includes(KEY), f);
  assert.equal(r.git("status", "--porcelain", "--", "list.txt", "count.problem.json", "measure"), "");
});

test("proposer model without SYNTHE_API_KEY is a failed setup: exit 1 and no request", async () => {
  const r = repo(FILES);
  const file = problem(r.dir);
  r.git("add", "."); r.git("commit", "-qm", "problem");
  bodies = [];
  const res = await run(["solve", file, "--out", join(r.dir, ".out")], r.dir, env({}));
  assert.equal(res.code, 1, res.out);
  assert.match(res.out, /SYNTHE_API_KEY/);
  assert.equal(bodies.length, 0);
});

test("budget.max_calls stops a model run, and each request counts as one call", async () => {
  const r = repo(FILES);
  const file = problem(r.dir, { budget: { max_rounds: 6, max_calls: 2 } });
  r.git("add", "."); r.git("commit", "-qm", "problem");
  bodies = [];
  replies = [add("gamma"), add("delta", "gamma"), add("eps", "delta"), add("zeta", "eps")];
  const out = join(r.dir, ".out");
  const res = await run(["solve", file, "--out", out], r.dir, env({ SYNTHE_API_KEY: KEY }));
  assert.equal(res.code, 0, res.out);
  assert.equal(bodies.length, 2);
  const result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
  assert.match(result.stopped, /call/i);
});
