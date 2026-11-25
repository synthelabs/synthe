import assert from "node:assert/strict";
import { test } from "node:test";
import { minWinsToPass, powerLines } from "../src/core/power.ts";
import { signP } from "../src/core/merge-rule.ts";
import { noWinSection, renderReport } from "../src/loop/report.ts";
import { newState } from "../src/core/state.ts";
import { goal } from "./helpers.ts";

test("minWinsToPass returns the smallest passing win count, checked against signP", () => {
  assert.equal(minWinsToPass(5, 0.05), 5);
  assert.equal(minWinsToPass(4, 0.05), null);
  assert.equal(minWinsToPass(20, 0.05), 15);
  for (const [n, p] of [[5, 0.05], [20, 0.05], [10, 0.1], [30, 0.05]] as const) {
    const w = minWinsToPass(n, p)!;
    assert.ok(signP(w, n - w) <= p);
    assert.ok(w === 0 || signP(w - 1, n - w + 1) > p, "one fewer win must not pass");
  }
});

test("powerLines states both thresholds and how many cases a 60/40 split needs", () => {
  const text = powerLines(goal(), 20, 10).join(" ");
  assert.match(text, /With 20 training cases, a change must be better in at least 15 and worse in at most 5 \(ties don't count\) to pass\./);
  assert.match(text, /With 10 held-back cases, at least 8 of 10\./);
  assert.match(text, /Adding about \d+ more cases your agent gets wrong/);
});

test("the no-win report includes the power lines when counts are known, and stays unchanged without them", () => {
  const state = { ...newState(), round: 3, stalls: 3, stopped: "3 rounds in a row found no winner" };
  assert.match(noWinSection(goal(), state, { train: 20, holdout: 10 }).join("\n"), /What your test cases can detect:.*at least 15/);
  assert.match(renderReport(goal(), state, new Date(), undefined, { train: 20, holdout: 10 }), /at least 15 and worse in at most 5/);
  assert.doesNotMatch(noWinSection(goal(), state).join("\n"), /can detect/);
});
