import type { Goal } from "../core/goal.ts";
import type { State } from "../core/state.ts";

export const ISSUE_TITLE = "Synthe: overnight prompt report";

export function renderReport(goal: Goal, state: State): string {
  const money = state.spendUnknown ? `over $${state.spendUsd.toFixed(2)} (some costs unknown)` : `$${state.spendUsd.toFixed(2)}`;
  const merged = state.rounds.filter((r) => r.outcome === "merged");
  const lines = [
    `**Goal:** ${goal.objective}`,
    "",
    state.stopped ? `**Status:** stopped: ${state.stopped}` : "**Status:** running",
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
