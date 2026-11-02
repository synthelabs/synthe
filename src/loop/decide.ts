import type { Goal } from "../core/goal.ts";
import { judgeRound, type RoundScores } from "../core/merge-rule.ts";
import { readPrompt, writePrompt } from "../core/prompt.ts";
import { candidateProblem, promptPathProblem, sha256 } from "../core/safety.ts";
import { resumeIfScenariosChanged, stopReason, type Landing, type RoundRecord, type State } from "../core/state.ts";
import type { MergeProblem, Repo } from "../github/repo.ts";
import { ISSUE_TITLE, renderReport } from "./report.ts";
import type { Candidate } from "./write.ts";
import { WIN } from "./score.ts";

export interface RoundInput { candidates: Candidate[] | null; scores: RoundScores | null; costUsd: number | null; writeUsd?: number | null; rejected?: string[] }

const LESSONS = 6;

// Merge problems a person has to fix; the run stops and the report says how.
// (A merge blocked by branch rules isn't here: its pull request is left open as a proposal instead.)
const NEEDS_A_PERSON: Partial<Record<MergeProblem, string>> = {
  permission: "GitHub Actions isn't allowed to merge here; turn on 'Allow GitHub Actions to create and approve pull requests' in the repo's Actions settings",
  token: "GitHub refused the workflow's token",
};

// A proposal was merged or closed by a person: keep a merge on record (so the revert check protects it) or note
// that it was declined, and let rounds continue.
async function settle(goal: Goal, repo: Repo, state: State, merged: boolean) {
  const p = state.proposal!;
  const record = state.rounds.find((r) => r.pr === p.pr && r.outcome === "proposed");
  if (merged) {
    // A reviewer may have edited the pull request before merging, so track what is really on the default branch.
    const source = await repo.readFile(goal.prompt.path, await repo.headSha(await repo.defaultBranch()));
    const live = source === null ? null : readPrompt(source, goal, p.text);
    if (live === null) {
      state.stopped = `the merged pull request changed the prompt in ${goal.prompt.path} so Synthe can't find it; set prompt.initial in synthe.json to the new text`;
    } else if (p.kind === "merge") {
      state.lastMerge = { pr: p.pr, priorPrompt: p.priorPrompt, mergedHash: sha256(live), reverted: false };
      state.prompt = goal.prompt.kind === "inline" ? live : null;
      state.stalls = 0;
    } else {
      if (state.lastMerge) state.lastMerge.reverted = true;
      state.prompt = goal.prompt.kind === "inline" ? live : null;
    }
  }
  if (record) {
    record.outcome = merged ? (p.kind === "merge" ? "merged" : "reverted") : "declined";
    record.reasons.push(merged ? `merged by a person after review` : `closed without merging`);
  }
  state.proposal = null;
}

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
    } else if (pr?.open && p.land.propose) {
      // A proposal that was opened just before the crash: leave it for review, as intended.
      Object.assign(record, { outcome: "proposed", pr: pr.number });
      record.reasons = ["proposed for review; the decide step stopped just after opening it"];
      state.proposal = { ...p.land, pr: pr.number, round: p.round };
    } else if (pr?.open) {
      await repo.closePr(pr.number);
    }
    if (!state.proposal || state.proposal.branch !== p.land.branch) await repo.deleteBranch(p.land.branch);
  }
  state.rounds.push(record);
  state.pending = null;
  return true;
}

export async function runDecide(goal: Goal, repo: Repo, input: RoundInput, now = new Date()): Promise<RoundRecord | null> {
  const state = await repo.readState();
  const { merge_rule, budget } = goal;
  const recovered = await recover(goal, repo, state);
  // While a proposal waits for review, nothing else happens: no candidates, no spend, no round.
  if (state.proposal) {
    const pr = await repo.findPr(state.proposal.branch);
    if (pr?.open) {
      state.issue = await repo.upsertIssue(state.issue, ISSUE_TITLE, renderReport(goal, state));
      await repo.writeState(state);
      return null;
    }
    await settle(goal, repo, state, Boolean(pr?.merged));
    if (!input.scores) {
      state.stopped = stopReason(state, merge_rule.max_rounds, merge_rule.stall_rounds, budget.max_usd);
      state.issue = await repo.upsertIssue(state.issue, ISSUE_TITLE, renderReport(goal, state));
      await repo.writeState(state);
      return null;
    }
  }
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

  // Opens the pull request, then merges it (auto mode) or leaves it for a person (propose mode, or a repo whose
  // branch rules require a review). Returns the pull request and whether it was only proposed, or null.
  const land = async (text: string, kind: "merge" | "revert", title: string, why: string): Promise<{ pr: number; proposed: boolean } | null> => {
    const branch = `synthe/round-${round}`;
    const landing: Landing = { branch, kind, text, priorPrompt: current!, propose: merge_rule.mode === "propose" };
    state.pending = { ...state.pending!, land: landing };
    await repo.writeState(state);
    const content = writePrompt(source!, goal.prompt, current!, text);
    const sha = await repo.commitFile({ branch, baseSha: head, path, content, message: title });
    const pr = await repo.openPr({ branch, base, title, body: `${why}\n\nChosen by Synthe from simulated scenarios. Only \`${path}\` changed.${landing.propose ? " Merge it to keep the change, or close it to decline." : ""}` });
    if (landing.propose) {
      state.proposal = { ...landing, pr, round };
      return { pr, proposed: true };
    }
    const merged = await repo.mergePr(pr, sha);
    if (merged.merged) {
      await repo.deleteBranch(branch);
      return { pr, proposed: false };
    }
    if (merged.problem === "blocked") {
      record.reasons.push(`this repo requires a review to merge, so Synthe left #${pr} open for you`);
      // Saved first, so crash recovery keeps this pull request open for review instead of closing it.
      landing.propose = true;
      await repo.writeState(state);
      state.proposal = { ...landing, pr, round };
      return { pr, proposed: true };
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
        const landed = await land(text!, "merge", `Synthe: improve prompt (round ${round})`, why);
        if (landed) {
          Object.assign(record, { outcome: landed.proposed ? "proposed" : "merged", pr: landed.pr, heldBefore: verdict.heldBefore, heldAfter: verdict.heldAfter, wins: verdict.wins, losses: verdict.losses });
          if (!landed.proposed) {
            state.lastMerge = { pr: landed.pr, priorPrompt: current, mergedHash: sha256(text!), reverted: false };
            state.prompt = goal.prompt.kind === "inline" ? text! : null;
          }
          stall = false;
        }
      }
    } else if (verdict.action === "revert") {
      const prior = state.lastMerge!.priorPrompt;
      const landed = await land(prior, "revert", `Synthe: revert round ${round - 1}'s prompt`, verdict.reasons.join(" "));
      if (landed) {
        Object.assign(record, { outcome: landed.proposed ? "proposed" : "reverted", pr: landed.pr });
        if (!landed.proposed) {
          state.lastMerge!.reverted = true;
          state.prompt = goal.prompt.kind === "inline" ? prior : null;
        }
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
