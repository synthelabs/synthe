import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Attempt } from "./types.ts";

// The record of the most recent solve run of a problem, so `solve --resume` can go on after a crash, a Ctrl-C or
// a killed process (swarm/GOAL-2.md). It lives in the git directory next to the history, so the working tree
// stays clean. It is written when the run starts, after each finished round, and once more when the run ends.

export interface RunRecord {
  run: number;
  // "running" until the run ends by its own stop rule. A run that stops any other way stays "running".
  status: "running" | "ended";
  branch: string;
  // The person's HEAD when the run started, and the scratch HEAD after the last finished round.
  base: string;
  head: string;
  // The scratch checkout. A killed run can not remove it, so a resume removes it.
  root: string;
  pid: number;
  // Finished rounds, the model calls they used, the baseline, and their attempts for result.json.
  rounds: number;
  calls: number;
  baseline: number | null;
  attempts: Attempt[];
}

const fileOf = (gitDir: string, name: string) => join(gitDir, "synthe", "solve", name, "run.json");

export function readRun(gitDir: string, name: string): RunRecord | null {
  const file = fileOf(gitDir, name);
  if (!existsSync(file)) return null;
  try {
    const r = JSON.parse(readFileSync(file, "utf8"));
    const ok = r && typeof r.run === "number" && (r.status === "running" || r.status === "ended") && typeof r.branch === "string"
      && typeof r.base === "string" && typeof r.head === "string" && typeof r.rounds === "number" && Array.isArray(r.attempts);
    if (!ok) return null;
    return {
      run: r.run, status: r.status, branch: r.branch, base: r.base, head: r.head,
      root: typeof r.root === "string" ? r.root : "", pid: typeof r.pid === "number" ? r.pid : 0,
      rounds: r.rounds, calls: typeof r.calls === "number" ? r.calls : 0,
      baseline: typeof r.baseline === "number" ? r.baseline : null, attempts: r.attempts,
    };
  } catch {
    return null;
  }
}

// Written to a temporary file and renamed, so a kill during the write leaves the old record, not half of a new one.
export function writeRun(gitDir: string, name: string, record: RunRecord): void {
  const file = fileOf(gitDir, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2) + "\n");
  renameSync(`${file}.tmp`, file);
}

// True while the process that wrote the record still runs: then that run is not stopped, and must not be resumed.
export function stillRunning(record: RunRecord): boolean {
  if (!record.pid || record.pid === process.pid) return false;
  try { process.kill(record.pid, 0); } catch { return false; }
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${record.pid}/stat`, "utf8")); } catch { return true; }
}

// The rounds in a row at the end of the record that kept nothing, so the 3-in-a-row stop rule carries across.
export function idleRounds(record: RunRecord): number {
  let idle = 0;
  for (let round = record.rounds; round >= 1; round--) {
    if (record.attempts.some((a) => a.round === round && a.kept)) break;
    idle++;
  }
  return idle;
}
