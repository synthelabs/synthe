import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { GOAL_FILE, parseGoal, parseScenarios } from "./core/goal.ts";
import { readPrompt } from "./core/prompt.ts";
import { sumCosts } from "./core/cost.ts";
import { resumeIfScenariosChanged, stopReason } from "./core/state.ts";
import { sha256 } from "./core/safety.ts";
import { githubRepo, type Repo } from "./github/repo.ts";
import { anthropicModel } from "./model/client.ts";
import { runDecide } from "./loop/decide.ts";
import { roundSummary } from "./loop/report.ts";
import { failureOf, type Failure } from "./loop/failure.ts";
import { explainScores, runScore } from "./loop/score.ts";
import { explainWrite, runWrite } from "./loop/write.ts";

const OUT = ".synthe-out";
// Wake-ups are every 10 minutes, so 50 keeps rounds about an hour apart however the wake-ups fall.
const ROUND_GAP_MS = 50 * 60_000;
const input = (name: string) => process.env[`INPUT_${name.toUpperCase()}`] ?? "";
const setOutput = (k: string, v: string) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };
const save = (name: string, value: unknown) => { mkdirSync(OUT, { recursive: true }); writeFileSync(`${OUT}/${name}`, JSON.stringify(value)); };
const load = <T>(name: string): T | null => (existsSync(`${OUT}/${name}`) ? JSON.parse(readFileSync(`${OUT}/${name}`, "utf8")) as T : null);

// A proposal the team already merged or closed doesn't need a round of its own to notice: decide settles it and then
// judges this round as usual. When GitHub won't say (a token that can't read pull requests), keep waiting.
async function stillWaiting(repo: Repo, branch: string): Promise<boolean> {
  try {
    const pr = await repo.findPr(branch);
    return !pr || pr.open;
  } catch {
    return true;
  }
}

async function main() {
  const step = input("step");
  const repo = githubRepo(process.env.GITHUB_REPOSITORY!, input("github-token"), process.env.GITHUB_API_URL);

  if (step === "decide") {
    const goalText = await repo.readFile(GOAL_FILE, await repo.defaultBranch());
    if (goalText === null) throw new Error(`${GOAL_FILE} is missing`);
    const written = load<any>("candidates.json");
    const scored = load<any>("scores.json");
    const costUsd = sumCosts([written?.costUsd ?? null, scored?.costUsd ?? null]);
    const record = await runDecide(parseGoal(goalText), repo, { candidates: written?.candidates ?? null, scores: scored?.scores ?? null, costUsd, writeUsd: written?.costUsd ?? null, rejected: written?.rejected, goalHash: sha256(goalText), error: load<Failure>("error.json") });
    console.log(record ? `Round ${record.round}: ${record.outcome}. ${record.reasons.join(" ")}` : "Stopped; nothing to do.");
    // The run's own page then says what happened, for whoever opens it from the Actions tab.
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, roundSummary(parseGoal(goalText), await repo.readState(), record, process.env.GITHUB_REPOSITORY!));
    return;
  }

  const goal = parseGoal(readFileSync(GOAL_FILE, "utf8"));
  const state = await repo.readState();
  // Checked before the stop reasons: a proposal opened in a run's last round still needs settling.
  // Only write decides this: score runs only when write said go, and its token can't read pull requests.
  if (state.proposal && !state.pending && (step !== "write" || await stillWaiting(repo, state.proposal.branch))) {
    // Waiting for a person to merge or close a proposal: no model calls. "check" skips scoring but lets decide
    // look at the pull request.
    console.log(`Waiting for review of #${state.proposal.pr}`);
    setOutput("go", "check");
    return;
  }
  // Decide makes the same check on the same commit and saves it; this job only needs to know whether to run.
  if (existsSync(goal.scenarios)) resumeIfScenariosChanged(state, sha256(readFileSync(goal.scenarios, "utf8")));
  const stop = stopReason(state, goal.merge_rule.max_rounds, goal.merge_rule.stall_rounds, goal.budget.max_usd);
  if (stop) {
    console.log(`Stopped: ${stop}`);
    // A decide step that died partway still needs its own cleanup and a final report, even when the run is over.
    // "recover" skips scoring (it only runs on "true") but lets decide run.
    setOutput("go", state.pending ? "recover" : "false");
    return;
  }
  // Scheduled wake-ups come every 10 minutes so a dropped one doesn't cost the night, but rounds stay about an hour
  // apart. Setup, restart and a manual run start a round right away.
  const last = state.rounds.at(-1);
  const since = last ? Date.now() - Date.parse(last.at) : Infinity;
  if (step === "write" && process.env.GITHUB_EVENT_NAME === "schedule" && since < ROUND_GAP_MS) {
    console.log(`Last round was ${Math.round(since / 60_000)} minutes ago; the next one starts after ${ROUND_GAP_MS / 60_000}.`);
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
    for (const line of explainWrite(written)) console.log(line);
    save("candidates.json", written);
    setOutput("go", "true");
  } else if (step === "score") {
    const written = load<any>("candidates.json");
    if (!written) throw new Error("candidates are missing");
    const last = state.lastMerge;
    const prior = last && !last.reverted && last.mergedHash === sha256(prompt) ? last.priorPrompt : null;
    const scored = await runScore(goal, prompt, written.candidates, scenarios, model, prior);
    console.log(`Scored with ${scored.calls} model calls for ${scored.costUsd === null ? "an unknown cost" : `$${scored.costUsd.toFixed(4)}`}`);
    for (const line of explainScores(scored.scores, scenarios)) console.log(line);
    const { confirmed, dismissed, failed, excusedConfirmed } = scored.checks;
    if (confirmed + dismissed + failed + excusedConfirmed > 0) console.log(`guardrail re-checks: new breaks ${confirmed} confirmed, ${dismissed} dismissed, ${failed} failed (a failed check still blocks); ${excusedConfirmed} confirmed as already broken by the current prompt`);
    save("scores.json", scored);
  } else {
    throw new Error(`unknown step: ${step}`);
  }
}

main().catch((e) => {
  console.error(e);
  // The decide step reads this to tell a busy API (try again next hour) from a key a person has to replace.
  const step = input("step");
  if (step === "write" || step === "score") {
    try {
      const failure = failureOf(step, e);
      save("error.json", failure);
      // Shown at the top of the run's page, in words, instead of only a stack trace in the log.
      console.log(`::error title=Synthe::${failure.message.replace(/\r?\n/g, " ")}`);
    } catch (saveError) { console.error(saveError); }
  }
  process.exit(1);
});
