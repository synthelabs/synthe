import assert from "node:assert/strict";
import { test } from "node:test";
import { PilotError } from "../src/pilot/errors.ts";
import { parseMetricContract } from "../src/pilot/metric.ts";
import { contract } from "./pilot-metric-helpers.ts";

const refused = (value: unknown, pattern: RegExp) =>
  assert.throws(() => parseMetricContract(value), (e: unknown) => {
    assert.ok(e instanceof PilotError, `expected PilotError, got ${e}`);
    assert.equal(e.code, "invalid_metric");
    assert.match(e.message, pattern);
    return true;
  });

const clone = <T>(v: T): any => JSON.parse(JSON.stringify(v));
const withPrimary = (over: Record<string, unknown>) => { const c = clone(contract()); Object.assign(c.primary, over); return c; };
const withGuard = (over: Record<string, unknown>, index = 0) => { const c = clone(contract()); Object.assign(c.guards[index], over); return c; };

test("a valid contract passes and comes back unchanged", () => {
  const c = contract();
  assert.deepEqual(parseMetricContract(clone(c)), c);
  assert.deepEqual(parseMetricContract(clone(contract({ guards: [] }))).guards, []);
  assert.equal(parseMetricContract(clone(contract({ query_hash: "f".repeat(64) }))).query_hash, "f".repeat(64));
  // A mean primary may have an effect of 1 or more.
  assert.equal(parseMetricContract(withPrimary({ kind: "mean", unit: "minutes", direction: "lower_is_better", min_effect: 2 })).primary.min_effect, 2);
});

test("not an object or wrong version", () => {
  refused(null, /object/);
  refused([], /object/);
  refused(clone(contract({ version: 2 as 1 })), /version/);
});

test("unknown keys are refused at every level, so a typo cannot silently pass", () => {
  refused({ ...clone(contract()), extra: 1 }, /extra/);
  const typo = clone(contract());
  typo.primary.min_efect = typo.primary.min_effect;
  delete typo.primary.min_effect;
  refused(typo, /min_efect/);
  refused(withGuard({ maxharm: 0.1 }), /maxharm/);
  refused(withGuard({ early_stop: { min_per_arm: 10, level: 0.99 } }), /level/);
  const so = clone(contract());
  so.signed_off.role = "x";
  refused(so, /role/);
});

test("primary metric fields", () => {
  refused(withPrimary({ name: "" }), /primary\.name/);
  refused(withPrimary({ name: "Resolved Rate" }), /primary\.name/);
  refused(withPrimary({ name: "segment" }), /primary\.name.*reserved/);
  refused(withPrimary({ kind: "ratio" }), /primary\.kind/);
  refused(withPrimary({ unit: "" }), /primary\.unit/);
  refused(withPrimary({ direction: "up" }), /primary\.direction/);
  refused(withPrimary({ min_effect: 0 }), /primary\.min_effect/);
  refused(withPrimary({ min_effect: -0.1 }), /primary\.min_effect/);
  refused(withPrimary({ min_effect: Number.POSITIVE_INFINITY }), /primary\.min_effect/);
  refused(withPrimary({ min_effect: 1 }), /primary\.min_effect.*less than 1/);
  const missing = clone(contract());
  delete missing.primary;
  refused(missing, /primary/);
});

test("guard fields", () => {
  const c = clone(contract());
  c.guards = {};
  refused(c, /guards/);
  refused(withGuard({ name: "resolved" }), /guards\[0\]\.name.*primary/);
  refused(withGuard({ name: "csat" }, 0), /guards\[1\]\.name.*more than once|csat.*more than once/);
  refused(withGuard({ max_harm: 0 }), /guards\[0\]\.max_harm.*zero margin/);
  refused(withGuard({ max_harm: 1 }), /guards\[0\]\.max_harm.*less than 1/);
  refused(withGuard({ max_harm: Number.NaN }), /guards\[0\]\.max_harm/);
  refused(withGuard({ critical: "yes" }), /guards\[0\]\.critical/);
  refused(withGuard({ early_stop: { min_per_arm: 0 } }), /early_stop\.min_per_arm/);
  refused(withGuard({ early_stop: { min_per_arm: 2.5 } }), /early_stop\.min_per_arm/);
  refused(withGuard({ critical: false }), /early_stop.*critical/);
  refused(withGuard({ kind: "count" }, 1), /guards\[1\]\.kind/);
  refused(withGuard({ unit: "  " }, 1), /guards\[1\]\.unit/);
  refused(withGuard({ direction: "down" }, 1), /guards\[1\]\.direction/);
  // A mean guard may tolerate more than 1 unit of harm.
  assert.equal(parseMetricContract(withGuard({ max_harm: 1.5 }, 1)).guards[1].max_harm, 1.5);
});

test("contract-level fields", () => {
  refused(clone(contract({ denominator: "" })), /denominator/);
  refused(clone(contract({ randomization_unit: "customer" as "conversation" })), /randomization_unit/);
  refused(clone(contract({ alpha: 0 })), /alpha/);
  refused(clone(contract({ alpha: 0.25 })), /alpha/);
  assert.equal(parseMetricContract(clone(contract({ alpha: 0.2 }))).alpha, 0.2);
  refused(clone(contract({ power: 0.4 })), /power/);
  refused(clone(contract({ power: 1 })), /power/);
  assert.equal(parseMetricContract(clone(contract({ power: 0.5 }))).power, 0.5);
  refused(clone(contract({ min_samples_per_arm: 1 })), /min_samples_per_arm/);
  refused(clone(contract({ min_samples_per_arm: 10.5 })), /min_samples_per_arm/);
  refused(clone(contract({ analysis_window_days: 0 })), /analysis_window_days/);
  refused(clone(contract({ outcome_lag_days: -1 })), /outcome_lag_days/);
  refused(clone(contract({ outcome_lag_days: 15 })), /outcome_lag_days.*cannot be attributed/);
  assert.equal(parseMetricContract(clone(contract({ outcome_lag_days: 14 }))).outcome_lag_days, 14);
  refused(clone(contract({ max_missing_rate: 0.6 })), /max_missing_rate/);
  refused(clone(contract({ max_unattributed_rate: -0.1 })), /max_unattributed_rate/);
  refused(clone(contract({ query_hash: "abc" })), /query_hash/);
  refused(clone(contract({ signed_off: { by: "", at: "2026-09-01T12:00:00Z" } })), /signed_off\.by/);
  refused(clone(contract({ signed_off: { by: "Mara Quill", at: "2026-09-01 12:00" } })), /signed_off\.at/);
  const noSign = clone(contract());
  delete noSign.signed_off;
  refused(noSign, /signed_off/);
});
