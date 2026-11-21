// P06 (second half): with a noisy measure and measure.runs 5, `solve` keeps a real gain of two noise standard
// deviations in at least 80% of seeded runs.
// How it decides: 80 seeded runs, each a fresh repo whose measure prints a true value plus seeded Gaussian noise
// (scale, noise, direction and names vary with the seed). The proposer offers one change that moves the true value
// by two noise standard deviations in the good direction. The noise is the same in every run of the check. The check
// needs at least 60 kept runs of 80 (75%): a rule whose true power is 80% passes about 89% of the time, a one-sided
// Welch t-test at 0.05 (power about 88%) more than 99%, and a two-sided Welch t-test at 0.05 (power about 77%)
// about 72%.
import assert from "node:assert/strict";
import { test } from "node:test";
import { noisyRun, pool, workDir } from "./helpers-b.ts";

const RUNS = 80;
const MIN_KEPT = 60;

test(`solve keeps a gain of 2 noise standard deviations in at least ${MIN_KEPT} of ${RUNS} seeded noisy runs`, async () => {
  const root = workDir("p06-gain");
  const kept = await pool(Array.from({ length: RUNS }, (_, i) => () => noisyRun("P06-gain", i + 1, 2, root)));
  const n = kept.filter(Boolean).length;
  assert.ok(n >= MIN_KEPT, `a real gain of 2 noise standard deviations was kept in only ${n} of ${RUNS} runs; at least ${MIN_KEPT} must be kept`);
});
