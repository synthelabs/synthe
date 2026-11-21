import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkProblem, problemSummary } from "../solve/problem.ts";
import type { ProblemCheck } from "../solve/types.ts";

// Reads and checks a problem file. A file that is missing or unreadable is one problem line, like any other.
export function loadProblem(path: string, cwd: string): ProblemCheck {
  const file = resolve(cwd, path);
  let raw: string;
  try { raw = readFileSync(file, "utf8"); } catch { return { ok: false, problems: [`${path}: Synthe can't read this file. Check the path.`] }; }
  return checkProblem(raw, file);
}

// `synthe problem check <file>`: exit 0 and a plain summary, or exit 1 and one line for each problem.
export function problemCommand(args: string[], cwd: string, say: (line: string) => void): number {
  if (args[0] !== "check" || !args[1]) { say("Usage: npx synthe problem check <problem-file>"); return 1; }
  const check = loadProblem(args[1], cwd);
  if (!check.ok) { for (const p of check.problems) say(p); return 1; }
  say(problemSummary(check));
  return 0;
}
