// The review bundle a person reads before the customer-run experiment. Lane: evidence and review workflow.
import type { Candidate, ExperimentSpec, Pack, PilotConfig, ReplayReport, ReviewBundle, Sha256, Stored } from "./types.ts";

const todo = (): never => { throw new Error("src/pilot/review.ts is not built yet"); };

// Unified diff of the prompt file.
export function promptDiff(_path: string, _before: string, _after: string): string { return todo(); }

// Throws PilotError replay_gate_failed when the replay gate did not pass: such a candidate has no review bundle.
export function buildReviewBundle(_input: {
  config: PilotConfig; config_id: Sha256; candidate: Candidate; baseline_prompt: string; candidate_prompt: string;
  replay: Stored<ReplayReport>; experiment: Stored<ExperimentSpec>;
}): ReviewBundle { return todo(); }

// Markdown used for REVIEW.md and for the pull request body.
export function renderReview(_bundle: ReviewBundle, _reviewId: Sha256, _pack: Pack): string { return todo(); }
