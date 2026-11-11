// Opening the review pull request. Off unless the operator asks, names the destination and confirms the candidate.
// Lane: evidence and review workflow.
import type { PilotRepo } from "./github.ts";
import { assertEgressSafe, type SensitiveIndex } from "./egress.ts";
import { PilotError } from "./errors.ts";
import { contentId, promptId, reviewBranch, shortId } from "./ids.ts";
import type { PilotConfig, ReviewBundle, Stored } from "./types.ts";

export interface PublishInput {
  config: PilotConfig;
  bundle: Stored<ReviewBundle>;
  // The pull request body (renderReview).
  body: string;
  candidate_prompt: string;
  // What the operator typed for this one publication.
  operator: { publish: boolean; repo: string; base: string; confirm: string };
  sensitive: SensitiveIndex;
  expectedPr?: number;
  // Test hook: called at named points ("after-commit", "after-open-pr") so a crash can be injected there.
  fault?: (point: string) => void;
}

// The fixed wording of the pull request title and commit message. Exported so the caller can tell the egress
// check that this wording is the pilot's own, not content.
export const publishTitle = (b: ReviewBundle): string => `Synthe pilot ${b.pilot_id}: candidate ${shortId(b.candidate_id)}`;
export const publishMessage = (b: ReviewBundle): string => `${publishTitle(b)}\n\nProposes a system prompt change for human review. Merging is a human decision.\n`;

export interface PublishResult { pr: number; branch: string; adopted: boolean }

// Throws PilotError: unauthorized_publish, wrong_repo, wrong_revision, egress_blocked, replay_gate_failed.
// Every check before step "Then, through the Repo" runs with no network call, so a refusal sends nothing.
export async function publishReview(repo: PilotRepo, input: PublishInput): Promise<PublishResult> {
  const { config, bundle, operator } = input;
  const b = bundle.value;

  if (operator.publish !== true) {
    throw new PilotError("unauthorized_publish", "Publishing is off. Nothing was sent. To open the review pull request, ask for it explicitly with --publish, the repo, the base branch and the full candidate id.");
  }
  if (operator.confirm !== b.candidate_id) {
    throw new PilotError("unauthorized_publish", "The confirmation does not match the candidate in this review bundle. Nothing was sent. Pass the full 64-character candidate id as the confirmation.");
  }

  const slugs = [operator.repo, config.repo.slug, b.repo.slug, ...(repo.slug === undefined ? [] : [repo.slug])];
  if (slugs.some((s) => s !== config.repo.slug)) {
    throw new PilotError("wrong_repo", `Nothing was sent. The pilot config names ${config.repo.slug}, but the operator, the review bundle or the GitHub connection names a different repo. Fix the mismatch so all of them name ${config.repo.slug}.`);
  }
  if ([operator.base, b.repo.base].some((s) => s !== config.repo.base)) {
    throw new PilotError("wrong_repo", `Nothing was sent. The pilot config names the base branch ${config.repo.base}, but the operator or the review bundle names a different one. Fix the mismatch so all of them name ${config.repo.base}.`);
  }

  if (b.replay.gate.eligible !== true) {
    throw new PilotError("replay_gate_failed", `This candidate did not pass the replay gate. Nothing was sent. Reasons: ${b.replay.gate.reasons.join("; ") || "none recorded"}.`);
  }
  if (promptId(input.candidate_prompt) !== b.candidate_id) {
    throw new PilotError("conflict", "The candidate prompt text is not the one this review bundle was built for. Nothing was sent. Rebuild the review from the current candidate.");
  }
  // Checks beyond the brief, still before any network call: a bundle that was edited after it was named, or that
  // points at another file or branch than the config does, must not be published.
  if (contentId(b) !== bundle.id) {
    throw new PilotError("tampered", "The review bundle does not match its id, so it was changed after it was written. Nothing was sent. Rebuild the review.");
  }
  if (b.repo.prompt_path !== config.agent.prompt_path || b.pilot_id !== config.pilot_id || b.repo.branch !== reviewBranch(b.candidate_id)) {
    throw new PilotError("conflict", "The review bundle names a different prompt file, pilot or branch than the pilot config. Nothing was sent. Rebuild the review.");
  }

  const title = publishTitle(b);
  const message = publishMessage(b);
  assertEgressSafe(title, input.sensitive, "pull request title");
  assertEgressSafe(input.body, input.sensitive, "pull request body");
  assertEgressSafe(message, input.sensitive, "commit message");
  assertEgressSafe(input.candidate_prompt, input.sensitive, "candidate prompt");

  const path = config.agent.prompt_path;
  const base = config.repo.base;
  const branch = b.repo.branch;

  const baseSha = await repo.headSha(base);
  const current = await repo.readFile(path, baseSha);
  if (current === null) {
    throw new PilotError("wrong_revision", `The prompt file ${path} was not found on the ${base} branch. Nothing was written. Check the prompt path and base branch in the pilot config.`);
  }
  if (promptId(current) !== b.baseline_prompt_id) {
    throw new PilotError("wrong_revision", `The ${base} branch no longer holds the baseline prompt this candidate was built from. Nothing was written. Re-run the pilot from the current prompt.`);
  }

  const file = { branch, baseSha, path, content: input.candidate_prompt, message };
  const existing = await repo.findReviewPr(branch);
  if (existing !== null) {
    if (existing.state !== "open" || existing.base !== base || existing.head !== branch || existing.body !== input.body
      || (input.expectedPr !== undefined && existing.number !== input.expectedPr)
      || !existing.headSha || !await repo.matchesReview(existing.headSha, file)) {
      throw new PilotError("conflict", "An existing pull request does not match this open review. Check its status, revisions and review body before retrying.");
    }
    return { pr: existing.number, branch, adopted: true };
  }
  if (input.expectedPr !== undefined) {
    throw new PilotError("conflict", "The previously published review pull request could not be verified. No replacement was opened.");
  }

  if (await repo.headSha(base) !== baseSha) throw new PilotError("wrong_revision", "The base branch moved during validation. Retry against its current revision.");
  const head = await repo.commitReview(file);
  input.fault?.("after-commit");
  if (!await repo.matchesReview(head, file) || await repo.headSha(branch) !== head || await repo.headSha(base) !== baseSha) {
    throw new PilotError("wrong_revision", "The base or review revision changed during publication. No pull request was opened.");
  }
  const pr = await repo.openPr({ branch, base, title, body: input.body });
  input.fault?.("after-open-pr");
  return { pr, branch, adopted: false };
}
