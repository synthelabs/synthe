// `synthe problem check <file>`: validates a problem file. Exit 0 with a summary, or exit 1 with one line per bad field.
import { loadProblem, problemSummary } from "../solve/problem.ts";

export function problemCommand(args: string[], say: (line: string) => void = console.log, warn: (line: string) => void = console.error): number {
  const [sub, file, ...rest] = args;
  if (sub !== "check" || !file || rest.length) {
    warn("Usage: synthe problem check <problem-file>");
    return 1;
  }
  const r = loadProblem(file);
  if (!r.ok) {
    // Errors go to stdout like the rest of the CLI's output, so a pipe or a test sees one line per bad field.
    for (const e of r.errors) say(e);
    return 1;
  }
  for (const line of problemSummary(r.problem)) say(line.replace("<this file>", file));
  return 0;
}
