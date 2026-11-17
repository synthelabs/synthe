import { baselineExport, CANARIES, DEMO, demoConfig, demoPack, HUMAN_CANDIDATE_PROMPT } from "../src/pilot/demo-data.ts";
import type { Pack, PilotConfig } from "../src/pilot/types.ts";
import { json, workspace, writeExport, type Ctx } from "./pilot-cli-helpers.ts";

// Runs the synthetic pilot to the review step on a pack and config the test has changed, through the same `main`
// the command line uses, and optionally publishes to the loopback GitHub stand-in. Each step must succeed, except
// the review and publish steps, whose exit codes are returned.
export interface Scenario { ctx: Ctx; candidate: string; review: number; publish: number | null; lines: string[] }

export async function reviewScenario(opts: {
  mutate?: (pack: Pack, config: PilotConfig) => void;
  human?: { prompt?: string; rationale?: string };
  publish?: boolean;
  env?: Record<string, string>;
} = {}): Promise<Scenario> {
  const ctx = await workspace();
  Object.assign(ctx.env, opts.env ?? {});
  const pack = demoPack();
  const config = demoConfig() as unknown as PilotConfig;
  opts.mutate?.(pack, config);
  const must = async (argv: string[]) => {
    const code = await ctx.run(argv);
    if (code !== 0) throw new Error(`${argv[0]} failed: ${ctx.lines.slice(-2).join(" | ")}`);
  };
  await must(["init", "--config", ctx.put("pilot.json", json(config)), "--repo-dir", ctx.repoDir]);
  await must(["baseline", "--telemetry", writeExport(ctx, "baseline.json", baselineExport())]);
  await must(["pack", "--file", ctx.put("pack.v1.json", json(pack))]);
  await must(["discover", "--model", ctx.model]);
  const finding = ctx.last("finding.found");
  let candidate: string;
  if (opts.human) {
    await must(["propose", "--finding", finding, "--file", ctx.put("cand.md", opts.human.prompt ?? HUMAN_CANDIDATE_PROMPT), "--author", "Pat Reviewer", "--rationale", opts.human.rationale ?? "Add the return-by date line."]);
    candidate = ctx.last("candidate.created");
  } else {
    // The first scripted attempt is rejected in replay; the second is eligible.
    await must(["propose", "--finding", finding, "--proposer", ctx.proposer]);
    await must(["replay", "--candidate", ctx.last("candidate.created"), "--model", ctx.model]);
    await must(["propose", "--finding", finding, "--proposer", ctx.proposer]);
    candidate = ctx.last("candidate.created");
  }
  await must(["replay", "--candidate", candidate, "--model", ctx.model]);
  await must(["experiment", "--candidate", candidate, "--start", DEMO.experiment_b_start]);
  const before = ctx.lines.length;
  const review = await ctx.run(["review", "--candidate", candidate]);
  let publish: number | null = null;
  if (review === 0 && opts.publish !== false) publish = await ctx.run(["review", "--candidate", candidate, "--publish", "--repo", DEMO.slug, "--base", DEMO.base, "--confirm", candidate]);
  return { ctx, candidate, review, publish, lines: ctx.lines.slice(before) };
}

// init, baseline, pack and discover only: the point where a test can run `propose`.
export async function reviewScenarioUntilPropose(opts: { mutate?: (pack: Pack, config: PilotConfig) => void; env?: Record<string, string> } = {}): Promise<{ ctx: Ctx; finding: string }> {
  const ctx = await workspace();
  Object.assign(ctx.env, opts.env ?? {});
  const pack = demoPack();
  const config = demoConfig() as unknown as PilotConfig;
  opts.mutate?.(pack, config);
  for (const argv of [
    ["init", "--config", ctx.put("pilot.json", json(config)), "--repo-dir", ctx.repoDir],
    ["baseline", "--telemetry", writeExport(ctx, "baseline.json", baselineExport())],
    ["pack", "--file", ctx.put("pack.v1.json", json(pack))],
    ["discover", "--model", ctx.model],
  ]) {
    const code = await ctx.run(argv);
    if (code !== 0) throw new Error(`${argv[0]} failed: ${ctx.lines.slice(-2).join(" | ")}`);
  }
  return { ctx, finding: ctx.last("finding.found") };
}

export const prBody = (ctx: Ctx): string | null => ctx.github.pulls[0]?.body ?? null;
export { CANARIES };
