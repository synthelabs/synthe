import { DEFAULTS, type Goal } from "./goal.ts";

// merge_rule.run_alpha: an opt-in limit on the estimated chance that a whole run merges at least one change that does
// nothing. It is an estimate under the assumptions at the end of the next comment, not a guarantee for the run.
// Each comparison is strict on its own, but a run makes many of them, and unset this file changes nothing.

// One candidate per writing angle in write.ts, plus one more when compose or population is on: the composed one, or
// the pool's combined one (src/loop/pool.ts). Never both, since compose sits out a round where the pool added its
// candidate. The count is the planned one, not how many happened to be scored: compose only writes its candidate
// after seeing the others' training results, and the pool has nothing to combine in some rounds, so a limit that
// loosened when either came up empty would let a round spend more than its share.
// A round that somehow scores more than planned uses its real count, so the cap can only get stricter.
export const WRITTEN_PER_ROUND = 2;
export function plannedCandidates(goal: Goal, scored = 0): number {
  return Math.max(WRITTEN_PER_ROUND + (goal.compose === true || goal.population === true ? 1 : 0), scored);
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
//
// It is not proved for three cases, and the report line (runLuckLines in run-risk.ts) says so:
// - A change that fits the training cases passes the training test by design, not by luck. Only the held-back test
//   stops it, at this limit in each round, so the run is not held to run_alpha for such changes.
// - Compose can use this round's training results and population can use earlier rounds' results. The calculation
//   treats these candidates' training results as independent even when they reuse the same cases.
// - A shorter candidate (merge_rule.allow_shorter) takes the no-worse test at this limit. A shorter prompt that
//   changes nothing is meant to pass that test, so run_alpha does not limit shorter rounds.
// The bound also needs the held-back test of the round's leader to stay valid given the training results and what
// earlier rounds showed. That is not established. A limit of run_alpha / max_rounds would not need the training
// test at all; with simulateRuns (scripts/simulate-run.ts) at 40 cases a side it merged about a third as many real
// gains as this limit (8% against 24%).
export function heldBackLimit(goal: Goal, candidates: number): number {
  const base = goal.merge_rule.holdout_max_p ?? DEFAULTS.merge_rule.holdout_max_p;
  const runAlpha = goal.merge_rule.run_alpha;
  if (runAlpha === undefined) return base;
  const trainingLuck = Math.min(1, Math.max(1, candidates) * goal.merge_rule.max_p);
  return Math.min(base, runAlpha / (Math.max(1, goal.merge_rule.max_rounds) * trainingLuck));
}
