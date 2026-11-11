// A person's approval, tied to one candidate and one experiment. Lane: evidence and review workflow.
import type { Approval, IsoTime, ReviewBundle, Sha256, Stored } from "./types.ts";

const todo = (): never => { throw new Error("src/pilot/approval.ts is not built yet"); };

// Throws PilotError unknown_approval when the ids do not match the review bundle.
export function makeApproval(_input: {
  pilot_id: string; bundle: Stored<ReviewBundle>; candidate_id: Sha256; experiment_id: Sha256;
  approver: string; decision: "approved" | "rejected"; at: IsoTime;
}): Approval { return todo(); }

// The approval for exactly this candidate and experiment. Throws PilotError unknown_approval when there is none
// or the only ones are rejections.
export function requireApproval(_approvals: Stored<Approval>[], _candidateId: Sha256, _experimentId: Sha256): Stored<Approval> { return todo(); }
