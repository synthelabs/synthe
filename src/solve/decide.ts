import { meanSummary, studentTCdf } from "../pilot/stats.ts";
import { plainNumber } from "../improve/verdict.ts";

export type Direction = "higher" | "lower";

export interface Comparison {
  /** Mean of the runs before and after the change. */
  before: number;
  after: number;
  /** One-sided p-value that the change is not better. null when there is no spread to test (fewer than 2 runs each). */
  p: number | null;
  /** The change moved the mean the right way. */
  better: boolean;
}

export interface Decision extends Comparison {
  keep: boolean;
  /** A plain sentence for result.json and report.md. */
  reason: string;
}

/** Fresh runs of the kept version and of the candidate, for the second look. */
export type Remeasure = () => Promise<{ baseline: number[]; candidate: number[] } | { error: string }>;

// Two looks keep both error rates low with few runs. The first look is a loose screen at 10%. A change that passes
// it gets fresh runs of both versions, and all the runs together must then pass a strict test at 0.5%. A no-op that
// is lucky once must be lucky again on twice the data. In a simulation with normal noise and 5 runs, a run of 6
// no-op rounds kept one in about 2.5% of runs, and a real gain of two standard deviations was kept in about 9 of 10.
export const SCREEN_ALPHA = 0.1;
export const CONFIRM_ALPHA = 0.005;

// Differences smaller than this share of the scale are floating-point dust, not a change.
const DUST = 1e-9;

/** Welch's one-sided t-test that `candidate` is better than `baseline` in `direction`. */
export function compare(direction: Direction, baseline: number[], candidate: number[]): Comparison {
  const a = meanSummary(candidate);
  const b = meanSummary(baseline);
  if (a.mean === null || b.mean === null) throw new Error("compare needs at least one run of each version");
  const before = b.mean, after = a.mean;
  const gain = direction === "higher" ? after - before : before - after;
  const scale = Math.max(1, Math.abs(before), Math.abs(after));
  const better = gain > DUST * scale;
  if (a.sd === null || b.sd === null) return { before, after, p: null, better };
  const va = (a.sd * a.sd) / a.n, vb = (b.sd * b.sd) / b.n;
  const se2 = va + vb;
  // No spread in either version: the measure is exact, so any real move is the whole truth.
  if (se2 <= (DUST * scale) ** 2) return { before, after, p: better ? 0 : 1, better };
  const df = (se2 * se2) / ((va * va) / (a.n - 1) + (vb * vb) / (b.n - 1));
  const cdf = studentTCdf(gain / Math.sqrt(se2), df);
  return { before, after, p: cdf === null ? 1 : 1 - cdf, better };
}

const word = (direction: Direction) => (direction === "higher" ? "higher" : "lower");

function verdict(c: Comparison, alpha: number, direction: Direction, look: string): Decision {
  const nums = `${plainNumber(c.before)} -> ${plainNumber(c.after)}`;
  if (!c.better) return { ...c, keep: false, reason: `Not better: the score went ${nums}, and ${word(direction)} is better.` };
  if (c.p === null) return { ...c, keep: true, reason: `Better: the score went ${nums}.` };
  if (c.p >= alpha) {
    return { ...c, keep: false, reason: `Within noise: the score went ${nums}, but a move this size happens by chance (p = ${plainNumber(c.p)}${look}).` };
  }
  return { ...c, keep: true, reason: `Better: the score went ${nums}, more than the noise explains (p = ${plainNumber(c.p)}${look}).` };
}

/**
 * The keep rule. `baseline` and `candidate` are the runs of the kept version and of the change.
 * Without `remeasure`, one look at SCREEN_ALPHA decides. With it, a change that passes the screen is measured
 * again and must pass CONFIRM_ALPHA on all the runs together.
 */
export async function decide(direction: Direction, baseline: number[], candidate: number[], remeasure?: Remeasure): Promise<Decision> {
  const first = verdict(compare(direction, baseline, candidate), SCREEN_ALPHA, direction, "");
  // An exact measure (p of 0 or null) needs no second look: fresh runs would give the same numbers.
  if (!first.keep || !remeasure || first.p === null || first.p === 0) return first;
  const more = await remeasure();
  if ("error" in more) return { ...first, keep: false, reason: `Could not measure again to confirm the gain: ${more.error}` };
  return verdict(compare(direction, [...baseline, ...more.baseline], [...candidate, ...more.candidate]), CONFIRM_ALPHA, direction, " on the second look");
}
