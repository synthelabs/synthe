import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

// The memory of every attempt on a problem, across runs (P12). It lives in the repository's git directory, not in
// the working tree: the person's tree stays clean, every worktree of the repository shares it, and git never
// commits it. One JSON object per line, appended, so a crash mid-run loses at most the line being written.

// One attempt as the proposer sees it in `history` (swarm/GOAL.md). Only these four fields go to the proposer:
// before/after numbers stay out, so a holdout number can never reach it through the history.
export interface HistoryEntry {
  round: number;
  summary: string;
  kept: boolean;
  reason: string;
}

// What the file stores: the proposer's view plus the run it came from and when.
export interface StoredEntry extends HistoryEntry {
  run: number;
  at: string;
}

const NAME = /^[A-Za-z0-9-]+$/;

// The shared git directory of the repository that holds `dir`. --git-common-dir, not --git-dir, so a scratch
// worktree and the person's checkout read and write the same history.
export function gitCommonDir(dir: string): string {
  const out = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  return isAbsolute(out) ? out : resolve(dir, out);
}

export function historyFile(dir: string, name: string): string {
  // The name is checked here too: it becomes a path, and "../x" must never reach outside the history folder.
  if (!NAME.test(name)) throw new Error(`The problem name "${name}" can hold only letters, digits and "-".`);
  return join(gitCommonDir(dir), "synthe", "solve", name, "history.jsonl");
}

function parse(line: string): StoredEntry | null {
  try {
    const e = JSON.parse(line);
    if (!e || typeof e !== "object" || typeof e.round !== "number" || typeof e.summary !== "string" || typeof e.kept !== "boolean" || typeof e.reason !== "string") return null;
    return { round: e.round, summary: e.summary, kept: e.kept, reason: e.reason, run: typeof e.run === "number" ? e.run : 0, at: typeof e.at === "string" ? e.at : "" };
  } catch {
    // A torn last line from a crash, or a hand edit: skip it rather than lose the rest of the memory.
    return null;
  }
}

// Every stored attempt for the problem, oldest first. Empty when the problem never ran.
export function readStored(dir: string, name: string): StoredEntry[] {
  const file = historyFile(dir, name);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map(parse).filter((e): e is StoredEntry => e !== null);
}

// The `history` list for the proposer's stdin: every earlier attempt, from earlier runs and this one, oldest first.
export function readHistory(dir: string, name: string): HistoryEntry[] {
  return readStored(dir, name).map(({ round, summary, kept, reason }) => ({ round, summary, kept, reason }));
}

// The number of the next run: one more than the highest run on record, so 1 for a new problem.
export function nextRun(dir: string, name: string): number {
  return readStored(dir, name).reduce((max, e) => Math.max(max, e.run), 0) + 1;
}

// Records one attempt at once, so the next round of this run and every later run see it.
export function appendHistory(dir: string, name: string, run: number, entry: HistoryEntry): void {
  const file = historyFile(dir, name);
  mkdirSync(join(file, ".."), { recursive: true });
  const stored: StoredEntry = { round: entry.round, summary: entry.summary, kept: entry.kept, reason: entry.reason, run, at: new Date().toISOString() };
  appendFileSync(file, JSON.stringify(stored) + "\n");
}
