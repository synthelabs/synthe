import assert from "node:assert/strict";
import { test } from "node:test";
import { simulate } from "../scripts/simulate-live-gate.ts";
import { DEFAULT_RULE, resolveRule } from "../src/live/rule.ts";

test("simulation: an A/A run promotes at the stated rate or less", () => {
  const r = simulate({ runs: 1000, baseRate: 0.03, testRate: 0.03, unitsPerArmPerDay: 500, rule: DEFAULT_RULE, seed: 1 });
  assert.ok(r.promote <= 0.045, `${r.promote}`); assert.equal(r.invalid < 0.01, true);
});
test("simulation: the same seed gives the same result", () => {
  const o = { runs: 200, baseRate: 0.03, testRate: 0.036, unitsPerArmPerDay: 497, rule: DEFAULT_RULE, seed: 7 };
  assert.deepEqual(simulate(o), simulate(o));
});
// M6: with split units, the split check gets real work. At the default 0.0001 it must stay rare; at 0.001 it fires.
test("simulation: split units at srm_p 0.0001, an A/A run is invalid at 0.005 or less", () => {
  const r = simulate({ runs: 4000, baseRate: 0.03, testRate: 0.03, unitsPerArmPerDay: 500, rule: DEFAULT_RULE, seed: 5, splitUnits: true });
  assert.ok(r.invalid <= 0.005, `${r.invalid}`);
});
test("simulation: split units at srm_p 0.001 flags some A/A runs as invalid", () => {
  const r = simulate({ runs: 4000, baseRate: 0.03, testRate: 0.03, unitsPerArmPerDay: 500, rule: resolveRule({ srm_p: 0.001 }).rule, seed: 5, splitUnits: true });
  assert.ok(r.invalid > 0, `${r.invalid}`);
});
// Task 11: mSPRT. Without minEffect the gate answers invalid (no_min_effect), so an A/A run must not be all invalid.
test("simulation: msprt A/A, 400 runs, promotes at most 0.08", () => {
  const o = { runs: 400, baseRate: 0.03, testRate: 0.03, unitsPerArmPerDay: 500, rule: resolveRule({ method: "msprt" }).rule, seed: 11, minEffect: 0.006 };
  const r = simulate(o);
  assert.ok(r.promote <= 0.08, `${r.promote}`);
  assert.ok(r.invalid < 0.01, `${r.invalid}`);
});
test("simulation: msprt with the same options gives the same result twice", () => {
  const o = { runs: 200, baseRate: 0.03, testRate: 0.036, unitsPerArmPerDay: 497, rule: resolveRule({ method: "msprt" }).rule, seed: 12, minEffect: 0.006 };
  assert.deepEqual(simulate(o), simulate(o));
});
