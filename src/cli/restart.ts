import type { Goal } from "../core/goal.ts";
import { isFinished, resumeIfScenariosChanged, type State } from "../core/state.ts";

// What `npx synthe restart` may change. A stop that needed a person (a GitHub setting, a key, a prompt Synthe
// couldn't find) is cleared, so the run continues once they've fixed it. A finished run isn't: its rounds, budget
// or ideas ran out, and starting again wouldn't change that.
// scenariosHash is the test-case file as it is on this computer: new cases after a stall are a reason to go on.
export function restartState(goal: Goal, state: State, scenariosHash: string | null = null): { state: State; note: string } | { why: string } {
  const stopped = state.stopped;
  if (!stopped) return { state, note: "" };
  if (scenariosHash !== null) {
    const next = { ...state };
    if (resumeIfScenariosChanged(next, scenariosHash)) return { state: next, note: "Your test cases changed, so it continues." };
  }
  if (state.spendUnknown) return { why: "Synthe couldn't measure what a round cost, so it won't spend any more on this run." };
  const recent = state.rounds.slice(-goal.merge_rule.stall_rounds);
  // Rounds that all failed (a key that stopped working) also count as stalls, so they read as a finished run.
  const failedOut = recent.length > 0 && recent.every((r) => r.outcome === "failed");
  const roundsRaised = /^reached \d+ rounds$/.test(stopped) && state.round < goal.merge_rule.max_rounds;
  if (isFinished(stopped) && !failedOut && !roundsRaised) {
    if (/no winner$/.test(stopped)) return { why: `The last ${goal.merge_rule.stall_rounds} rounds found nothing clearly better. To keep going, add test cases your agent still gets wrong to ${goal.scenarios}, push them, then run \`npx synthe restart\` again.` };
    if (/^budget/.test(stopped)) return { why: `Synthe has used its whole $${goal.budget.max_usd} budget, so this run is finished.` };
    return { why: `Synthe ran all ${goal.merge_rule.max_rounds} rounds. To run more, raise merge_rule.max_rounds in synthe.json, push it, then run npx synthe restart again.` };
  }
  return { state: { ...state, stopped: null, stalls: 0 }, note: stopped === "credit" ? "It had stopped on event credit." : `It had stopped because: ${stopped}.` };
}
