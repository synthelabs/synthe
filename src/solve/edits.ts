import type { Problem, Proposal, ProposerFile } from "./types.ts";

// The files the proposer sees: every tracked file in `dir` (a checkout of the repo) that matches artifact and is
// not protected. Paths are relative to the problem's folder. Owner: P03 crew.
export function artifactFiles(_checkout: string, _problem: Problem): ProposerFile[] {
  throw new Error("edits.ts is not built yet");
}

// Applies one proposal to the scratch checkout. All edits apply or none do. Refuses, with a reason that names the
// path: a path outside artifact, a protect path, a file the measure, guard, judge or proposer commands use, the
// problem file itself, a path that leaves the folder, and a search text that does not occur exactly once.
// Returns the changed paths (relative to the checkout root) or the plain reason. Owner: P03 crew, P08.
export function applyProposal(_checkout: string, _problem: Problem, _proposal: Proposal): { paths: string[] } | { refused: string } {
  throw new Error("edits.ts is not built yet");
}
