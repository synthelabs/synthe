// One scratch checkout for a whole solve run: a git worktree in the temp folder, on a new branch
// synthe/solve-<name>-<n> made from HEAD (n is the first free number). The person's working tree and current
// branch never change. Owner: P02 crew.
export interface Scratch {
  // The checkout's root, and the problem's folder inside it (the same relative path as in the repo).
  root: string;
  dir: string;
  branch: string;
  // Commits exactly these paths (relative to root) on the branch and returns the commit.
  commit(paths: string[], message: string): Promise<string>;
  // Puts every file back to the last commit and removes new files: used after a refused or lost proposal.
  reset(): Promise<void>;
  // Removes the checkout. Keeps the branch only when `keepBranch` is true (the run kept at least one change).
  close(keepBranch: boolean): Promise<void>;
}

export async function openScratch(_repoRoot: string, _problemDir: string, _name: string): Promise<Scratch> {
  throw new Error("scratch.ts is not built yet");
}
