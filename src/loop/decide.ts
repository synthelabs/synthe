import { parseScenarios, type Goal } from "../core/goal.ts";
import { judgeRound, type RoundScores } from "../core/merge-rule.ts";
import { readPrompt, writePrompt } from "../core/prompt.ts";
import { candidateProblem, promptPathProblem, sha256 } from "../core/safety.ts";
import { resumeIfScenariosChanged, stopReason, type Landing, type RoundRecord, type State } from "../core/state.ts";
import { Refusal, type MergeProblem, type Repo } from "../github/repo.ts";
import { ISSUE_TITLE, exampleText, notTested, renderReport } from "./report.ts";
import type { Candidate } from "./write.ts";
import type { Failure } from "./failure.ts";
import { WIN } from "./score.ts";

export interface RoundInput { candidates: Candidate[] | null; scores: RoundScores | null; costUsd: number | null; writeUsd?: number | null; rejected?: string[]; goalHash?: string; error?: Failure | null }

const LESSONS = 6;

export interface Example { input: string; before: string; after: string }
const clipText = (t: string, n = 280) => (t.length > n ? `${t.slice(0, n).trimEnd()}...` : t).replace(/\s+/g, " ").trim();

// One real test case the change won, with both replies: what a team wants to see, and to show.
function pickExample(scores: RoundScores, candidateId: string, scenarioText: string | null): Example | undefined {
  if (!scenarioText) return undefined;
  let rows: { id: string; input: string; split: string }[] = [];
  try { rows = parseScenarios(scenarioText); } catch { return undefined; }
  const wins = scores.candidates.find((c) => c.id === candidateId)?.train.filter((r) => r.score === WIN && typeof r.reply === "string") ?? [];
  // A case where the old reply broke a rule shows most clearly what the change fixes.
  const won = wins.find((r) => scores.baselineTrain.find((b) => b.id === r.id)?.violation === true) ?? wins[0];
  const before = won && scores.baselineTrain.find((r) => r.id === won.id)?.reply;
  const scenario = won && rows.find((r) => r.id === won.id && r.split === "train");
  return won && before && scenario ? { input: clipText(scenario.input, 200), before: clipText(before), after: clipText(won.reply!) } : undefined;
}


// Details a change adds that a business would have to really offer: amounts, percentages, time limits, web
// addresses and emails that are nowhere in the old prompt or the policy. A reviewer should check they're real.
const DETAIL = /\$\s?\d[\d,]*(?:\.\d+)?|\b\d+(?:\.\d+)?\s?%|\b\d+[- ]?(?:days?|hours?|weeks?|months?|years?)\b|\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\b(?:https?:\/\/)?[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|io|co|ai|app|shop|store)(?:\/[\w\-/]*)?/gi;
export function newDetails(edits: { find: string; replace: string }[] | undefined, known: string): string[] {
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, "").replace(/^https?:\/\//, "");
  const have = norm(known);
  const added = (edits ?? []).flatMap((e) => e.replace.match(DETAIL) ?? []);
  return [...new Set(added.map((d) => d.trim()))].filter((d) => !have.includes(norm(d))).slice(0, 8);
}

// The edits as a diff a reviewer can read at a glance.
function diffLines(edits: { find: string; replace: string }[] | undefined): string[] {
  return (edits ?? []).flatMap((e) => [
    ...(e.find ? e.find.split("\n").map((l) => `- ${l}`) : []),
    ...e.replace.split("\n").map((l) => `+ ${l}`),
  ]).slice(0, 60);
}

// Merge problems a person has to fix; the run stops and the report says how.
// (A merge blocked by branch rules isn't here: its pull request is left open as a proposal instead.)
const NEEDS_A_PERSON: Partial<Record<MergeProblem, string>> = {
  permission: "GitHub Actions isn't allowed to merge here; turn on 'Allow GitHub Actions to create and approve pull requests' in the repo's Actions settings",
  token: "GitHub refused the workflow's token",
};

// The report is how a team sees what happened, but losing the round over it is worse. If GitHub refuses the issue
// (Issues are off, as in a fresh fork, or the token can't write them) the run carries on and the state is saved
// with a note on the latest round. It doesn't stop the run: merges and proposals still help, and each pull
// request explains itself.
async function writeReport(goal: Goal, repo: Repo, state: State) {
  try {
    state.issue = await repo.upsertIssue(state.issue, ISSUE_TITLE, renderReport(goal, state));
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    const note = `couldn't write the report issue: ${e.plain}`;
    const last = state.rounds.at(-1);
    if (last && !last.reasons.includes(note)) last.reasons.push(note);
    console.log(`::warning::${note}`);
  }
}

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
      // Backup runs check an open proposal; only write when something changed, so the state branch
      // and the report don't get a new commit or edit each time.
      if (recovered || state.issue === null) {
        await writeReport(goal, repo, state);
        await repo.writeState(state);
      }
      return null;
    }
    await settle(goal, repo, state, Boolean(pr?.merged));
    if (!input.scores) {
      state.stopped = stopReason(state, merge_rule.max_rounds, merge_rule.stall_rounds, budget.max_usd);
      await writeReport(goal, repo, state);
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
      await writeReport(goal, repo, state);
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
  type Why = { changed: string; plain: string; technical: string; diff?: string[]; example?: Example; unverified?: string[] };
  const land = async (text: string, kind: "merge" | "revert", title: string, why: Why): Promise<{ pr: number; proposed: boolean } | null> => {
    const branch = `synthe/round-${round}`;
    const landing: Landing = { branch, kind, text, priorPrompt: current!, propose: merge_rule.mode === "propose" };
    state.pending = { ...state.pending!, land: landing };
    await repo.writeState(state);
    const content = writePrompt(source!, goal.prompt, current!, text);
    const sha = await repo.commitFile({ branch, baseSha: head, path, content, message: title });
    const short = (h: string | null | undefined) => (h ? `\`sha256:${h.slice(0, 12)}\`` : "unknown");
    const { writer, runner, judge, checker } = goal.models;
    const receipt = [
      "Fingerprints of exactly what was tested, so anyone can check or reproduce this decision. You can ignore them.",
      `- Commit tested: \`${head.slice(0, 12)}\``,
      `- Prompt before: ${short(sha256(current!))}, after: ${short(sha256(text))}`,
      `- Test cases: ${short(scenariosHash)}, goal file: ${short(input.goalHash)}`,
      `- AI models: writer ${writer}, agent ${runner}, judge ${judge}, rule checker ${checker}`,
    ].join("\n");
    const when = `${now.toISOString().slice(0, 16).replace("T", " ")} UTC`;
    // Written for whoever opens the notification: what happened, what changed, why, what to do, and how to undo it.
    // The fingerprints and the test's limits are there for anyone who wants to check, folded away.
    const bodyFor = (proposed: boolean, blocked = false) => [
      proposed
        ? blocked
          ? `**Waiting for your review.** Synthe found a better prompt, but this repo's rules require a review before merging into \`${base}\`. Merge this pull request to keep the change, or close it to decline. Synthe pauses until you decide.`
          : `**Waiting for your review.** Synthe found a better prompt. Merge this pull request to keep the change, or close it to decline. Synthe pauses until you decide.`
        : `**Already merged into \`${base}\`** at ${when}, because automatic merging was chosen at setup. If \`${base}\` deploys your app, this change is live.`,
      `**What changed in \`${path}\`:** ${why.changed}`,
      ...(why.diff?.length ? ["```diff\n" + why.diff.join("\n") + "\n```"] : []),
      ...(why.unverified?.length ? [`**Check these are real:** this change adds ${why.unverified.map((d) => `\`${d}\``).join(", ")}, which ${why.unverified.length === 1 ? "isn't" : "aren't"} in your old prompt or your policy. Make sure your business really offers ${why.unverified.length === 1 ? "it" : "them"}${proposed ? " before merging" : ", or revert this change"}.`] : []),
      `**Why:** ${why.plain}`,
      ...(why.example ? [exampleText(why.example)] : []),
      proposed
        ? "After merging, pull before you edit the prompt yourself."
        : "**Before you edit the prompt yourself, pull the latest changes,** so this change isn't overwritten. To undo it, click **Revert** on this pull request.",
      "Tested on simulated messages only. It can't tell you how real users will react.",
      `<details><summary>Fingerprints of what was tested</summary>\n\n${receipt}\n\nThe judge's numbers: ${why.technical}\n\n</details>`,
      `<details><summary>What this did not test</summary>\n\n${notTested(goal).slice(1).join("\n")}\n\n</details>`,
    ].join("\n\n");
    const body = bodyFor(Boolean(landing.propose));
    let pr: number;
    try {
      pr = await repo.openPr({ branch, base, title, body });
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      // Every round would find the same winner and be refused the same way, so stop with the fix.
      await repo.deleteBranch(branch);
      record.reasons.push(`couldn't open a pull request: ${e.message}`);
      record.plain = "Synthe found a better prompt but GitHub wouldn't let it open a pull request, so nothing changed.";
      state.stopped = e.plain;
      return null;
    }
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
      await repo.updatePrBody(pr, bodyFor(true, true));
      return { pr, proposed: true };
    }
    await repo.closePr(pr);
    await repo.deleteBranch(branch);
    record.reasons.push(`merge failed: ${merged.why}`);
    const stop = NEEDS_A_PERSON[merged.problem];
    if (stop) state.stopped = stop;
    return null;
  };

  if ((!scores || !input.candidates) && current === null) {
    // The write step stops before any model call when it can't find the prompt, so this costs nothing and needs a person.
    record.outcome = "failed";
    record.reasons.push(`couldn't find the prompt in ${path}`);
    record.plain = source === null
      ? `This round didn't run because ${path} is missing. If you moved your prompt, change prompt.path in synthe.json to its new place.`
      : goal.prompt.kind === "inline"
        ? `This round didn't run because Synthe can't tell which string in ${path} is your prompt. Set prompt.initial in synthe.json to your prompt's text as it is now.`
        : `This round didn't run because Synthe couldn't read your prompt in ${path}.`;
    stall = false;
  } else if (!scores || !input.candidates) {
    record.outcome = "failed";
    const error = input.error;
    if (error) record.failure = error.kind;
    if (error?.kind === "busy") {
      // Overload or rate limits pass by themselves, so a busy hour mustn't use up the rounds allowed without a winner.
      record.reasons.push(`Anthropic's API was busy during the ${error.step} step: ${error.message}`);
      record.plain = "This round didn't finish because Anthropic's API was busy. Nothing is wrong on your side, and nothing changed. Synthe will retry on the hourly backup run.";
      stall = false;
    } else if (error?.kind === "key") {
      record.reasons.push(`the ${error.step} step's key was refused: ${error.message}`);
      const cause = error.message.split(/(?<=\.) /)[0];
      record.plain = `This round didn't finish. ${cause} Get a new key from the Synthe table, then run \`gh secret set SYNTHE_ANTHROPIC_KEY\` in your repo and paste the key when it asks.`;
    } else {
      record.reasons.push("the round did not finish; check the Actions log and the API key");
      record.plain = "This round didn't finish. If it keeps happening, check the Actions log and that your key still has credit.";
    }
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
    record.tried = [
      ...input.candidates.map((c) => ({
        summary: c.summary ?? "A change to the prompt",
        outcome: verdict.notes[c.id] ?? (candidateProblem(c.text, goal.prompt) ? "Refused by a safety check, so it wasn't tested." : "Not tested."),
      })),
      ...(input.rejected ?? []).map((r) => ({ summary: "An edit that couldn't be applied", outcome: `Not used: ${r.replace(/^candidate-\d+: /, "")}.` })),
    ];
    if (verdict.action === "skip") record.plain = "Nothing was clearly better, so your prompt stayed the same.";
    if (verdict.action === "merge") {
      const chosen = input.candidates.find((c) => c.id === verdict.candidateId);
      const text = chosen?.text;
      const problem = text === undefined ? "candidate missing" : candidateProblem(text, goal.prompt) ?? (text.trim() === current.trim() ? "candidate is the current prompt" : null);
      if (problem) {
        record.reasons.push(problem);
      } else {
        const changed = chosen?.summary ?? "A change to the prompt";
        const example = pickExample(scores, verdict.candidateId, scenarioText);
        const unverified = newDetails(chosen?.edits, `${current}\n${goal.policy ?? ""}`);
        const name = chosen?.title ?? (changed.length > 60 ? `${changed.slice(0, 57)}...` : changed);
        const landed = await land(text!, "merge", `Synthe: ${name}`,
          { changed, plain: verdict.plain, technical: verdict.reasons.join(" "), diff: diffLines(chosen?.edits), example, unverified });
        if (landed) {
          if (example) record.example = example;
          if (chosen?.title) record.title = chosen.title;
          if (unverified.length) record.unverified = unverified;
        }
        if (landed) {
          Object.assign(record, { outcome: landed.proposed ? "proposed" : "merged", pr: landed.pr, heldBefore: verdict.heldBefore, heldAfter: verdict.heldAfter, wins: verdict.wins, losses: verdict.losses, ...(verdict.checks ? { checks: verdict.checks } : {}) });
          record.changed = chosen?.summary ?? "A change to the prompt";
          record.plain = verdict.plain;
          if (!landed.proposed) {
            state.lastMerge = { pr: landed.pr, priorPrompt: current, mergedHash: sha256(text!), reverted: false };
            state.prompt = goal.prompt.kind === "inline" ? text! : null;
          }
          stall = false;
        }
      }
    } else if (verdict.action === "revert") {
      const prior = state.lastMerge!.priorPrompt;
      const landed = await land(prior, "revert", "Synthe: undo the last prompt change", { changed: "Puts back the prompt from before Synthe's last change.", plain: verdict.plain, technical: verdict.reasons.join(" ") });
      if (landed) {
        Object.assign(record, { outcome: landed.proposed ? "proposed" : "reverted", pr: landed.pr });
        record.changed = "Put back the prompt from before the last change";
        record.plain = verdict.plain;
        if (!landed.proposed) {
          state.lastMerge!.reverted = true;
          state.prompt = goal.prompt.kind === "inline" ? prior : null;
        }
      }
    }
  }

  if (scores) {
    // Training rows only: held-back scenarios are never in scores.baselineTrain, so the writer can't learn them.
    // A lesson is a scenario where the current prompt broke a guardrail, failed one of the team's checks, or a rewrite
    // beat it, with both replies.
    const lessons = scores.baselineTrain.flatMap((r) => {
      if (typeof r.reply !== "string") return [];
      const winner = scores.candidates.map((c) => c.train.find((x) => x.id === r.id)).find((x) => x?.score === WIN && typeof x.reply === "string");
      if (!winner && r.violation !== true && !r.failedChecks?.length) return [];
      return [{ id: r.id, reply: r.reply, better: winner?.reply, violation: r.violation === true, ...(r.failedChecks?.length ? { failedChecks: r.failedChecks } : {}) }];
    });
    lessons.sort((a, b) => Number(b.violation) - Number(a.violation) || (b.failedChecks?.length ?? 0) - (a.failedChecks?.length ?? 0));
    state.lessons = { promptHash: scores.baselineHash, rows: lessons.slice(0, LESSONS) };
  }
  state.stalls = record.outcome === "merged" ? 0 : stall ? priorStalls + 1 : priorStalls;
  state.scenariosHash = scenariosHash;
  state.pending = null;
  state.rounds.push(record);
  state.stopped = state.stopped ?? stopReason(state, merge_rule.max_rounds, merge_rule.stall_rounds, budget.max_usd);
  state.chainReady = Boolean(input.scores && input.candidates && record.outcome !== "failed" && !state.stopped && !state.proposal && !state.pending && state.round < merge_rule.max_rounds && !record.reasons.some((reason) => reason.startsWith("merge failed:")));
  await writeReport(goal, repo, state);
  await repo.writeState(state);
  return record;
}
