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
  rounds: RoundRecord[];
}

export const newState = (): State => ({
  round: 0, prompt: null, lastMerge: null, stalls: 0, spendUsd: 0, spendUnknown: false, stopped: null, issue: null, rounds: [],
});

export function stopReason(s: State, maxRounds: number, stallRounds: number, maxUsd: number): string | null {
  if (s.stopped) return s.stopped;
  if (s.spendUnknown) return "spend could not be measured";
  if (s.spendUsd >= maxUsd) return `budget of $${maxUsd} is used`;
  if (s.round >= maxRounds) return `reached ${maxRounds} rounds`;
  if (s.stalls >= stallRounds) return `${stallRounds} rounds in a row found no winner`;
  return null;
}
