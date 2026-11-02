import type { Goal } from "../core/goal.ts";
import { isFinished, type RoundRecord, type State } from "../core/state.ts";

export const ISSUE_TITLE = "Synthe: overnight prompt report";

// What a round can't tell you, said every time, so an offline win is never mistaken for proof of business results.
export function notTested(goal: Goal): string[] {
  return [
    "**What this did not test**",
    "- Tools or actions your agent takes: only the system prompt was run, with no tools.",
    "- Conversations: each scenario is a single message, not a back-and-forth.",
    "- Real customers: scenarios are simulated, and generated ones aren't reviewed by a person.",
    "- People's judgment: replies were compared by an AI judge.",
    ...(goal.policy?.trim() ? [] : ["- Your business policy: synthe.json has no `policy`, so the judge only saw each scenario's good-response line."]),
  ];
}

const money = (state: State) => (state.spendUnknown ? `over $${state.spendUsd.toFixed(2)}` : `$${state.spendUsd.toFixed(2)}`);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The first thing a team reads in the morning: the outcome in one line, then what it means.
export function headline(goal: Goal, state: State): { title: string; summary: string } {
  const merged = state.rounds.filter((r) => r.outcome === "merged").length;
  const spent = `It has spent ${money(state)} of $${goal.budget.max_usd}.`;
  if (state.proposal) {
    return { title: `A better prompt is waiting for your review: #${state.proposal.pr}`, summary: `Merge it to keep the change, or close it to decline. Synthe pauses, spending nothing, until you decide. ${spent}` };
  }
  if (!state.stopped) {
    return merged > 0
      ? { title: `Your prompt is getting better: ${plural(merged, "change")} merged so far`, summary: `Synthe is still running, one round an hour. This page updates after each round. ${spent}` }
      : { title: "Synthe is working on your prompt", summary: `${plural(state.round, "round")} so far, one an hour. This page updates after each round. ${spent}` };
  }
  const recent = state.rounds.slice(-goal.merge_rule.stall_rounds);
  if (recent.length > 0 && recent.every((r) => r.outcome === "failed")) {
    return { title: "Stopped: the last rounds didn't finish", summary: "Check that your Synthe key still has credit, and look at the latest run in the Actions tab for the error." };
  }
  if (!isFinished(state.stopped)) return { title: "Stopped: Synthe needs you to fix something", summary: `${state.stopped[0].toUpperCase()}${state.stopped.slice(1)}.` };
  const why = /no winner$/.test(state.stopped) ? `the last ${goal.merge_rule.stall_rounds} rounds found nothing clearly better`
    : /^budget/.test(state.stopped) ? `it used its $${goal.budget.max_usd} budget` : `it ran all ${goal.merge_rule.max_rounds} rounds`;
  return merged > 0
    ? { title: `Done: your prompt got better overnight (${plural(merged, "change")} merged)`, summary: `Synthe stopped because ${why}. It spent ${money(state)} of $${goal.budget.max_usd}.` }
    : { title: "Done: no change was clearly better, so your prompt stays as it was", summary: `Synthe stopped because ${why}. It spent ${money(state)} of $${goal.budget.max_usd}.` };
}

function nextSteps(goal: Goal, state: State): string[] {
  const merged = state.rounds.some((r) => r.outcome === "merged" || r.outcome === "reverted");
  const steps: string[] = [];
  if (state.proposal) steps.push(`Review #${state.proposal.pr}: merge it to keep the change, or close it to decline.`);
  if (merged) steps.push("Pull the latest changes before you edit your prompt, so Synthe's changes aren't overwritten.");
  if (state.stopped && /no winner$/.test(state.stopped)) {
    steps.push(`To keep improving, add cases your agent still gets wrong to \`${goal.scenarios}\` (one JSON line each: \`input\`, \`expected\`, \`split\`).${state.round < goal.merge_rule.max_rounds ? " The next hourly run picks them up and continues." : " Then raise `merge_rule.max_rounds` in `synthe.json`."}`);
  }
  if (!state.stopped && !state.proposal) steps.push("Nothing to do. Synthe runs every hour and stops by itself.");
  if (!state.stopped || state.proposal) steps.push("To stop early: `npx synthe stop`.");
  return steps;
}

function roundRow(r: RoundRecord): string {
  const result = { merged: "Merged", reverted: "Undone", proposed: "Waiting for review", declined: "Declined by you", skipped: "No change", failed: "Didn't finish" }[r.outcome];
  const tried = r.tried?.length
    ? r.tried.map((t) => `${t.summary} <i>${t.outcome}</i>`).join("<br>")
    : r.plain ?? r.reasons.join("; ");
  const cost = r.costUsd === null ? "unknown" : `$${r.costUsd.toFixed(2)}`;
  return `| ${r.round} | ${result}${r.pr ? ` (#${r.pr})` : ""} | ${tried.replaceAll("|", "/").replaceAll("\n", " ")} | ${cost} |`;
}

export function renderReport(goal: Goal, state: State): string {
  const { title, summary } = headline(goal, state);
  const changes = state.rounds.filter((r) => ["merged", "reverted", "proposed"].includes(r.outcome) && r.pr);
  const lines = [`## ${title}`, "", summary, ""];
  if (changes.length) {
    lines.push("### What changed", "");
    for (const r of changes) {
      const undo = r.outcome === "merged" ? ` To undo it, click **Revert** on #${r.pr}.` : "";
      const note = r.outcome === "proposed" ? " (waiting for your review)" : r.outcome === "reverted" ? " (an undo)" : "";
      lines.push(`- **#${r.pr}${note}:** ${r.changed ?? "A change to the prompt"}. ${r.plain ?? ""}${undo}`);
    }
    lines.push("");
  }
  lines.push("### What to do next", "", ...nextSteps(goal, state).map((s) => `- ${s}`), "");
  if (state.rounds.length) {
    lines.push(
      "<details><summary>Round by round: every change Synthe tried and what happened</summary>", "",
      "| Round | Result | What Synthe tried | Cost |", "| --- | --- | --- | --- |",
      ...[...state.rounds].reverse().map(roundRow),
      "", "</details>", "",
    );
  }
  lines.push(
    "<details><summary>Details for reviewers</summary>", "",
    `- Goal: ${goal.objective}`,
    `- Rounds: ${state.round} of up to ${goal.merge_rule.max_rounds}. Spent ${money(state)} of $${goal.budget.max_usd}.`,
    `- Models: writer ${goal.models.writer}, runner ${goal.models.runner}, judge ${goal.models.judge}, checker ${goal.models.checker}.`,
    ...[...state.rounds].reverse().map((r) => `- Round ${r.round}: ${r.outcome}, cost ${r.costUsd === null ? "unknown" : `$${r.costUsd.toFixed(2)}`}${typeof r.writeUsd === "number" ? ` (writing $${r.writeUsd.toFixed(2)})` : ""}. ${r.reasons.join("; ").replaceAll("\n", " ")}`),
    "", "</details>", "",
    ...notTested(goal), "",
    "Only your prompt file can change. Was this useful? React 👍 or 👎 on this issue to tell us.",
  );
  return lines.join("\n");
}
