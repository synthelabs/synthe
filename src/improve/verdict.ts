import type { Direction, Measurement } from "./config.ts";

export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export const range = (xs: number[]) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);

export interface Verdict { win: boolean; why: string; delta: number; noise: number }

// Plain numbers for the sentences below; units belong to the caller's formatting.
export const plainNumber = (n: number) => String(Number.isInteger(n) ? n : Number(n.toFixed(2)));

// A change wins only when it moves the median the right way by more than the runs already vary, and the
// regression check (when there is one) still passes. Anything else is reported as not better.
export function verdict(direction: Direction, baseline: Measurement, candidate: Measurement, guardPassed: boolean | null): Verdict {
  const delta = candidate.median - baseline.median;
  const noise = Math.max(range(baseline.runs), range(candidate.runs));
  const result = (win: boolean, why: string): Verdict => ({ win, why, delta, noise });
  if (guardPassed === false) return result(false, "The regression check did not pass.");
  const better = direction === "higher" ? delta : -delta;
  if (better <= 0) return result(false, `Not better than the current code (${plainNumber(candidate.median)} vs ${plainNumber(baseline.median)}).`);
  const d = plainNumber(Math.abs(delta));
  if (Math.abs(delta) <= noise) return result(false, `Within noise: changed by ${d}, but runs vary by up to ${plainNumber(noise)}.`);
  return result(true, `Better by ${d}, more than the run-to-run noise of ${plainNumber(noise)}${guardPassed ? "; the regression check passed." : "."}`);
}
