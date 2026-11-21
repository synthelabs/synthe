// Shared helpers for the milestone checks of author B (P04, P05, P06, P07, P11, P12).
// They build fixture git repositories in temp folders, write scripted proposers, and run the CLI as a black box:
// `node src/cli/main.ts solve ...`. Nothing here imports from src/.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const CLI = join(REPO, "src/cli/main.ts");

// No global or system git config, so a fixture behaves the same on every machine.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

// The environment for `solve`: no model keys, so a check can never spend money.
export function solveEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...extra };
  for (const k of Object.keys(env)) if (/(_API_KEY|_ANTHROPIC_KEY)$/.test(k) || k === "ANTHROPIC_BASE_URL") delete env[k];
  return env;
}

export function workDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `synthe-ms-${tag}-`));
}

export function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

export interface FixtureRepo {
  dir: string;
  git: (...args: string[]) => string;
}

// A git repository on branch `main` with one commit that holds `files`.
export function makeRepo(dir: string, files: Record<string, string>): FixtureRepo {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: GIT_ENV, stdio: ["pipe", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "Fixture");
  for (const [path, text] of Object.entries(files)) write(dir, path, text);
  git("add", ".");
  git("commit", "-qm", "Fixture");
  return { dir, git };
}

export interface RunResult { code: number | null; out: string }

// Runs `node src/cli/main.ts <args>` in `cwd`. Async, so many runs can go at the same time.
export function runCli(args: string[], cwd: string, env: NodeJS.ProcessEnv = solveEnv(), timeoutMs = 120_000): Promise<RunResult> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const timer = setTimeout(() => { out += `\n[the check stopped this run after ${timeoutMs} ms]`; child.kill("SIGKILL"); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); done({ code, out }); });
  });
}

export interface Attempt { round: number; summary: string; kept: boolean; reason: string; before?: number; after?: number }
export interface SolveResult { problem: string; stopped: string; baseline: number; final: number; branch: string | null; attempts: Attempt[] }

// Runs `solve` and reads result.json from `outDir`. Fails with the CLI output when the run did not end normally.
export async function solve(problemFile: string, outDir: string | null, extraArgs: string[] = [], cwd = dirname(problemFile)): Promise<{ result: SolveResult; run: RunResult }> {
  const args = ["solve", problemFile, ...(outDir ? ["--out", outDir] : []), ...extraArgs];
  const run = await runCli(args, cwd);
  const resultPath = join(outDir ?? defaultOut(problemFile), "result.json");
  const tail = run.out.slice(-1500);
  assert.equal(run.code, 0, `\`solve\` must exit 0 when the run ends normally. It exited ${run.code}. Output:\n${tail}`);
  assert.ok(existsSync(resultPath), `\`solve\` must write ${resultPath}. It did not. Output:\n${tail}`);
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as SolveResult;
  assert.ok(Array.isArray(result.attempts), `result.json must have an "attempts" list. Got: ${JSON.stringify(result).slice(0, 500)}`);
  return { result, run };
}

// GOAL.md: the default --out is .synthe/solve/<name>/ in the repository that holds the problem file.
function defaultOut(problemFile: string): string {
  const name = (JSON.parse(readFileSync(problemFile, "utf8")) as { name: string }).name;
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dirname(problemFile), encoding: "utf8" }).trim();
  return join(top, ".synthe/solve", name);
}

export function keptAttempts(r: SolveResult): Attempt[] {
  return r.attempts.filter((a) => a.kept === true);
}

// The text of `path` at the tip of the branch that result.json names.
export function fileOnBranch(repo: FixtureRepo, r: SolveResult, path: string): string {
  assert.ok(typeof r.branch === "string" && r.branch.length > 0, `result.json must name the branch of the kept changes. Got: ${JSON.stringify(r.branch)}`);
  return repo.git("show", `${r.branch}:${path}`);
}

export function approx(actual: unknown, expected: number, what: string): void {
  assert.ok(typeof actual === "number" && Math.abs(actual - expected) < 1e-6, `${what}: expected ${expected}, got ${JSON.stringify(actual)}`);
}

// Small seeded random numbers, so a check can vary names and values without depending on Math.random.
export function rng(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(r: () => number, items: readonly T[]): T {
  return items[Math.floor(r() * items.length)];
}

export function shuffled<T>(r: () => number, items: readonly T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const WORDS = ["amber", "birch", "cedar", "delta", "ember", "fjord", "gale", "heron", "iris", "juniper", "kestrel", "lumen", "maple", "nimbus", "onyx", "pebble", "quartz", "raven", "sorrel", "tundra", "umber", "vale", "willow", "yarrow", "zephyr"];
export function word(r: () => number): string {
  return pick(r, WORDS);
}

export interface Proposal { summary: string; edits: { path: string; search: string; replace: string }[] }

// A scripted proposer that reads its menu from `menuPath` at each call, so a check can change the menu between runs.
// It decides only from its stdin: it skips every menu item whose summary is already in `history`, and (when
// `onlyApplicable`) every item whose edits do not apply to the current `files`. It returns as many items as
// `candidates` asks for, and an empty list when nothing is left. Every stdin object is appended to `logPath`.
export function writeMenuProposer(path: string, menuPath: string, logPath: string, onlyApplicable: boolean): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `import { appendFileSync, readFileSync } from "node:fs";
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ stdin: raw }) + "\\n");
  const input = JSON.parse(raw);
  const menu = JSON.parse(readFileSync(${JSON.stringify(menuPath)}, "utf8"));
  const tried = new Set((input.history || []).map((h) => h.summary));
  const files = new Map((input.files || []).map((f) => [f.path, f.text]));
  const once = (text, s) => typeof text === "string" && text.split(s).length === 2;
  const applies = (p) => p.edits.every((e) => once(files.get(e.path), e.search));
  const want = Math.max(1, Number(input.candidates) || 1);
  const open = menu.filter((p) => !tried.has(p.summary) && (!${onlyApplicable} || applies(p)));
  process.stdout.write(JSON.stringify({ proposals: open.slice(0, want) }));
});
`);
  return path;
}

export interface ProposerCall { round: number; goal: string; files: { path: string; text: string }[]; history: Attempt[]; candidates: number }

export function readProposerLog(logPath: string): { raw: string; input: ProposerCall }[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => {
    const raw = (JSON.parse(l) as { stdin: string }).stdin;
    return { raw, input: JSON.parse(raw) as ProposerCall };
  });
}

// Python source for seeded Gaussian noise: each measure run takes the next free slot in a counter folder outside
// the repository (an exclusive create, so parallel runs never share a slot), and hashes the seed and the slot.
// Every run of a check sees the same noise in the same order, whatever the code under test does.
export function pythonNoise(counterDir: string, seed: string): string {
  return `import hashlib, math, os
def _slot():
    n = 0
    while True:
        try:
            os.close(os.open(os.path.join(${JSON.stringify(counterDir)}, str(n)), os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            return n
        except FileExistsError:
            n += 1
def _u(n, k):
    h = hashlib.sha256(("%s:%d:%s" % (${JSON.stringify(seed)}, n, k)).encode()).digest()
    return (int.from_bytes(h[:4], "big") + 1) / 4294967297
def gauss():
    n = _slot()
    return math.sqrt(-2 * math.log(_u(n, "a"))) * math.cos(2 * math.pi * _u(n, "b"))
`;
}

// Runs `jobs` with at most `limit` of them at the same time.
export async function pool<T>(jobs: (() => Promise<T>)[], limit = Math.min(8, Math.max(2, availableParallelism()))): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); }
  }));
  return out;
}

export function problemFile(dir: string, file: string, problem: Record<string, unknown>): string {
  write(dir, file, `${JSON.stringify({ version: 1, ...problem }, null, 2)}\n`);
  return join(dir, file);
}

// One seeded P06 run: a fresh repo whose measure is a true value plus Gaussian noise of a known standard deviation,
// and a proposer that offers one change, then nothing. `gain` is the change's true effect in noise standard
// deviations, in the good direction (0 for a no-op). Names, scale, noise and direction vary with the seed.
// Returns whether `solve` kept the change.
export async function noisyRun(tag: string, i: number, gain: number, root: string): Promise<boolean> {
  const seed = `${tag}:${i}`;
  const r = rng(seed);
  const dir = join(root, `run-${i}`);
  const counter = join(dir, "noise");
  mkdirSync(counter, { recursive: true });
  const levelKey = pick(r, ["level", "depth", "passes", "workers", "batch"]);
  const colorKey = pick(r, ["label", "theme", "mode", "tag"]);
  const [c1, c2] = shuffled(r, ["red", "green", "blue", "gold", "teal"]);
  const sd = Number((0.2 + r() * 4.8).toFixed(3));
  const base = Number((20 + r() * 480).toFixed(2));
  const direction = r() < 0.5 ? "higher" : "lower";
  const sign = direction === "higher" ? 1 : -1;
  const level0 = 2 + Math.floor(r() * 5);
  const settings = (level: number, color: string) => `${JSON.stringify({ [levelKey]: level, [colorKey]: color }, null, 2)}\n`;
  const repo = makeRepo(join(dir, "repo"), {
    "settings.json": settings(level0, c1),
    "measure/score.py": `import json\n${pythonNoise(counter, seed)}\ncfg = json.load(open("settings.json"))\nvalue = ${base} + ${sign * gain * sd} * (cfg[${JSON.stringify(levelKey)}] - ${level0}) + ${sd} * gauss()\nprint("one sample of %d" % 5)\nprint("%.6f" % value)\n`,
  });
  const change: Proposal = gain === 0
    ? { summary: `set ${colorKey} to ${c2}`, edits: [{ path: "settings.json", search: `"${colorKey}": "${c1}"`, replace: `"${colorKey}": "${c2}"` }] }
    : { summary: `set ${levelKey} to ${level0 + 1}`, edits: [{ path: "settings.json", search: `"${levelKey}": ${level0}`, replace: `"${levelKey}": ${level0 + 1}` }] };
  write(dir, "propose.mjs", `let raw = "";
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  const input = JSON.parse(raw);
  process.stdout.write(JSON.stringify({ proposals: input.history.length ? [] : [${JSON.stringify(change)}] }));
});
`);
  const file = problemFile(repo.dir, "problem.json", {
    name: `noisy-${i}`, goal: `Make the score ${direction}.`,
    artifact: ["settings.json"], protect: ["measure/**"],
    measure: { command: "python3 measure/score.py", direction, unit: "points", runs: 5 },
    proposer: { command: `node ${JSON.stringify(join(dir, "propose.mjs"))}` },
    budget: { max_rounds: 3 },
  });
  repo.git("add", ".");
  repo.git("commit", "-qm", "Problem file");
  const { result } = await solve(file, join(dir, "out"), ["--seed", String(i)]);
  const kept = keptAttempts(result).length > 0;
  if (kept) {
    const onBranch = JSON.parse(fileOnBranch(repo, result, "settings.json")) as Record<string, unknown>;
    const expected = { ...JSON.parse(settings(level0, c1)), ...JSON.parse(`{${change.edits[0].replace}}`) };
    assert.deepEqual(onBranch, expected, `run ${i}: the branch holds the kept change`);
  }
  return kept;
}

