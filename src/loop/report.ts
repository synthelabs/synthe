import type { Goal } from "../core/goal.ts";
import { isFinished, type State } from "../core/state.ts";

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

// What the run did, said as an outcome: a run that ran out of ideas is done, not broken.
function status(goal: Goal, state: State): string[] {
  if (state.proposal) {
    return [`**Status:** waiting for review. Synthe proposed #${state.proposal.pr}: merge it to keep the change, or close it to decline. Rounds continue after that, with no spending while it waits.`];
  }
  if (!state.stopped) return ["**Status:** running"];
  const recent = state.rounds.slice(-goal.merge_rule.stall_rounds);
  if (recent.length > 0 && recent.every((r) => r.outcome === "failed")) {
    return [`**Status:** stopped: the last ${recent.length} rounds failed. Check the Actions log and the API key.`];
  }
  if (!isFinished(state.stopped)) return [`**Status:** stopped: ${state.stopped}.`];
  const merged = state.rounds.filter((r) => r.outcome === "merged");
  const reverted = state.rounds.filter((r) => r.outcome === "reverted").length;
  const gain = merged.length > 0
    ? ` Each beat the prompt before it head to head, on training and held-back scenarios.${reverted ? ` ${reverted} later turned out worse and ${reverted === 1 ? "was" : "were"} reverted.` : ""}` : "";
  const result = merged.length === 0
    ? "No rewrite won clearly enough to merge, so your prompt stays as it was."
    : `Merged ${merged.length} improvement${merged.length === 1 ? "" : "s"}.${gain}`;
  const lines = [`**Status:** finished. ${result}`, ""];
  if (/no winner$/.test(state.stopped)) {
    lines.push(
      `In the last ${goal.merge_rule.stall_rounds} rounds no rewrite won clearly enough to merge. Either the current prompt already handles these scenarios well, or the differences are too small for this many scenarios to show.`,
      state.round < goal.merge_rule.max_rounds
        ? `**To keep improving,** add more or harder scenarios to \`${goal.scenarios}\`, especially cases your agent still gets wrong. The next scheduled run picks them up and continues.`
        : `**To keep improving,** add more or harder scenarios to \`${goal.scenarios}\`, especially cases your agent still gets wrong, and raise \`merge_rule.max_rounds\` in \`synthe.json\`.`,
    );
  } else {
    lines.push(/^budget/.test(state.stopped) ? `It used its $${goal.budget.max_usd} budget.` : `It ran all ${goal.merge_rule.max_rounds} rounds.`);
  }
  return lines;
}

export function renderReport(goal: Goal, state: State): string {
  const money = state.spendUnknown ? `over $${state.spendUsd.toFixed(2)} (some costs unknown)` : `$${state.spendUsd.toFixed(2)}`;
  const merged = state.rounds.filter((r) => r.outcome === "merged");
  const proposed = state.rounds.filter((r) => r.outcome === "proposed" || r.outcome === "declined").length;
  const lines = [
    `**Goal:** ${goal.objective}`,
    "",
    ...status(goal, state),
    "",
    `**Rounds:** ${state.round} of up to ${goal.merge_rule.max_rounds}. **Merged:** ${merged.length}.${proposed ? ` **Proposed:** ${proposed}.` : ""} **Spent:** ${money} of $${goal.budget.max_usd}.`,
    "",
    "| Round | Result | Held-back head-to-head (50 = even) | Scenarios won / lost | PR | Cost | Why |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of [...state.rounds].reverse()) {
    const score = r.heldAfter !== undefined ? r.heldAfter.toFixed(1) : "";
    const split = r.wins !== undefined ? `${r.wins} / ${r.losses}` : "";
    const cost = r.costUsd === null ? "unknown"
      : `$${r.costUsd.toFixed(2)}${typeof r.writeUsd === "number" ? ` (writing $${r.writeUsd.toFixed(2)})` : ""}`;
    lines.push(`| ${r.round} | ${r.outcome} | ${score} | ${split} | ${r.pr ? `#${r.pr}` : ""} | ${cost} | ${r.reasons.join("; ").replaceAll("|", "/").slice(0, 200)} |`);
  }
  lines.push("", ...notTested(goal), "", "Only the prompt can change. Stop any time with `npx synthe stop`.");
  return lines.join("\n");
}
