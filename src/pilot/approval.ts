// A person's approval, tied to one candidate and one experiment. Lane: evidence and review workflow.
import { PilotError } from "./errors.ts";
import { ms } from "./ids.ts";
import type { Approval, IsoTime, ReviewBundle, Sha256, Stored } from "./types.ts";

// Throws PilotError unknown_approval when the ids do not match the review bundle.
export function makeApproval(input: {
  pilot_id: string; bundle: Stored<ReviewBundle>; candidate_id: Sha256; experiment_id: Sha256;
  approver: string; decision: "approved" | "rejected"; at: IsoTime;
}): Approval {
  const b = input.bundle.value;
  if (input.candidate_id !== b.candidate_id || input.experiment_id !== b.experiment_id || input.pilot_id !== b.pilot_id) {
    throw new PilotError("unknown_approval", "An approval must name the exact pilot, candidate and experiment in the review bundle. Copy the ids from the approve command in REVIEW.md.");
  }
  if (typeof input.approver !== "string" || input.approver.trim() === "") throw new PilotError("usage", "Say who is approving: pass --approver with your name.");
  if (input.decision !== "approved" && input.decision !== "rejected") throw new PilotError("usage", "The decision must be approved or rejected.");
  if (typeof input.at !== "string" || Number.isNaN(ms(input.at))) throw new PilotError("usage", "The approval time must be a UTC time like 2026-10-01T00:00:00Z.");
  return {
    version: 1, pilot_id: b.pilot_id, candidate_id: b.candidate_id, experiment_id: b.experiment_id, review_id: input.bundle.id,
    scope: "experiment", decision: input.decision, approver: input.approver.trim(), at: input.at,
  };
}

// The approval for exactly this candidate and experiment. Throws PilotError unknown_approval when there is none
// or the last decision is a rejection. `approvals` is in journal order and the last matching one decides: the
// time on an approval is whatever the operator's clock said, and a clock that stepped back must not let an
// earlier-stamped approval outrank a rejection recorded after it. A prefix or short id never matches.
export function requireApproval(approvals: Stored<Approval>[], candidateId: Sha256, experimentId: Sha256): Stored<Approval> {
  const latest = approvals.filter((a) => a.value.candidate_id === candidateId && a.value.experiment_id === experimentId).at(-1);
  if (latest === undefined) throw new PilotError("unknown_approval", "No approval names this exact candidate and experiment. Run the approve command from REVIEW.md with the full ids.");
  if (latest.value.decision === "rejected") throw new PilotError("unknown_approval", `The latest decision for this candidate and experiment is a rejection (by ${latest.value.approver}). Approve it again to go ahead.`);
  return latest;
}
