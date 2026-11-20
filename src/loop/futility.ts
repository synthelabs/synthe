import type { Goal, Scenario } from "../core/goal.ts";
import { candidateTrainingProblem, type ScoreRow } from "../core/merge-rule.ts";

// Futility stopping. A candidate is dueled on the training cases a chunk at a time, and stops once it could no
// longer pass its own training rule (candidateTrainingProblem) even if it won every case it has not been dueled on
// yet. Winning is the best a row can score: it raises the mean and adds a win to the sign test without adding a
// loss, so if the candidate fails with every remaining case won, it fails with any real result. The same holds for
// a shorter candidate (merge_rule.allow_shorter), judged by whether it is no worse: a win adds a decided case
// without adding a loss, which can only lower its non-inferiority p, so it is stopped only once even that can't pass. Stopping only ever drops a candidate that was
// going to fail anyway, so it never makes a merge more likely and can't raise the false-merge rate; it only saves
// the calls a lost cause would have spent. Rows it never dueled are unknown (null), never wins, and the candidate
// carries stoppedAfter so the report can say why it stopped.

const BEST = 100; // a win (WIN in score.ts): the highest score a row can get

// What the current prompt's training rows will read as. Its rows are even (50) whenever it has a reply, whatever
// the duels say, and the training rules read only their scores, so this is exact before any candidate is dueled.
export const currentScores = (train: Scenario[], replies: Map<string, string | null>): ScoreRow[] =>
  train.map((s) => ({ id: s.id, score: (replies.get(s.id) ?? null) === null ? null : 50, violation: null }));

// kind: the candidate's kind, so a shorter one is held to the no-worse test it is judged by, not superiority.
export function couldStillPass(id: string, done: ScoreRow[], rest: Scenario[], current: ScoreRow[], goal: Goal, kind?: "shorter"): boolean {
  const best = [...done, ...rest.map((s): ScoreRow => ({ id: s.id, score: BEST, violation: false }))];
  return candidateTrainingProblem({ id, train: best, ...(kind ? { kind } : {}) }, current, goal) === null;
}

// Runs fn over items a chunk at a time, in order, and stops between chunks once keepGoing says no. Returns the
// results of the items it ran, which are always the first ones. The chunk size must be even so the alternating
// reply order stays balanced over the cases actually dueled.
export async function inChunks<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>, keepGoing: (done: R[]) => boolean): Promise<R[]> {
  if (size < 2 || size % 2 !== 0) throw new Error("chunk size must be even");
  const done: R[] = [];
  for (let at = 0; at < items.length; at += size) {
    done.push(...(await Promise.all(items.slice(at, at + size).map(fn))));
    if (done.length < items.length && !keepGoing(done)) break;
  }
  return done;
}
