import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_RULE, resolveRule } from "../src/live/rule.ts";

test("rule: defaults", () => {
  assert.deepEqual(resolveRule(), { rule: DEFAULT_RULE, changed: [] });
  assert.equal(DEFAULT_RULE.alpha, 0.05); assert.equal(DEFAULT_RULE.min_days, 7); assert.equal(DEFAULT_RULE.max_days, 28);
});
test("rule: each changed setting is listed, an equal value is not", () => {
  assert.deepEqual(resolveRule({ min_days: 3, alpha: 0.05, aa_first: false }).changed, ["aa_first", "min_days"]);
});
test("rule: bad values name the setting", () => {
  assert.throws(() => resolveRule({ alpha: 0 }), /alpha must be above 0 and below 1/);
  assert.throws(() => resolveRule({ min_days: -1 }), /min_days must be 0 or more/);
  assert.throws(() => resolveRule({ min_days: 10, max_days: 5 }), /max_days must be at least min_days/);
  assert.throws(() => resolveRule({ method: "magic" as never }), /method must be fixed or looks/);
  assert.throws(() => resolveRule({ looks: 0 }), /looks must be a whole number from 1 to 60/);
  assert.throws(() => resolveRule({ holdout_share: 0.6 }), /holdout_share must be from 0 to 0.5/);
});
test("rule: max_days is checked against the effective min_days", () => {
  assert.throws(() => resolveRule({ min_days: 30 }), /max_days must be at least min_days/);
  assert.throws(() => resolveRule({ max_days: 3 }), /max_days must be at least min_days/);
  assert.equal(resolveRule({ min_days: 0, max_days: 0 }).rule.max_days, 0);
});
test("rule: wrong types and other bad values name the setting", () => {
  assert.throws(() => resolveRule({ alpha: "0.05" as never }), /alpha must be above 0 and below 1/);
  assert.throws(() => resolveRule({ alpha: 1 }), /alpha must be above 0 and below 1/);
  assert.throws(() => resolveRule({ max_days: Number.NaN }), /max_days must be at least min_days/);
  assert.throws(() => resolveRule({ min_units_per_arm: 1.5 }), /min_units_per_arm must be a whole number, 0 or more/);
  assert.throws(() => resolveRule({ min_events_per_arm: -2 }), /min_events_per_arm must be a whole number, 0 or more/);
  assert.throws(() => resolveRule({ srm_p: 1 }), /srm_p must be 0 or more and below 1/);
  assert.throws(() => resolveRule({ aa_first: "yes" as never }), /aa_first must be true or false/);
});
test("rule: unknown keys throw, an undefined value counts as not given", () => {
  assert.throws(() => resolveRule({ nope: 1 } as never), /unknown setting: nope/);
  assert.deepEqual(resolveRule({ alpha: undefined }), { rule: DEFAULT_RULE, changed: [] });
});
test("rule: returns a fresh object and never mutates the defaults", () => {
  const { rule } = resolveRule({ min_days: 3 });
  assert.notEqual(rule, DEFAULT_RULE);
  assert.equal(rule.min_days, 3);
  assert.equal(DEFAULT_RULE.min_days, 7);
  assert.throws(() => { (DEFAULT_RULE as { alpha: number }).alpha = 0.1; }, TypeError);
});
