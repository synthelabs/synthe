import type { Goal } from "../core/goal.ts";
import type { State } from "../core/state.ts";
import { renderDeltaBlock } from "../loop/delta.ts";

// What `npx synthe changes` says until the first round finishes: there is no score to draw yet,
// and a plain sentence is better than an invented graph. main.ts prints this too when the state
// file isn't on the state branch yet, which means the same thing: no round has finished.
export const NO_ROUNDS_YET = "No rounds have run yet. The score graph will appear after the first round.";

// The text of `npx synthe changes`: the delta block the rounds recorded, exactly as written, so a
// coding agent can show it to the person word for word. Reading state is all this does; it never
// calls a model and changes nothing.
export function changesText(goal: Goal, state: State): string {
  return state.rounds.length ? renderDeltaBlock(goal, state) : NO_ROUNDS_YET;
}
