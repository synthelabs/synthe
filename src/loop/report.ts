import type { Goal } from "../core/goal.ts";
import { isFinished, type State } from "../core/state.ts";

export const ISSUE_TITLE = "Synthe: overnight prompt report";

// What the run did, said as an outcome: a run that ran out of ideas is done, not broken.
function status(goal: Goal, state: State): string[] {
  if (!state.stopped) return ["**Status:** running"];
  const recent = state.rounds.slice(-goal.merge_rule.stall_rounds);
  if (recent.length > 0 && recent.every((r) => r.outcome === "failed")) {
    return [`**Status:** stopped: the last ${recent.length} rounds failed. Check the Actions log and the API key.`];
  }
  if (!isFinished(state.stopped)) return [`**Status:** stopped: ${state.stopped}.`];
  const merged = state.rounds.filter((r) => r.outcome === "merged");
  const reverted = state.rounds.some((r) => r.outcome === "reverted");
  const first = merged[0];
  const last = merged.at(-1);
  const gain = first && last && !reverted && first.heldBefore !== undefined && last.heldAfter !== undefined
    ? ` Held-back score went from ${first.heldBefore.toFixed(1)} to ${last.heldAfter.toFixed(1)}.` : "";
  const result = merged.length === 0
    ? "No rewrite beat your prompt, so it stays as it was."
    : `Merged ${merged.length} improvement${merged.length === 1 ? "" : "s"}.${gain}`;
  const lines = [`**Status:** finished. ${result}`, ""];
  if (/no winner$/.test(state.stopped)) {
    lines.push(
      `In the last ${goal.merge_rule.stall_rounds} rounds no rewrite beat the current prompt by ${goal.merge_rule.min_improvement} points, so it is close to the best these scenarios can measure.`,
      state.round < goal.merge_rule.max_rounds
        ? `**To keep improving,** add harder scenarios to \`${goal.scenarios}\`, especially cases your agent still gets wrong. The next scheduled run picks them up and continues.`
        : `**To keep improving,** add harder scenarios to \`${goal.scenarios}\`, especially cases your agent still gets wrong, and raise \`merge_rule.max_rounds\` in \`synthe.json\`.`,
    );
  } else {
    lines.push(/^budget/.test(state.stopped) ? `It used its $${goal.budget.max_usd} budget.` : `It ran all ${goal.merge_rule.max_rounds} rounds.`);
  }
  return lines;
}

export function renderReport(goal: Goal, state: State): string {
  const money = state.spendUnknown ? `over $${state.spendUsd.toFixed(2)} (some costs unknown)` : `$${state.spendUsd.toFixed(2)}`;
  const merged = state.rounds.filter((r) => r.outcome === "merged");
  const lines = [
    `**Goal:** ${goal.objective}`,
    "",
    ...status(goal, state),
    "",
    `**Rounds:** ${state.round} of up to ${goal.merge_rule.max_rounds}. **Merged:** ${merged.length}. **Spent:** ${money} of $${goal.budget.max_usd}.`,
    "",
    "| Round | Result | Held-back score | Scenarios won / lost | PR | Why |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of [...state.rounds].reverse()) {
    const score = r.heldAfter !== undefined ? `${r.heldBefore?.toFixed(1)} to ${r.heldAfter.toFixed(1)}` : "";
    const split = r.wins !== undefined ? `${r.wins} / ${r.losses}` : "";
    lines.push(`| ${r.round} | ${r.outcome} | ${score} | ${split} | ${r.pr ? `#${r.pr}` : ""} | ${r.reasons.join("; ").replaceAll("|", "/").slice(0, 200)} |`);
  }
  lines.push("", "Scores come from simulated scenarios, not live traffic, and generated scenarios aren't reviewed by a person. Only the prompt can change. Stop any time with `npx synthe stop`.");
  return lines.join("\n");
}
