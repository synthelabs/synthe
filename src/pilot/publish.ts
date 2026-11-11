// Opening the review pull request. Off unless the operator asks, names the destination and confirms the candidate.
// Lane: evidence and review workflow.
import type { Repo } from "../github/repo.ts";
import type { SensitiveIndex } from "./egress.ts";
import type { PilotConfig, ReviewBundle, Stored } from "./types.ts";

const todo = (): never => { throw new Error("src/pilot/publish.ts is not built yet"); };

export interface PublishInput {
  config: PilotConfig;
  bundle: Stored<ReviewBundle>;
  // The pull request body (renderReview).
  body: string;
  candidate_prompt: string;
  // What the operator typed for this one publication.
  operator: { publish: boolean; repo: string; base: string; confirm: string };
  sensitive: SensitiveIndex;
  // Test hook: called at named points ("after-commit", "after-open-pr") so a crash can be injected there.
  fault?: (point: string) => void;
}

export interface PublishResult { pr: number; branch: string; adopted: boolean }

// Throws PilotError: unauthorized_publish, wrong_repo, wrong_revision, egress_blocked, replay_gate_failed.
export function publishReview(_repo: Repo, _input: PublishInput): Promise<PublishResult> { return todo(); }
