import { meanSummary, studentTCdf } from "../core/stats.ts";
import { plainNumber } from "../improve/verdict.ts";
import type { Decision, Direction, Measurement } from "./types.ts";

// Two looks keep both error rates low with few runs. The first look is a loose screen at 10%. A change that passes
// it gets fresh runs of both versions, and all the runs together must then pass a strict test at 0.5%. A no-op that
// is lucky once must be lucky again on twice the data. In a simulation with normal noise and 5 runs, a run of 6
// no-op rounds kept one in about 2.5% of runs, and a real gain of two standard deviations was kept in about 9 of 10.
// One look alone cannot do both: at 10% too many no-ops pass, and at 0.5% too few real gains do.
export const SCREEN_ALPHA = 0.1;
export const CONFIRM_ALPHA = 0.005;

// Differences smaller than this share of the scale are floating-point dust, not a change.
const DUST = 1e-9;

export interface Comparison {
  /** The candidate moved the mean the right way. */
  better: boolean;
  /** One-sided Welch p-value that the candidate is not better. 0 for an exact measure, null below 2 runs each. */
  p: number | null;
}

/** Welch's one-sided t-test that the `after` runs are better than the `before` runs in `direction`. */
export function compare(direction: Direction, before: number[], after: number[]): Comparison {
  const a = meanSummary(after), b = meanSummary(before);
  if (a.mean === null || b.mean === null) return { better: false, p: null };
  const gain = direction === "higher" ? a.mean - b.mean : b.mean - a.mean;
  const scale = Math.max(1, Math.abs(a.mean), Math.abs(b.mean));
  const better = gain > DUST * scale;
  if (a.sd === null || b.sd === null) return { better, p: null };
  const va = (a.sd * a.sd) / a.n, vb = (b.sd * b.sd) / b.n;
  const se2 = va + vb;
  // No spread in either version: the measure is exact, so any real move is the whole truth.
  if (se2 <= (DUST * scale) ** 2) return { better, p: better ? 0 : 1 };
  const df = (se2 * se2) / ((va * va) / (a.n - 1) + (vb * vb) / (b.n - 1));
  const cdf = studentTCdf(gain / Math.sqrt(se2), df);
  return { better, p: cdf === null ? 1 : 1 - cdf };
}

function look(direction: Direction, before: Measurement, after: Measurement, alpha: number, second: boolean): Decision & { exact: boolean } {
  const c = compare(direction, before.runs, after.runs);
  const nums = `${plainNumber(before.value)} -> ${plainNumber(after.value)}`;
  const exact = c.p === null || c.p === 0;
  if (!c.better) return { keep: false, exact, reason: `Not better: the score went ${nums}, and ${direction} is better.` };
  if (c.p === null) return { keep: true, exact, reason: `Better: the score went ${nums}.` };
  const p = `p = ${plainNumber(c.p)}${second ? ` on ${after.runs.length} runs each` : ""}`;
  if (c.p >= alpha) return { keep: false, exact, reason: `Within noise: the score went ${nums}, but a move this size happens by chance (${p}).` };
  return { keep: true, exact, reason: `Better: the score went ${nums}, more than the noise explains (${p}).` };
}

// The keep rule for a number measure, one look: keep only when the candidate is better than the kept version by
// more than the runs' noise explains, at SCREEN_ALPHA. A screen alone keeps too many no-ops on a noisy measure;
// the loop uses decideWithConfirm for P06.
export function decide(direction: Direction, before: Measurement, after: Measurement): Decision {
  const { keep, reason } = look(direction, before, after, SCREEN_ALPHA, false);
  return { keep, reason };
}

/** Fresh measurements of the kept version and of the candidate, or the plain reason they failed. */
export type Remeasure = () => Promise<{ before: Measurement; after: Measurement } | { failed: string }>;

const join = (a: Measurement, b: Measurement): Measurement => {
  const runs = [...a.runs, ...b.runs];
  const s = [...runs].sort((x, y) => x - y), mid = Math.floor(s.length / 2);
  return { runs, value: s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2 };
};

// The full keep rule (P06). A candidate that passes the screen is measured again, and all its runs must beat all
// the kept version's runs at CONFIRM_ALPHA. An exact measure needs no second look: fresh runs give the same numbers.
// `before` and `after` in the answer are what result.json reports: the values over every run that was made.
export async function decideWithConfirm(direction: Direction, before: Measurement, after: Measurement, remeasure: Remeasure):
  Promise<Decision & { before: Measurement; after: Measurement }> {
  const first = look(direction, before, after, SCREEN_ALPHA, false);
  if (!first.keep || first.exact) return { keep: first.keep, reason: first.reason, before, after };
  const more = await remeasure();
  if ("failed" in more) return { keep: false, reason: `Could not measure again to confirm the gain: ${more.failed}`, before, after };
  const b = join(before, more.before), a = join(after, more.after);
  const second = look(direction, b, a, CONFIRM_ALPHA, true);
  return { keep: second.keep, reason: second.reason, before: b, after: a };
}
