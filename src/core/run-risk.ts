import type { Goal } from "./goal.ts";
import { signP } from "./merge-rule.ts";
import { heldBackLimit, plannedCandidates } from "./run-alpha.ts";

// The chance that a whole run merges at least one change that does nothing, under a model of independent duels
// (below), worked out exactly instead of simulated, so the report can show it for the team's own case counts at no
// cost. scripts/simulate-run.ts checks these numbers against whole runs simulated through the real trainingProblem
// and judgeRound.

// Tie rates the estimate is maximised over: how often a duel ties depends on the agent and the cases, and the
// chance a no-effect change passes moves with it, so the report quotes the worst of these.
export const TIE_RATES = Array.from({ length: 19 }, (_, i) => i * 0.05);

const logFactorials: number[] = [0];
function logFactorial(n: number): number {
  for (let k = logFactorials.length; k <= n; k++) logFactorials[k] = logFactorials[k - 1] + Math.log(k);
  return logFactorials[n];
}

// The chance that a change with no real effect passes one gate of n cases, for each tie rate: each duel ties with
// that chance and is otherwise a win or a loss with equal chance. Passing is what trainingProblem and judgeRound's
// held-back check ask: the change's mean (100 a win, 50 a tie, 0 a loss, against 50 for the current prompt) is
// ahead by at least minImprovement, and the sign test on wins and losses is at most limit. Both only get easier
// with more wins, so for each number of decided duels it is enough to find the fewest wins that pass.
export function gatePassChances(n: number, ties: number[], minImprovement: number, limit: number): number[] {
  if (n <= 0) return ties.map(() => 0);
  const passes = (wins: number, decided: number) =>
    // Integer sums divided once, as mean() does, so the boundary case falls the same way.
    (100 * wins + 50 * (n - decided)) / n >= 50 + minImprovement && signP(wins, decided - wins) <= limit;
  // tail[d]: the chance that d decided duels, each a fair coin, give a passing number of wins.
  const tail: number[] = [];
  for (let decided = 0; decided <= n; decided++) {
    let lo = 0, hi = decided + 1; // the fewest passing wins lies in [lo, hi]; hi = decided + 1 means none pass
    while (lo < hi) { const mid = (lo + hi) >> 1; if (passes(mid, decided)) hi = mid; else lo = mid + 1; }
    let t = 0;
    for (let wins = lo; wins <= decided; wins++) t += Math.exp(logFactorial(decided) - logFactorial(wins) - logFactorial(decided - wins) - decided * Math.LN2);
    tail.push(t);
  }
  return ties.map((tie) => {
    let total = 0;
    for (let decided = 0; decided <= n; decided++) {
      if (tail[decided] === 0) continue;
      const tied = n - decided;
      if ((tie === 0 && tied > 0) || (tie === 1 && decided > 0)) continue;
      total += tail[decided] * Math.exp(logFactorial(n) - logFactorial(decided) - logFactorial(tied)
        + (tied ? tied * Math.log(tie) : 0) + (decided ? decided * Math.log(1 - tie) : 0));
    }
    return Math.min(1, total);
  });
}

// One round's chance of merging a change that does nothing, when none of its candidates does anything: at least
// one candidate passes training, and then the leader passes the held-back cases, which are judged afresh.
export function roundFalseMergeChances(goal: Goal, train: number, holdout: number, ties: number[]): number[] {
  const { min_improvement, max_p } = goal.merge_rule;
  const candidates = plannedCandidates(goal);
  const trains = gatePassChances(train, ties, min_improvement, max_p);
  const holds = gatePassChances(holdout, ties, min_improvement, heldBackLimit(goal, candidates));
  return ties.map((_, i) => (1 - (1 - trains[i]) ** candidates) * holds[i]);
}

// nothingWorks: the chance a run merges at least one change that does nothing when none of the changes Synthe
// tries really helps. Such a run stops after stall_rounds rounds without a winner, so it has that many chances
// (exact, under the duel model above). anyRun: the most it can be in any run, which is when real gains keep
// resetting the stall count and the run uses all max_rounds rounds. Both are the worst over TIE_RATES.
export function runFalseMergeChance(goal: Goal, train: number, holdout: number): { nothingWorks: number; anyRun: number; tie: number } {
  const { max_rounds, stall_rounds } = goal.merge_rule;
  const rounds = roundFalseMergeChances(goal, train, holdout, TIE_RATES);
  const worst = rounds.reduce((w, m, i) => (m > rounds[w] ? i : w), 0);
  const m = rounds[worst];
  return { nothingWorks: 1 - (1 - m) ** Math.max(0, Math.min(stall_rounds, max_rounds)), anyRun: 1 - (1 - m) ** Math.max(0, max_rounds), tie: TIE_RATES[worst] };
}

const share = (x: number) => (x < 0.001 ? "under 0.1%" : `${(100 * x).toFixed(1)}%`);

// The report's line under "How Synthe decides", from the latest round's case counts. Nothing until a round has
// recorded them.
//
// The figures are estimates under the duel model at the top of this file, not a guarantee for the run, and the line
// says so. The model holds only while each test case is judged on its own, a change
// with no effect wins and loses equally often, and the held-back result does not depend on the training results or
// on earlier rounds. Three things are outside it, and the line names each one that applies:
// - a change that fits the training cases passes training by design, so only the held-back test stops it;
// - a shorter candidate (merge_rule.allow_shorter) is kept when it is no worse, a different test with a different
//   error, so merge_rule.run_alpha does not limit it;
// - compose can use this round's training results and population can use earlier rounds' results. Both can
//   build a candidate from the same cases it will be judged on.
export function runLuckLines(goal: Goal, rounds: { cases?: { train: number; holdout: number } }[]): string[] {
  const cases = [...rounds].reverse().find((r) => r.cases)?.cases;
  if (!cases) return [];
  const { nothingWorks, anyRun } = runFalseMergeChance(goal, cases.train, cases.holdout);
  const alpha = goal.merge_rule.run_alpha;
  const alphaPct = alpha === undefined ? "" : alpha < 0.0001 ? "under 0.01%" : `${+(100 * alpha).toFixed(2)}%`;
  const compose = goal.compose === true;
  const population = goal.population === true;
  return [[
    `- Luck across a whole run (model estimate), for your ${cases.train} learned-from and ${cases.holdout} hidden test cases.`,
    `The estimated upper rates for merging at least one change with no effect on any test case are ${share(nothingWorks)} when nothing Synthe tries really helps and ${share(anyRun)} across runs of up to ${goal.merge_rule.max_rounds} rounds.`,
    "The model assumes test-case results are independent and that a change with no effect wins and loses equally often.",
    "It treats candidate results as independent within and across rounds and assumes the hidden results are independent of the learned-from results.",
    "A change that genuinely improves only the learned-from cases falls outside this estimate.",
    ...(goal.merge_rule.allow_shorter === true ? ["Shorter rounds are not in the estimate: a shorter prompt is kept when it does no worse, which is a different test."] : []),
    ...(compose ? ["`compose` can build a candidate from this round's learned-from results."] : []),
    ...(population ? ["`population` can build a candidate from earlier rounds' learned-from results."] : []),
    ...(compose || population ? ["Reusing results this way can break the model's independence assumption."] : []),
    alpha === undefined
      ? "To target a lower estimate, set `merge_rule.run_alpha` in `synthe.json` (for example 0.05). A tighter threshold can also reject real improvements."
      : `Synthe uses \`merge_rule.run_alpha\` (${alphaPct}) as a target for this estimate and tightens the hidden-test threshold when needed.`,
  ].join(" ")];
}
