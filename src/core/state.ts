import type { ScoreRow } from "./merge-rule.ts";

export interface RoundRecord {
  round: number; at: string; outcome: "merged" | "reverted" | "proposed" | "declined" | "skipped" | "failed";
  heldBefore?: number; heldAfter?: number; wins?: number; losses?: number; pr?: number; reasons: string[]; costUsd: number | null; writeUsd?: number | null;
  // For the team, in plain words: what the round did, what changed if anything, and what happened to each idea.
  plain?: string; changed?: string; tried?: { summary: string; outcome: string }[];
  example?: { input: string; before: string; after: string }; title?: string; unverified?: string[];
  edits?: { find: string; replace: string }[];
  // Why a failed round's write or score step failed, when it said; the report's advice depends on it.
  failure?: "busy" | "key" | "other";
  // The share of the team's checks passed before and after a merged or proposed change, as whole percentages.
  checks?: { before: number; after: number };
}

export interface Landing { branch: string; kind: "merge" | "revert"; text: string; priorPrompt: string; propose?: boolean }

export interface State {
  round: number;
  prompt: string | null; // tracked inline prompt text
  lastMerge: { pr: number; priorPrompt: string; mergedHash: string; reverted: boolean } | null;
  stalls: number;
  spendUsd: number;
  spendUnknown: boolean;
  stopped: string | null;
  issue: number | null;
  scenariosHash: string | null; // scenarios the last round was scored on
  // Training cases from the last round where the current prompt lost or broke a guardrail, for the next writer.
  lessons: { promptHash: string; rows: { id: string; reply: string; better?: string; violation: boolean; failedChecks?: string[] }[] } | null;
  // Set while a decide step is acting, so the next one can tell it died partway and clean up after it.
  pending: { round: number; at: string; costUsd: number | null; land?: Landing } | null;
  // A pull request Synthe opened and left for a person to merge (propose mode, or a repo that requires review).
  // Rounds wait, without model calls, until it is merged or closed.
  proposal: (Landing & { pr: number; round: number }) | null;
  // A completed round has queued its successor. A backup run may replace that pending run.
  chainReady?: boolean;
  rounds: RoundRecord[];
}

export const newState = (): State => ({
  round: 0, prompt: null, lastMerge: null, stalls: 0, spendUsd: 0, spendUnknown: false, stopped: null, issue: null, scenariosHash: null, lessons: null, pending: null, proposal: null, chainReady: false, rounds: [],
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
