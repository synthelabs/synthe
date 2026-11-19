// The simulation of the pilot's decision rule (scripts/simulate-pilot.ts) and its theory limits
// (scripts/simulate-pilot-reference.mjs). The full run is `node scripts/simulate-pilot.ts` (20,000 experiments per
// scenario, a few minutes); these tests run it small, check that it repeats exactly, and check that it has teeth.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { EARLY_STOP_LEVEL } from "../src/pilot/experiment.ts";
import { interimLooksAllowed } from "../src/pilot/watch.ts";
import { measured, runAll, simulate, simulatedSpec, type Scenario } from "../scripts/simulate-pilot.ts";
import { atLeast, atMost, earlyStopLooks, limits, PLAN, SCENARIOS } from "../scripts/simulate-pilot-reference.mjs";

const ROOT = join(import.meta.dirname, "..");
const scenario = (name: string) => (SCENARIOS as Record<string, Scenario>)[name];

test("the same seed gives the same result twice, and another seed gives another draw", () => {
  const a = runAll(40, 11);
  const b = runAll(40, 11);
  assert.deepEqual(a, b);
  assert.notDeepEqual(simulate(scenario("lift_min"), 200, 12), simulate(scenario("lift_min"), 200, 13));
});

test("every limit holds on a small run, and every scenario reaches a decision or a final hold", () => {
  const { results, checks } = runAll(300, 20261117);
  for (const c of checks) assert.ok(c.ok, `${c.scenario} ${c.measure}: measured ${c.value}, limit ${c.kind} ${c.limit}`);
  for (const [name, r] of Object.entries(results)) assert.equal(r.keep + r.revert_early + r.revert_final + r.hold_final, r.runs, name);
  // The outcomes point the right way: a harmless gain is mostly kept, a large harm always reverts, no difference is not kept.
  assert.ok(results.lift_double.keep > results.lift_min.keep && results.lift_min.keep > results.aa.keep);
  assert.equal(results.harm_large.keep, 0);
  assert.equal(results.harm_large.revert_early + results.harm_large.revert_final, results.harm_large.runs);
});

test("the simulated schedule is the watch gate's: one look a day, never more than the gate allows", () => {
  const { spec } = simulatedSpec();
  const r = simulate(scenario("aa"), 60, 5);
  assert.equal(r.interim_allowed, interimLooksAllowed(spec, 1));
  assert.ok(r.max_interim_looks <= r.interim_allowed);
  // A tick every day from day 1 to the day before the cutoff, and no experiment is cut short when nothing is wrong.
  assert.equal(r.max_interim_looks, PLAN.days + PLAN.lag_days - 1);
  assert.equal(r.interim_looks, r.runs * r.max_interim_looks);
});

test("the plan the reference reasons about is the plan the simulation runs", () => {
  const { spec, contract } = simulatedSpec();
  assert.equal(contract.analysis_window_days, PLAN.days);
  assert.equal(spec.outcome_lag_days, PLAN.lag_days);
  assert.equal(spec.primary.min_effect, PLAN.min_effect);
  const esc = spec.guards.find((g) => g.name === "escalated");
  assert.equal(esc?.max_harm, PLAN.escalated_max_harm);
  assert.equal(esc?.critical, true);
  assert.equal(esc?.early_stop?.min_per_arm, PLAN.early_stop_min_per_arm);
  assert.equal(spec.guards.find((g) => g.name === "refund_usd")?.max_harm, PLAN.refund_max_harm);
  assert.equal(spec.early_stop_level, EARLY_STOP_LEVEL);
  // The experiment is large enough to be decided: each arm expects more than the specification requires.
  assert.ok((PLAN.days * PLAN.per_day) / 2 > spec.required_per_arm, `required ${spec.required_per_arm}`);
  // The early stop can fire at the first look with two mature days, and at every later look, the final one included.
  assert.deepEqual(earlyStopLooks().map((l) => l.day), Array.from({ length: PLAN.days + PLAN.lag_days - 3 }, (_, i) => i + 4));
});

test("the reference shares no code with the pilot, and its limits are bounded the way it says", () => {
  const source = readFileSync(join(ROOT, "scripts", "simulate-pilot-reference.mjs"), "utf8");
  assert.ok(!/^\s*import\b/m.test(source), "the reference must not import anything: its arithmetic is its own");
  // An upper limit is never below its theory value and a lower limit is never above it; more runs tighten both.
  for (const l of limits(20000)) assert.ok(l.kind === "max" ? l.limit >= l.theory : l.limit <= l.theory, `${l.scenario} ${l.measure}`);
  assert.ok(atMost(0.025, 20000) < atMost(0.025, 300));
  assert.ok(atLeast(0.8, 20000) > atLeast(0.8, 300));
  // By design: a guard exactly at its margin is shown safe 2.5% of the time, and no difference clears min_effect far less often.
  const byName = Object.fromEntries(limits(20000).map((l) => [`${l.scenario}.${l.measure}`, l.theory]));
  assert.ok(Math.abs(byName["harm_boundary.keep"] - 0.025) < 1e-4);
  assert.ok(byName["aa.keep"] < 0.0025);
  // The union bound over the looks that can fire the early stop: 13 looks at 0.05% each.
  assert.ok(Math.abs(byName["harm_boundary.revert_early"] - earlyStopLooks().length * 0.0005) < 2e-4);
});

test("the limits notice a looser rule: an early stop at 95%, and a keep with no minimum effect", () => {
  // The early stop checked at the ordinary 95% level at every look: far more false stops at the margin.
  const loose = simulate(scenario("harm_boundary"), 500, 3, { tweak: (spec) => ({ ...spec, early_stop_level: 0.95 }) });
  const earlyLimit = limits(500).find((l) => l.scenario === "harm_boundary" && l.measure === "revert_early");
  assert.ok(earlyLimit && measured(loose, "revert_early") > earlyLimit.limit, `measured ${measured(loose, "revert_early")}, limit ${earlyLimit?.limit}`);
  assert.ok(measured(simulate(scenario("harm_boundary"), 500, 3), "revert_early") <= earlyLimit.limit);
  // Keep with no real minimum effect (the specification check refuses 0, so a value far below any measurable gain):
  // no true difference is then kept whenever its interval clears zero.
  const noFloor = simulate(scenario("aa"), 1500, 4, { tweak: (spec) => ({ ...spec, primary: { ...spec.primary, min_effect: 1e-9 } }) });
  const keepLimit = limits(1500).find((l) => l.scenario === "aa" && l.measure === "keep");
  assert.ok(keepLimit && measured(noFloor, "keep") > keepLimit.limit, `measured ${measured(noFloor, "keep")}, limit ${keepLimit?.limit}`);
  assert.ok(measured(simulate(scenario("aa"), 1500, 4), "keep") <= keepLimit.limit);
});

test("the limits notice a rule that keeps a gain below min_effect, or that ignores the refund guard", () => {
  // No real minimum effect: a true gain exactly at min_effect is then kept far more often than half the time.
  const noFloor = simulate(scenario("lift_min"), 1500, 6, { tweak: (spec) => ({ ...spec, primary: { ...spec.primary, min_effect: 1e-9 } }) });
  const liftLimit = limits(1500).find((l) => l.scenario === "lift_min" && l.measure === "keep");
  assert.ok(liftLimit && measured(noFloor, "keep") > liftLimit.limit, `measured ${measured(noFloor, "keep")}, limit ${liftLimit?.limit}`);
  assert.ok(measured(simulate(scenario("lift_min"), 1500, 6), "keep") <= liftLimit.limit);
  // The refund guard dropped from the specification: refunds at the margin are then kept with the gain.
  const noRefund = simulate(scenario("refund_boundary"), 300, 8, { tweak: (spec) => ({ ...spec, guards: spec.guards.filter((g) => g.name !== "refund_usd") }) });
  const refundLimit = limits(300).find((l) => l.scenario === "refund_boundary" && l.measure === "keep");
  assert.ok(refundLimit && measured(noRefund, "keep") > refundLimit.limit, `measured ${measured(noRefund, "keep")}, limit ${refundLimit?.limit}`);
  assert.ok(measured(simulate(scenario("refund_boundary"), 300, 8), "keep") <= refundLimit.limit);
});

test("the rows form (what watch --log imports) gives the same decisions as the aggregates form on the same draws", () => {
  // The rows path has its own code: per-row maturity, the sd from the rows, unit ids. Same seed and stream, so the
  // same conversations; every count, day of early stop and hold reason must match. Slow (seconds per experiment),
  // so the sample is small; `node scripts/simulate-pilot.ts --rows` runs more.
  for (const [name, runs] of [["harm_double", 4], ["refund_double", 3]] as const) {
    assert.deepEqual(simulate(scenario(name), runs, 31, { form: "rows" }), simulate(scenario(name), runs, 31), name);
  }
});
