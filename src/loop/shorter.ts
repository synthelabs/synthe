// Shorter rounds (merge_rule.allow_shorter, off by default). Kept changes pile up, so without this a prompt only
// grows. On a shorter round, the writer is asked to fill one of the round's slots with a deletion: removing or
// tightening one instruction. If the result removes enough it is marked kind "shorter", and the merge rule keeps it
// if it is no worse (src/core/non-inferiority.ts) and passes every other gate unchanged. If not, it is an ordinary
// candidate, judged by the usual rule.
import type { Goal } from "../core/goal.ts";
import type { State } from "../core/state.ts";
import type { Candidate } from "./write.ts";

// A shorter candidate takes a slot from the improving ones, so it is only tried once the run has stalled: when the
// last round found nothing better, the improving angles are at their least productive, and a run that is about to
// stop at stall_rounds gets one more kind of progress. A run that keeps finding wins keeps both slots for them.
// (Every Nth round would spend the slot even mid-streak, when improvements are landing.)
export const SHORTER_AFTER_STALLS = 1;

// A deletion has to be worth a pull request: at least 5% of the prompt or 200 characters, whichever is smaller.
// 5% keeps a short prompt from trading a word at a time; 200 characters caps what a long prompt has to give up.
export const SHORTER_MIN_SHARE = 0.05;
export const SHORTER_MIN_CHARS = 200;

export const shorterRound = (goal: Goal, state: State) => goal.merge_rule.allow_shorter === true && state.stalls >= SHORTER_AFTER_STALLS;

const size = (t: string) => t.trim().length;
export const minShorterBy = (prompt: string) => Math.max(1, Math.min(Math.ceil(size(prompt) * SHORTER_MIN_SHARE), SHORTER_MIN_CHARS));

// Why a candidate marked shorter isn't shorter enough to be judged as one, or null.
export function shorterProblem(before: string, after: string): string | null {
  const need = minShorterBy(before);
  const removed = size(before) - size(after);
  if (removed < need) return `a shorter candidate must remove at least ${need} characters, and this one ${removed <= 0 ? `adds ${-removed}` : `removes ${removed}`}`;
  return null;
}

// The writer's instruction for the deletion slot.
export const shorterAngle = (prompt: string) =>
  `Make the prompt shorter without making replies worse: delete or tighten one instruction that is redundant, repeats another, or isn't needed by any of the situations below. Use deletions or shorter wording only, add nothing new, and remove at least ${minShorterBy(prompt)} characters in total.`;

// The fields the score step copies onto a shorter candidate's scores, so the merge rule knows its kind and the
// report can say how much it removed.
export function shorterFields(c: Candidate, baseline: string): { kind?: "shorter"; chars?: { before: number; after: number } } {
  return c.kind === "shorter" ? { kind: "shorter", chars: { before: size(baseline), after: size(c.text) } } : {};
}
