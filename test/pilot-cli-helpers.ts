import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pilotGithubRepo } from "../src/pilot/github.ts";
import { main } from "../src/pilot/main.ts";
import { GITHUB_TOKEN_ENV, type PilotDeps } from "../src/pilot/commands.ts";
import { agentScript, BASELINE_PROMPT, baselineExport, DEMO, demoConfig, demoPack, proposerScript } from "../src/pilot/demo-data.ts";
import { FakeGitHub } from "../src/pilot/fake-github.ts";
import { PilotStore } from "../src/pilot/store.ts";

// Temporary directories are removed when the test process ends, so repeated runs do not fill the disk.
const made: string[] = [];
process.on("exit", () => { for (const dir of made) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } });
export function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

// A pilot on the synthetic Fernhill data, driven through the same `main` the command line uses.
export interface Ctx {
  root: string; dir: string; inputs: string; repoDir: string; commit: string;
  store: PilotStore; github: FakeGitHub; lines: string[]; env: Record<string, string | undefined>;
  model: string; proposer: string;
  run(argv: string[], over?: Partial<PilotDeps>): Promise<number>;
  // Moves the pilot's clock to 09:00 UTC on a day, e.g. "2026-10-24".
  on(day: string): void;
  put(name: string, content: string): string;
  last(step: string): string;
  stop(): Promise<void>;
}

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@fernhill.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@fernhill.invalid", GIT_AUTHOR_DATE: "2026-09-28T09:00:00Z", GIT_COMMITTER_DATE: "2026-09-28T09:00:00Z" };
// Inherited GIT_* settings are dropped first: with a GIT_DIR from a git hook, these commands would otherwise
// commit into the developer's own repository instead of the throwaway one.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
export const git = (args: string[], cwd: string): string => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...cleanEnv(), ...GIT_ENV }, stdio: ["ignore", "pipe", "pipe"] });
export const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

export async function workspace(): Promise<Ctx> {
  const root = tmp("pilot-cli-");
  const inputs = join(root, "inputs");
  const repoDir = join(root, "customer-repo");
  const dir = join(root, "pilot");
  mkdirSync(inputs);
  mkdirSync(join(repoDir, dirname(DEMO.prompt_path)), { recursive: true });
  writeFileSync(join(repoDir, DEMO.prompt_path), BASELINE_PROMPT);
  git(["init", "-q", "-b", DEMO.base], repoDir);
  git(["add", DEMO.prompt_path], repoDir);
  git(["commit", "-q", "-m", "prompt"], repoDir);
  const commit = git(["rev-parse", "HEAD"], repoDir).trim();
  const github = new FakeGitHub(DEMO.slug, DEMO.base, { [DEMO.prompt_path]: BASELINE_PROMPT }, commit);
  const url = await github.start();
  const lines: string[] = [];
  let clock = Date.parse("2026-10-17T09:00:00Z");
  const env: Record<string, string | undefined> = { [GITHUB_TOKEN_ENV]: "test-token" };
  const put = (name: string, content: string): string => { const path = join(inputs, name); writeFileSync(path, content); return path; };
  const store = new PilotStore(dir);
  const ctx: Ctx = {
    root, dir, inputs, repoDir, commit, store, github, lines, env, put,
    model: `scripted:${put("agent.script.json", json(agentScript()))}`,
    proposer: `scripted:${put("proposer.script.json", json(proposerScript()))}`,
    run: (argv, over = {}) => main([...argv, "--dir", dir], {
      say: (line) => { lines.push(line); }, env, now: () => new Date((clock += 60_000)),
      github: (slug, token) => pilotGithubRepo(slug, token, url), ...over,
    }),
    on: (day) => { clock = Date.parse(`${day}T09:00:00Z`); },
    last: (step) => {
      const entry = store.last(step);
      if (!entry) throw new Error(`no ${step} entry`);
      return entry.key;
    },
    stop: () => github.stop(),
  };
  return ctx;
}

export function writeExport(ctx: Ctx, name: string, x: { header: Record<string, unknown>; csv: string }): string {
  ctx.put(String(x.header.rows_csv), x.csv);
  return ctx.put(name, json(x.header));
}

// init, baseline and pack.
export async function frozenPilot(): Promise<Ctx> {
  const ctx = await workspace();
  for (const argv of [
    ["init", "--config", ctx.put("pilot.json", json(demoConfig())), "--repo-dir", ctx.repoDir],
    ["baseline", "--telemetry", writeExport(ctx, "baseline.json", baselineExport())],
    ["pack", "--file", ctx.put("pack.v1.json", json(demoPack()))],
  ]) {
    if (await ctx.run(argv) !== 0) throw new Error(`setup failed at ${argv[0]}: ${ctx.lines.slice(-3).join(" | ")}`);
  }
  return ctx;
}

// Up to two replayed candidates: the first rejected, the second eligible.
export async function replayedPilot(): Promise<Ctx & { finding: string; rejected: string; eligible: string }> {
  const ctx = await frozenPilot();
  const must = async (argv: string[]) => { if (await ctx.run(argv) !== 0) throw new Error(`setup failed at ${argv[0]}: ${ctx.lines.slice(-3).join(" | ")}`); };
  await must(["discover", "--model", ctx.model]);
  const finding = ctx.last("finding.found");
  await must(["propose", "--finding", finding, "--proposer", ctx.proposer]);
  const rejected = ctx.last("candidate.created");
  await must(["replay", "--candidate", rejected, "--model", ctx.model]);
  await must(["propose", "--finding", finding, "--proposer", ctx.proposer]);
  const eligible = ctx.last("candidate.created");
  await must(["replay", "--candidate", eligible, "--model", ctx.model]);
  return Object.assign(ctx, { finding, rejected, eligible });
}

// The same export as per-arm aggregates, the form a customer uses when rows cannot leave the warehouse.
export function asAggregates(x: { header: Record<string, unknown>; csv: string }, exportId: string): Record<string, unknown> {
  const [head, ...lines] = x.csv.trimEnd().split("\n");
  const cols = head.split(",");
  const arms = new Map<string, { n: number; immature: number; resolved: number; escalated: number; refunds: number[]; segments: Record<string, number> }>();
  for (const line of lines) {
    const cell = Object.fromEntries(line.split(",").map((v, i) => [cols[i], v]));
    const arm = arms.get(cell.prompt_version) ?? { n: 0, immature: 0, resolved: 0, escalated: 0, refunds: [], segments: {} };
    arms.set(cell.prompt_version, arm);
    arm.segments[cell.segment] = (arm.segments[cell.segment] ?? 0) + 1;
    if (cell.resolved === "") { arm.immature++; continue; }
    arm.n++;
    arm.resolved += Number(cell.resolved);
    arm.escalated += Number(cell.escalated);
    arm.refunds.push(Number(cell.refund_usd));
  }
  const { rows_csv: _rows, expected_rows: _expected, ...header } = x.header;
  return {
    ...header, export_id: exportId,
    aggregates: [...arms].map(([tag, a]) => {
      const mean = a.refunds.reduce((s, v) => s + v, 0) / a.n;
      const sd = Math.sqrt(a.refunds.reduce((s, v) => s + (v - mean) ** 2, 0) / (a.n - 1));
      return { prompt_version: tag, n: a.n, immature: a.immature, unattributed: 0, segments: a.segments, metrics: {
        resolved: { kind: "rate", successes: a.resolved, missing: 0 }, escalated: { kind: "rate", successes: a.escalated, missing: 0 }, refund_usd: { kind: "mean", mean, sd, missing: 0 },
      } };
    }),
  };
}
