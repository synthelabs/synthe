import type { Problem, Proposer, SolveOptions, SolveResult } from "./types.ts";

export interface SolveIo { say(line: string): void; env: NodeJS.ProcessEnv }

// One solve run: open the scratch checkout, check the guards and measure the baseline (a failure here is a failed
// setup: throw SetupError), then run rounds until the proposer has nothing more, the budget ends (max_rounds,
// max_calls), or 3 rounds in a row keep nothing. Each round: ask the proposer, apply each proposal (edits.ts),
// run the guards, measure, decide, and commit at most one proposal: the best that passes. Owner: P02.
export async function solve(_problem: Problem, _proposer: Proposer, _options: SolveOptions, _io: SolveIo): Promise<SolveResult> {
  throw new Error("solve is not built yet");
}

// A failed setup: not in a git repository, a guard that fails on the baseline, a measure that prints no number.
// The CLI prints the message and exits 1.
export class SetupError extends Error {}
