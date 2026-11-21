import type { Problem, Proposer } from "./types.ts";

// The outside proposer: runs problem.proposer.command in problem.dir, writes the request as one JSON object to
// stdin and parses one JSON object from stdout. Any failure becomes `{ failed: reason }`. Owner: P03.
export function commandProposer(_problem: Problem): Proposer {
  throw new Error("proposer.ts is not built yet");
}

// Picks the proposer the problem asks for: the outside command, or the model (model-proposer.ts, P16).
export function proposerFor(problem: Problem): Proposer {
  return commandProposer(problem);
}
