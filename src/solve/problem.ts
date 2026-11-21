import type { ProblemCheck } from "./types.ts";

// Parses and validates the text of a problem file. `file` is its absolute path. Finds every problem, not only the
// first: one line for each, and each line names the field. Owner: P01.
export function checkProblem(_raw: string, _file: string): ProblemCheck {
  return { ok: false, problems: ["problem check is not built yet"] };
}

// The plain summary that `problem check` prints for a valid file. Owner: P01.
export function problemSummary(_check: Extract<ProblemCheck, { ok: true }>): string {
  return "";
}
