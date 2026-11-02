import type { ScoreRow } from "./merge-rule.ts";

export interface RoundRecord {
  round: number; at: string; outcome: "merged" | "reverted" | "skipped" | "failed";
  heldBefore?: number; heldAfter?: number; wins?: number; losses?: number; pr?: number; reasons: string[]; costUsd: number | null;
}

export interface State {
  round: number;
  prompt: string | null; // tracked inline prompt text
  lastMerge: { pr: number; priorPrompt: string; priorScores: ScoreRow[]; mergedHash: string; reverted: boolean } | null;
  stalls: number;
  spendUsd: number;
  spendUnknown: boolean;
  stopped: string | null;
  issue: number | null;
  scenariosHash: string | null; // scenarios the last round was scored on
  rounds: RoundRecord[];
}

export const newState = (): State => ({
  round: 0, prompt: null, lastMerge: null, stalls: 0, spendUsd: 0, spendUnknown: false, stopped: null, issue: null, scenariosHash: null, rounds: [],
});

export function stopReason(s: State, maxRounds: number, stallRounds: number, maxUsd: number): string | null {
  if (s.stopped) return s.stopped;
  if (s.spendUnknown) return "spend could not be measured";
  if (s.spendUsd >= maxUsd) return `budget of $${maxUsd} is used`;
  if (s.round >= maxRounds) return `reached ${maxRounds} rounds`;
  if (s.stalls >= stallRounds) return `${stallRounds} rounds in a row found no winner`;
  return null;
}

// Running out of rounds, budget or ideas is a finished run. Anything else needs someone to act.
export function isFinished(reason: string): boolean {
  return /^(budget of .* is used|reached \d+ rounds|\d+ rounds in a row found no winner)$/.test(reason);
}

// A run that stalled starts again when the scenarios change, so adding harder ones is all it takes to continue.
export function resumeIfScenariosChanged(s: State, scenariosHash: string): boolean {
  if (!s.stopped || !/rounds in a row found no winner$/.test(s.stopped) || s.scenariosHash === null || s.scenariosHash === scenariosHash) return false;
  s.stopped = null;
  s.stalls = 0;
  return true;
}
