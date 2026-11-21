import type { Goal } from "./goal.ts";
import { signP } from "./merge-rule.ts";

// The fewest wins out of `decided` cases (ties don't count) whose sign test passes at maxP, or null when
// even winning every case can't pass. Reuses signP so this can never disagree with the merge rule.
export function minWinsToPass(decided: number, maxP: number): number | null {
  for (let w = 0; w <= decided; w++) if (signP(w, decided - w) <= maxP) return w;
  return null;
}

// How many cases a 60/40 split (3 wins for every 2 losses) needs to pass at maxP, or null if it never does within a sane size.
function casesForSixtyForty(maxP: number): number | null {
  for (let n = 1; n <= 2000; n++) {
    const wins = Math.ceil(0.6 * n);
    if (signP(wins, n - wins) <= maxP) return n;
  }
  return null;
}

// Plain sentences telling a team the smallest gain their test cases can detect, and what to do about it.
// Describes the existing merge rule; it changes no threshold.
export function powerLines(goal: Goal, trainCount: number, holdoutCount: number): string[] {
  const { max_p, holdout_max_p } = goal.merge_rule;
  const lines: string[] = [];
  const need = minWinsToPass(trainCount, max_p);
  if (need === null) {
    lines.push(`With ${trainCount} training cases, no change can pass: even better in every one isn't enough to rule out luck.`);
  } else {
    lines.push(`With ${trainCount} training cases, a change must be better in at least ${need} and worse in at most ${trainCount - need} (ties don't count) to pass.`);
  }
  const heldNeed = minWinsToPass(holdoutCount, holdout_max_p);
  lines.push(heldNeed === null
    ? `With ${holdoutCount} held-back cases, no change can pass the held-back check.`
    : `With ${holdoutCount} held-back cases, at least ${heldNeed} of ${holdoutCount}.`);
  const target = casesForSixtyForty(max_p);
  if (target !== null && target > trainCount) {
    lines.push(`Adding about ${target - trainCount} more cases your agent gets wrong lets a smaller real gain pass (a change better in 6 of every 10 decided cases passes at ${target}).`);
  } else if (target !== null) {
    lines.push("You have enough training cases for a change that is better in 6 of every 10 decided cases to pass; harder cases still help, because easy ones end in ties.");
  }
  return lines;
}
