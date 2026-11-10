import type { Direction, Measurement } from "./config.ts";

export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export const range = (xs: number[]) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0);

export type NotKept = "guard" | "worse" | "tests" | "noise";
export interface Verdict { win: boolean; why: string; delta: number; noise: number; reason?: NotKept }

// Plain numbers for the sentences below; units belong to the caller's formatting.
export const plainNumber = (n: number) => String(Number.isInteger(n) ? n : Number(n.toFixed(2)));

const MAX_NAMED = 3;

// Metrics that count passing tests have no separate regression check (a repo with failing tests is where that number
// has room to grow), so the tests are their own check. Without this, a change that fixes two failing tests and breaks
// a passing one wins by one. `failing` is set only for those metrics; null means the output did not say which tests failed.
export function brokenTests(baseline: Measurement, candidate: Measurement): string | null {
  if (candidate.failing === undefined) return null;
  if (candidate.failing !== null && candidate.failing.length === 0) return null;
  if (baseline.failing === undefined) return "Some tests still fail, and the current code was measured before Synthe recorded which tests fail, so a fixed test could be hiding a newly broken one. Run npx synthe improve again to measure it.";
  if (candidate.failing === null || baseline.failing === null) return "Some tests still fail, and Synthe could not tell which ones from the test output, so a fixed test could be hiding a newly broken one.";
  const before = new Set(baseline.failing);
  const broken = candidate.failing.filter((t) => !before.has(t));
  if (!broken.length) return null;
  const named = broken.slice(0, MAX_NAMED).join("; ") + (broken.length > MAX_NAMED ? `; and ${broken.length - MAX_NAMED} more` : "");
  return `It breaks ${broken.length === 1 ? "a test that" : `${broken.length} tests that`} passed in every run before: ${named}.`;
}

// A change wins only when it moves the median the right way by more than the runs already vary, the regression
// check (when there is one) still passes, and no test that passed before now fails. Anything else is not kept.
export function verdict(direction: Direction, baseline: Measurement, candidate: Measurement, guardPassed: boolean | null): Verdict {
  const delta = candidate.median - baseline.median;
  const noise = Math.max(range(baseline.runs), range(candidate.runs));
  const result = (win: boolean, why: string, reason?: NotKept): Verdict => ({ win, why, delta, noise, ...(reason && { reason }) });
  if (guardPassed === false) return result(false, "The regression check did not pass.", "guard");
  const better = direction === "higher" ? delta : -delta;
  if (better <= 0) return result(false, `Not better than the current code (${plainNumber(candidate.median)} vs ${plainNumber(baseline.median)}).`, "worse");
  const broken = brokenTests(baseline, candidate);
  if (broken) return result(false, broken, "tests");
  const d = plainNumber(Math.abs(delta));
  if (Math.abs(delta) <= noise) return result(false, `Within noise: changed by ${d}, but runs vary by up to ${plainNumber(noise)}.`, "noise");
  return result(true, `Better by ${d}, more than the run-to-run noise of ${plainNumber(noise)}${guardPassed ? "; the regression check passed." : "."}`);
}
