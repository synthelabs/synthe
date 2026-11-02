import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { GOAL_FILE, parseGoal, parseScenarios } from "./core/goal.ts";
import { readPrompt } from "./core/prompt.ts";
import { sumCosts } from "./core/cost.ts";
import { resumeIfScenariosChanged, stopReason } from "./core/state.ts";
import { sha256 } from "./core/safety.ts";
import { githubRepo } from "./github/repo.ts";
import { anthropicModel } from "./model/client.ts";
import { runDecide } from "./loop/decide.ts";
import { runScore } from "./loop/score.ts";
import { runWrite } from "./loop/write.ts";

const OUT = ".synthe-out";
const input = (name: string) => process.env[`INPUT_${name.toUpperCase()}`] ?? "";
const setOutput = (k: string, v: string) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };
const save = (name: string, value: unknown) => { mkdirSync(OUT, { recursive: true }); writeFileSync(`${OUT}/${name}`, JSON.stringify(value)); };
const load = <T>(name: string): T | null => (existsSync(`${OUT}/${name}`) ? JSON.parse(readFileSync(`${OUT}/${name}`, "utf8")) as T : null);

async function main() {
  const step = input("step");
  const repo = githubRepo(process.env.GITHUB_REPOSITORY!, input("github-token"), process.env.GITHUB_API_URL);

  if (step === "decide") {
    const goalText = await repo.readFile(GOAL_FILE, await repo.defaultBranch());
    if (goalText === null) throw new Error(`${GOAL_FILE} is missing`);
    const written = load<any>("candidates.json");
    const scored = load<any>("scores.json");
    const costUsd = sumCosts([written?.costUsd ?? null, scored?.costUsd ?? null]);
    const record = await runDecide(parseGoal(goalText), repo, { candidates: written?.candidates ?? null, scores: scored?.scores ?? null, costUsd, writeUsd: written?.costUsd ?? null });
    console.log(record ? `Round ${record.round}: ${record.outcome}. ${record.reasons.join(" ")}` : "Stopped; nothing to do.");
    return;
  }

  const goal = parseGoal(readFileSync(GOAL_FILE, "utf8"));
  const state = await repo.readState();
  // Decide makes the same check on the same commit and saves it; this job only needs to know whether to run.
  if (existsSync(goal.scenarios)) resumeIfScenariosChanged(state, sha256(readFileSync(goal.scenarios, "utf8")));
  const stop = stopReason(state, goal.merge_rule.max_rounds, goal.merge_rule.stall_rounds, goal.budget.max_usd);
  if (stop) {
    console.log(`Stopped: ${stop}`);
    setOutput("go", "false");
    return;
  }
  const prompt = readPrompt(readFileSync(goal.prompt.path, "utf8"), goal, state.prompt);
  if (prompt === null) throw new Error(`could not find the prompt in ${goal.prompt.path}`);
  const scenarios = parseScenarios(readFileSync(goal.scenarios, "utf8"));
  const model = anthropicModel(input("anthropic-api-key"));

  if (step === "write") {
    const written = await runWrite(goal, state, prompt, scenarios, model);
    console.log(`Wrote ${written.candidates.length} candidates for ${written.costUsd === null ? "an unknown cost" : `$${written.costUsd.toFixed(4)}`}`);
    save("candidates.json", written);
    setOutput("go", "true");
  } else if (step === "score") {
    const written = load<any>("candidates.json");
    if (!written) throw new Error("candidates are missing");
    const last = state.lastMerge;
    const prior = last && !last.reverted && last.mergedHash === sha256(prompt) ? last.priorPrompt : null;
    const scored = await runScore(goal, prompt, written.candidates, scenarios, model, prior);
    console.log(`Scored with ${scored.calls} model calls for ${scored.costUsd === null ? "an unknown cost" : `$${scored.costUsd.toFixed(4)}`}`);
    save("scores.json", scored);
  } else {
    throw new Error(`unknown step: ${step}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
