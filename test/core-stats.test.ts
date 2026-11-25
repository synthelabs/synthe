import assert from "node:assert/strict";
import { test } from "node:test";
import { meanSummary, studentTCdf } from "../src/core/stats.ts";

// Moved from the pilot's statistics tests when the pilot left this package: Solve's decision (src/solve/decide.ts)
// uses these two functions.

const near = (actual: number | null | undefined, expected: number, tol: number, what = "") => {
  assert.ok(typeof actual === "number" && Number.isFinite(actual), `${what}: expected a number, got ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} is not within ${tol} of ${expected}`);
};

test("Student t CDF matches published tables", () => {
  const table: [number, number, number][] = [
    [2.228139, 10, 0.975], [4.302653, 2, 0.975], [2.570582, 5, 0.975], [2.042272, 30, 0.975], [1.979930, 120, 0.975],
    [2.131847, 4, 0.95], [5.840909, 3, 0.995], [31.599055, 2, 0.9995], [3.849516, 20, 0.9995], [63.656741, 1, 0.995],
  ];
  for (const [t, df, p] of table) near(studentTCdf(t, df), p, 1e-6, `F(${t}, ${df})`);
  near(studentTCdf(-2.228139, 10), 0.025, 1e-6, "lower tail is symmetric");
  near(studentTCdf(0, 7), 0.5, 1e-15, "zero is the median");
  // Welch degrees of freedom are fractional: the CDF at a fixed t must sit between the neighbouring integer values.
  const mid = studentTCdf(2.2, 10.5)!;
  assert.ok(mid > studentTCdf(2.2, 10)! && mid < studentTCdf(2.2, 11)!, `F(2.2, 10.5) = ${mid}`);
  assert.equal(studentTCdf(2, 0), null);
  assert.equal(studentTCdf(Number.NaN, 10), null);
  assert.equal(studentTCdf(2, Number.POSITIVE_INFINITY), null);
});

test("mean summary gives n, the mean and the sample standard deviation", () => {
  const s = meanSummary([2, 4, 4, 4, 5, 5, 7, 9]);
  assert.equal(s.n, 8);
  near(s.mean, 5, 1e-12, "mean");
  near(s.sd, Math.sqrt(32 / 7), 1e-12, "sample sd uses n - 1");
  assert.deepEqual(meanSummary([3]), { n: 1, mean: 3, sd: null });
  assert.deepEqual(meanSummary([]), { n: 0, mean: null, sd: null });
});
