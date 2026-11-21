import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { historyFile } from "./history.ts";
import type { Attempt } from "./types.ts";

// The state of the latest solve run of a problem, for `solve --resume` (stage 2, S03). It lives next to the history
// in the repository's git directory, so the working tree stays clean. solve() writes it when a run starts, after
// every finished round, and marks it done after result.json. A run that was killed leaves it at "running": that is
// how --resume knows the run stopped before its own stop rule.
//
// `head` is the commit of the kept state when the last finished round ended. A kill can land after a commit and
// before the round is recorded; resuming at `head` drops that half-finished round, so it runs again in full, and no
// finished round runs twice.

export interface RunState {
  version: 1;
  status: "running" | "done";
  run: number;
  branch: string;
  base: string;
  // The scratch checkout's folder, so a resume can remove a checkout that a hard kill left on disk.
  root: string;
  head: string;
  rounds: number;
  attempts: Attempt[];
  baseline: number;
  calls: number;
  idle: number;
  keptAny: boolean;
  stopped?: string;
  at: string;
}

export function stateFile(gitDir: string, name: string): string {
  return join(historyFile(gitDir, name), "..", "run.json");
}

const isAttempt = (a: unknown): a is Attempt => {
  const x = a as Attempt;
  return !!x && typeof x.round === "number" && typeof x.summary === "string" && typeof x.kept === "boolean" && typeof x.reason === "string";
};

// The saved state, or null when there is none or it cannot be read. A state that cannot be read is treated as
// absent: --resume then starts a new run and says so, which is safe.
export function readState(gitDir: string, name: string): RunState | null {
  const file = stateFile(gitDir, name);
  if (!existsSync(file)) return null;
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    const ok = s && s.version === 1 && (s.status === "running" || s.status === "done") && Number.isInteger(s.run) &&
      typeof s.branch === "string" && typeof s.base === "string" && typeof s.root === "string" && typeof s.head === "string" &&
      Number.isInteger(s.rounds) && Array.isArray(s.attempts) && s.attempts.every(isAttempt) && typeof s.baseline === "number" &&
      Number.isInteger(s.calls) && Number.isInteger(s.idle) && typeof s.keptAny === "boolean";
    return ok ? (s as RunState) : null;
  } catch {
    return null;
  }
}

// Written to a temp file and renamed, so a kill during the write leaves the old state, never a torn one.
export function writeState(gitDir: string, name: string, state: Omit<RunState, "version" | "at">): void {
  const file = stateFile(gitDir, name);
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, ...state, at: new Date().toISOString() } satisfies RunState, null, 2)}\n`);
  renameSync(tmp, file);
}
