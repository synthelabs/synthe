import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, type ArmData, type GateInput, type Reading, type Verdict } from "../src/live/gate.ts";
import { DEFAULT_RULE, resolveRule } from "../src/live/rule.ts";

const DAY = 86400000;
const START = "2026-01-01T00:00:00Z";
const iso = (day: number) => new Date(Date.parse(START) + day * DAY).toISOString();
const reading = (day: number, base: ArmData, test: ArmData): Reading => ({
  from: START,
  to: iso(day),
  read_at: iso(day),
  arms: { base, test },
});
const input = (readings: Reading[]): GateInput => ({
  direction: "higher",
  weights: { base: 50, test: 50 },
  readings,
  rule: DEFAULT_RULE,
  changed: [],
});
const at = (day: number, base: ArmData, test: ArmData): GateInput => input([reading(day, base, test)]);
const pick = (v: Verdict) => [v.action, v.reason];

test("gate: promote a real win at the end, higher is better", () => {
  const v = decide(at(28, { units: 10000, events: 300 }, { units: 10000, events: 360 }));
  assert.equal(v.action, "promote"); assert.equal(v.reason, "win"); assert.equal(v.days, 28);
});
test("gate: lower is better, the rate falls: promote", () => {
  assert.equal(decide({ ...at(28, { units: 10000, events: 360 }, { units: 10000, events: 300 }), direction: "lower" }).action, "promote");
});
test("gate: the same data in the wrong direction is dropped as worse", () => {
  const v = decide(at(28, { units: 10000, events: 360 }, { units: 10000, events: 300 }));
  assert.deepEqual([v.action, v.reason], ["drop", "worse"]);
});
test("gate: a tie keeps the current prompt", () => {
  assert.deepEqual(pick(decide(at(28, { units: 10000, events: 300 }, { units: 10000, events: 305 }))), ["drop", "no_difference"]);
});
test("gate: no promotion before the end, even with a strong result", () => {
  assert.deepEqual(pick(decide(at(10, { units: 10000, events: 300 }, { units: 10000, events: 400 }))), ["continue", "running"]);
});
test("gate: too early, empty arm, broken split", () => {
  assert.deepEqual(pick(decide(at(3, { units: 10000, events: 300 }, { units: 10000, events: 400 }))), ["continue", "too_early"]);
  assert.deepEqual(pick(decide(at(28, { units: 0, events: 0 }, { units: 10000, events: 400 }))), ["continue", "no_data"]);
  assert.deepEqual(pick(decide(at(28, { units: 5000, events: 150 }, { units: 5400, events: 200 }))), ["invalid", "split"]);
});
test("gate: a guard breach drops at once and names the guard", () => {
  const g = { name: "escalation rate", direction: "lower" as const, max_worse: 0.01, base: { units: 5000, events: 250 }, test: { units: 5000, events: 400 } };
  const v = decide({ ...at(2, { units: 5000, events: 150 }, { units: 5000, events: 200 }), guards: [g] });
  assert.deepEqual([v.action, v.reason, v.guard], ["drop", "guard", "escalation rate"]);
});
test("gate: looks method needs p below alpha / looks", () => {
  const { rule, changed } = resolveRule({ method: "looks", looks: 4 });
  const strong = { ...at(7, { units: 10000, events: 300 }, { units: 10000, events: 400 }), rule, changed };
  assert.equal(decide(strong).action, "promote"); assert.equal(decide(strong).look, 1); assert.deepEqual(decide(strong).changed, ["method"]);
  const weak = { ...at(7, { units: 10000, events: 300 }, { units: 10000, events: 360 }), rule, changed }; // p 0.0175 > 0.0125
  assert.deepEqual(pick(decide(weak)), ["continue", "running"]);
});
test("gate: split check off is a setting", () => {
  const { rule, changed } = resolveRule({ srm_p: 0 });
  assert.notEqual(decide({ ...at(28, { units: 5000, events: 150 }, { units: 5400, events: 200 }), rule, changed }).action, "invalid");
});
test("gate: means work the same way", () => {
  const v = decide({ ...at(28, { units: 1000, sum: 12000, sum_sq: 244000 }, { units: 1000, sum: 11000, sum_sq: 221000 }), direction: "lower" });
  assert.equal(v.action, "promote");
});

// One test per line of the order of checks, beyond the plan's cases above.
test("gate: no reading at all, or arms of different kinds, never promote", () => {
  assert.deepEqual([decide(input([])).action, decide(input([])).reason, decide(input([])).days], ["continue", "no_data", 0]);
  const mixed = decide(at(28, { units: 10000, events: 300 }, { units: 10000, sum: 1, sum_sq: 1 }));
  assert.deepEqual(pick(mixed), ["continue", "no_data"]);
});
test("gate: a guard arm with no units is skipped, not divided by", () => {
  // Without the skip, base 5/0 is Infinity and this would drop as a guard breach.
  const g = { name: "escalation rate", direction: "higher" as const, max_worse: 0.01, base: { units: 0, events: 5 }, test: { units: 5000, events: 10 } };
  const v = decide({ ...at(28, { units: 10000, events: 300 }, { units: 10000, events: 360 }), guards: [g] });
  assert.deepEqual(pick(v), ["promote", "win"]);
  // The min-units check also skips a 0-unit arm, so with min 0 only the zero-unit skip stops the breach.
  const alone = { ...at(28, { units: 10000, events: 300 }, { units: 10000, events: 360 }), guards: [g], rule: { ...DEFAULT_RULE, min_units_per_arm: 0 } };
  assert.deepEqual(pick(decide(alone)), ["promote", "win"]);
});
test("gate: an arm under min units is too early, even with enough events", () => {
  assert.deepEqual(pick(decide(at(28, { units: 90, events: 30 }, { units: 90, events: 60 }))), ["continue", "too_early"]);
});
test("gate: looks interval uses alpha / looks on every reading, fixed uses alpha", () => {
  const { rule, changed } = resolveRule({ method: "looks", looks: 4 });
  const v = decide({
    ...input([reading(7, { units: 10000, events: 300 }, { units: 10000, events: 360 }), reading(8, { units: 10000, events: 300 }, { units: 10000, events: 400 })]),
    rule,
    changed,
  });
  assert.ok(v.interval);
  assert.ok(Math.abs(v.interval[0] - 0.003508) < 1e-6, String(v.interval));
  assert.ok(Math.abs(v.interval[1] - 0.016492) < 1e-6, String(v.interval));
});
test("gate: bad weights (NaN) fail closed as a broken split", () => {
  const v = decide({ ...at(28, { units: 5000, events: 150 }, { units: 5400, events: 250 }), weights: { base: 50, test: Number.NaN } });
  assert.deepEqual(pick(v), ["invalid", "split"]);
});
test("gate: too early when an arm is under min units or min events", () => {
  assert.deepEqual(pick(decide(at(28, { units: 90, events: 5 }, { units: 90, events: 20 }))), ["continue", "too_early"]);
  assert.deepEqual(pick(decide(at(28, { units: 10000, events: 20 }, { units: 10000, events: 400 }))), ["continue", "too_early"]);
});
test("gate: looks, a look taken at an earlier reading is not taken again", () => {
  const { rule, changed } = resolveRule({ method: "looks", looks: 4 });
  // Look 1 is due at day 7 (7 * 4 >= 28 * 1). It is weak there, so no win and no promotion.
  // At day 8 the result is strong, but look 1 was already taken, so the gate must wait.
  const v = decide({
    ...input([reading(7, { units: 10000, events: 300 }, { units: 10000, events: 360 }), reading(8, { units: 10000, events: 300 }, { units: 10000, events: 400 })]),
    rule,
    changed,
  });
  assert.deepEqual(pick(v), ["continue", "running"]);
  assert.equal(v.look, 1);
});
test("gate: after the final look a later reading drops and never promotes", () => {
  const strong = { units: 10000, events: 400 };
  const weak = { units: 10000, events: 360 };
  const base = { units: 10000, events: 300 };
  const looks = resolveRule({ method: "looks", looks: 4 });
  const late = { ...input([reading(28, base, weak), reading(35, base, strong)]), rule: looks.rule, changed: looks.changed };
  assert.deepEqual(pick(decide(late)), ["drop", "no_difference"]);
  assert.deepEqual(pick(decide(input([reading(28, base, weak), reading(35, base, strong)]))), ["drop", "no_difference"]);
});

test("gate: a bad sign on the test reads as worse, not as a win, for lower", () => {
  const v = decide({ ...at(28, { units: 10000, events: 300 }, { units: 10000, events: 360 }), direction: "lower" });
  assert.deepEqual([v.action, v.reason], ["drop", "worse"]);
});
