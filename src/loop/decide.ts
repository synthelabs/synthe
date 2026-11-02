import type { Goal } from "../core/goal.ts";
import { judgeRound, type RoundScores } from "../core/merge-rule.ts";
import { readPrompt, writePrompt } from "../core/prompt.ts";
import { candidateProblem, promptPathProblem, sha256 } from "../core/safety.ts";
import { resumeIfScenariosChanged, stopReason, type RoundRecord } from "../core/state.ts";
import type { Repo } from "../github/repo.ts";
import { ISSUE_TITLE, renderReport } from "./report.ts";
import type { Candidate } from "./write.ts";

export interface RoundInput { candidates: Candidate[] | null; scores: RoundScores | null; costUsd: number | null }

export async function runDecide(goal: Goal, repo: Repo, input: RoundInput, now = new Date()): Promise<RoundRecord | null> {
  const state = await repo.readState();
  const { merge_rule, budget } = goal;
  const base = await repo.defaultBranch();
  const head = await repo.headSha(base);
  const scenarioText = await repo.readFile(goal.scenarios, head);
  const scenariosHash = scenarioText === null ? null : sha256(scenarioText);
  if (scenariosHash !== null) resumeIfScenariosChanged(state, scenariosHash);
  if (stopReason(state, merge_rule.max_rounds, merge_rule.stall_rounds, budget.max_usd)) return null;

  const path = goal.prompt.path;
  const source = await repo.readFile(path, head);
  const current = source === null ? null : readPrompt(source, goal, state.prompt);
  const round = state.round + 1;
  const record: RoundRecord = { round, at: now.toISOString(), outcome: "skipped", reasons: [], costUsd: input.costUsd };
  const scores = input.scores;

  const land = async (text: string, title: string, why: string): Promise<number | null> => {
    const branch = `synthe/round-${round}`;
    const content = writePrompt(source!, goal.prompt, current!, text);
    const sha = await repo.commitFile({ branch, baseSha: head, path, content, message: title });
    const pr = await repo.openPr({ branch, base, title, body: `${why}\n\nChosen by Synthe from simulated scenarios. Only \`${path}\` changed.` });
    const merged = await repo.mergePr(pr, sha);
    if (merged.merged) {
      await repo.deleteBranch(branch);
      return pr;
    }
    await repo.closePr(pr);
    await repo.deleteBranch(branch);
    record.reasons.push(`merge failed: ${merged.why}`);
    if (merged.blocked) state.stopped = "this repo blocks automatic merges; exempt Synthe's token in the branch rules";
    return null;
  };

  if (!scores || !input.candidates) {
    record.outcome = "failed";
    record.reasons.push("the round did not finish; check the Actions log and the API key");
    state.stalls += 1;
  } else if (input.costUsd === null) {
    record.reasons.push("cost unknown, so nothing merges");
    state.spendUnknown = true;
  } else if (source === null || current === null || sha256(current) !== scores.baselineHash) {
    record.reasons.push("the prompt changed during this round");
  } else if (promptPathProblem(path)) {
    record.reasons.push(promptPathProblem(path)!);
    state.stopped = promptPathProblem(path);
  } else {
    // A teammate's later edit is a different prompt, so its score says nothing about Synthe's merge.
    const last = state.lastMerge;
    const replaced = last && !last.reverted && last.mergedHash === scores.baselineHash ? last.priorScores : null;
    const verdict = judgeRound(scores, goal, replaced);
    record.reasons.push(...verdict.reasons);
    if (verdict.action === "merge") {
      const text = input.candidates.find((c) => c.id === verdict.candidateId)?.text;
      const problem = text === undefined ? "candidate missing" : candidateProblem(text, goal.prompt) ?? (text.trim() === current.trim() ? "candidate is the current prompt" : null);
      if (problem) {
        record.reasons.push(problem);
        state.stalls += 1;
      } else {
        const pr = await land(text!, `Synthe: improve prompt (round ${round})`, verdict.reasons.join(" "));
        if (pr !== null) {
          Object.assign(record, { outcome: "merged", pr, heldBefore: verdict.heldBefore, heldAfter: verdict.heldAfter, wins: verdict.wins, losses: verdict.losses });
          state.lastMerge = { pr, priorPrompt: current, priorScores: [...scores.baselineTrain, ...scores.baselineHoldout], mergedHash: sha256(text!), reverted: false };
          state.prompt = goal.prompt.kind === "inline" ? text! : null;
          state.stalls = 0;
        } else {
          state.stalls += 1;
        }
      }
    } else if (verdict.action === "revert") {
      const prior = state.lastMerge!.priorPrompt;
      const pr = await land(prior, `Synthe: revert round ${round - 1}'s prompt`, verdict.reasons.join(" "));
      if (pr !== null) {
        Object.assign(record, { outcome: "reverted", pr });
        state.lastMerge!.reverted = true;
        state.prompt = goal.prompt.kind === "inline" ? prior : null;
      }
      state.stalls += 1;
    } else {
      state.stalls += 1;
    }
  }

  state.round = round;
  state.scenariosHash = scenariosHash;
  state.spendUsd += input.costUsd ?? 0;
  state.rounds.push(record);
  state.stopped = stopReason(state, merge_rule.max_rounds, merge_rule.stall_rounds, budget.max_usd);
  state.issue = await repo.upsertIssue(state.issue, ISSUE_TITLE, renderReport(goal, state));
  await repo.writeState(state);
  return record;
}
