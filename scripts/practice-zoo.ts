// The practice zoo: runs `synthe solve` on every problem in test/fixtures/practice-zoo/ with seeds 1, 2 and 3, and
// counts what was kept by class. It finds FINAL misses before the frozen zoo exists. It is not the zoo bench (P14).
//
//   node scripts/practice-zoo.ts [--seeds 1,2,3] [--only name,name] [--json out.json]
//
// Each problem folder holds problem.json, its files and menu.json. The runner copies the folder into a fresh git
// repository with the shared proposer (_proposer.mjs as propose.mjs) and noise helper (_noise.cjs as
// measure/noise.cjs), and replaces {{TMP}} in problem.json with a folder for that run's noise counters. Every menu
// summary starts with GAIN:, NOOP: or TRAP:. Synthe sees the summary, so the classes say nothing a real proposer
// could not say; the runner reads them only to count.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ZOO = join(ROOT, "test", "fixtures", "practice-zoo");
const CLI = join(ROOT, "src", "cli", "main.ts");

type Kind = "GAIN" | "NOOP" | "TRAP";
const KINDS: Kind[] = ["GAIN", "NOOP", "TRAP"];
export interface Row { problem: string; seed: number; code: number; stopped: string; offered: Record<Kind, number>; kept: Record<Kind, number>; error?: string }

const kindOf = (summary: string): Kind | null => KINDS.find((k) => summary.startsWith(`${k}:`)) ?? null;
const zero = (): Record<Kind, number> => ({ GAIN: 0, NOOP: 0, TRAP: 0 });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function run(cwd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => done({ code: code ?? 1, out }));
  });
}

export async function runOne(problem: string, seed: number): Promise<Row> {
  const src = join(ZOO, problem);
  const menu: { summary: string }[] = JSON.parse(readFileSync(join(src, "menu.json"), "utf8"));
  const offered = zero();
  for (const m of menu) { const k = kindOf(m.summary); if (k) offered[k]++; }
  const tmp = mkdtempSync(join(tmpdir(), `practice-zoo-${problem}-${seed}-`));
  try {
    const repo = join(tmp, "repo"), noise = join(tmp, "noise"), out = join(tmp, "out");
    mkdirSync(noise);
    cpSync(src, repo, { recursive: true });
    cpSync(join(ZOO, "_proposer.mjs"), join(repo, "propose.mjs"));
    if (existsSync(join(repo, "measure"))) cpSync(join(ZOO, "_noise.cjs"), join(repo, "measure", "noise.cjs"));
    const pf = join(repo, "problem.json");
    writeFileSync(pf, readFileSync(pf, "utf8").replaceAll("{{TMP}}", noise));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("-c", "user.name=zoo", "-c", "user.email=zoo@example.invalid", "commit", "-q", "-m", "start");
    const r = await run(repo, [CLI, "solve", "problem.json", "--out", out, "--seed", String(seed)]);
    const kept = zero();
    if (!existsSync(join(out, "result.json"))) return { problem, seed, code: r.code, stopped: "", offered, kept, error: r.out.trim().split("\n").slice(-3).join(" | ") };
    const result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
    for (const a of result.attempts) { const k = kindOf(a.summary ?? ""); if (k && a.kept) kept[k]++; }
    return { problem, seed, code: r.code, stopped: result.stopped, offered, kept };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function pool<T>(jobs: (() => Promise<T>)[], width: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => { while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); } }));
  return out;
}

async function main() {
  const seeds = (arg("seeds") ?? "1,2,3").split(",").map(Number);
  const only = arg("only")?.split(",");
  const problems = readdirSync(ZOO, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_") && (!only || only.includes(d.name))).map((d) => d.name).sort();
  const rows = await pool(problems.flatMap((p) => seeds.map((s) => () => runOne(p, s))), 4);
  const total = { offered: zero(), kept: zero() };
  console.log("problem          seed  exit  gains kept  no-ops kept  traps kept  stopped");
  for (const r of rows) {
    for (const k of KINDS) { total.offered[k] += r.offered[k]; total.kept[k] += r.kept[k]; }
    const cell = (k: Kind) => `${r.kept[k]}/${r.offered[k]}`.padEnd(k === "GAIN" ? 12 : k === "NOOP" ? 13 : 12);
    console.log(`${r.problem.padEnd(17)}${String(r.seed).padEnd(6)}${String(r.code).padEnd(6)}${cell("GAIN")}${cell("NOOP")}${cell("TRAP")}${r.error ? `ERROR: ${r.error}` : r.stopped}`);
  }
  const share = total.offered.GAIN ? Math.round((100 * total.kept.GAIN) / total.offered.GAIN) : 100;
  console.log(`\nTotal: gains kept ${total.kept.GAIN}/${total.offered.GAIN} (${share}%), no-ops kept ${total.kept.NOOP}, traps kept ${total.kept.TRAP}.`);
  const pass = share >= 80 && total.kept.TRAP === 0 && total.kept.NOOP <= 1 && rows.every((r) => !r.error);
  console.log(pass ? "Meets the FINAL bar: 80% of gains, no trap, at most 1 no-op." : "Misses the FINAL bar: 80% of gains, no trap, at most 1 no-op.");
  const json = arg("json");
  if (json) writeFileSync(json, JSON.stringify({ rows, total }, null, 2));
  process.exitCode = pass ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
