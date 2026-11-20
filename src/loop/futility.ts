import type { Goal, Scenario } from "../core/goal.ts";
import { trainingProblem, type ScoreRow } from "../core/merge-rule.ts";

// Futility stopping. A candidate is dueled on the training cases a chunk at a time, and stops once it could no
// longer pass trainingProblem even if it won every case it has not been dueled on yet. Winning is the best a row
// can score: it raises the mean and adds a win to the sign test without adding a loss, so if the candidate fails
// with every remaining case won, it fails with any real result. Stopping only ever drops a candidate that was
// going to fail anyway, so it never makes a merge more likely and can't raise the false-merge rate; it only saves
// the calls a lost cause would have spent. Rows it never dueled are unknown (null), never wins, and the candidate
// carries stoppedAfter so the report can say why it stopped.

const BEST = 100; // a win (WIN in score.ts): the highest score a row can get

// What the current prompt's training rows will read as. Its rows are even (50) whenever it has a reply, whatever
// the duels say, and trainingProblem reads only their scores, so this is exact before any candidate is dueled.
export const currentScores = (train: Scenario[], replies: Map<string, string | null>): ScoreRow[] =>
  train.map((s) => ({ id: s.id, score: (replies.get(s.id) ?? null) === null ? null : 50, violation: null }));

export function couldStillPass(id: string, done: ScoreRow[], rest: Scenario[], current: ScoreRow[], goal: Goal): boolean {
  const best = [...done, ...rest.map((s): ScoreRow => ({ id: s.id, score: BEST, violation: false }))];
  return trainingProblem({ id, train: best }, current, goal) === null;
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
