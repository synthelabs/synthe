import type { Goal } from "../core/goal.ts";
import { judgeRound, type RoundScores } from "../core/merge-rule.ts";
import { readPrompt, writePrompt } from "../core/prompt.ts";
import { candidateProblem, promptPathProblem, sha256 } from "../core/safety.ts";
import { resumeIfScenariosChanged, stopReason, type RoundRecord, type State } from "../core/state.ts";
import type { MergeProblem, Repo } from "../github/repo.ts";
import { ISSUE_TITLE, renderReport } from "./report.ts";
import type { Candidate } from "./write.ts";
import { WIN } from "./score.ts";

export interface RoundInput { candidates: Candidate[] | null; scores: RoundScores | null; costUsd: number | null; writeUsd?: number | null; rejected?: string[] }

const LESSONS = 6;

// Merge problems a person has to fix; the run stops and the report says how.
const NEEDS_A_PERSON: Partial<Record<MergeProblem, string>> = {
  blocked: "this repo blocks automatic merges; exempt Synthe's token in the branch rules",
  permission: "GitHub Actions isn't allowed to merge here; turn on 'Allow GitHub Actions to create and approve pull requests' in the repo's Actions settings",
  token: "GitHub refused the workflow's token",
};

// A decide step that died partway leaves state.pending behind. Find out on GitHub what it got done, keep a merge
// that went through (so the revert check still protects it), and clean up a branch or pull request it left.
async function recover(goal: Goal, repo: Repo, state: State): Promise<boolean> {
  const p = state.pending;
  if (!p) return false;
  const record: RoundRecord = { round: p.round, at: p.at, outcome: "failed", reasons: ["the decide step stopped partway; check the Actions log"], costUsd: p.costUsd };
  if (p.land) {
    const pr = await repo.findPr(p.land.branch);
    if (pr?.merged) {
      Object.assign(record, { outcome: p.land.kind === "merge" ? "merged" : "reverted", pr: pr.number });
      record.reasons = ["this merge went through just before the decide step stopped, and was recovered"];
      if (p.land.kind === "merge") {
        state.lastMerge = { pr: pr.number, priorPrompt: p.land.priorPrompt, mergedHash: sha256(p.land.text), reverted: false };
        state.stalls = 0;
      } else if (state.lastMerge) {
        state.lastMerge.reverted = true;
      }
      state.prompt = goal.prompt.kind === "inline" ? p.land.text : null;
    } else if (pr?.open) {
      await repo.closePr(pr.number);
    }
    await repo.deleteBranch(p.land.branch);
  }
  state.rounds.push(record);
  state.pending = null;
  return true;
}

export async function runDecide(goal: Goal, repo: Repo, input: RoundInput, now = new Date()): Promise<RoundRecord | null> {
  const state = await repo.readState();
  const { merge_rule, budget } = goal;
  const recovered = await recover(goal, repo, state);
  const base = await repo.defaultBranch();
  const head = await repo.headSha(base);
  const scenarioText = await repo.readFile(goal.scenarios, head);
  const scenariosHash = scenarioText === null ? null : sha256(scenarioText);
  if (scenariosHash !== null) resumeIfScenariosChanged(state, scenariosHash);
  if (stopReason(state, merge_rule.max_rounds, merge_rule.stall_rounds, budget.max_usd)) {
    if (recovered) {
      state.stopped = stopReason(state, merge_rule.max_rounds, merge_rule.stall_rounds, budget.max_usd);
      state.issue = await repo.upsertIssue(state.issue, ISSUE_TITLE, renderReport(goal, state));
      await repo.writeState(state);
    }
    return null;
  }

  const path = goal.prompt.path;
  const source = await repo.readFile(path, head);
  const current = source === null ? null : readPrompt(source, goal, state.prompt);
  const round = state.round + 1;
  const record: RoundRecord = { round, at: now.toISOString(), outcome: "skipped", reasons: [...(input.rejected ?? [])], costUsd: input.costUsd, writeUsd: input.writeUsd ?? null };
  const scores = input.scores;

  // Saved before anything touches the repo: this round's number and spend, and a stall that only a clean finish
  // can take back. If this step dies partway, the run still moves toward its limits instead of spending forever.
  const priorStalls = state.stalls;
  state.round = round;
  state.spendUsd += input.costUsd ?? 0;
  state.stalls = priorStalls + 1;
  state.pending = { round, at: record.at, costUsd: input.costUsd };
  await repo.writeState(state);
  let stall = true;

  const land = async (text: string, kind: "merge" | "revert", title: string, why: string): Promise<number | null> => {
    const branch = `synthe/round-${round}`;
    state.pending = { ...state.pending!, land: { branch, kind, text, priorPrompt: current! } };
    await repo.writeState(state);
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
    const stop = NEEDS_A_PERSON[merged.problem];
    if (stop) state.stopped = stop;
    return null;
  };

  if (!scores || !input.candidates) {
    record.outcome = "failed";
    record.reasons.push("the round did not finish; check the Actions log and the API key");
  } else if (input.costUsd === null) {
    record.reasons.push("cost unknown, so nothing merges");
    state.spendUnknown = true;
    stall = false;
  } else if (source === null || current === null || sha256(current) !== scores.baselineHash) {
    record.reasons.push("the prompt changed during this round");
    stall = false;
  } else if (promptPathProblem(path)) {
    record.reasons.push(promptPathProblem(path)!);
    state.stopped = promptPathProblem(path);
    stall = false;
  } else {
    // A teammate's later edit is a different prompt, so its score says nothing about Synthe's merge.
    const last = state.lastMerge;
    const replaced = last && !last.reverted && last.mergedHash === scores.baselineHash && scores.prior ? scores.prior : null;
    const verdict = judgeRound(scores, goal, replaced);
    record.reasons.push(...verdict.reasons);
    if (verdict.action === "merge") {
      const chosen = input.candidates.find((c) => c.id === verdict.candidateId);
      const text = chosen?.text;
      const problem = text === undefined ? "candidate missing" : candidateProblem(text, goal.prompt) ?? (text.trim() === current.trim() ? "candidate is the current prompt" : null);
      if (problem) {
        record.reasons.push(problem);
      } else {
        const why = [chosen?.summary ? `What changed: ${chosen.summary}` : "", verdict.reasons.join(" ")].filter(Boolean).join("\n\n");
        const pr = await land(text!, "merge", `Synthe: improve prompt (round ${round})`, why);
        if (pr !== null) {
          Object.assign(record, { outcome: "merged", pr, heldBefore: verdict.heldBefore, heldAfter: verdict.heldAfter, wins: verdict.wins, losses: verdict.losses });
          state.lastMerge = { pr, priorPrompt: current, mergedHash: sha256(text!), reverted: false };
          state.prompt = goal.prompt.kind === "inline" ? text! : null;
          stall = false;
        }
      }
    } else if (verdict.action === "revert") {
      const prior = state.lastMerge!.priorPrompt;
      const pr = await land(prior, "revert", `Synthe: revert round ${round - 1}'s prompt`, verdict.reasons.join(" "));
      if (pr !== null) {
        Object.assign(record, { outcome: "reverted", pr });
        state.lastMerge!.reverted = true;
        state.prompt = goal.prompt.kind === "inline" ? prior : null;
      }
    }
  }

  if (scores) {
    // Training rows only: held-back scenarios are never in scores.baselineTrain, so the writer can't learn them.
    // A lesson is a scenario where the current prompt broke a guardrail or a rewrite beat it, with both replies.
    const lessons = scores.baselineTrain.flatMap((r) => {
      if (typeof r.reply !== "string") return [];
      const winner = scores.candidates.map((c) => c.train.find((x) => x.id === r.id)).find((x) => x?.score === WIN && typeof x.reply === "string");
      if (!winner && r.violation !== true) return [];
      return [{ id: r.id, reply: r.reply, better: winner?.reply, violation: r.violation === true }];
    });
    lessons.sort((a, b) => Number(b.violation) - Number(a.violation));
    state.lessons = { promptHash: scores.baselineHash, rows: lessons.slice(0, LESSONS) };
  }
  state.stalls = record.outcome === "merged" ? 0 : stall ? priorStalls + 1 : priorStalls;
  state.scenariosHash = scenariosHash;
  state.pending = null;
  state.rounds.push(record);
  state.stopped = state.stopped ?? stopReason(state, merge_rule.max_rounds, merge_rule.stall_rounds, budget.max_usd);
  state.issue = await repo.upsertIssue(state.issue, ISSUE_TITLE, renderReport(goal, state));
  await repo.writeState(state);
  return record;
}
