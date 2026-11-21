import type { Decision, Direction, Measurement } from "./types.ts";

// The keep rule for a number measure: keep only when the candidate is better than the kept version by more than
// the runs' noise explains. Must hold P06: a no-op is kept in at most 5% of whole runs, and a gain of two noise
// standard deviations is kept in at least 80% when runs is 5. Owner: P02 crew, then P06.
export function decide(_direction: Direction, _before: Measurement, _after: Measurement): Decision {
  throw new Error("decide.ts is not built yet");
}
