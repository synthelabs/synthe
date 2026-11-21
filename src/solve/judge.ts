import type { Decision, Problem } from "./types.ts";

// The judged measure (GOAL.md, "The judged measure"): runs every case on the kept checkout and on the candidate
// checkout, asks `compare` twice for each case with a and b swapped, and decides with a paired test across cases.
// A win that comes only from the judge's position or length bias is refused. Owner: P09.
export async function judgeCandidate(_keptCheckout: string, _candidateCheckout: string, _problem: Problem, _seed?: number): Promise<Decision> {
  throw new Error("judge.ts is not built yet");
}
