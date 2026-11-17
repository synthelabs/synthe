import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_RULE, resolveRule } from "../src/live/rule.ts";

test("rule: defaults", () => {
  assert.deepEqual(resolveRule(), { rule: DEFAULT_RULE, changed: [] });
  assert.equal(DEFAULT_RULE.alpha, 0.05); assert.equal(DEFAULT_RULE.min_days, 7); assert.equal(DEFAULT_RULE.max_days, 28);
  assert.equal(DEFAULT_RULE.srm_p, 0.0001);
  assert.equal(DEFAULT_RULE.guard_missing, "block");
});
test("rule: guard_missing is block or ignore; anything else names the setting", () => {
  assert.equal(resolveRule({ guard_missing: "ignore" }).rule.guard_missing, "ignore");
  assert.deepEqual(resolveRule({ guard_missing: "ignore" }).changed, ["guard_missing"]);
  assert.throws(() => resolveRule({ guard_missing: "skip" as never }), /guard_missing must be block or ignore\./);
  assert.throws(() => resolveRule({ guard_missing: true as never }), /guard_missing must be block or ignore\./);
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

// Task 10: method "msprt" and whole_weeks. The method error keeps the phrase the older test checks for.
test("rule: msprt is a method; whole_weeks defaults to true and is listed when changed", () => {
  assert.equal(DEFAULT_RULE.method, "fixed");
  assert.equal(DEFAULT_RULE.whole_weeks, true);
  assert.deepEqual(resolveRule({ method: "msprt" }).changed, ["method"]);
  assert.equal(resolveRule({ method: "msprt" }).rule.whole_weeks, true);
  assert.deepEqual(resolveRule({ method: "msprt", whole_weeks: false }).changed, ["method", "whole_weeks"]);
});
test("rule: method error names msprt, whole_weeks must be true or false", () => {
  assert.throws(() => resolveRule({ method: "magic" as never }), /method must be fixed or looks, or msprt\./);
  assert.throws(() => resolveRule({ whole_weeks: "yes" as never }), /whole_weeks must be true or false\./);
});
