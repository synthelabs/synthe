// P06 (first half): with a noisy measure, `solve` keeps a no-op change in no more than 5% of seeded runs.
// How it decides: 80 seeded runs, each a fresh repo whose measure prints a fixed value plus seeded Gaussian noise
// (scale, noise, direction and names vary with the seed), with measure.runs 5. The proposer offers one change that
// the measure ignores. The noise is the same in every run of the check, so the result is repeatable. The check
// allows at most 6 kept runs of 80 (7.5%): a rule whose true rate is 5% passes about 90% of the time, a one-sided
// Welch t-test at 0.05 (true rate about 4.7%) about 92%, a rule at 2.5% more than 99%, and a rule at 10% about 30%.
import assert from "node:assert/strict";
import { test } from "node:test";
import { noisyRun, pool, workDir } from "./helpers-b.ts";

const RUNS = 80;
const MAX_KEPT = 6;

test(`solve keeps a no-op change in at most ${MAX_KEPT} of ${RUNS} seeded noisy runs`, async () => {
  const root = workDir("p06-noop");
  const kept = await pool(Array.from({ length: RUNS }, (_, i) => () => noisyRun("P06-noop", i + 1, 0, root)));
  const n = kept.filter(Boolean).length;
  assert.ok(n <= MAX_KEPT, `a no-op change was kept in ${n} of ${RUNS} runs (runs ${kept.flatMap((k, i) => (k ? [i + 1] : [])).join(", ")}); at most ${MAX_KEPT} may be kept`);
});
