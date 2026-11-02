import type { Goal } from "./goal.ts";

// One scenario's result. A null score means it could not be measured.
// reply is kept only for the current prompt's training rows, so the next writer can study what went wrong.
export interface ScoreRow { id: string; score: number | null; violation: boolean | null; reply?: string }

export interface CandidateScore { id: string; train: ScoreRow[]; holdout?: ScoreRow[] }

export interface RoundScores {
  baselineHash: string;
  baselineTrain: ScoreRow[];
  baselineHoldout: ScoreRow[];
  candidates: CandidateScore[];
  // The prompt the last merge replaced, challenging the current one head to head, when that merge is still live.
  prior?: ScoreRow[];
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

// Never add a guardrail break: a candidate may still break a guardrail only on a scenario where the current prompt
// already breaks it, so a merge is never less safe than what it replaces, and a prompt that already breaks
// guardrails can be fixed a step at a time. Unknown counts as broken on the candidate's side.
const addedBreaks = (rows: ScoreRow[], current: ScoreRow[]) => {
  const before = new Map(current.map((r) => [r.id, r.violation]));
  return rows.filter((r) => r.violation === null || (r.violation === true && before.get(r.id) !== true)).length;
};
const breaks = (rows: ScoreRow[]) => rows.filter((r) => r.violation === true).length;

// Why a candidate fails on the training scenarios, or null if it passes. Scoring uses this to pick which
// candidate earns the held-back test, and judgeRound uses it again, so the two can never disagree.
export function trainingProblem(c: CandidateScore, baselineTrain: ScoreRow[], goal: Goal): string | null {
  const { min_improvement, max_p } = goal.merge_rule;
  const before = mean(baselineTrain);
  if (before === null) return "baseline score unknown";
  const after = mean(c.train);
  if (after === null) return `${c.id}: training score unknown`;
  if (after < before + min_improvement) return `${c.id}: head-to-head ${after.toFixed(1)}, needs ${(before + min_improvement).toFixed(1)} (${before.toFixed(0)} is even)`;
  const split = paired(c.train, baselineTrain);
  if (split === null) return `${c.id}: scenarios could not be compared`;
  if (split.p > max_p) return `${c.id}: won ${split.wins} and lost ${split.losses} scenarios, which could be noise`;
  return null;
}

// replaced holds the head-to-head rows of the prompt the last merge replaced against the current prompt, or null
// when there is nothing to check. It reverts only when that older prompt now wins clearly.
export function judgeRound(scores: RoundScores, goal: Goal, replaced: ScoreRow[] | null): Verdict {
  const { min_improvement, noise_margin, max_p } = goal.merge_rule;
  const before = mean(scores.baselineTrain);
  const beforeHoldout = mean(scores.baselineHoldout);
  if (before === null || beforeHoldout === null) return { action: "skip", reasons: ["baseline score unknown"] };

  if (replaced !== null) {
    const now = [...scores.baselineTrain, ...scores.baselineHoldout];
    const was = mean(replaced);
    const is = mean(now);
    const worse = paired(replaced, now);
    if (was !== null && is !== null && worse !== null && is < was - noise_margin && worse.p <= max_p) {
      return {
        action: "revert",
        reasons: [`the prompt it replaced now wins head to head, ${was.toFixed(1)} to ${is.toFixed(1)}: better on ${worse.wins} scenarios, worse on ${worse.losses}`],
      };
    }
  }

  const reasons: string[] = [];
  let best: Extract<Verdict, { action: "merge" }> | null = null;
  for (const c of scores.candidates) {
    const problem = trainingProblem(c, scores.baselineTrain, goal);
    if (problem) { reasons.push(problem); continue; }
    const after = mean(c.train)!;
    const split = paired(c.train, scores.baselineTrain)!;
    if (!c.holdout) { reasons.push(`${c.id}: not held-back tested`); continue; }
    const held = mean(c.holdout);
    if (held === null) { reasons.push(`${c.id}: held-back score unknown`); continue; }
    if (held < beforeHoldout + min_improvement) { reasons.push(`${c.id}: did not gain ${min_improvement} on held-back scenarios, ${held.toFixed(1)} vs ${beforeHoldout.toFixed(1)}`); continue; }
    if (addedBreaks(c.train, scores.baselineTrain) + addedBreaks(c.holdout, scores.baselineHoldout) > 0) {
      reasons.push(`${c.id}: breaks a guardrail where the current prompt keeps it, or couldn't be checked`);
      continue;
    }
    const stillBroken = breaks(c.train) + breaks(c.holdout);
    const wasBroken = breaks(scores.baselineTrain) + breaks(scores.baselineHoldout.filter((r) => c.holdout!.some((h) => h.id === r.id)));
    if (best === null || after > best.after) {
      best = {
        action: "merge", candidateId: c.id, before, after, heldBefore: beforeHoldout, heldAfter: held, wins: split.wins, losses: split.losses,
        reasons: [`head-to-head ${held.toFixed(1)} held back and ${after.toFixed(1)} on training, where ${before.toFixed(0)} is even; won ${split.wins} and lost ${split.losses} training scenarios${stillBroken > 0 ? `; still breaks a guardrail on ${stillBroken} scenario${stillBroken === 1 ? "" : "s"}, down from ${wasBroken}` : ""}`],
      };
    }
  }
  return best ?? { action: "skip", reasons: reasons.length ? reasons : ["no candidates"] };
}
