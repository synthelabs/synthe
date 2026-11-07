import assert from "node:assert/strict";
import { test } from "node:test";
import type { Measurement } from "../src/improve/config.ts";
import { median, range, verdict } from "../src/improve/verdict.ts";

const m = (median: number, runs: number[]): Measurement => ({ commit: "c", median, runs, at: "2026-11-07T00:00:00Z" });

test("verdict: wins only beyond noise, in the right direction, with the guard green", () => {
  assert.equal(verdict("higher", m(3, [3]), m(12, [12]), true).win, true);
  assert.equal(verdict("higher", m(3, [3]), m(12, [12]), true).why, "Better by 9, more than the run-to-run noise of 0; the regression check passed.");
  assert.equal(verdict("lower", m(3, [3]), m(12, [12]), true).win, false);
  assert.equal(verdict("lower", m(3, [3]), m(12, [12]), true).why, "Not better than the current code (12 vs 3).");
  const within = verdict("higher", m(100, [98, 100, 103]), m(104, [102, 104, 107]), true);
  assert.equal(within.why, "Within noise: changed by 4, but runs vary by up to 5.");
  assert.deepEqual([within.win, within.delta, within.noise], [false, 4, 5]);
  assert.equal(verdict("lower", m(1000, [990, 1000, 1010]), m(800, [795, 800, 805]), true).win, true);
  assert.equal(verdict("higher", m(3, [3]), m(12, [12]), false).why, "The regression check did not pass.");
  const noGuard = verdict("higher", m(3, [3]), m(12, [12]), null);
  assert.equal(noGuard.win, true);
  assert.equal(noGuard.why, "Better by 9, more than the run-to-run noise of 0.");
  assert.equal(verdict("higher", m(5, [5]), m(5, [5]), true).win, false);
});

test("median and range", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(range([7]), 0);
  assert.equal(range([2, 9, 4]), 7);
});
