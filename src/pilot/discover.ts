// Recurring failures from discovery cases, the proposer's context, and candidates. Lane: replay and failure discovery.
import type { ArmRun, Candidate, FailureFinding, Pack, ProposerContext, Sha256 } from "./types.ts";

const todo = (): never => { throw new Error("src/pilot/discover.ts is not built yet"); };

// Checks the baseline fails in at least min_recurring_cases discovery cases, most frequent first.
export function discoverFailures(_input: { pack: Pack; baseline: ArmRun; min_recurring_cases: number }): FailureFinding[] { return todo(); }

// Everything a proposer is given. Built from discovery cases only; throws PilotError holdout_leak otherwise.
export function proposerContext(_input: { pack: Pack; baseline_prompt: string; finding: FailureFinding; attempt: number; feedback: string[]; max_changed_lines: number }): ProposerContext { return todo(); }

// Lines added plus lines removed between two prompt texts.
export function changedLines(_before: string, _after: string): number { return todo(); }

// Validates a proposed or human-written prompt as a narrow change. Throws PilotError: invalid_candidate, candidate_not_narrow.
export function makeCandidate(_input: {
  pilot_id: string; baseline_prompt: string; prompt: string; origin: "proposer" | "human"; author: string; rationale: string;
  finding_id: Sha256 | null; target_check_id: string | null; max_changed_lines: number;
}): Candidate { return todo(); }

export function renderFindings(_findings: FailureFinding[], _pack: Pack): string { return todo(); }
