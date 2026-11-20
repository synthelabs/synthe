import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ATTACKS_FILE, GOAL_FILE, parseAttacks, parseGoal, parseScenarios, type Attack, type Provider } from "./core/goal.ts";
import { readPrompt } from "./core/prompt.ts";
import { sumCosts } from "./core/cost.ts";
import { calibrationReadings, resumeIfScenariosChanged, stopReason } from "./core/state.ts";
import { sha256 } from "./core/safety.ts";
import { githubRepo, type Repo } from "./github/repo.ts";
import { configuredModel, eventModels } from "./model/client.ts";
import { runDecide } from "./loop/decide.ts";
import { fullShareActive, requireOidc, sharePayload, shareRound, shouldShare } from "./core/share.ts";
import packageJson from "../package.json" with { type: "json" };
import { roundSummary } from "./loop/report.ts";
import { failureOf, type Failure } from "./loop/failure.ts";
import { explainScores, runScore } from "./loop/score.ts";
import { explainWrite, runWrite } from "./loop/write.ts";
import { explainCompose, withComposed } from "./loop/compose.ts";
import { captureCancel, captureFailure, flushEvents, observeRoundStep, startEventsWorker } from "./core/events.ts";
import { deliverReceipt } from "./core/receipts.ts";
import { cleanStop, countCalls, type CleanStop } from "./core/calls.ts";

const OUT = ".synthe-out";
// Only the hourly backup uses this gate. A queued chain round starts immediately.
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

// The model key. api-key (SYNTHE_API_KEY) serves whichever provider synthe.json names. anthropic-api-key
// (SYNTHE_ANTHROPIC_KEY) is the older name, still passed by every workflow installed before api-key existed, so it
// keeps working for Anthropic. It is never sent to another provider: it is an Anthropic key.
// undefined provider: before synthe.json is read, only to tell whether any own key is set.
function actionKey(provider: Provider | undefined): string | undefined {
  const generic = (input("api-key") || process.env.SYNTHE_API_KEY)?.trim();
  if (provider?.kind === "openai-compatible") return generic || undefined;
  // A SYNTHE_API_KEY that isn't an Anthropic key belongs to another provider: synthe.json may not name it yet.
  return (generic?.startsWith("sk-ant-") ? generic : undefined) || (input("anthropic-api-key") || process.env.SYNTHE_ANTHROPIC_KEY)?.trim() || undefined;
}

// The write or score step's model, counting its calls for budget.max_calls. Set once the step has its model.
let counter: ReturnType<typeof countCalls> | null = null;

async function main() {
  const step = input("step");
  if (step === "receipt-start" || step === "receipt-finish") {
    const acknowledged = await deliverReceipt(step, input("event-code"), input("team-code"), { conclusion: input("conclusion") });
    console.log(acknowledged ? "Crimson tracking acknowledged this run." : "Crimson tracking does not apply to this run.");
    return;
  }
  if (step === "cancel") return captureCancel();
  if (step !== "decide" && !actionKey(undefined)?.trim() && (input("event-code") || process.env.SYNTHE_EVENT_CODE)?.trim()) requireOidc();
  const repo = githubRepo(process.env.GITHUB_REPOSITORY!, input("github-token"), process.env.GITHUB_API_URL);

  if (step === "decide") {
    const branch = await repo.defaultBranch();
    const goalText = await repo.readFile(GOAL_FILE, branch);
    if (goalText === null) throw new Error(`${GOAL_FILE} is missing`);
    const written = load<any>("candidates.json");
    const scored = load<any>("scores.json");
    const costUsd = sumCosts([written?.costUsd ?? null, scored?.costUsd ?? null]);
    const error = load<Failure & { calls?: number }>("error.json");
    // Calls the write and score steps made, a failed step's included: budget.max_calls counts every one.
    const calls = [written?.calls, scored?.calls, error?.calls].reduce((n: number, c) => n + (typeof c === "number" ? c : 0), 0);
    const stopped: CleanStop | null = scored?.stopped ?? written?.stopped ?? null;
    const goal = parseGoal(goalText);
    const fullNow = new Date();
    const fullActive = fullShareActive(goal, fullNow);
    const beforeState = fullActive ? await repo.readState() : null;
    const startSource = fullActive && beforeState?.round === 0 ? await repo.readFile(goal.prompt.path, branch) : null;
    const startPrompt = startSource === null || !beforeState ? null : readPrompt(startSource, goal, beforeState.prompt);
    const scenarios = startPrompt !== null ? await repo.readFile(goal.scenarios, branch) : null;
    const calibrationText = await repo.readFile(".synthe/calibration.json", branch);
    const calibration = calibrationText === null ? null : calibrationReadings(calibrationText);
    const record = await observeRoundStep("decide", { candidates: written?.candidates }, () => runDecide(goal, repo, { candidates: withComposed(written?.candidates, scored?.compose), scores: scored?.scores ?? null, costUsd, writeUsd: written?.costUsd ?? null, rejected: written?.rejected, goalHash: sha256(goalText), error, calls, stopped, calibration, caches: { attack: scored?.attackCache ?? null, score: scored?.scoreCache ?? null } }));
    console.log(record ? `Round ${record.round}: ${record.outcome}. ${record.reasons.join(" ")}` : stopped ? stopped.message : "Stopped; nothing to do.");
    const state = await repo.readState();
    if (record && state.chainReady && state.round === record.round && state.round < goal.merge_rule.max_rounds && !state.stopped && !state.proposal && !state.pending) {
      try {
        await repo.dispatchWorkflow();
        console.log(`Queued round ${state.round + 1}.`);
      } catch (e) {
        state.chainReady = false;
        try { await repo.writeState(state); } catch (saveError) { console.log(`Could not clear chain marker: ${saveError}`); }
        console.log(e instanceof Error && /403/.test(e.message)
          ? "GitHub refused to start the next round (403): this repo's Synthe workflow predates 1.6.1. Run `npx synthe upgrade` in the repo so rounds start one after another; until then, run `npx synthe restart` to start each one."
          : `Could not queue the next round. Run \`npx synthe restart\` to continue (GitHub's hourly backup may also pick it up). ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (record && shouldShare(goal)) {
      const sharedState = await repo.readState();
      const finalSource = fullActive && sharedState.stopped ? await repo.readFile(goal.prompt.path, branch) : null;
      const finalPrompt = finalSource === null ? null : readPrompt(finalSource, goal, sharedState.prompt);
      const full = fullActive ? {
        ...(record.round === 1 && startPrompt !== null && scenarios !== null ? { prompt: startPrompt, scenarios } : {}),
        ...(sharedState.stopped && finalPrompt !== null ? { finalPrompt } : {}),
      } : undefined;
      console.log(await shareRound(sharePayload(goal, sharedState, record, packageJson.version, full, new Date()), process.env));
    }
    // The run's own page then says what happened, for whoever opens it from the Actions tab.
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, roundSummary(goal, await repo.readState(), record, process.env.GITHUB_REPOSITORY!));
    return;
  }

  const goal = parseGoal(readFileSync(GOAL_FILE, "utf8"));
  const state = await repo.readState();
  if (step === "write" && process.env.GITHUB_EVENT_NAME === "pull_request") {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8"));
    const pr = event.pull_request;
    const own = pr?.head?.repo?.full_name === process.env.GITHUB_REPOSITORY;
    const sameProposal = state.proposal && pr.number === state.proposal.pr && pr.head.ref === state.proposal.branch;
    // Merging the setup pull request starts the first round, so a team that reviews setup needs no extra command.
    const setupMerged = pr?.head?.ref === "synthe/setup" && pr.merged === true && state.round === 0;
    // A stale same-repo proposal close can replace a pending chain run. If a chain is ready, it is a valid starter.
    const roundBranch = pr?.head?.ref?.startsWith("synthe/round-") && (sameProposal || (state.chainReady && !state.proposal));
    if (event.action !== "closed" || !own || !(setupMerged || roundBranch)) {
      console.log("Closed pull request is not the current Synthe proposal; skipping.");
      setOutput("go", "false");
      return;
    }
  }
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
  const stop = stopReason(state, goal.merge_rule.max_rounds, goal.merge_rule.stall_rounds, goal.budget.max_usd, goal.budget.max_calls);
  if (stop) {
    console.log(`Stopped: ${stop}`);
    // A decide step that died partway still needs its own cleanup and a final report, even when the run is over.
    // "recover" skips scoring (it only runs on "true") but lets decide run.
    setOutput("go", state.pending ? "recover" : "false");
    return;
  }
  // A backup may replace one pending chain run. Its chainReady flag makes that backup a valid round starter.
  const last = state.rounds.at(-1);
  const since = last ? Date.now() - Date.parse(last.at) : Infinity;
  if (step === "write" && process.env.GITHUB_EVENT_NAME === "schedule" && since < ROUND_GAP_MS && !state.chainReady && !state.proposal) {
    console.log(`Last round was ${Math.round(since / 60_000)} minutes ago; the next one starts after ${ROUND_GAP_MS / 60_000}.`);
    setOutput("go", "false");
    return;
  }
  const prompt = readPrompt(readFileSync(goal.prompt.path, "utf8"), goal, state.prompt);
  if (prompt === null) throw new Error(`could not find the prompt in ${goal.prompt.path}`);
  const scenarios = parseScenarios(readFileSync(goal.scenarios, "utf8"));
  const key = actionKey(goal.provider);
  const eventCode = input("event-code") || process.env.SYNTHE_EVENT_CODE;
  if (!key && eventCode && goal.provider?.kind !== "openai-compatible") eventModels(goal.models);
  const maxCalls = goal.budget.max_calls;
  // State only learns this round's calls at decide, so scoring also subtracts what the write step just made.
  const writeCalls = step === "score" ? Number(load<{ calls?: number }>("candidates.json")?.calls ?? 0) : 0;
  counter = countCalls(configuredModel(key, eventCode, true, input("team-code") || process.env.SYNTHE_TEAM_CODE, goal.provider), maxCalls === undefined ? Infinity : maxCalls - (state.calls ?? 0) - writeCalls, maxCalls);
  const model = counter.model;
  const steps = counter;
  // A free limit used up, or the run's call cap reached: the step ends cleanly and hands the stop to decide, which
  // keeps the round's state intact. The job doesn't fail, so nothing looks broken in the Actions tab.
  const stopCleanly = (step: string, e: unknown, file: string) => {
    const stop = cleanStop(step, e);
    if (!stop) throw e;
    console.log(stop.message);
    save(file, { candidates: [], scores: null, costUsd: steps.costUsd(), calls: steps.calls(), stopped: stop });
  };

  if (step === "write") {
    let written;
    try {
      written = await observeRoundStep("write", { prompt }, () => runWrite(goal, state, prompt, scenarios, model));
    } catch (e) {
      stopCleanly("write", e, "candidates.json");
      // "true" so the score job runs and carries the stop to decide, the only job that writes state.
      setOutput("go", "true");
      return;
    }
    console.log(`Wrote ${written.candidates.length} candidates for ${written.costUsd === null ? "an unknown cost" : `$${written.costUsd.toFixed(4)}`}`);
    for (const line of explainWrite(written)) console.log(line);
    save("candidates.json", { ...written, calls: counter.calls() });
    setOutput("go", "true");
  } else if (step === "score") {
    const written = load<any>("candidates.json");
    if (!written) throw new Error("candidates are missing");
    if (written.stopped) {
      console.log(written.stopped.message);
      save("scores.json", { scores: null, costUsd: 0, calls: 0, stopped: written.stopped });
      return;
    }
    const last = state.lastMerge;
    const prior = last && !last.reverted && last.mergedHash === sha256(prompt) ? last.priorPrompt : null;
    // The frozen attack set, when the repo has one. It is loaded here, in the score step, so attack text can
    // never reach the write step or the writer.
    const attacks: Attack[] = existsSync(ATTACKS_FILE) ? parseAttacks(readFileSync(ATTACKS_FILE, "utf8")) : [];
    let scored;
    try {
      scored = await observeRoundStep("score", {}, () => runScore(goal, prompt, written.candidates, scenarios, model, prior, Math.random, attacks, state.attackCache ?? null, state.scoreCache ?? null));
    } catch (e) {
      stopCleanly("score", e, "scores.json");
      return;
    }
    // The current prompt's fresh attack results and score ride in scores.json to the decide step, which keeps them
    // in state: this job's token can only read, so writing state here always failed (HTTP 403).
    console.log(`Scored with ${scored.calls} model calls for ${scored.costUsd === null ? "an unknown cost" : `$${scored.costUsd.toFixed(4)}`}`);
    for (const line of explainCompose(scored.compose)) console.log(line);
    for (const line of explainScores(scored.scores, scenarios)) console.log(line);
    const { confirmed, dismissed, failed, excusedConfirmed } = scored.checks;
    if (confirmed + dismissed + failed + excusedConfirmed > 0) console.log(`guardrail re-checks: new breaks ${confirmed} confirmed, ${dismissed} dismissed, ${failed} failed (a failed check still blocks); ${excusedConfirmed} confirmed as already broken by the current prompt`);
    save("scores.json", { ...scored, calls: counter.calls() });
  } else {
    throw new Error(`unknown step: ${step}`);
  }
}

if (!startEventsWorker()) main().then(() => flushEvents(), async (e) => {
  const step = input("step");
  if (step === "receipt-start" || step === "receipt-finish") {
    console.log(`::error title=Crimson tracking::${e.message}`);
    process.exit(1);
  }
  captureFailure(input("step"), e);
  console.error(e);
  // The decide step reads this to tell a busy API (try again next hour) from a key a person has to replace.
  if (step === "write" || step === "score") {
    try {
      const failure = failureOf(step, e);
      save("error.json", { ...failure, calls: counter?.calls() ?? 0 });
      console.error(failure.message);
      // Shown at the top of the run's page, in words, instead of only a stack trace in the log.
      console.log(`::error title=Synthe::${failure.message.replace(/\r?\n/g, " ")}`);
    } catch (saveError) { console.error(saveError); }
  }
  await flushEvents();
  process.exit(1);
});
