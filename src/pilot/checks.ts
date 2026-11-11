// Deterministic checks on one assistant turn. Lane: replay and failure discovery.
import type { CaseCheck, CheckResult } from "./types.ts";

const todo = (): never => { throw new Error("src/pilot/checks.ts is not built yet"); };

export interface TurnBehaviour {
  // The final reply text, or null when the turn did not finish.
  reply: string | null;
  // Tool names requested during this turn, in order.
  tools_requested: string[];
  // Tool names requested in earlier turns of the recorded conversation.
  tools_before: string[];
}

// One result per check. A check that needs the reply text is null when reply is null.
export function gradeChecks(_checks: CaseCheck[], _behaviour: TurnBehaviour): CheckResult[] { return todo(); }
