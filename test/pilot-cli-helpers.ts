import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { githubRepo } from "../src/github/repo.ts";
import { main } from "../src/pilot/main.ts";
import { GITHUB_TOKEN_ENV, type PilotDeps } from "../src/pilot/commands.ts";
import { agentScript, BASELINE_PROMPT, baselineExport, DEMO, demoConfig, demoPack, proposerScript } from "../src/pilot/demo-data.ts";
import { FakeGitHub } from "../src/pilot/fake-github.ts";
import { PilotStore } from "../src/pilot/store.ts";

// A pilot on the synthetic Fernhill data, driven through the same `main` the command line uses.
export interface Ctx {
  root: string; dir: string; inputs: string; repoDir: string; commit: string;
  store: PilotStore; github: FakeGitHub; lines: string[]; env: Record<string, string | undefined>;
  model: string; proposer: string;
  run(argv: string[], over?: Partial<PilotDeps>): Promise<number>;
  put(name: string, content: string): string;
  last(step: string): string;
  stop(): Promise<void>;
}

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@fernhill.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@fernhill.invalid", GIT_AUTHOR_DATE: "2026-09-28T09:00:00Z", GIT_COMMITTER_DATE: "2026-09-28T09:00:00Z" };
export const git = (args: string[], cwd: string): string => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV }, stdio: ["ignore", "pipe", "pipe"] });
export const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

export async function workspace(): Promise<Ctx> {
  const root = mkdtempSync(join(tmpdir(), "pilot-cli-"));
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
      github: (slug, token) => githubRepo(slug, token, url), ...over,
    }),
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
