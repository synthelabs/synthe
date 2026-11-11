// Deterministic checks on one assistant turn. Lane: replay and failure discovery.
import type { CaseCheck, CheckResult } from "./types.ts";

export interface TurnBehaviour {
  // The final reply text, or null when the turn did not finish.
  reply: string | null;
  // Tool names requested during this turn, in order.
  tools_requested: string[];
  // Tool names requested in earlier turns of the recorded conversation.
  tools_before: string[];
}

// One result per check. A check that needs the reply text is null when reply is null.
export function gradeChecks(checks: CaseCheck[], behaviour: TurnBehaviour): CheckResult[] {
  return checks.map((check) => ({ id: check.id, role: check.role, blocking: check.blocking === true, pass: grade(check, behaviour) }));
}

function grade(check: CaseCheck, b: TurnBehaviour): boolean | null {
  const finished = b.reply !== null;
  switch (check.kind) {
    case "reply_includes":
    case "reply_excludes": {
      if (b.reply === null) return null;
      const reply = b.reply.toLowerCase();
      const found = check.any_of.some((phrase) => reply.includes(phrase.toLowerCase()));
      return check.kind === "reply_includes" ? found : !found;
    }
    case "calls_tool": {
      if (b.tools_requested.includes(check.tool)) return true;
      // An unfinished turn might still have called it, so "not yet" is not "never".
      return finished ? false : null;
    }
    case "avoids_tool": {
      if (b.tools_requested.includes(check.tool)) return false;
      return finished ? true : null;
    }
    case "tool_requires": {
      let seenAfter = b.tools_before.includes(check.after);
      for (const name of b.tools_requested) {
        if (name === check.tool) {
          if (!seenAfter) return false;
        }
        if (name === check.after) seenAfter = true;
      }
      // Nothing wrong so far, but an unfinished turn could still break the rule with a later request.
      if (!finished) return null;
      return true;
    }
  }
}
