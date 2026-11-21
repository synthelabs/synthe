import type { Problem, Proposer } from "./types.ts";

// The model proposer: sends the same request object to the OpenAI-compatible endpoint in problem.model and parses
// the reply into proposals. A malformed reply becomes `{ failed: reason }`. The key comes only from SYNTHE_API_KEY
// and goes only to base_url. Owner: P16.
export function modelProposer(_problem: Problem, _env: NodeJS.ProcessEnv): Proposer {
  throw new Error("model-proposer.ts is not built yet");
}
