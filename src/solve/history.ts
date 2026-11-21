import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { HistoryEntry } from "./types.ts";

// The memory of every attempt on a problem, across runs (P12). It lives in the repository's git directory, not in
// the working tree: the person's tree stays clean, every worktree of the repository shares it, and git never
// commits it. One JSON object per line, appended, so a crash mid-run loses at most the line being written.

// HistoryEntry is the proposer's view of one attempt (swarm/GOAL.md). Only its four fields go to the proposer:
// before/after numbers stay out, so a holdout number can never reach it through the history.
// What the file stores: the proposer's view plus the run it came from and when.
export interface StoredEntry extends HistoryEntry {
  run: number;
  at: string;
}

const NAME = /^[A-Za-z0-9-]+$/;

// The shared git directory of the repository that holds `dir`. `dir` may be any folder in the repository, a
// worktree of it, or the git directory itself. --git-common-dir, not --git-dir, so a scratch
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

// Records attempts at once, so the next round of this run and every later run see them. Call it after each round,
// not only at the end, so a run that crashes still leaves its attempts. Read nextRun() once at the start of a run and
// pass it to every call of that run; without it, each call counts as a new run.
export function appendHistory(dir: string, name: string, entries: HistoryEntry[], run = nextRun(dir, name)): void {
  if (entries.length === 0) return;
  const file = historyFile(dir, name);
  mkdirSync(join(file, ".."), { recursive: true });
  const at = new Date().toISOString();
  const lines = entries.map((e) => JSON.stringify({ round: e.round, summary: e.summary, kept: e.kept, reason: e.reason, run, at } satisfies StoredEntry));
  appendFileSync(file, lines.join("\n") + "\n");
}
