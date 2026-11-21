import { DEFAULTS, type Goal, type Scenario } from "../../src/core/goal.ts";
import { sumCosts } from "../../src/core/cost.ts";
import { sha256 } from "../../src/core/safety.ts";
import { stopReason } from "../../src/core/state.ts";
import { runDecide } from "../../src/loop/decide.ts";
import { runScore } from "../../src/loop/score.ts";
import { applyEdits, runWrite } from "../../src/loop/write.ts";
import type { Model } from "../../src/model/client.ts";
import { MemoryRepo } from "../../test/helpers.ts";
import { shuffle, stream } from "../rng.ts";
import { Oracle, present, trueQuality, type Role } from "./oracle.ts";
import { SCENARIOS, type Kind, type PromptTask } from "./tasks.ts";

export interface PromptRun {
  task: string;
  seed: string;
  rounds: number;
  stopped: string | null;
  qualityStart: number;
  qualityEnd: number;
  qualityBest: number; // every real gain on the menu, and nothing else
  gainsKept: number; // merges that added a real gain
  falseKeeps: number; // merges that added a neutral edit or a trap
  trapsKept: number;
  neutralKept: number;
  gainsMissed: number; // real gains on the menu that are not in the final prompt
  reverts: number;
  merged: { round: number; added: string[]; kinds: Kind[] }[];
  calls: Record<Role, number>;
  costUsd: number;
  upperUsd: Record<Role, number>; // the most each role's calls could have cost live: replies at their full limit
  outcomes: string[];
}

const PROMPT_PATH = "prompt.md";
const SCENARIO_PATH = ".synthe/scenarios.jsonl";
const round2 = (n: number) => Math.round(n * 1000) / 1000;

export function goalFor(task: PromptTask, rounds: number): Goal {
  return {
    version: 1, prompt: { kind: "file", path: PROMPT_PATH }, objective: task.objective, guardrails: task.guardrails, scenarios: SCENARIO_PATH,
    ...(task.checks ? { checks: task.checks } : {}), ...(task.counter_checks ? { counter_checks: task.counter_checks } : {}),
    models: { ...DEFAULTS.models }, merge_rule: { ...DEFAULTS.merge_rule, mode: "auto", max_rounds: rounds }, budget: { ...DEFAULTS.budget },
  };
}

// The prompt with every real gain on the menu applied, through the real edit function: the best the loop could do.
function bestPrompt(task: PromptTask): string {
  let text = task.prompt;
  for (const m of task.menu.filter((x) => x.kind === "gain")) {
    const r = applyEdits(text, [{ find: m.find, replace: m.replace }]);
    if ("text" in r) text = r.text;
  }
  return text;
}

// One task for a fixed number of rounds, the way the workflow runs a round: write, then score, then decide, with the
// replaced prompt challenging the current one after a merge and the score step's caches handed to decide. The repo
// is the in-memory fake from the tests, so a merge really changes the prompt the next round starts from.
export async function runPromptTask(task: PromptTask, seed: string, rounds = task.rounds, live: Model | null = null): Promise<PromptRun> {
  const goal = goalFor(task, rounds);
  const oracle = new Oracle(task, seed, shuffle(task.menu, seed, task.name, "menu"), live);
  const repo = new MemoryRepo(task.prompt, PROMPT_PATH);
  const scenarios: Scenario[] = SCENARIOS.map(({ id, input, expected, split }) => ({ id, input, expected, split }));
  repo.files.set(SCENARIO_PATH, scenarios.map((s) => JSON.stringify(s)).join("\n") + "\n");
  const goalHash = sha256(JSON.stringify(goal));
  const merged: PromptRun["merged"] = [];
  const outcomes: string[] = [];
  let reverts = 0;
  let ran = 0;

  for (let n = 1; n <= rounds; n++) {
    const state = await repo.readState();
    if (stopReason(state, goal.merge_rule.max_rounds, goal.merge_rule.stall_rounds, goal.budget.max_usd, goal.budget.max_calls)) break;
    const prompt = repo.files.get(PROMPT_PATH)!;
    const before = new Set(present(task, prompt).map((m) => m.id));
    const written = await runWrite(goal, state, prompt, scenarios, oracle);
    const last = state.lastMerge;
    const prior = last && !last.reverted && last.mergedHash === sha256(prompt) ? last.priorPrompt : null;
    const scored = await runScore(goal, prompt, written.candidates, scenarios, oracle, prior, stream(seed, task.name, n), [], state.attackCache ?? null, state.scoreCache ?? null);
    const record = await runDecide(goal, repo, {
      candidates: written.candidates, scores: scored.scores, costUsd: sumCosts([written.costUsd, scored.costUsd]), writeUsd: written.costUsd,
      rejected: written.rejected, goalHash, caches: { attack: scored.attackCache ?? null, score: scored.scoreCache ?? null },
    }, new Date(Date.UTC(2026, 0, 1, n)));
    ran++;
    outcomes.push(record?.outcome ?? "none");
    const after = present(task, repo.files.get(PROMPT_PATH)!);
    if (record?.outcome === "merged") {
      const added = after.filter((m) => !before.has(m.id));
      merged.push({ round: n, added: added.map((m) => m.id), kinds: added.map((m) => m.kind) });
    }
    if (record?.outcome === "reverted") reverts++;
  }

  const final = repo.files.get(PROMPT_PATH)!;
  const kinds = merged.flatMap((m) => m.kinds);
  const state = await repo.readState();
  return {
    task: task.name, seed, rounds: ran, stopped: state.stopped,
    qualityStart: round2(trueQuality(task, task.prompt)), qualityEnd: round2(trueQuality(task, final)), qualityBest: round2(trueQuality(task, bestPrompt(task))),
    gainsKept: kinds.filter((k) => k === "gain").length,
    falseKeeps: kinds.filter((k) => k !== "gain").length,
    trapsKept: kinds.filter((k) => k === "trap").length,
    neutralKept: kinds.filter((k) => k === "neutral").length,
    gainsMissed: task.menu.filter((m) => m.kind === "gain" && !final.includes(m.marker)).length,
    reverts, merged, calls: { ...oracle.usage.calls }, costUsd: round2(oracle.usage.costUsd), upperUsd: Object.fromEntries(Object.entries(oracle.usage.upperUsd).map(([k, v]) => [k, round2(v)])) as Record<Role, number>, outcomes,
  };
}
