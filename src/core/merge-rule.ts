import type { Goal } from "./goal.ts";

// One scenario's result. A null score means it could not be measured.
export interface ScoreRow { id: string; score: number | null; violation: boolean | null }

export interface CandidateScore { id: string; train: ScoreRow[]; holdout?: ScoreRow[] }

export interface RoundScores {
  baselineHash: string;
  baselineTrain: ScoreRow[];
  baselineHoldout: ScoreRow[];
  candidates: CandidateScore[];
}

export type Verdict =
  | { action: "merge"; candidateId: string; before: number; after: number; heldBefore: number; heldAfter: number; wins: number; losses: number; reasons: string[] }
  | { action: "revert"; reasons: string[] }
  | { action: "skip"; reasons: string[] };

// An unknown is never zero: one unmeasured row makes the whole mean unknown.
export function mean(rows: ScoreRow[]): number | null {
  if (rows.length === 0 || rows.some((r) => r.score === null || !Number.isFinite(r.score))) return null;
  return rows.reduce((sum, r) => sum + (r.score as number), 0) / rows.length;
}

// One-sided exact sign test: the chance of a split this lopsided if neither prompt is better. Ties don't count.
export function signP(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  let tail = 0;
  let ways = 1;
  for (let i = 0; i <= losses; i++) {
    tail += ways;
    ways = (ways * (n - i)) / (i + 1);
  }
  return Math.min(1, tail / 2 ** n);
}

// Compares two prompts scenario by scenario. Null if any scenario can't be paired, so an unknown never counts as a win.
export function paired(after: ScoreRow[], before: ScoreRow[]) {
  const scores = new Map(before.map((r) => [r.id, r.score]));
  if (after.length === 0 || after.length !== before.length || new Set(after.map((r) => r.id)).size !== after.length) return null;
  let wins = 0;
  let losses = 0;
  for (const r of after) {
    const other = scores.get(r.id);
    if (typeof other !== "number" || !Number.isFinite(other) || typeof r.score !== "number" || !Number.isFinite(r.score)) return null;
    if (r.score > other) wins++;
    else if (r.score < other) losses++;
  }
  return { wins, losses, p: signP(wins, losses) };
}

// Points of noise in one score, from the same prompt scored twice.
export function noisePoints(first: ScoreRow[], second: ScoreRow[]): number | null {
  if (paired(first, second) === null) return null;
  const other = new Map(second.map((r) => [r.id, r.score as number]));
  const gaps = first.map((r) => (r.score as number) - other.get(r.id)!);
  const average = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  return Math.sqrt(gaps.reduce((sum, g) => sum + (g - average) ** 2, 0) / gaps.length / 2);
}

const violated = (rows: ScoreRow[]) => rows.some((r) => r.violation !== false);

// replaced holds the scores of the prompt the last merge replaced, or null when there is nothing to check.
export function judgeRound(scores: RoundScores, goal: Goal, replaced: ScoreRow[] | null): Verdict {
  const { min_improvement, noise_margin, max_p } = goal.merge_rule;
  const before = mean(scores.baselineTrain);
  const beforeHoldout = mean(scores.baselineHoldout);
  if (before === null || beforeHoldout === null) return { action: "skip", reasons: ["baseline score unknown"] };

  // The best of three candidates reads high, so a revert compares against what the merge replaced, not its own score.
  if (replaced !== null) {
    const now = [...scores.baselineTrain, ...scores.baselineHoldout];
    const was = mean(replaced);
    const is = mean(now);
    const worse = paired(replaced, now);
    if (was !== null && is !== null && worse !== null && is < was - noise_margin && worse.p <= max_p) {
      return {
        action: "revert",
        reasons: [`now ${is.toFixed(1)}, below the ${was.toFixed(1)} of the prompt it replaced; worse on ${worse.wins} scenarios, better on ${worse.losses}`],
      };
    }
  }

  const reasons: string[] = [];
  let best: Extract<Verdict, { action: "merge" }> | null = null;
  for (const c of scores.candidates) {
    const after = mean(c.train);
    if (after === null) { reasons.push(`${c.id}: training score unknown`); continue; }
    if (after < before + min_improvement) { reasons.push(`${c.id}: ${after.toFixed(1)} did not beat ${before.toFixed(1)} by ${min_improvement}`); continue; }
    const split = paired(c.train, scores.baselineTrain);
    if (split === null) { reasons.push(`${c.id}: scenarios could not be compared`); continue; }
    if (split.p > max_p) { reasons.push(`${c.id}: won ${split.wins} and lost ${split.losses} scenarios, which could be noise`); continue; }
    if (!c.holdout) { reasons.push(`${c.id}: not held-back tested`); continue; }
    const held = mean(c.holdout);
    if (held === null) { reasons.push(`${c.id}: held-back score unknown`); continue; }
    if (held < beforeHoldout + min_improvement) { reasons.push(`${c.id}: did not gain ${min_improvement} on held-back scenarios, ${held.toFixed(1)} vs ${beforeHoldout.toFixed(1)}`); continue; }
    if (violated(c.train) || violated(c.holdout)) { reasons.push(`${c.id}: guardrail failed or unknown`); continue; }
    if (best === null || after > best.after) {
      best = {
        action: "merge", candidateId: c.id, before, after, heldBefore: beforeHoldout, heldAfter: held, wins: split.wins, losses: split.losses,
        reasons: [`${beforeHoldout.toFixed(1)} to ${held.toFixed(1)} held back, ${before.toFixed(1)} to ${after.toFixed(1)} on training; won ${split.wins} and lost ${split.losses} training scenarios`],
      };
    }
  }
  return best ?? { action: "skip", reasons: reasons.length ? reasons : ["no candidates"] };
}
