import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { costUsd, knownModels, sumCosts } from "../core/cost.ts";
import { GOAL_FILE, parseGoal, parseScenarios, type Goal } from "../core/goal.ts";
import { checkRate, type ScoreRow } from "../core/merge-rule.ts";
import { readPrompt } from "../core/prompt.ts";
import { anthropicModel, type Model } from "../model/client.ts";
import { compareRunners, LOSS, TIE, WIN } from "../loop/score.ts";

const MAX_DROP = 5; // points of judge score, or percentage points of checks passed, that a switch may lose

export interface MigrateEnv {
  cwd: string;
  say(text: string): void;
  apiKey?: string;
  model?: Model; // used instead of the real client, for tests
  random?: () => number;
}

function parseArgs(args: string[]): { from?: string; to?: string; dryRun: boolean } | string {
  const out: { from?: string; to?: string; dryRun: boolean } = { dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s);
    if (flag === "--dry-run") out.dryRun = true;
    else if (flag === "--from" || flag === "--to") {
      const value = inline ?? args[++i];
      if (!value || value.startsWith("--")) return `${flag} needs a model name, like ${flag} claude-sonnet-5-5.`;
      out[flag === "--from" ? "from" : "to"] = value;
    } else return `Unknown option ${args[i]}. Use --to <model>, and optionally --from <model> and --dry-run.`;
  }
  return out;
}

// Stands in for the API in a dry run: every reply ties, every check passes, and each call costs what a fixed-size
// call to that model would, so the table shows the real price ratio between the two models.
function dryRunModel(goal: Goal): Model {
  return {
    async ask(a) {
      const cost = costUsd(a.model, { input_tokens: 500, output_tokens: 300 });
      if (!a.schema) return { text: `[dry run] a reply from ${a.model}`, costUsd: cost };
      const props = (a.schema.properties ?? {}) as Record<string, unknown>;
      const checks = goal.checks?.filter((c) => c.trim()) ?? [];
      const answer = "results" in props
        ? { results: checks.map((_, i) => ({ check: i + 1, applies: true, passes: true })) }
        : { better: "tie", a_guardrail_ok: true, b_guardrail_ok: true };
      return { text: JSON.stringify(answer), costUsd: cost };
    },
  };
}

const money = (n: number | null) => (n === null ? "unknown" : `$${n.toFixed(3)}`);
const signed = (n: number, digits = 1) => `${n > 0 ? "+" : ""}${n.toFixed(digits)}`;

function costSection(before: number | null, after: number | null): string[] {
  const change = before !== null && after !== null && before > 0 ? `${signed((100 * (after - before)) / before, 0)}%` : "unknown";
  return ["Cost per round (answering every test case once)", `  Before: ${money(before)}  After: ${money(after)}  Change: ${change}`, ""];
}

// Runs the team's current prompt on both models and prints how the replies compare. Changes nothing and merges
// nothing. Returns the exit code.
export async function migrate(args: string[], env: MigrateEnv): Promise<number> {
  const say = env.say;
  const fail = (text: string) => { say(text); return 1; };
  const parsed = parseArgs(args);
  if (typeof parsed === "string") return fail(parsed);
  if (!existsSync(join(env.cwd, GOAL_FILE))) return fail("Synthe isn't set up in this folder. Run `npx synthe init` inside your project's folder first.");
  const goal = parseGoal(readFileSync(join(env.cwd, GOAL_FILE), "utf8"));
  const from = parsed.from ?? goal.models.writer;
  const to = parsed.to;
  if (!to) return fail("Say which model to try: npx synthe migrate --to <model>");
  const known = knownModels();
  const unknown = [from, to].find((m) => !known.includes(m));
  if (unknown) return fail(`Synthe doesn't know the model "${unknown}", so it can't work out what it costs. Models it knows: ${known.join(", ")}.`);
  if (from === to) return fail(`--from and --to are both ${to}. Pick two different models to compare.`);

  const prompt = readPrompt(readFileSync(join(env.cwd, goal.prompt.path), "utf8"), goal, null);
  if (prompt === null) return fail(`Couldn't find your prompt in ${goal.prompt.path}. If you moved or rewrote it, update prompt in ${GOAL_FILE}.`);
  const scenarios = parseScenarios(readFileSync(join(env.cwd, goal.scenarios), "utf8"));

  let real = env.model;
  if (!parsed.dryRun && !real) {
    if (!env.apiKey) return fail("`npx synthe migrate` runs on your computer, changing nothing, and needs your Synthe key:\n  ANTHROPIC_API_KEY=your-key npx synthe migrate --to " + to + "\nTo see the layout without spending anything, add --dry-run.");
    real = anthropicModel(env.apiKey);
  }
  const model = parsed.dryRun ? dryRunModel(goal) : real!;

  // Every call is kept, so the run's own cost is a list like the ones a round records. A reply to a scenario is the
  // only call without a schema, so those are the cost of each model answering as the agent.
  const costs: (number | null)[] = [];
  const replyCosts = new Map<string, (number | null)[]>([[from, []], [to, []]]);
  const metered: Model = {
    async ask(a) {
      const r = await model.ask(a);
      costs.push(r.costUsd);
      if (!a.schema) replyCosts.get(a.model)?.push(r.costUsd);
      return r;
    },
  };

  const train = scenarios.filter((s) => s.split === "train").length;
  say(`Migrating from ${from} to ${to}`);
  say(`\nScenarios: ${train} train + ${scenarios.length - train} holdout = ${scenarios.length} total`);
  if (parsed.dryRun) say("Dry run: no model was called. Every reply ties and every check passes, so the scores below are placeholders; the costs are estimates from a fixed size of call.");
  say(`Your current prompt answers each test case on both models. The judge and checks stay as configured (judge ${goal.models.judge}).\n`);

  const { before, after } = await compareRunners(goal, prompt, scenarios, from, to, metered, env.random);

  // Only test cases where both replies were judged can be compared.
  const judged = after.flatMap((a, i): [ScoreRow, ScoreRow][] => (typeof a.score === "number" && typeof before[i].score === "number" ? [[before[i], a]] : []));
  if (judged.length === 0) return fail("None of the test cases could be judged, so there's nothing to compare. Try again in a few minutes; if it keeps happening, open an issue at https://github.com/synthelabs/synthe/issues");
  const avg = (rows: ScoreRow[]) => rows.reduce((n, r) => n + (r.score as number), 0) / rows.length;
  const judgeBefore = avg(judged.map(([b]) => b)), judgeAfter = avg(judged.map(([, a]) => a));
  const count = (score: number) => judged.filter(([, a]) => a.score === score).length;

  const lines: string[] = [];
  lines.push(`Test cases: better on ${to} in ${count(WIN)}, worse in ${count(LOSS)}, the same in ${count(TIE)}${judged.length < scenarios.length ? `. ${scenarios.length - judged.length} couldn't be judged and are left out` : ""}`, "");
  lines.push("Judge score (all scenarios, head to head: 50 is even)", `  Before: ${judgeBefore.toFixed(1)}  After: ${judgeAfter.toFixed(1)}  Change: ${signed(judgeAfter - judgeBefore)}`, "");

  let rateDrop = 0, rateChange: number | null = null;
  if (goal.checks?.some((c) => c.trim())) {
    const both = judged.filter(([b, a]) => [b, a].every((r) => typeof r.failed === "number" && typeof r.applicable === "number"));
    const rateBefore = checkRate(both.map(([b]) => b)), rateAfter = checkRate(both.map(([, a]) => a));
    if (rateBefore === null || rateAfter === null) lines.push("Check pass rate", "  Couldn't be measured: no check applied to these test cases, or the checker's answers were incomplete.", "");
    else {
      rateDrop = rateBefore - rateAfter;
      rateChange = rateAfter - rateBefore;
      lines.push("Check pass rate", `  Before: ${rateBefore}%  After: ${rateAfter}%  Change: ${signed(rateChange, 0)}pp`, "");
    }
  }

  const costBefore = sumCosts(replyCosts.get(from)!), costAfter = sumCosts(replyCosts.get(to)!);
  lines.push(...costSection(costBefore, costAfter));

  const judgeDrop = judgeBefore - judgeAfter;
  const worse: string[] = [];
  if (judgeDrop > MAX_DROP) worse.push(`judge score dropped more than ${MAX_DROP} points`);
  if (rateDrop > MAX_DROP) worse.push(`check pass rate dropped more than ${MAX_DROP}pp`);
  const cheaper = costBefore !== null && costAfter !== null && costAfter < costBefore;
  const better = judgeAfter - judgeBefore > MAX_DROP || (rateChange ?? 0) > MAX_DROP;
  if (parsed.dryRun) lines.push("Verdict: none from a dry run. Run again without --dry-run to compare real replies.");
  else if (worse.length) lines.push(`Verdict: ${worse.join("; ")}. Review before switching.`);
  else if (cheaper) lines.push(`Verdict: Looks good: ${better ? "better" : "similar"} quality, lower cost.`);
  else lines.push(`Verdict: Review before switching. ${costBefore === null || costAfter === null ? "The cost couldn't be worked out." : "The new model doesn't cost less."}`);

  lines.push("", "This is one run on each model, so small changes can be the judge varying. `npx synthe try --noise` shows how much it varies.");
  const spent = sumCosts(costs);
  lines.push(parsed.dryRun ? `Cost of this comparison: $0.00 (dry run). A real run would cost about ${money(spent)}.` : `Cost of this comparison: ${money(spent)}`);
  say(lines.join("\n"));
  return 0;
}
