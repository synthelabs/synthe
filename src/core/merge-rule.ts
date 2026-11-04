import type { Goal } from "./goal.ts";

// One scenario's result. A null score means it could not be measured.
// reply is kept only for the current prompt's training rows, so the next writer can study what went wrong.
// failed and applicable count the team's checks on this reply; failedChecks names them for the next writer.
// guardFailed and guardApplicable count the team's guards the same way. Guards are measured, never used to score.
export interface ScoreRow { id: string; score: number | null; violation: boolean | null; reply?: string; failed?: number; applicable?: number; failedChecks?: string[]; guardFailed?: number; guardApplicable?: number }

// The share of the team's checks the replies passed, as a whole percentage, or null when no check applied or a reply
// wasn't checked. The same rows must be compared on both sides.
export function checkRate(rows: ScoreRow[]): number | null {
  if (rows.length === 0 || rows.some((r) => typeof r.applicable !== "number" || typeof r.failed !== "number")) return null;
  const applicable = rows.reduce((n, r) => n + r.applicable!, 0);
  return applicable === 0 ? null : Math.round((100 * (applicable - rows.reduce((n, r) => n + r.failed!, 0))) / applicable);
}

// The same measure for the team's guards: the share they passed, or null when none applied or a reply wasn't checked.
export function guardRate(rows: ScoreRow[]): number | null {
  if (rows.length === 0 || rows.some((r) => typeof r.guardApplicable !== "number" || typeof r.guardFailed !== "number")) return null;
  const applicable = rows.reduce((n, r) => n + r.guardApplicable!, 0);
  return applicable === 0 ? null : Math.round((100 * (applicable - rows.reduce((n, r) => n + r.guardFailed!, 0))) / applicable);
}

// "Your guards held at 94%, down from 96%." in the report, wherever guard numbers are shown.
export function guardSentence(g: { before: number; after: number }): string {
  if (g.after > g.before) return `Your guards improved from ${g.before}% to ${g.after}%.`;
  if (g.after === g.before) return `Your guards held at ${g.after}%.`;
  return `Your guards held at ${g.after}%, down from ${g.before}%.`;
}

export interface CandidateScore { id: string; train: ScoreRow[]; holdout?: ScoreRow[] }

export interface RoundScores {
  baselineHash: string;
  baselineTrain: ScoreRow[];
  baselineHoldout: ScoreRow[];
  candidates: CandidateScore[];
  // The prompt the last merge replaced, challenging the current one head to head, when that merge is still live.
  prior?: ScoreRow[];
}

// reasons are technical, for logs and receipts. plain and notes say the same for the team, in everyday words:
// plain explains the decision, notes says what happened to each candidate.
export type Verdict =
  | { action: "merge"; candidateId: string; before: number; after: number; heldBefore: number; heldAfter: number; wins: number; losses: number; heldWins: number; heldLosses: number; checks?: { before: number; after: number }; guards?: { before: number; after: number }; reasons: string[]; plain: string; notes: Record<string, string> }
  | { action: "revert"; reasons: string[]; plain: string; notes: Record<string, string> }
  | { action: "skip"; reasons: string[]; notes: Record<string, string> };

const cases = (n: number) => `${n} case${n === 1 ? "" : "s"}`;
// Wins, losses and ties of a candidate against the current prompt, for plain sentences.
function tally(rows: ScoreRow[], current: ScoreRow[]) {
  const split = paired(rows, current);
  return split ? { w: split.wins, l: split.losses, t: rows.length - split.wins - split.losses } : null;
}

// The same verdict as trainingProblem, in words a team understands.
function trainingNote(c: CandidateScore, current: ScoreRow[], goal: Goal): string {
  const t = tally(c.train, current);
  if (mean(c.train) === null || !t) return "Some replies couldn't be judged, so it wasn't used.";
  if (mean(c.train)! < mean(current)! + goal.merge_rule.min_improvement) {
    return `Not clearly better: better in ${cases(t.w)}, worse in ${t.l}, the same in ${t.t}.`;
  }
  return `Not clearly better: better in ${cases(t.w)} and worse in ${t.l}, which could be luck.`;
}

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
  if (after < before + min_improvement) return `${c.id}: judge score ${after.toFixed(1)}, needs ${(before + min_improvement).toFixed(1)} (${before.toFixed(0)} is even)`;
  const split = paired(c.train, baselineTrain);
  if (split === null) return `${c.id}: test cases could not be compared`;
  if (split.p > max_p) return `${c.id}: better in ${split.wins} and worse in ${split.losses} test cases, which could be luck`;
  return null;
}

// replaced holds the head-to-head rows of the prompt the last merge replaced against the current prompt, or null
// when there is nothing to check. It reverts only when that older prompt now wins clearly.
export function judgeRound(scores: RoundScores, goal: Goal, replaced: ScoreRow[] | null): Verdict {
  const { min_improvement, noise_margin, max_p } = goal.merge_rule;
  const before = mean(scores.baselineTrain);
  const beforeHoldout = mean(scores.baselineHoldout);
  if (before === null || beforeHoldout === null) return { action: "skip", reasons: ["baseline score unknown"], notes: {} };

  if (replaced !== null) {
    const now = [...scores.baselineTrain, ...scores.baselineHoldout];
    const was = mean(replaced);
    const is = mean(now);
    const worse = paired(replaced, now);
    if (was !== null && is !== null && worse !== null && is < was - noise_margin && worse.p <= max_p) {
      return {
        action: "revert", notes: {},
        reasons: [`the prompt it replaced now wins, judge score ${was.toFixed(1)} to ${is.toFixed(1)}: better in ${worse.wins} test cases, worse in ${worse.losses}`],
        plain: `The prompt from before the last change now does better (better in ${cases(worse.wins)}, worse in ${worse.losses}), so Synthe put it back.`,
      };
    }
  }

  const reasons: string[] = [];
  const notes: Record<string, string> = {};
  let best: Extract<Verdict, { action: "merge" }> | null = null;
  for (const c of scores.candidates) {
    const problem = trainingProblem(c, scores.baselineTrain, goal);
    if (problem) { reasons.push(problem); notes[c.id] = trainingNote(c, scores.baselineTrain, goal); continue; }
    const after = mean(c.train)!;
    const split = paired(c.train, scores.baselineTrain)!;
    if (!c.holdout) { reasons.push(`${c.id}: not tried on the hidden test cases`); notes[c.id] = "Also looked better, but another change did better still."; continue; }
    const held = mean(c.holdout);
    const heldSplit = tally(c.holdout, scores.baselineHoldout);
    if (held === null || !heldSplit) { reasons.push(`${c.id}: hidden test cases couldn't be judged`); notes[c.id] = "Couldn't be checked on the hidden test cases, so it wasn't used."; continue; }
    if (held < beforeHoldout + min_improvement) {
      reasons.push(`${c.id}: judge score ${held.toFixed(1)} on the hidden test cases, needs ${(beforeHoldout + min_improvement).toFixed(1)}`);
      notes[c.id] = `Better on the test cases it learned from, but not on the ${c.holdout.length} hidden ones (better in ${heldSplit.w}, worse in ${heldSplit.l}), so it may only fit the ones it saw.`;
      continue;
    }
    const added = addedBreaks(c.train, scores.baselineTrain) + addedBreaks(c.holdout, scores.baselineHoldout);
    if (added > 0) {
      reasons.push(`${c.id}: breaks a rule where the current prompt follows it, or couldn't be checked`);
      notes[c.id] = `Broke one of your rules in ${cases(added)} where your current prompt follows it, so it wasn't used.`;
      continue;
    }
    // Guards catch a change that wins the checks by gaming them. They only measure, so they can refuse a merge but
    // never pick a winner. Same rows on both sides, like the checks.
    const currentHeld = scores.baselineHoldout.filter((r) => c.holdout!.some((h) => h.id === r.id));
    const guardBefore = guardRate([...scores.baselineTrain, ...currentHeld]);
    const guardAfter = guardRate([...c.train, ...c.holdout]);
    if (goal.counter_checks?.length) {
      if (guardBefore === null || guardAfter === null) {
        reasons.push(`${c.id}: guard verdicts missing`);
        notes[c.id] = "Your guards couldn't be checked on its replies, so it wasn't used.";
        continue;
      }
      if (guardBefore - guardAfter > goal.merge_rule.guard_margin) {
        reasons.push(`${c.id}: guards passed ${guardAfter}% against ${guardBefore}% for the current prompt, a drop of ${guardBefore - guardAfter} points where ${goal.merge_rule.guard_margin} is allowed`);
        notes[c.id] = `Its replies looked better, but they pass your guards less often (${guardAfter}% against ${guardBefore}%), which can mean it is gaming your checks, so it wasn't used.`;
        continue;
      }
    }
    const guards = goal.counter_checks?.length ? { before: guardBefore!, after: guardAfter! } : undefined;
    const stillBroken = breaks(c.train) + breaks(c.holdout);
    const wasBroken = breaks(scores.baselineTrain) + breaks(scores.baselineHoldout.filter((r) => c.holdout!.some((h) => h.id === r.id)));
    notes[c.id] = "Also looked better, but another change did better still.";
    if (best === null || after > best.after) {
      // The team's own number first, when they set checks: it is what they asked Synthe to improve.
      const rateBefore = checkRate([...scores.baselineTrain, ...currentHeld]);
      const rateAfter = checkRate([...c.train, ...c.holdout]);
      const rates = rateBefore !== null && rateAfter !== null ? { before: rateBefore, after: rateAfter } : undefined;
      const lead = rates ? `Your checks passed ${rates.after}% of the time, up from ${rates.before}%. ` : "";
      const rules = wasBroken > 0
        ? stillBroken > 0 ? ` Your old prompt broke your rules in ${cases(wasBroken)}; this one in ${stillBroken}.` : ` Your old prompt broke your rules in ${cases(wasBroken)}; this one in none.`
        : " It follows your rules in every test case.";
      const guardLine = guards ? ` ${guardSentence(guards)}` : "";
      best = {
        action: "merge", candidateId: c.id, before, after, heldBefore: beforeHoldout, heldAfter: held, wins: split.wins, losses: split.losses,
        heldWins: heldSplit.w, heldLosses: heldSplit.l, notes, ...(rates ? { checks: rates } : {}), ...(guards ? { guards } : {}),
        plain: `${lead}Its replies were better in ${cases(split.wins)} and worse in ${split.losses}, then better again on the hidden test cases it never saw (better in ${heldSplit.w}, worse in ${heldSplit.l}).${rules}${guardLine}`,
        reasons: [`judge score ${held.toFixed(1)} on the hidden test cases and ${after.toFixed(1)} on the learned-from ones, where ${before.toFixed(0)} is even; better in ${split.wins} and worse in ${split.losses} learned-from test cases${stillBroken > 0 ? `; still breaks a rule in ${stillBroken} test case${stillBroken === 1 ? "" : "s"}, down from ${wasBroken}` : ""}`],
      };
    }
  }
  if (best) best.notes[best.candidateId] = "Merged.";
  return best ?? { action: "skip", reasons: reasons.length ? reasons : ["no candidates"], notes };
}
