import { DEFAULTS, type Goal } from "./goal.ts";

// merge_rule.run_alpha: an opt-in cap on the chance that a whole run merges at least one change that does nothing.
// Each comparison is strict on its own, but a run makes many of them, and unset this file changes nothing.

// One candidate per writing angle in write.ts, plus the composed one when compose is on. The count is the planned
// one, not how many happened to be scored: compose only writes its candidate after seeing the others' training
// results, so a limit that loosened when compose came up empty would let a round spend more than its share.
// A round that somehow scores more than planned uses its real count, so the cap can only get stricter.
export const WRITTEN_PER_ROUND = 2;
export function plannedCandidates(goal: Goal, scored = 0): number {
  return Math.max(WRITTEN_PER_ROUND + (goal.compose === true ? 1 : 0), scored);
}

// The sign-test limit for the held-back cases this round. With run_alpha unset it is holdout_max_p, as before.
//
// With run_alpha set, only this limit tightens, not max_p on the training cases. A change that does nothing has to
// pass two independent tests to merge: the training test, which each of the round's candidates passes by luck
// with chance at most max_p, and then the held-back test, which only the round's best training passer takes, on
// cases the training never saw. So a round merges a no-effect change with chance at most
// candidates x max_p x limit, and a run of max_rounds rounds at most max_rounds times that. A limit of
// run_alpha / (max_rounds x candidates x max_p) caps the run at run_alpha.
//
// Plain Bonferroni on both tests (each at run_alpha / (max_rounds x candidates), 0.002 for run_alpha 0.05) would
// also be correct, but it caps the run near run_alpha x holdout_max_p, far below what was asked. In
// scripts/simulate-run.ts a real gain (two wins for every loss) then merged in 0.6% of the rounds that tried one
// with 60 training cases, and almost never with fewer, against 17% under this limit.
//
// The bound assumes what the sign test already assumes: each case's duel is judged on its own, and training and
// held-back cases are different cases. It covers one run of max_rounds rounds; restarting after raising
// max_rounds gives the new rounds a share of a new budget.
export function heldBackLimit(goal: Goal, candidates: number): number {
  const base = goal.merge_rule.holdout_max_p ?? DEFAULTS.merge_rule.holdout_max_p;
  const runAlpha = goal.merge_rule.run_alpha;
  if (runAlpha === undefined) return base;
  const trainingLuck = Math.min(1, Math.max(1, candidates) * goal.merge_rule.max_p);
  return Math.min(base, runAlpha / (Math.max(1, goal.merge_rule.max_rounds) * trainingLuck));
}
