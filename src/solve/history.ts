import type { HistoryEntry } from "./types.ts";

// Attempts from every run of a problem, oldest first. They live in the git folder (<git-dir>/synthe/solve/<name>/),
// so a run never dirties the person's working tree and --out does not move them. Owner: P12.
export function readHistory(_gitDir: string, _name: string): HistoryEntry[] {
  return [];
}

export function appendHistory(_gitDir: string, _name: string, _entries: HistoryEntry[]): void {
  /* not built yet */
}
