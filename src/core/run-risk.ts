import type { Goal } from "./goal.ts";
import { signP } from "./merge-rule.ts";
import { heldBackLimit, plannedCandidates } from "./run-alpha.ts";

// The chance that a whole run merges at least one change that does nothing, worked out exactly instead of
// simulated, so the report can show it for the team's own case counts at no cost. scripts/simulate-run.ts checks
// these numbers against whole runs simulated through the real trainingProblem and judgeRound.

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
export function runLuckLines(goal: Goal, rounds: { cases?: { train: number; holdout: number } }[]): string[] {
  const cases = [...rounds].reverse().find((r) => r.cases)?.cases;
  if (!cases) return [];
  const { nothingWorks, anyRun } = runFalseMergeChance(goal, cases.train, cases.holdout);
  const alpha = goal.merge_rule.run_alpha;
  return [`- Luck across a whole run: with your ${cases.train} learned-from and ${cases.holdout} hidden test cases, the chance that a run merges a change that does nothing is at most ${share(nothingWorks)} when nothing Synthe tries really helps, and at most ${share(anyRun)} in any run of up to ${goal.merge_rule.max_rounds} rounds.${alpha === undefined
    ? " To cap it lower, set `merge_rule.run_alpha` in `synthe.json` (for example 0.05); real improvements then merge less often too."
    : ` \`merge_rule.run_alpha\` caps it at ${+(100 * alpha).toFixed(2)}%.`}`];
}
