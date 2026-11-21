// The zoo bench: runs `synthe solve` on every problem in swarm/zoo/ with several seeds and counts what it kept.
// Each zoo problem is copied into a new temp git repository, so a run never makes branches in this repository and
// never changes the frozen zoo. The CLI runs as a black box, the same way a person runs it.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "src/cli/main.ts");
export const ZOO_DIR = join(ROOT, "swarm/zoo");
export const ZOO_RESULTS = "bench/zoo-results.json";
export const SEEDS = [1, 2, 3];

// What a zoo problem's proposal is: a real gain, a no-op that changes nothing that matters, or a trap that only
// looks good. The labels come from the problem's truth.json, which only the bench and the checks read: solve never
// sees it. An attempt with no label (a failed reply, for example) is not counted.
export type Label = "real" | "noop" | "trap";

export interface ZooAttempt { round: number; summary: string; kept: boolean; reason: string }
export interface SeedRun { seed: number; ok: boolean; error?: string; stopped?: string; baseline?: number; final?: number; attempts: ZooAttempt[] }

export interface ProblemRow {
  problem: string;
  seeds: number[];
  failedRuns: number;
  real: { offered: number; kept: number };
  noop: { offered: number; kept: number };
  trap: { offered: number; kept: number };
  runs: SeedRun[];
}

export interface ZooResults { seeds: number[]; problems: ProblemRow[]; totals: { realOffered: number; realKept: number; noopKept: number; trapKept: number; failedRuns: number } }

export interface ZooProblem { name: string; dir: string; problemFile: string; labels: Map<string, Label> }

// The problem file of a zoo folder: problem.json, or else the only *.json file whose "version" is 1 and that has a
// "measure".
function findProblemFile(dir: string): string | null {
  if (existsSync(join(dir, "problem.json"))) return join(dir, "problem.json");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const found = files.filter((f) => {
    try { const j = JSON.parse(readFileSync(join(dir, f), "utf8")); return j && j.version === 1 && j.measure !== undefined && typeof j.name === "string"; } catch { return false; }
  });
  return found.length === 1 ? join(dir, found[0]) : null;
}

// The labels of a zoo problem, from its truth.json: { "<summary>": "real" | "noop" | "trap" }.
export function readLabels(dir: string): Map<string, Label> {
  const labels = new Map<string, Label>();
  const path = join(dir, "truth.json");
  if (!existsSync(path)) return labels;
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  for (const [summary, label] of Object.entries(raw)) {
    if (label === "real" || label === "noop" || label === "trap") labels.set(summary, label);
  }
  return labels;
}

export function listZoo(zooDir = ZOO_DIR): ZooProblem[] {
  if (!existsSync(zooDir)) return [];
  const out: ZooProblem[] = [];
  for (const name of readdirSync(zooDir).sort()) {
    const dir = join(zooDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const problemFile = findProblemFile(dir);
    if (problemFile) out.push({ name, dir, problemFile, labels: readLabels(dir) });
  }
  return out;
}

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

// A temp git repository on branch main that holds a copy of the zoo folder, committed. noise.json (swarm/zoo/README.md)
// seeds the noisy measures and the judge, with a counter file outside the repository; truth.json stays out of the
// copy, so solve could not read it even by mistake.
function copyToRepo(p: ZooProblem, seed: number): { repo: string; work: string } {
  const work = mkdtempSync(join(tmpdir(), `synthe-zoo-${p.name}-`));
  const repo = join(work, "repo");
  cpSync(p.dir, repo, { recursive: true, filter: (src) => src !== join(p.dir, "truth.json") });
  writeFileSync(join(repo, "noise.json"), JSON.stringify({ counter: join(work, "noise-counter"), seed: String(seed) }) + "\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "zoo@example.com");
  git("config", "user.name", "Zoo");
  git("add", ".");
  git("commit", "-qm", "Zoo problem");
  return { repo, work };
}

// The bench never spends money: model keys are removed from the environment of every run.
function benchEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
  for (const k of Object.keys(env)) if (/(_API_KEY|_ANTHROPIC_KEY)$/.test(k) || k === "ANTHROPIC_BASE_URL") delete env[k];
  return env;
}

function runSolve(repo: string, problemFile: string, out: string, seed: number, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CLI, "solve", problemFile, "--out", out, "--seed", String(seed)], { cwd: repo, env: benchEnv(), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });
    const timer = setTimeout(() => { output += `\nStopped after ${timeoutMs} ms.`; child.kill("SIGKILL"); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); done({ code, output }); });
  });
}

export async function runOne(p: ZooProblem, seed: number, timeoutMs = 300_000): Promise<SeedRun> {
  const { repo, work } = copyToRepo(p, seed);
  try {
    const problemFile = join(repo, p.problemFile.slice(p.dir.length + 1));
    const out = join(work, "out");
    const r = await runSolve(repo, problemFile, out, seed, timeoutMs);
    const resultPath = join(out, "result.json");
    if (r.code !== 0 || !existsSync(resultPath)) return { seed, ok: false, error: `solve exited ${r.code}: ${r.output.trim().split("\n").slice(-3).join(" ")}`, attempts: [] };
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as { stopped: string; baseline: number; final: number; attempts: ZooAttempt[] };
    const attempts = (result.attempts ?? []).map((a) => ({ round: a.round, summary: a.summary, kept: a.kept === true, reason: a.reason }));
    return { seed, ok: true, stopped: result.stopped, baseline: result.baseline, final: result.final, attempts };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Counts each labeled proposal once per run: offered when the proposer offered it, kept when solve kept it.
export function tally(p: Pick<ZooProblem, "name" | "labels">, runs: SeedRun[]): ProblemRow {
  const row: ProblemRow = { problem: p.name, seeds: runs.map((r) => r.seed), failedRuns: runs.filter((r) => !r.ok).length, real: { offered: 0, kept: 0 }, noop: { offered: 0, kept: 0 }, trap: { offered: 0, kept: 0 }, runs };
  for (const run of runs) {
    const seen = new Map<string, boolean>();
    for (const a of run.attempts) seen.set(a.summary, (seen.get(a.summary) ?? false) || a.kept);
    for (const [summary, kept] of seen) {
      const label = p.labels.get(summary);
      if (!label) continue;
      row[label].offered++;
      if (kept) row[label].kept++;
    }
  }
  return row;
}

export function totals(rows: ProblemRow[]): ZooResults["totals"] {
  const sum = (f: (r: ProblemRow) => number) => rows.reduce((n, r) => n + f(r), 0);
  return {
    realOffered: sum((r) => r.real.offered), realKept: sum((r) => r.real.kept),
    noopKept: sum((r) => r.noop.kept), trapKept: sum((r) => r.trap.kept), failedRuns: sum((r) => r.failedRuns),
  };
}

// Runs every problem with every seed, at most `limit` runs at the same time.
export async function runZoo(problems: ZooProblem[], seeds = SEEDS, limit = Math.max(2, availableParallelism())): Promise<ZooResults> {
  const jobs = problems.flatMap((p) => seeds.map((seed) => ({ p, seed })));
  const done: SeedRun[][] = problems.map(() => []);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const { p, seed } = jobs[next++];
      done[problems.indexOf(p)].push(await runOne(p, seed));
    }
  }));
  const rows = problems.map((p, i) => tally(p, done[i].sort((a, b) => a.seed - b.seed)));
  return { seeds, problems: rows, totals: totals(rows) };
}

export function formatZoo(r: ZooResults): string {
  const head = ["problem", "real gains kept", "no-ops kept", "traps kept", "failed runs"];
  const rows = r.problems.map((p) => [p.problem, `${p.real.kept} of ${p.real.offered}`, `${p.noop.kept} of ${p.noop.offered}`, `${p.trap.kept} of ${p.trap.offered}`, String(p.failedRuns)]);
  const t = r.totals;
  rows.push(["total", `${t.realKept} of ${t.realOffered}`, String(t.noopKept), String(t.trapKept), String(t.failedRuns)]);
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(width[i])).join("  ").trimEnd();
  return [line(head), ...rows.map(line)].join("\n");
}
