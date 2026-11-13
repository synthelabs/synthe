import assert from "node:assert/strict";
import { test } from "node:test";
import type { MetricQuery, MetricSource } from "../src/metric/types.ts";

// Each adapter's test file calls conformance() with its own make(). make() maps these two sentinels to the
// adapter's own time-out and failure, so every adapter is held to the same problem sentences.
export const TIMED_OUT = Symbol("timed out");
export const FAILED = Symbol("failed");

const QUERY: MetricQuery = { agent: "default", from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z", arms: ["base", "test"] };

const TIMED_OUT_SENTENCE = "The metric command did not finish in time.";
const FAILED_SENTENCE = "The metric command failed (exit code not 0). Run it by hand to see the error.";
const NO_JSON_SENTENCE = 'The metric command printed no JSON result. Print one line like {"arms":{"base":{"units":100,"events":3}}}.';

const RATE_BASE = { units: 100, events: 3 };
const RATE_TEST = { units: 98, events: 5 };

// A reply with one bad arm `base` and a good `test`, so only the base arm's problem can show.
const withBase = (base: unknown) => ({ arms: { base, test: RATE_TEST } });
const badArm = (field: string) => `The metric result for arm "base" is not valid: ${field}.`;

export function conformance(name: string, make: (reply: unknown) => MetricSource): void {
  const ask = (reply: unknown) => make(reply).read(QUERY);

  test(`${name}: a good rate reply returns both arms`, async () => {
    const got = await ask({ arms: { base: RATE_BASE, test: RATE_TEST } });
    assert.deepEqual(got, { arms: { base: RATE_BASE, test: RATE_TEST } });
  });

  test(`${name}: a good mean reply returns both arms`, async () => {
    const base = { units: 10, sum: 20, sum_sq: 50 };
    const testArm = { units: 12, sum: 30, sum_sq: 80 };
    assert.deepEqual(await ask({ arms: { base, test: testArm } }), { arms: { base, test: testArm } });
  });

  test(`${name}: returns only the asked arms, with only their known fields`, async () => {
    const got = await ask({
      arms: { base: { ...RATE_BASE, note: "extra" }, test: RATE_TEST, hold: { units: 1, events: 0 } },
    });
    assert.deepEqual(got, { arms: { base: RATE_BASE, test: RATE_TEST } });
  });

  test(`${name}: a time-out gives the time-out sentence`, async () => {
    assert.deepEqual(await ask(TIMED_OUT), { problem: TIMED_OUT_SENTENCE });
  });

  test(`${name}: a failed run gives the exit-code sentence`, async () => {
    assert.deepEqual(await ask(FAILED), { problem: FAILED_SENTENCE });
  });

  test(`${name}: output with no JSON object gives the no-JSON sentence`, async () => {
    assert.deepEqual(await ask("Done.\nNo numbers today.\n"), { problem: NO_JSON_SENTENCE });
  });

  test(`${name}: a JSON array is not a result`, async () => {
    assert.deepEqual(await ask("[1,2]\n"), { problem: NO_JSON_SENTENCE });
  });

  test(`${name}: a reply with no arms object names the first asked arm`, async () => {
    assert.deepEqual(await ask({}), { problem: 'The metric result has no arm "base".' });
  });

  test(`${name}: a missing asked arm is named`, async () => {
    assert.deepEqual(await ask({ arms: { base: RATE_BASE } }), { problem: 'The metric result has no arm "test".' });
  });

  test(`${name}: a missing arm is reported before a bad arm that comes earlier in the query`, async () => {
    assert.deepEqual(await ask({ arms: { test: { units: -1, events: 0 } } }), { problem: 'The metric result has no arm "base".' });
  });

  test(`${name}: an arm that is not an object names units`, async () => {
    assert.deepEqual(await ask(withBase(5)), { problem: badArm("units") });
    assert.deepEqual(await ask(withBase(null)), { problem: badArm("units") });
  });

  test(`${name}: units below 0 or not a number names units`, async () => {
    assert.deepEqual(await ask(withBase({ units: -1, events: 0 })), { problem: badArm("units") });
    assert.deepEqual(await ask(withBase({ units: "100", events: 3 })), { problem: badArm("units") });
  });

  test(`${name}: an arm with both events and sum is not valid`, async () => {
    assert.deepEqual(await ask(withBase({ units: 100, events: 3, sum: 3 })), { problem: badArm("events and sum") });
  });

  test(`${name}: an arm with neither events nor sum is not valid`, async () => {
    assert.deepEqual(await ask(withBase({ units: 100 })), { problem: badArm("events or sum") });
  });

  test(`${name}: a rate with events below 0 or not a number names events`, async () => {
    assert.deepEqual(await ask(withBase({ units: 100, events: -1 })), { problem: badArm("events") });
    assert.deepEqual(await ask(withBase({ units: 100, events: "3" })), { problem: badArm("events") });
  });

  test(`${name}: a rate with events above units names events`, async () => {
    assert.deepEqual(await ask(withBase({ units: 100, events: 101 })), { problem: badArm("events") });
  });

  test(`${name}: a mean with a sum that is not a number at or above 0 names sum`, async () => {
    assert.deepEqual(await ask(withBase({ units: 10, sum: "x", sum_sq: 5 })), { problem: badArm("sum") });
    assert.deepEqual(await ask(withBase({ units: 10, sum: -1, sum_sq: 5 })), { problem: badArm("sum") });
  });

  test(`${name}: a mean with a sum_sq that is not a number at or above 0 names sum_sq`, async () => {
    assert.deepEqual(await ask(withBase({ units: 10, sum: 20, sum_sq: -1 })), { problem: badArm("sum_sq") });
    assert.deepEqual(await ask(withBase({ units: 10, sum: 20 })), { problem: badArm("sum_sq") });
  });

  test(`${name}: a mean whose sum_sq is too small for its sum (negative variance) names sum_sq`, async () => {
    const base = { units: 1000, sum: 12000, sum_sq: 0 };
    const testArm = { units: 1000, sum: 11200, sum_sq: 225340 };
    assert.deepEqual(await ask({ arms: { base, test: testArm } }), { problem: badArm("sum_sq") });
  });

  test(`${name}: a constant mean (sum_sq exactly sum squared over units) is accepted`, async () => {
    const base = { units: 1000, sum: 700, sum_sq: 490 };
    const testArm = { units: 1000, sum: 710, sum_sq: 505 };
    assert.deepEqual(await ask({ arms: { base, test: testArm } }), { arms: { base, test: testArm } });
  });
}
