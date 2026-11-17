import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, type ArmData, type GateInput, type GuardReading, type Reading, type Verdict } from "../src/live/gate.ts";
import { DEFAULT_RULE, resolveRule, type LiveRule } from "../src/live/rule.ts";
import { msprtHalfWidth, rateVariance } from "../src/live/stats.ts";

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
  // Under guard_missing "ignore" this is today's behaviour: the missing guard is skipped and the win stands.
  const ignore = { ...DEFAULT_RULE, guard_missing: "ignore" as const };
  const v = decide({ ...at(28, { units: 10000, events: 300 }, { units: 10000, events: 360 }), guards: [g], rule: ignore });
  assert.deepEqual(pick(v), ["promote", "win"]);
  // The min-units check also skips a 0-unit arm, so with min 0 only the zero-unit skip stops the breach.
  const alone = { ...at(28, { units: 10000, events: 300 }, { units: 10000, events: 360 }), guards: [g], rule: { ...ignore, min_units_per_arm: 0 } };
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

// Final-review items: bad arm values, the look ledger, and one-arm sparse data.
test("gate: a bad arm value fails closed as no data", () => {
  // events above units is not a rate; it must never reach a test.
  assert.deepEqual(pick(decide(at(28, { units: 10000, events: 300 }, { units: 10000, events: 12000 }))), ["continue", "no_data"]);
  assert.deepEqual(pick(decide(at(28, { units: 10000, events: -5 }, { units: 10000, events: 360 }))), ["continue", "no_data"]);
  assert.deepEqual(pick(decide(at(28, { units: Number.NaN, events: 300 }, { units: 10000, events: 360 }))), ["continue", "no_data"]);
  assert.deepEqual(pick(decide(at(28, { units: 1000, sum: Number.NaN, sum_sq: 5 }, { units: 1000, sum: 11000, sum_sq: 221000 }))), ["continue", "no_data"]);
  assert.deepEqual(pick(decide(at(28, { units: 1000, sum: 12000, sum_sq: -1 }, { units: 1000, sum: 11000, sum_sq: 221000 }))), ["continue", "no_data"]);
});
test("gate: a look is not lost when its first reading was too early", () => {
  const v = decide(input([
    reading(28, { units: 2800, events: 22 }, { units: 2800, events: 60 }), // too early: base has under 25 events
    reading(29, { units: 2900, events: 25 }, { units: 2900, events: 63 }),
  ]));
  assert.deepEqual(pick(v), ["promote", "win"]);
});
test("gate: a ledger whose window end goes back is no data", () => {
  const arms = [{ units: 10000, events: 300 }, { units: 10000, events: 360 }] as const;
  assert.deepEqual(pick(decide(input([reading(14, arms[0], arms[1]), reading(13, arms[0], arms[1]), reading(15, arms[0], arms[1])]))), ["continue", "no_data"]);
});
test("gate: a reading whose end is not a date is no data", () => {
  const bad = { ...reading(28, { units: 10000, events: 300 }, { units: 10000, events: 360 }), to: "?" };
  assert.deepEqual(pick(decide(input([bad]))), ["continue", "no_data"]);
});
test("gate: one sparse arm is too early on its own (test arm units)", () => {
  assert.deepEqual(pick(decide({ ...at(28, { units: 10000, events: 300 }, { units: 90, events: 30 }), weights: { base: 10000, test: 90 } })), ["continue", "too_early"]);
});
test("gate: one sparse arm is too early on its own (base arm units)", () => {
  assert.deepEqual(pick(decide({ ...at(28, { units: 90, events: 30 }, { units: 10000, events: 300 }), weights: { base: 90, test: 10000 }, direction: "lower" })), ["continue", "too_early"]);
});
test("gate: one sparse arm is too early on its own (test arm events)", () => {
  assert.deepEqual(pick(decide({ ...at(28, { units: 10000, events: 300 }, { units: 10000, events: 20 }), direction: "lower" })), ["continue", "too_early"]);
});

// M4: a guard with too little data blocks a promotion by default (fail closed). It never causes a drop before the end.
const missingGuard = (units: number) => ({
  name: "escalation rate", direction: "lower" as const, max_worse: 0.01,
  base: { units, events: 0 }, test: { units: 5000, events: 250 },
});
test("gate: a missing guard blocks a promotion at the final decision, and names the guard", () => {
  const v = decide({ ...at(28, { units: 10000, events: 300 }, { units: 10000, events: 360 }), guards: [missingGuard(0)] });
  assert.deepEqual([v.action, v.reason, v.guard], ["drop", "guard_no_data", "escalation rate"]);
});
test("gate: a missing guard before the end is continue, not drop", () => {
  const { rule, changed } = resolveRule({ method: "looks", looks: 4 });
  const v = decide({ ...at(7, { units: 10000, events: 300 }, { units: 10000, events: 400 }), rule, changed, guards: [missingGuard(0)] });
  assert.deepEqual([v.action, v.reason, v.guard, v.look], ["continue", "guard_no_data", "escalation rate", 1]);
});
test("gate: guard_missing ignore promotes the same input, and the setting is listed as changed", () => {
  const { rule, changed } = resolveRule({ guard_missing: "ignore" });
  const v = decide({ ...at(28, { units: 10000, events: 300 }, { units: 10000, events: 360 }), rule, changed, guards: [missingGuard(0)] });
  assert.deepEqual([v.action, v.reason], ["promote", "win"]);
  assert.deepEqual(v.changed, ["guard_missing"]);
});
test("gate: a guard with 50 units is missing too (below min_units_per_arm 100)", () => {
  const v = decide({ ...at(28, { units: 10000, events: 300 }, { units: 10000, events: 360 }), guards: [missingGuard(50)] });
  assert.deepEqual([v.action, v.reason, v.guard], ["drop", "guard_no_data", "escalation rate"]);
});
test("gate: a missing guard never changes running, too early, worse or no difference", () => {
  const g = [missingGuard(0)];
  assert.deepEqual(pick(decide({ ...at(10, { units: 10000, events: 300 }, { units: 10000, events: 400 }), guards: g })), ["continue", "running"]);
  assert.deepEqual(pick(decide({ ...at(3, { units: 10000, events: 300 }, { units: 10000, events: 400 }), guards: g })), ["continue", "too_early"]);
  assert.deepEqual(pick(decide({ ...at(28, { units: 10000, events: 360 }, { units: 10000, events: 300 }), guards: g })), ["drop", "worse"]);
  assert.deepEqual(pick(decide({ ...at(28, { units: 10000, events: 300 }, { units: 10000, events: 305 }), guards: g })), ["drop", "no_difference"]);
});
test("gate: a missing guard with a tie is no difference, not a guard drop", () => {
  const g = { ...missingGuard(0), base: { units: 0, events: 5 } };
  assert.deepEqual(pick(decide({ ...at(28, { units: 10000, events: 300 }, { units: 10000, events: 305 }), guards: [g] })), ["drop", "no_difference"]);
});
// Guard arms with unusable numbers are missing data, not a skip that lets a promotion through.
const badGuard = (base: ArmData, test: ArmData) => ({
  name: "escalation rate", direction: "lower" as const, max_worse: 0.01, base, test,
});
test("gate: a guard arm with NaN units blocks a promotion as no guard data", () => {
  const g = badGuard({ units: 5000, events: 250 }, { units: Number.NaN, events: 5 });
  const v = decide({ ...at(28, { units: 10000, events: 300 }, { units: 10000, events: 360 }), guards: [g] });
  assert.deepEqual([v.action, v.reason, v.guard], ["drop", "guard_no_data", "escalation rate"]);
});
test("gate: a guard arm with events above units blocks a promotion as no guard data", () => {
  const g = badGuard({ units: 5000, events: 6000 }, { units: 5000, events: 250 });
  const v = decide({ ...at(28, { units: 10000, events: 300 }, { units: 10000, events: 360 }), guards: [g] });
  assert.deepEqual([v.action, v.reason, v.guard], ["drop", "guard_no_data", "escalation rate"]);
});
test("gate: a guard with a rate arm and a mean arm blocks a promotion as no guard data", () => {
  const g = badGuard({ units: 5000, events: 250 }, { units: 5000, sum: 1, sum_sq: 1 });
  const v = decide({ ...at(28, { units: 10000, events: 300 }, { units: 10000, events: 360 }), guards: [g] });
  assert.deepEqual([v.action, v.reason, v.guard], ["drop", "guard_no_data", "escalation rate"]);
});

// Task 10: method "msprt". Reference values from Python on 2026-11-17, min_effect 0.006.
const MS = resolveRule({ method: "msprt" });
const msInput = (readings: Reading[], extra: Partial<GateInput> = {}): GateInput => ({
  ...input(readings), rule: MS.rule, changed: MS.changed, min_effect: 0.006, ...extra,
});
const msAt = (day: number, base: ArmData, test: ArmData, extra: Partial<GateInput> = {}): GateInput =>
  msInput([reading(day, base, test)], extra);
const R = (events: number, units: number): ArmData => ({ units, events });

test("msprt: a win at day 7 promotes, and the method is the only change", () => {
  const v = decide(msAt(7, R(300, 10000), R(420, 10000)));
  assert.deepEqual(pick(v), ["promote", "win"]);
  assert.deepEqual(v.changed, ["method"]);
  assert.ok(v.msprt);
  assert.ok(Math.abs(Math.exp(v.msprt.ln_lambda) / 2427.46 - 1) < 1e-4, String(Math.exp(v.msprt.ln_lambda)));
});
test("msprt: a weak reading at day 7 keeps running", () => {
  assert.deepEqual(pick(decide(msAt(7, R(300, 10000), R(360, 10000)))), ["continue", "running"]);
});
test("msprt: lower is better, the rate falls at day 7: promote", () => {
  assert.deepEqual(pick(decide({ ...msAt(7, R(420, 10000), R(300, 10000)), direction: "lower" })), ["promote", "win"]);
});
test("msprt: trap, a strong bad reading on a non-deciding day is not a decision and never promotes", () => {
  const v = decide(msInput([
    reading(7, R(300, 10000), R(300, 10000)),
    reading(10, R(430, 14000), R(300, 14000)), // bad: Lambda 14921.8, but day 10 is not a decision reading
    reading(14, R(600, 20000), R(610, 20000)), // good but weak: Lambda 0.29, so the latest reading decides
  ]));
  assert.deepEqual(pick(v), ["continue", "running"]);
  assert.ok(v.msprt);
  assert.ok(Math.abs(Math.exp(v.msprt.ln_lambda) - 0.29) < 0.01, String(Math.exp(v.msprt.ln_lambda)));
});
test("msprt: a reading in the same week as an earlier one is not a decision reading", () => {
  assert.deepEqual(pick(decide(msInput([reading(7, R(300, 10000), R(360, 10000)), reading(8, R(300, 10000), R(420, 10000))]))), ["continue", "running"]);
});
test("msprt: with whole_weeks false the same readings promote", () => {
  const { rule, changed } = resolveRule({ method: "msprt", whole_weeks: false });
  const v = decide({ ...msInput([reading(7, R(300, 10000), R(360, 10000)), reading(8, R(300, 10000), R(420, 10000))]), rule, changed });
  assert.deepEqual(pick(v), ["promote", "win"]);
  assert.deepEqual(v.changed, ["method", "whole_weeks"]);
});
test("msprt: at day 28 a small difference is drop, no_difference", () => {
  const v = decide(msAt(28, R(300, 10000), R(330, 10000)));
  assert.deepEqual(pick(v), ["drop", "no_difference"]);
  assert.ok(Math.abs(Math.exp(v.msprt!.ln_lambda) - 0.72) < 0.01, String(Math.exp(v.msprt!.ln_lambda)));
});
test("msprt: min_effect missing, 0, negative or not finite is invalid, never a silent switch", () => {
  for (const bad of [undefined, 0, -0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
    const v = decide({ ...msAt(28, R(300, 10000), R(420, 10000)), min_effect: bad });
    assert.deepEqual(pick(v), ["invalid", "no_min_effect"], String(bad));
  }
});
test("msprt: the min_effect check runs before the too-early check", () => {
  assert.deepEqual(pick(decide({ ...msAt(3, R(300, 10000), R(420, 10000)), min_effect: 0 })), ["invalid", "no_min_effect"]);
});
test("msprt: a very strong reading is compared in logs and still promotes", () => {
  const v = decide(msAt(7, R(300, 10000), R(3000, 10000)));
  assert.deepEqual(pick(v), ["promote", "win"]);
  assert.ok(Number.isFinite(v.msprt!.ln_lambda));
});
test("msprt: the verdict keeps every number through JSON", () => {
  const v = decide(msAt(7, R(300, 10000), R(420, 10000)));
  assert.deepEqual(JSON.parse(JSON.stringify(v)), v);
});
test("msprt: a reading whose msprt log is null adds to no maximum and puts no NaN in the verdict", () => {
  const { rule, changed } = resolveRule({ method: "msprt", min_events_per_arm: 0 });
  const v = decide({ ...msAt(28, R(0, 10000), R(10000, 10000)), rule, changed });
  assert.deepEqual(pick(v), ["drop", "no_difference"]);
  assert.equal(v.msprt, undefined);
  assert.ok(!JSON.stringify(v).includes("NaN"));
  const early = decide({ ...msAt(7, R(0, 10000), R(10000, 10000)), rule, changed });
  assert.deepEqual(pick(early), ["continue", "running"]);
});
test("msprt: a missing guard blocks a promotion at the end, and before the end it waits", () => {
  const g = { name: "escalation rate", direction: "lower" as const, max_worse: 0.01, base: { units: 0, events: 0 }, test: { units: 5000, events: 250 } };
  assert.deepEqual(pick(decide({ ...msAt(28, R(300, 10000), R(420, 10000)), guards: [g] })), ["drop", "guard_no_data"]);
  assert.deepEqual(pick(decide({ ...msAt(7, R(300, 10000), R(420, 10000)), guards: [g] })), ["continue", "guard_no_data"]);
});
test("msprt: a guard breach drops at once", () => {
  const g = { name: "escalation rate", direction: "lower" as const, max_worse: 0.01, base: { units: 5000, events: 250 }, test: { units: 5000, events: 400 } };
  const v = decide({ ...msAt(7, R(300, 10000), R(420, 10000)), guards: [g] });
  assert.deepEqual([v.action, v.reason, v.guard], ["drop", "guard", "escalation rate"]);
});
test("msprt: the default method is still fixed, and a fixed verdict has no msprt field", () => {
  const v = decide(at(28, R(300, 10000), R(360, 10000)));
  assert.equal(v.msprt, undefined);
  assert.equal(DEFAULT_RULE.method, "fixed");
});

// Review of Task 10 (2026-11-17): a drop is final, the bad side wins, the latest reading must be usable and
// good, week 0 never decides, and the threshold and earlier-reading filter are pinned.
const M = (units: number, sum: number, sum_sq: number): ArmData => ({ units, sum, sum_sq });
const msRule = (partial: Partial<LiveRule> = {}) => resolveRule({ method: "msprt", ...partial });
test("msprt review: an old good crossing does not promote a reading that is now worse", () => {
  const v = decide(msInput([
    reading(7, R(300, 10000), R(360, 10000)),
    reading(8, R(340, 11400), R(470, 11400)), // good, Lambda 4045; not a decision reading (week 1)
    reading(14, R(700, 20000), R(560, 20000)), // bad, Lambda 460
  ]));
  assert.deepEqual(pick(v), ["drop", "worse"]);
});
test("msprt review: a latest reading with no usable ln, or not good, cannot promote", () => {
  const { rule, changed } = msRule({ whole_weeks: false });
  const v = decide({
    ...msInput([
      reading(7, M(1000, 12000, 244000), M(1000, 14000, 296000)), // good, Lambda about 171: a decision reading
      reading(8, M(1000, 12000, 244000), M(1000, 14000, 1000)), // impossible variance: no ln
    ]),
    rule, changed, min_effect: 0.5,
  });
  assert.deepEqual(pick(v), ["continue", "running"]);
  assert.equal(v.msprt, undefined);
});
test("msprt review: a drop at max_days is final; a later strong good reading does not promote", () => {
  assert.deepEqual(pick(decide(msInput([
    reading(28, R(300, 10000), R(330, 10000)),
    reading(29, R(310, 10400), R(460, 10400)), // Lambda 139834, good
  ]))), ["drop", "no_difference"]);
});
test("msprt review: a bad reading on a non-deciding day does not end the test; day 21 promotes on its own numbers", () => {
  assert.deepEqual(pick(decide(msInput([
    reading(7, R(300, 10000), R(300, 10000)),
    reading(10, R(430, 14000), R(300, 14000)), // bad, Lambda 14921, not a decision reading
    reading(14, R(600, 20000), R(610, 20000)), // weak, not a crossing
    reading(21, R(900, 30000), R(1250, 30000)), // strong good, Lambda clears ln(20) on its own
  ]))), ["promote", "win"]);
});
test("msprt review: a decision uses only that reading, not an earlier crossing on either side", () => {
  assert.deepEqual(pick(decide(msInput([
    reading(7, R(300, 10000), R(300, 10000)),
    reading(10, R(430, 14000), R(300, 14000)), // bad, Lambda 14921; day 10 is not a decision reading
    reading(12, R(480, 16800), R(600, 16800)), // good, Lambda 158; week 1, not a decision
    reading(14, R(600, 20000), R(700, 20000)), // good, Lambda 10.98: below ln(20), so it continues
  ]))), ["continue", "running"]);
});
test("msprt review: week 0 never decides, even when min_days is below 7", () => {
  const { rule, changed } = msRule({ min_days: 3 });
  assert.deepEqual(pick(decide({ ...msInput([reading(3, R(300, 10000), R(420, 10000))]), rule, changed })), ["continue", "running"]);
  assert.deepEqual(pick(decide({ ...msInput([reading(3, R(300, 10000), R(420, 10000)), reading(7, R(300, 10000), R(420, 10000))]), rule, changed })), ["promote", "win"]);
});
test("msprt review: the threshold is ln(1/alpha): Lambda 18.19 continues, Lambda 21.99 promotes", () => {
  assert.deepEqual(pick(decide(msAt(7, R(300, 10000), R(377, 10000)))), ["continue", "running"]);
  assert.deepEqual(pick(decide(msAt(7, R(300, 10000), R(379, 10000)))), ["promote", "win"]);
});
test("msprt review: a reading too early under min_days is not replayed into the maxima", () => {
  // Day 5 is too early (min_days 7) and has Lambda 2427; the day 7 reading alone is not good enough.
  assert.deepEqual(pick(decide(msInput([reading(5, R(300, 10000), R(420, 10000)), reading(7, R(600, 20000), R(640, 20000))]))), ["continue", "running"]);
});
test("msprt review: p_latest and the interval on the Lambda 21.99 win", () => {
  const v = decide(msAt(7, R(300, 10000), R(379, 10000)));
  assert.ok(v.msprt);
  assert.ok(Math.abs(v.msprt.p_latest - Math.exp(-v.msprt.ln_lambda)) < 1e-12);
  assert.ok(v.msprt.p_latest < 0.05, String(v.msprt.p_latest));
  assert.ok(v.interval);
  const h = msprtHalfWidth(rateVariance({ units: 10000, events: 300 }, { units: 10000, events: 379 })!, 0.006, 0.05)!;
  assert.ok(Math.abs(v.interval[0] - (v.msprt.d - h)) < 1e-12);
  assert.ok(Math.abs(v.interval[1] - (v.msprt.d + h)) < 1e-12);
  assert.ok(v.interval[0] > 0, "0 must be outside the interval");
});
test("msprt review: a good crossing before, then a latest reading in the bad direction with no bad crossing, does not promote", () => {
  // Day 7 is good (Lambda 2427, a decision reading). Day 14 has D < 0 with Lambda about 0.28: no bad crossing, no promotion.
  assert.deepEqual(pick(decide(msInput([
    reading(7, R(300, 10000), R(420, 10000)),
    reading(14, R(600, 20000), R(590, 20000)),
  ]))), ["continue", "running"]);
});
// Re-review of c0a379b: each test below fails against one named mutant and passes on the current code.
test("msprt re-review: a split-broken earlier reading stops the experiment, so a later weak reading is invalid", () => {
  // Day 7 is strong but its arms are split 10000 vs 13000 (broken). The experiment stops there (S4), so day 8 is invalid.
  const { rule, changed } = msRule({ whole_weeks: false });
  assert.deepEqual(pick(decide({ ...msInput([
    reading(7, R(300, 10000), R(900, 13000)),
    reading(8, R(300, 10000), R(360, 10000)),
  ]), rule, changed })), ["invalid", "split"]);
});
test("msprt re-review: the threshold is ln(1/alpha), not a fixed ln(20)", () => {
  // Lambda 21.99 clears ln(20) but not ln(100), the threshold at alpha 0.01.
  const { rule, changed } = msRule({ alpha: 0.01 });
  assert.deepEqual(pick(decide({ ...msAt(7, R(300, 10000), R(379, 10000)), rule, changed })), ["continue", "running"]);
});
test("msprt re-review: max_days decides, so no promotion after the end", () => {
  const { rule, changed } = msRule({ max_days: 10 });
  assert.deepEqual(pick(decide({ ...msInput([
    reading(7, R(300, 10000), R(360, 10000)),
    reading(10, R(430, 14300), R(515, 14300)), // the end: no difference, so drop
    reading(14, R(600, 20000), R(780, 20000)), // strong good, but after the end
  ]), rule, changed })), ["drop", "no_difference"]);
});
test("msprt re-review: a worse decision stays a drop when a later reading in the same week is strong", () => {
  assert.deepEqual(pick(decide(msInput([
    reading(7, R(300, 10000), R(360, 10000)), // weak, decision, keeps running
    reading(14, R(700, 20000), R(560, 20000)), // decision, bad, Lambda 460: drop worse
    reading(15, R(750, 21400), R(1000, 21400)), // week 2 again: not a decision reading, and strong
  ]))), ["drop", "worse"]);
});
test("msprt re-review: an earlier decision at max_days is final, even when it could have promoted", () => {
  // Day 28 would have promoted (Lambda 7.79), so the first decision reading at max_days ends the experiment.
  // The strong good day 29 reading does not promote.
  assert.deepEqual(pick(decide(msInput([
    reading(28, R(300, 10000), R(420, 10000)),
    reading(29, R(310, 10400), R(460, 10400)),
  ]))), ["drop", "no_difference"]);
});

// Task 12 (final review B1): mSPRT decides on the latest reading's own ln Lambda. A glitched earlier reading (day 8,
// Lambda 4045, not a decision reading) must not promote the weak honest day 14 reading.
test("msprt B1: a glitched earlier reading does not promote a later weak honest reading", () => {
  assert.deepEqual(pick(decide(msInput([
    reading(7, R(300, 10000), R(300, 10000)),
    reading(8, R(340, 11400), R(470, 11400)),
    reading(14, R(600, 20000), R(610, 20000)),
  ]))), ["continue", "running"]);
});
test("msprt B1: a too-early reading that has a crossing does not use up week 1's decision", () => {
  // Day 7 has 20 events in each arm, so it is too early and must not count; day 8 is then week 1's first decision.
  assert.deepEqual(pick(decide(msInput([
    reading(7, R(20, 1000), R(20, 1000)),
    reading(8, R(300, 10000), R(420, 10000)),
  ]))), ["promote", "win"]);
});

// Task 12 (final review S1): decide validates the rule itself and uses the resolved rule. A stored or hand-written
// rule with a missing or misspelled setting gets the safe defaults, and a bad value is invalid.
const without = (keys: (keyof LiveRule)[], base: LiveRule): LiveRule => {
  const r: Partial<LiveRule> = { ...base };
  for (const k of keys) delete r[k];
  return r as LiveRule;
};
test("S1: a rule with a misspelled method is invalid, never a silent fixed", () => {
  const rule = { ...DEFAULT_RULE, method: "MSPRT" } as unknown as LiveRule;
  assert.deepEqual(pick(decide({ ...at(28, R(300, 10000), R(360, 10000)), rule })), ["invalid", "bad_input"]);
});
test("S1: a rule without guard_missing takes the default (block), so the guard with no units blocks", () => {
  const g = { name: "escalation rate", direction: "lower" as const, max_worse: 0.01, base: { units: 0, events: 0 }, test: { units: 5000, events: 250 } };
  const rule = without(["guard_missing"], DEFAULT_RULE);
  assert.deepEqual(pick(decide({ ...at(28, R(300, 10000), R(360, 10000)), rule, guards: [g] })), ["drop", "guard_no_data"]);
});
test("S1: a msprt rule without whole_weeks takes the default, so a mid-week strong reading does not decide", () => {
  const rule = without(["whole_weeks"], MS.rule);
  assert.deepEqual(pick(decide({ ...msInput([
    reading(7, R(300, 10000), R(360, 10000)),
    reading(8, R(300, 10000), R(420, 10000)),
  ]), rule })), ["continue", "running"]);
});

// Task 14 (SF1, corrects Task 12 S2): a guard whose direction or max_worse cannot be read is a bad setting, not
// missing data. It is invalid in every method and under either guard_missing, so a real breach is never waved through.
const escalation = (direction: string, max_worse: number | undefined) => ({
  name: "escalation rate", direction, max_worse, base: { units: 5000, events: 250 }, test: { units: 5000, events: 750 },
}) as unknown as GuardReading;
for (const guard_missing of ["block", "ignore"] as const) {
  const rule = resolveRule({ guard_missing }).rule;
  const cases: [string, GuardReading][] = [
    ["max_worse NaN", escalation("lower", Number.NaN)],
    ["max_worse -0.01", escalation("lower", -0.01)],
    ["max_worse undefined", escalation("lower", undefined)],
    ["direction Lower (capital L)", escalation("Lower", 0.01)],
  ];
  for (const [label, guard] of cases) {
    test(`SF1: a guard with ${label} is invalid, bad_input (guard_missing ${guard_missing})`, () => {
      const v = decide({ ...at(28, R(300, 10000), R(360, 10000)), rule, guards: [guard] });
      assert.deepEqual(pick(v), ["invalid", "bad_input"]);
    });
  }
}
test("SF1: the reviewer's msprt case: a guard named Higher on a falling metric is invalid under block and ignore", () => {
  const guard = { name: "csat", direction: "Higher", max_worse: 0.01, base: { units: 1500, events: 1500 }, test: { units: 10000, events: 500 } } as unknown as GuardReading;
  for (const guard_missing of ["block", "ignore"] as const) {
    const rule = resolveRule({ method: "msprt", guard_missing }).rule;
    const v = decide({ ...msAt(7, R(300, 10000), R(420, 10000)), rule, guards: [guard] });
    assert.deepEqual(pick(v), ["invalid", "bad_input"], guard_missing);
  }
});
test("SF1: a readable guard with a real breach still drops at once under guard_missing ignore", () => {
  const breach = { name: "escalation rate", direction: "lower" as const, max_worse: 0.01, base: { units: 5000, events: 250 }, test: { units: 5000, events: 400 } };
  const v = decide({ ...at(28, R(300, 10000), R(360, 10000)), rule: resolveRule({ guard_missing: "ignore" }).rule, guards: [breach] });
  assert.deepEqual([v.action, v.reason, v.guard], ["drop", "guard", "escalation rate"]);
});

// Task 12 (S3): a primary direction that is not "higher" or "lower" is invalid in every method, before any test.
test("S3: a direction other than higher or lower is invalid, bad_input, in fixed, looks and msprt", () => {
  for (const bad of [undefined, "Higher", "up"]) {
    const dir = bad as unknown as "higher";
    const fixed = decide({ ...at(28, R(300, 10000), R(420, 10000)), direction: dir });
    const looks = decide({ ...at(28, R(300, 10000), R(420, 10000)), rule: resolveRule({ method: "looks" }).rule, direction: dir });
    const msprt = decide({ ...msAt(7, R(420, 10000), R(300, 10000)), direction: dir });
    for (const v of [fixed, looks, msprt]) assert.deepEqual(pick(v), ["invalid", "bad_input"], String(bad));
  }
});

// Task 12 (S4): a broken split at any earlier reading with usable arms stops the experiment, in every method.
test("S4: a broken split at an earlier reading makes a later winning reading invalid, split, in every method", () => {
  const broken = reading(7, R(300, 10000), { units: 10600, events: 300 });
  const win = reading(28, R(1200, 40000), R(1440, 40600));
  for (const method of ["fixed", "looks", "msprt"] as const) {
    const { rule, changed } = resolveRule({ method });
    const v = decide({ ...input([broken, win]), rule, changed, min_effect: 0.006 });
    assert.deepEqual(pick(v), ["invalid", "split"], method);
  }
  const v = decide({ ...msInput([reading(7, R(300, 10000), { units: 10600, events: 300 }), reading(14, R(600, 20000), R(760, 20600))]) });
  assert.deepEqual(pick(v), ["invalid", "split"]);
});

// Task 14: a rule that is not a plain object is bad input. undefined, null and {} still mean all defaults.
test("rule shape: a rule that is a number, a string, true or an array is invalid, bad_input", () => {
  for (const bad of [5, "msprt", true, []]) {
    const v = decide({ ...at(28, R(300, 10000), R(360, 10000)), rule: bad as unknown as LiveRule });
    assert.deepEqual(pick(v), ["invalid", "bad_input"], JSON.stringify(bad));
  }
});
test("rule shape: undefined, null and {} mean all defaults, so the day-28 win promotes", () => {
  for (const r of [undefined, null, {}]) {
    const v = decide({ ...at(28, R(300, 10000), R(360, 10000)), rule: r as unknown as LiveRule });
    assert.deepEqual(pick(v), ["promote", "win"], String(r));
  }
});

// Task 14 (SF2, X7): an earlier reading with an empty arm is no data, so it is not a broken split.
test("SF2: an earlier reading with an empty arm is not a broken split, so the later win promotes", () => {
  const empty = reading(7, { units: 0, events: 0 }, R(300, 10000));
  const win = reading(28, R(300, 10000), R(360, 10000));
  assert.deepEqual(pick(decide(input([empty, win]))), ["promote", "win"]);
});

// Task 14 (SF2, X8): a broken split is final however many readings back it was, not only the previous one.
test("SF2: a broken split two readings back is still final, so a later win is invalid, split", () => {
  const broken = reading(7, R(300, 10000), { units: 10600, events: 300 });
  const sound = reading(14, R(600, 20000), R(720, 20000));
  const win = reading(28, R(1200, 40000), R(1440, 40000));
  assert.deepEqual(pick(decide(input([broken, sound, win]))), ["invalid", "split"]);
});

// Task 14 (SF2, X11): when a bound of the interval is not finite, the interval is left out, not kept as Infinity.
test("SF2: a msprt interval with a bound that is not finite is left out, and the verdict survives JSON", () => {
  const v = decide({ ...msAt(7, R(300, 10000), R(420, 10000)), min_effect: 1e-200 });
  assert.equal("interval" in v, false);
  const round = JSON.parse(JSON.stringify(v)) as Verdict;
  assert.equal("interval" in round, false);
  assert.equal(round.action, v.action);
});

// Task 14 (SF2, X15): the split check uses the resolved rule, so a rule object without srm_p gets the default.
test("SF2: a rule object without srm_p still catches a broken split (the default 0.0001 applies)", () => {
  const rule = without(["srm_p"], DEFAULT_RULE);
  const v = decide({ ...at(28, R(300, 10000), { units: 10600, events: 360 }), rule });
  assert.deepEqual(pick(v), ["invalid", "split"]);
});

// Task 12 property: over seeded random mSPRT ledgers, every promotion's interval excludes 0 on the winning side.
test("msprt property: every promotion has an interval that excludes 0 on the winning side (300 seeded ledgers)", () => {
  let seed = 20261117;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let promotes = 0;
  for (let run = 0; run < 300; run++) {
    const direction = run % 2 === 0 ? "higher" : "lower";
    const p0 = 0.03;
    const p1 = rnd() < 0.5 ? p0 - 0.01 + rnd() * 0.02 : p0;
    const readings: Reading[] = [];
    let bu = 0, tu = 0, be = 0, te = 0;
    for (let day = 1; day <= 28; day++) {
      for (let i = 0; i < 300; i++) {
        be += rnd() < p0 ? 1 : 0;
        te += rnd() < p1 ? 1 : 0;
      }
      bu += 300;
      tu += 300;
      readings.push(reading(day, R(be, bu), R(te, tu)));
    }
    const v = decide({ ...msInput(readings), direction });
    if (v.action !== "promote") continue;
    promotes++;
    assert.ok(v.interval, `run ${run}: a promotion has an interval`);
    if (direction === "higher") assert.ok(v.interval[0] > 0, `run ${run}: ${v.interval}`);
    else assert.ok(v.interval[1] < 0, `run ${run}: ${v.interval}`);
  }
  assert.ok(promotes > 0, "the property has promotions to check");
});
