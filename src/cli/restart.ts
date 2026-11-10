import type { Goal } from "../core/goal.ts";
import { budgetSpend, isFinished, resumeIfScenariosChanged, type State } from "../core/state.ts";

// What `npx synthe restart` may change. A stop that needed a person (a GitHub setting, a key, a prompt Synthe
// couldn't find) is cleared, so the run continues once they've fixed it. A finished run isn't: its rounds, budget
// or ideas ran out, and starting again wouldn't change that.
// scenariosHash is the test-case file as it is on this computer: new cases after a stall are a reason to go on.
export function restartState(goal: Goal, state: State, scenariosHash: string | null = null): { state: State; note: string } | { why: string } {
  const stopped = state.stopped;
  if (!stopped) return { state, note: "" };
  // Clearing a stop with no rounds left would only stop again at the next round, whatever had stopped it.
  // That includes "reached N rounds" when the last round also failed on a key or code: fixing the code isn't enough.
  const noRoundsLeft = state.round < goal.merge_rule.max_rounds ? null
    : /^reached \d+ rounds$/.test(stopped)
      ? { why: `Synthe ran all ${goal.merge_rule.max_rounds} rounds. To run more, raise merge_rule.max_rounds in synthe.json, push it, then run npx synthe restart again.` }
      : { why: `Synthe has also run all ${goal.merge_rule.max_rounds} rounds. Raise merge_rule.max_rounds in synthe.json, push it, then run \`npx synthe restart\` again; otherwise it would stop again straight away.` };
  if (scenariosHash !== null) {
    const next = { ...state };
    if (resumeIfScenariosChanged(next, scenariosHash)) return noRoundsLeft ?? { state: next, note: "Your test cases changed, so it continues." };
  }
  if (state.spendUnknown) return { why: "Synthe couldn't measure what a round cost, so it won't spend any more on this run." };
  const recent = state.rounds.slice(-goal.merge_rule.stall_rounds);
  // Rounds that failed on a key or a refused code also count as stalls. When the latest one did, the stop clears once
  // the team fixes it, even if earlier rounds in the stall were ordinary no-wins: the report tells them to.
  const last = state.rounds.at(-1);
  const failedOut = recent.length > 0 && (recent.every((r) => r.outcome === "failed") || (last?.outcome === "failed" && last.failure === "key"));
  const roundsRaised = /^reached \d+ rounds$/.test(stopped) && state.round < goal.merge_rule.max_rounds;
  const budgetAvailable = /^budget/.test(stopped) && budgetSpend(state) < goal.budget.max_usd;
  if (isFinished(stopped) && (!failedOut || /^budget/.test(stopped)) && !roundsRaised && !budgetAvailable) {
    if (/no winner$/.test(stopped)) return { why: `The last ${goal.merge_rule.stall_rounds} rounds found nothing clearly better. To keep going, add test cases your agent still gets wrong to ${goal.scenarios}, push them, then run \`npx synthe restart\` again.` };
    if (/^budget/.test(stopped)) return { why: `Synthe has used its whole $${goal.budget.max_usd} budget. ${state.ownKeyFromUsd === undefined ? "Run \`npx synthe key\` for a fresh own-key budget, or raise" : "Raise"} budget.max_usd in synthe.json${state.round >= goal.merge_rule.max_rounds ? ` (and merge_rule.max_rounds: all ${goal.merge_rule.max_rounds} rounds have run)` : ""} and push it, then run \`npx synthe restart\`.` };
    return { why: `Synthe ran all ${goal.merge_rule.max_rounds} rounds. To run more, raise merge_rule.max_rounds in synthe.json, push it, then run npx synthe restart again.` };
  }
  if (noRoundsLeft) return noRoundsLeft;
  return { state: { ...state, stopped: null, stalls: 0 }, note: stopped === "credit" ? "It had stopped on event credit." : `It had stopped because: ${stopped}.` };
}
