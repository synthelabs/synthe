import assert from "node:assert/strict";
import { test } from "node:test";
import { runOne } from "../scripts/practice-zoo.ts";

// Two practice-zoo problems end to end: every trap is refused and every real gain is kept.
for (const problem of ["holdout-trap", "measure-trap"]) {
  test(`practice zoo: ${problem} keeps the gains and refuses the traps`, async () => {
    const r = await runOne(problem, 1);
    assert.equal(r.error, undefined, r.error ?? "");
    assert.equal(r.code, 0);
    assert.equal(r.kept.TRAP, 0, "no trap is kept");
    assert.equal(r.kept.GAIN, r.offered.GAIN, "every gain is kept");
  });
}
