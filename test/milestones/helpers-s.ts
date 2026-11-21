// Shared helpers for the stage 2 milestone checks (S01 to S05). The checks call the CLI as a black box:
// `node src/cli/main.ts <command>`. They build each fixture git repository in a temp folder, and every model call
// goes to a fake Messages API server on 127.0.0.1. Only Node built-ins. Nothing here imports from src/.
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CLI = join(ROOT, "src/cli/main.ts");

// Random tokens and numbers: names, texts and values differ in each run, so no code can match on them.
export const tag = (bytes = 3) => randomBytes(bytes).toString("hex");
export const randInt = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));
export function sample<T>(items: readonly T[], n: number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) { const j = randInt(0, i); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

export function tempDir(label: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `synthe-ms-${label}-`)));
}

export const tail = (text: string, lines = 25) => text.trim().split("\n").slice(-lines).join("\n");
export const memo = <T>(f: () => Promise<T>) => { let p: Promise<T> | undefined; return () => (p ??= f()); };

// ---------------------------------------------------------------------------------------------------------------
// Processes

// The environment of a CLI run: a private home folder, and no key or Synthe setting from the person who runs the
// checks. So a check can never spend money, and no run sees the memory of another check. NODE_TEST_CONTEXT must
// go too: with it, a `node --test` that a guard starts does not report its failures. No git identity is set here:
// each fixture repository has its own, and Synthe's own tests (the S05 guard) need git to have none.
export function cliEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(SYNTHE_|ANTHROPIC_|OPENAI_|GIT_|XDG_|NODE_TEST)/.test(k)) continue;
    env[k] = v;
  }
  mkdirSync(home, { recursive: true });
  Object.assign(env, {
    HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_STATE_HOME: join(home, ".state"),
    XDG_DATA_HOME: join(home, ".data"), XDG_CACHE_HOME: join(home, ".cache"),
    GIT_CONFIG_NOSYSTEM: "1",
  }, extra);
  return env;
}

export interface Ran { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; out: string; timedOut: boolean }
export interface RunOptions { cwd: string; home: string; env?: Record<string, string>; timeoutMs?: number; input?: string }
export interface Started { child: ChildProcess; done: Promise<Ran>; kill(): void }

// Starts a command in its own process group. `kill()` sends SIGKILL to the whole group: the command gets no
// chance to clean up, as when a person's machine stops.
export function start(cmd: string, args: string[], o: RunOptions): Started {
  const child = spawn(cmd, args, { cwd: o.cwd, env: cliEnv(o.home, o.env), stdio: ["pipe", "pipe", "pipe"], detached: true });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout!.on("data", (d) => { stdout += d; });
  child.stderr!.on("data", (d) => { stderr += d; });
  const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
  const timer = setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs ?? 90_000);
  const done = new Promise<Ran>((ok) => {
    child.on("error", (e) => { stderr += String(e); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) stderr += `\n[the check stopped this command after ${o.timeoutMs ?? 90_000} ms]`;
      ok({ code, signal, stdout, stderr, out: `${stdout}\n${stderr}`, timedOut });
    });
  });
  child.stdin!.on("error", () => {});
  child.stdin!.end(o.input ?? "");
  return { child, done, kill };
}

// `node src/cli/main.ts <args>`: the way every check calls Synthe.
export const startCli = (args: string[], o: RunOptions) => start(process.execPath, [CLI, ...args], o);
export const runCli = (args: string[], o: RunOptions) => startCli(args, o).done;

export async function waitFor(what: string, ready: () => boolean, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!ready()) {
    assert.ok(Date.now() < end, `waited ${timeoutMs} ms for ${what}`);
    await new Promise((ok) => setTimeout(ok, 25));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Fixture repositories

export interface Repo {
  base: string; // temp folder that holds the repository, the private home folder and the logs
  dir: string; // the repository
  home: string;
  git(...args: string[]): string;
  write(path: string, text: string): void;
  commit(message: string): void; // stage every file and commit
}

export function gitIn(dir: string): (...args: string[]) => string {
  return (...args) => execFileSync("git", args, {
    cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

// A git repository on branch main with one commit that holds `files`.
export function makeRepo(files: Record<string, string>, label: string): Repo {
  const base = tempDir(label);
  const dir = join(base, "repo");
  const home = join(base, "home");
  mkdirSync(dir);
  mkdirSync(home);
  const git = gitIn(dir);
  const write = (path: string, text: string) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  const commit = (message: string) => { git("add", "-A"); git("commit", "-qm", message); };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "team@example.com");
  git("config", "user.name", "Team");
  git("config", "commit.gpgsign", "false");
  for (const [path, text] of Object.entries(files)) write(path, text);
  commit("Start");
  return { base, dir, home, git, write, commit };
}

export interface TreeSnapshot { head: string; branch: string; status: string; files: Map<string, string> }

export function snapshot(dir: string): TreeSnapshot {
  const git = gitIn(dir);
  const files = new Map<string, string>();
  for (const f of git("ls-files").split("\n").filter(Boolean)) {
    const s = statSync(join(dir, f), { throwIfNoEntry: false });
    if (s?.isFile()) files.set(f, readFileSync(join(dir, f), "latin1"));
  }
  return { head: git("rev-parse", "HEAD"), branch: git("rev-parse", "--abbrev-ref", "HEAD"), status: statusOf(dir), files };
}

// Untracked files under .synthe/ do not count: the contract puts the default output folder there.
function statusOf(dir: string): string {
  return gitIn(dir)("status", "--porcelain", "--untracked-files=all").split("\n").filter((l) => l && !/^\?\? \.synthe\//.test(l)).join("\n");
}

// The person's working tree and current branch did not change.
export function assertTreeUnchanged(dir: string, before: TreeSnapshot) {
  const git = gitIn(dir);
  assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), before.branch, "the current branch changed");
  assert.equal(git("rev-parse", "HEAD"), before.head, "the current commit changed");
  for (const [f, text] of before.files) {
    assert.ok(existsSync(join(dir, f)), `${f} is gone from the working tree`);
    assert.ok(readFileSync(join(dir, f), "latin1") === text, `${f} changed in the working tree`);
  }
  assert.equal(statusOf(dir), before.status, "git status changed outside .synthe/");
}

export function showFile(dir: string, ref: string, path: string): string {
  return execFileSync("git", ["show", `${ref}:${path}`], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// Every file under dir, as absolute paths. Links are not followed.
export function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walkFiles(p) : e.isFile() ? [p] : [];
  });
}

// ---------------------------------------------------------------------------------------------------------------
// result.json

export function readResult(outDir: string, run?: Ran): any {
  const path = join(outDir, "result.json");
  assert.ok(existsSync(path), `solve wrote no result.json in ${outDir}${run ? `\n${tail(run.out)}` : ""}`);
  const result = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(Array.isArray(result.attempts), `result.json has no attempts list: ${JSON.stringify(result).slice(0, 400)}`);
  return result;
}

// The attempts whose summary holds `summary`.
export function attemptsWith(result: any, summary: string): any[] {
  return result.attempts.filter((a: any) => typeof a?.summary === "string" && a.summary.includes(summary));
}

// The one attempt whose summary holds `summary`.
export function attempt(result: any, summary: string): any {
  const found = attemptsWith(result, summary);
  assert.equal(found.length, 1, `result.json has exactly one attempt with the summary "${summary}": ${JSON.stringify(result.attempts)}`);
  return found[0];
}

export function near(actual: unknown, expected: number, what: string, tolerance = 1e-6) {
  assert.ok(typeof actual === "number" && Math.abs(actual - expected) <= tolerance, `${what}: expected ${expected}, got ${JSON.stringify(actual)}`);
}

export function plainReason(s: unknown, what: string): string {
  assert.ok(typeof s === "string" && /[a-z]{3,}\s+\S+\s+\S+/i.test(s), `${what} is a reason in plain words: ${JSON.stringify(s)}`);
  return s as string;
}

// ---------------------------------------------------------------------------------------------------------------
// Scripted proposers. They decide only from their stdin, never from a call counter.

export interface Edit { path: string; search: string; replace: string }
export interface Proposal { summary: string; edits: Edit[] }

// CommonJS source of a proposer. It appends each stdin object to `logPath` (outside the repository). It sends the
// first proposal whose summary is not yet in the history, and an empty list when every proposal is in the history.
export function listProposer(logPath: string, proposals: Proposal[]): string {
  return `const fs = require("fs");
let raw = "";
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ raw }) + "\\n");
  const input = JSON.parse(raw);
  const seen = (input.history || []).map((h) => String(h && h.summary != null ? h.summary : ""));
  const next = ${JSON.stringify(proposals)}.find((p) => !seen.some((s) => s.includes(p.summary)));
  process.stdout.write(JSON.stringify({ proposals: next ? [next] : [] }));
});
`;
}

// Every stdin object a proposer got, in order. An empty list when the proposer never ran.
export function readProposerLog(logPath: string): any[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(JSON.parse(line).raw));
}

// CommonJS source of a measure for the "knob" fixture: the score is the sum of every `level=N` line in knob.txt
// minus the sum of every `penalty=N` line in other.txt. It finds the files from its own folder. It prints other
// numbers first, so only the last number on stdout is the score. `extra` is source that runs first, with `knob`
// (the text of knob.txt) in scope.
export function knobMeasure(extra = ""): string {
  return `const fs = require("fs"), path = require("path");
const read = (f) => { const p = path.join(__dirname, "..", f); return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""; };
const sum = (text, key) => [...text.matchAll(new RegExp("^" + key + "=(\\\\d+)", "gm"))].reduce((a, m) => a + Number(m[1]), 0);
const knob = read("knob.txt");
${extra}
console.log("checked 2 files in 3 ms");
console.log("score " + (sum(knob, "level") - sum(read("other.txt"), "penalty")));
`;
}

export interface Knob {
  repo: Repo;
  name: string;
  problemFile: string; // relative to the repository
  log: string; // the proposer's stdin log, outside the repository
  out: string; // a folder outside the repository for --out
}

// A repository with knob.txt (`level=<level>`), other.txt (`penalty=0`), a knob measure with 1 run, and a problem
// file. `problem` adds or replaces fields of the problem file. With `proposals`, the proposer is a listProposer.
export function knobFixture(o: { label: string; level: number; proposals?: Proposal[]; problem?: Record<string, unknown>; measureExtra?: string }): Knob {
  const t = tag();
  const measureFile = `tools/score-${t}.cjs`;
  const repo = makeRepo({
    "knob.txt": `level=${o.level}\n# notes ${t}\n`,
    "other.txt": "penalty=0\n",
    [measureFile]: knobMeasure(o.measureExtra),
  }, o.label);
  const log = join(repo.base, "proposer.log");
  const name = `${o.label}-${t}`;
  const problemFile = `solve-${t}.json`;
  if (o.proposals) repo.write("propose.cjs", listProposer(log, o.proposals));
  repo.write(problemFile, JSON.stringify({
    version: 1, name, goal: `Raise the score of ${name}.`, artifact: ["knob.txt", "other.txt"],
    measure: { command: `node ${measureFile}`, direction: "higher", runs: 1 },
    ...(o.proposals ? { proposer: { command: "node propose.cjs" } } : {}),
    budget: { max_rounds: 20 },
    ...(o.problem ?? {}),
  }, null, 2));
  repo.commit("Add the problem");
  return { repo, name, problemFile, log, out: join(repo.base, "out") };
}

// ---------------------------------------------------------------------------------------------------------------
// A fake Messages API (POST /v1/messages) on 127.0.0.1. Like the real API, it refuses a request with no key, no
// anthropic-version header, or a body without `model`, `max_tokens` and `messages`. The key goes in the x-api-key
// header or as a bearer token in the authorization header: the official SDK has used both. The reply text and
// the usage numbers come from the check. It answers with one JSON message, or with server-sent events when the
// request has "stream": true.

export interface Usage { input_tokens: number; output_tokens: number }
export interface FakeCall {
  n: number; // 1 for the first accepted call
  headers: IncomingHttpHeaders;
  raw: string; // the request body as sent
  body: any;
  text: string; // every string in the body, joined: what the model reads
  usage: Usage; // what the fake reported for this call
}
export interface FakeReply { text: string; usage?: Usage }
export interface Refused { method: string; url: string; status: number; why: string }
export interface FakeMessages {
  url: string;
  calls: FakeCall[]; // accepted POST /v1/messages requests
  refused: Refused[]; // every other request
  raws: string[]; // the URL, the headers (without the key headers) and the body of every request, for key leak checks
  total(): Usage;
  close(): Promise<void>;
}

// Every string in a JSON value, joined with new lines.
export function stringsIn(value: unknown): string {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  visit(value);
  return out.join("\n");
}

export async function startFakeMessages(reply: (call: FakeCall) => FakeReply, o: { key?: string } = {}): Promise<FakeMessages> {
  const calls: FakeCall[] = [];
  const refused: Refused[] = [];
  const raws: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      const headers = { ...req.headers };
      const key = String(headers["x-api-key"] ?? "") || String(headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      delete headers["x-api-key"];
      delete headers.authorization;
      raws.push(`${req.method} ${req.url}\n${JSON.stringify(headers)}\n${raw}`);
      const refuse = (status: number, type: string, why: string) => {
        refused.push({ method: req.method ?? "", url: req.url ?? "", status, why });
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type, message: why } }));
      };
      const path = (req.url ?? "").split("?")[0];
      if (req.method !== "POST" || path !== "/v1/messages") return refuse(404, "not_found_error", `the fake serves only POST /v1/messages, not ${req.method} ${path}`);
      if (!key) return refuse(401, "authentication_error", "the request has no key: no x-api-key header and no authorization header");
      if (o.key !== undefined && key !== o.key) return refuse(401, "authentication_error", "the key header does not hold the key that the check set");
      if (!req.headers["anthropic-version"]) return refuse(400, "invalid_request_error", "the request has no anthropic-version header");
      let body: any;
      try { body = JSON.parse(raw); } catch { return refuse(400, "invalid_request_error", "the request body is not JSON"); }
      if (typeof body?.model !== "string" || !body.model) return refuse(400, "invalid_request_error", "model: field required");
      if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) return refuse(400, "invalid_request_error", "max_tokens: field required");
      if (!Array.isArray(body.messages) || body.messages.length === 0) return refuse(400, "invalid_request_error", "messages: field required");
      const call: FakeCall = { n: calls.length + 1, headers: req.headers, raw, body, text: stringsIn({ system: body.system, messages: body.messages }), usage: { input_tokens: 0, output_tokens: 0 } };
      const r = reply(call);
      call.usage = r.usage ?? { input_tokens: randInt(200, 900), output_tokens: randInt(20, 200) };
      calls.push(call);
      const id = `msg_fake_${tag(6)}`;
      const usage = { ...call.usage, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      if (body.stream !== true) {
        res.writeHead(200, { "content-type": "application/json", "request-id": `req_fake_${call.n}` });
        res.end(JSON.stringify({ id, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: r.text }], stop_reason: "end_turn", stop_sequence: null, usage }));
        return;
      }
      // As the real API does: message_start has the input tokens, and the last message_delta has the output total.
      const events: [string, unknown][] = [
        ["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: r.text } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: call.usage.output_tokens } }],
        ["message_stop", { type: "message_stop" }],
      ];
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": `req_fake_${call.n}` });
      res.end(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url, calls, refused, raws,
    total: () => calls.reduce((t, c) => ({ input_tokens: t.input_tokens + c.usage.input_tokens, output_tokens: t.output_tokens + c.usage.output_tokens }), { input_tokens: 0, output_tokens: 0 }),
    close: () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); }),
  };
}

// Every request went to POST /v1/messages in the form the Messages API takes, with the key in a key header.
export function assertMessagesOnly(fake: FakeMessages) {
  assert.deepEqual(fake.refused, [], "the fake Messages API refused a request");
}

// The reply text for a request that asks for a verdict. With structured outputs (output_config.format.schema, as
// the Messages API takes it), the reply fits the schema: the verdict goes in the field that allows "a", "b" and
// "tie", and every other text field gets `note`. With no schema, the reply is {"winner": ...}, the object a
// compare command prints.
export function verdictText(call: FakeCall, winner: "a" | "b" | "tie", note = "ok"): string {
  const schema = call.body?.output_config?.format?.schema;
  return JSON.stringify(schema && typeof schema === "object" ? fill(schema, (s) => (Array.isArray(s.enum) && s.enum.includes("tie") ? winner : note)) : { winner });
}

// The reply text for a request that asks for free text, such as a rubric: the text itself, or with structured
// outputs an object that fits the schema with the text in every text field.
export function freeText(call: FakeCall, text: string): string {
  const schema = call.body?.output_config?.format?.schema;
  return schema && typeof schema === "object" ? JSON.stringify(fill(schema, () => text)) : text;
}

function fill(schema: any, text: (schema: any) => string): unknown {
  const type = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
  if (type === "object" || schema?.properties) return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, fill(v, text)]));
  if (type === "array") return [fill(schema.items ?? { type: "string" }, text)];
  if (type === "number" || type === "integer") return 1;
  if (type === "boolean") return true;
  if (Array.isArray(schema?.enum) && !schema.enum.includes("tie")) return schema.enum[0];
  return text(schema);
}

// Which of two texts the request shows first: the checks take the output that the request names "a" to come before
// the output it names "b". Each text is located by its last occurrence.
export function firstOf(text: string, x: string, y: string): "x" | "y" | null {
  const ix = text.lastIndexOf(x), iy = text.lastIndexOf(y);
  if (ix < 0 || iy < 0) return null;
  return ix < iy ? "x" : "y";
}

// The key appears in no output, in no request outside the key headers, in no file under `dirs`, and in no commit
// of `repo`.
export function assertNoKey(key: string, where: { outputs: string[]; fake: FakeMessages; dirs: string[]; repo?: string }) {
  for (const o of where.outputs) assert.ok(!o.includes(key), "the key is in Synthe's output");
  for (const r of where.fake.raws) assert.ok(!r.includes(key), "the key is in a request outside the key headers (x-api-key, authorization)");
  for (const dir of where.dirs) {
    for (const f of walkFiles(dir)) assert.ok(!readFileSync(f).includes(key), `the key is in a file: ${f}`);
  }
  if (where.repo) assert.ok(!gitIn(where.repo)("log", "--all", "-p", "--format=%B").includes(key), "the key is in the git history of the repository");
}

// ---------------------------------------------------------------------------------------------------------------
// A judged fixture: the artifact style.txt holds one word, and the `run` command prints each case's input with that
// word. So an output is better or worse only through the word, and a fake judge can rank words.

export interface Judged {
  repo: Repo;
  name: string;
  problemFile: string;
  log: string;
  out: string;
  cases: number;
}

// `word` is the word in style.txt at the start. `runExtra` is source that runs first in the run command.
export function judgedFixture(o: { label: string; word: string; proposals: Proposal[]; problem?: Record<string, unknown>; runExtra?: string }): Judged {
  const t = tag();
  const cases = Array.from({ length: 8 }, (_, i) => ({ id: `case-${i + 1}-${tag(2)}`, input: `question ${tag(4)}` }));
  const repo = makeRepo({
    "style.txt": `${o.word}\n`,
    "cases.jsonl": cases.map((c) => JSON.stringify(c)).join("\n") + "\n",
    "run.cjs": `const fs = require("fs"), path = require("path");
${o.runExtra ?? ""}
let raw = "";
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  const c = JSON.parse(raw);
  console.log("reply to " + c.input + ": " + fs.readFileSync(path.join(__dirname, "style.txt"), "utf8").trim());
});
`,
  }, o.label);
  const log = join(repo.base, "proposer.log");
  const name = `${o.label}-${t}`;
  const problemFile = `judged-${t}.json`;
  repo.write("propose.cjs", listProposer(log, o.proposals));
  repo.write(problemFile, JSON.stringify({
    version: 1, name, goal: `Make the replies of ${name} better.`, artifact: ["style.txt"],
    measure: { judge: { cases: "cases.jsonl", run: "node run.cjs", compare: "model" } },
    proposer: { command: "node propose.cjs" }, budget: { max_rounds: 4 },
    ...(o.problem ?? {}),
  }, null, 2));
  repo.commit("Add the problem");
  return { repo, name, problemFile, log, out: join(repo.base, "out"), cases: cases.length };
}

// A fake judge that ranks words: `words` goes from best to worst. It finds the two words in the request and names
// the better one. One word or none in the request is a tie.
export function rankJudge(words: string[]): (call: FakeCall) => FakeReply {
  return (call) => {
    const found = words.filter((w) => call.text.includes(w));
    if (found.length < 2) return { text: verdictText(call, "tie") };
    const [better, worse] = found;
    return { text: verdictText(call, firstOf(call.text, better, worse) === "x" ? "a" : "b") };
  };
}
