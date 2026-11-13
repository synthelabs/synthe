import assert from "node:assert/strict";
import { test } from "node:test";
import { simulate } from "../scripts/simulate-live-gate.ts";
import { DEFAULT_RULE } from "../src/live/rule.ts";

test("simulation: an A/A run promotes at the stated rate or less", () => {
  const r = simulate({ runs: 1000, baseRate: 0.03, testRate: 0.03, unitsPerArmPerDay: 500, rule: DEFAULT_RULE, seed: 1 });
  assert.ok(r.promote <= 0.045, `${r.promote}`); assert.equal(r.invalid < 0.01, true);
});
test("simulation: the same seed gives the same result", () => {
  const o = { runs: 200, baseRate: 0.03, testRate: 0.036, unitsPerArmPerDay: 497, rule: DEFAULT_RULE, seed: 7 };
  assert.deepEqual(simulate(o), simulate(o));
});
