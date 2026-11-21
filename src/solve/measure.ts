import type { Measurement, Problem } from "./types.ts";

export type Split = "train" | "holdout";
export interface MeasureContext { seed?: number; split?: Split }

// Runs the problem's measure in the checkout: measure.command `runs` times (the last number on stdout is the
// score), with SYNTHE_SPLIT set when the problem has a held-back split and SYNTHE_SEED set when there is a seed.
// Returns the measurement, or the plain reason no number came out. Owner: P02 crew. Judged measures: judge.ts.
export async function measure(_checkout: string, _problem: Problem, _ctx: MeasureContext = {}): Promise<Measurement | { failed: string }> {
  throw new Error("measure.ts is not built yet");
}

// Runs every guard in the checkout. Returns null when all exit 0, or the first guard command that failed.
// Owner: P02 crew, P10.
export async function failedGuard(_checkout: string, _problem: Problem): Promise<string | null> {
  throw new Error("measure.ts is not built yet");
}
