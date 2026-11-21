import type { SolveResult } from "./types.ts";

// Writes result.json and report.md to `outDir` (made when missing). report.md names each attempt, says whether it
// was kept, and gives the reason in plain words. Owner: P02 crew.
export function writeReport(_outDir: string, _result: SolveResult): void {
  throw new Error("report.ts is not built yet");
}
