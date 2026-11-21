// Helpers for the milestone checks of author A (P01 P02 P03 P08 P10 P13). The checks call the CLI as a black box:
// they build a git repository in a temp folder, write a scripted proposer into it, and read result.json.
// Only Node built-ins. Nothing here imports from src/.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CLI = join(ROOT, "src/cli/main.ts");

// A short random token: it makes names, paths and values different in each run, so no code can match on them.
export const tag = () => randomBytes(3).toString("hex");
export const randInt = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));

export function tempDir(label: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `synthe-ms-${label}-`)));
}

export interface Repo {
  base: string; // temp folder that holds the repository, the isolated HOME and the logs
  dir: string; // the repository
  home: string;
  git(...args: string[]): string;
  write(path: string, text: string): void;
  read(path: string): string;
  commit(message: string): void; // stage every file and commit
}

// A git repository on branch main with one commit that holds `files`.
export function makeRepo(files: Record<string, string>, label = "repo"): Repo {
  const base = tempDir(label);
  const dir = join(base, "repo");
  const home = join(base, "home");
  mkdirSync(dir);
  mkdirSync(home);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (path: string, text: string) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  const read = (path: string) => readFileSync(join(dir, path), "utf8");
  const commit = (message: string) => { git("add", "-A"); git("commit", "-qm", message); };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "team@example.com");
  git("config", "user.name", "Team");
  git("config", "commit.gpgsign", "false");
  for (const [path, text] of Object.entries(files)) write(path, text);
  commit("Start");
  return { base, dir, home, git, write, read, commit };
}

export interface CliResult { code: number | null; stdout: string; stderr: string; out: string }

// Runs `node src/cli/main.ts <args>`. The child gets no model keys from this process, and an isolated HOME,
// so no run can spend money and no run can see the memory of another test.
export function runCli(args: string[], opts: { cwd: string; home: string; env?: Record<string, string>; timeoutMs?: number }): Promise<CliResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(SYNTHE_|ANTHROPIC_|OPENAI_)/.test(k)) continue;
    env[k] = v;
  }
  Object.assign(env, {
    HOME: opts.home,
    XDG_CONFIG_HOME: join(opts.home, ".config"),
    XDG_STATE_HOME: join(opts.home, ".state"),
    XDG_DATA_HOME: join(opts.home, ".data"),
    XDG_CACHE_HOME: join(opts.home, ".cache"),
    GIT_AUTHOR_NAME: "Synthe Check", GIT_AUTHOR_EMAIL: "check@example.com",
    GIT_COMMITTER_NAME: "Synthe Check", GIT_COMMITTER_EMAIL: "check@example.com",
  }, opts.env ?? {});
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 45_000);
    child.on("close", (code) => { clearTimeout(timer); done({ code, stdout, stderr, out: `${stdout}\n${stderr}` }); });
  });
}

export interface Edit { path: string; search: string; replace: string }
export interface Proposal { summary: string; edits: Edit[] }

// A scripted proposer (CommonJS source). It logs each stdin object to `logPath`, outside the repository.
// It decides only from its stdin: it sends the first proposal whose summary is not yet in the history,
// and an empty list when every proposal is in the history.
export function listProposer(logPath: string, proposals: Proposal[]): string {
  return `const fs = require("fs");
const LOG = ${JSON.stringify(logPath)};
const PROPOSALS = ${JSON.stringify(proposals)};
let raw = "";
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  fs.appendFileSync(LOG, JSON.stringify({ cwd: process.cwd(), raw }) + "\\n");
  const input = JSON.parse(raw);
  const seen = (input.history || []).map((h) => String(h && h.summary != null ? h.summary : ""));
  const next = PROPOSALS.find((p) => !seen.some((s) => s.includes(p.summary)));
  process.stdout.write(JSON.stringify({ proposals: next ? [next] : [] }));
});
`;
}

export interface LogEntry { cwd: string; input: any }

// Every stdin object the proposer got, in order. An empty list when the proposer never ran.
export function readLog(logPath: string): LogEntry[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((line) => {
    const { cwd, raw } = JSON.parse(line);
    let input: any;
    try { input = JSON.parse(raw); } catch { input = { notJson: raw }; }
    return { cwd, input };
  });
}

export function readResult(outDir: string): any {
  const path = join(outDir, "result.json");
  assert.ok(existsSync(path), `solve wrote no result.json in ${outDir}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function readReport(outDir: string): string {
  const path = join(outDir, "report.md");
  assert.ok(existsSync(path), `solve wrote no report.md in ${outDir}`);
  return readFileSync(path, "utf8");
}

// The attempt whose summary holds `summary`. Fails when there is no such attempt.
export function attempt(result: any, summary: string): any {
  assert.ok(Array.isArray(result.attempts), "result.json has an attempts list");
  const found = result.attempts.find((a: any) => typeof a?.summary === "string" && a.summary.includes(summary));
  assert.ok(found, `result.json has an attempt with the summary "${summary}"`);
  return found;
}

export function near(actual: unknown, expected: number, what: string) {
  assert.equal(typeof actual, "number", `${what} is a number (got ${JSON.stringify(actual)})`);
  assert.ok(Math.abs((actual as number) - expected) < 1e-6, `${what} is ${expected} (got ${actual})`);
}

export interface TreeSnapshot { head: string; branch: string; files: Map<string, string> }

export function snapshot(repo: Repo): TreeSnapshot {
  const files = new Map<string, string>();
  for (const f of repo.git("ls-files").split("\n").filter(Boolean)) files.set(f, readFileSync(join(repo.dir, f), "utf8"));
  return { head: repo.git("rev-parse", "HEAD"), branch: repo.git("rev-parse", "--abbrev-ref", "HEAD"), files };
}

// The person's working tree and current branch did not change. Untracked files under .synthe/ are allowed:
// the contract puts the default output folder there.
export function assertTreeUnchanged(repo: Repo, before: TreeSnapshot) {
  assert.equal(repo.git("rev-parse", "--abbrev-ref", "HEAD"), before.branch, "the current branch did not change");
  assert.equal(repo.git("rev-parse", "HEAD"), before.head, "the current commit did not change");
  for (const [f, text] of before.files) {
    assert.ok(existsSync(join(repo.dir, f)), `${f} still exists in the working tree`);
    assert.equal(readFileSync(join(repo.dir, f), "utf8"), text, `${f} did not change in the working tree`);
  }
  const status = repo.git("status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean)
    .filter((l) => !/^\?\? \.synthe\//.test(l));
  assert.deepEqual(status, [], "git status shows no change outside .synthe/");
}

export function solveBranches(repo: Repo): string[] {
  return repo.git("for-each-ref", "--format=%(refname:short)", "refs/heads/synthe/").split("\n").filter(Boolean);
}

export function showFile(repo: Repo, ref: string, path: string): string {
  return execFileSync("git", ["show", `${ref}:${path}`], { cwd: repo.dir, encoding: "utf8" });
}

export const memo = <T>(f: () => Promise<T>) => { let p: Promise<T> | undefined; return () => (p ??= f()); };

// The source of a measure script for the "knob" fixture. Score = sum of every `level=N` in knob.txt minus the sum of
// every `penalty=N` in other.txt. The script finds the files from its own folder, so the folder it runs
// in does not matter. It prints other numbers first and a number on stderr: only the last number on stdout counts.
export function knobMeasure(): string {
  return `const fs = require("fs"), path = require("path");
const read = (f) => { const p = path.join(__dirname, "..", f); return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : ""; };
const sum = (text, key) => [...text.matchAll(new RegExp("^" + key + "=(\\\\d+(?:\\\\.\\\\d+)?)", "gm"))].reduce((a, m) => a + Number(m[1]), 0);
const score = sum(read("knob.txt"), "level") - sum(read("other.txt"), "penalty");
console.error("debug 987654");
console.log("checked 2 files in 3 ms");
console.log("score " + score);
`;
}

export interface Fixture {
  repo: Repo;
  name: string;
  problemFile: string; // relative to the repository
  log: string; // the proposer's stdin log, outside the repository
  out: string; // an empty folder outside the repository for --out
  measureFile: string;
}

// A repository with knob.txt (`level=<level>`), other.txt (`penalty=0`), a knob measure, a proposer and a problem file.
// `problem` adds or replaces fields of the problem file. The proposer is `listProposer(proposals)` unless
// `proposerSource` is given.
export function knobFixture(opts: {
  label: string; level: number; proposals?: Proposal[]; proposerSource?: (log: string) => string;
  problem?: Record<string, unknown>; files?: Record<string, string>; direction?: "higher" | "lower";
}): Fixture {
  const t = tag();
  const measureFile = `tools/score-${t}.cjs`;
  const repo = makeRepo({
    "knob.txt": `level=${opts.level}\n# notes\n`,
    "other.txt": "penalty=0\n",
    [measureFile]: knobMeasure(),
    "README.md": `# ${opts.label}\n`,
    ...(opts.files ?? {}),
  }, opts.label);
  const log = join(repo.base, "proposer.log");
  const out = join(repo.base, "out");
  const name = `${opts.label}-${t}`;
  const problemFile = `solve-${t}.json`;
  repo.write("propose.cjs", opts.proposerSource ? opts.proposerSource(log) : listProposer(log, opts.proposals ?? []));
  repo.write(problemFile, JSON.stringify({
    version: 1, name, goal: `Raise the score of ${name}.`, artifact: ["knob.txt", "other.txt"],
    measure: { command: `node ${measureFile}`, direction: opts.direction ?? "higher" },
    proposer: { command: "node propose.cjs" }, budget: { max_rounds: 20 },
    ...(opts.problem ?? {}),
  }, null, 2));
  repo.commit("Add the problem");
  return { repo, name, problemFile, log, out, measureFile };
}

export const solve = (f: Fixture, extra: string[] = []) =>
  runCli(["solve", f.problemFile, "--out", f.out, ...extra], { cwd: f.repo.dir, home: f.repo.home });
