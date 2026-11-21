import assert from "node:assert/strict";
import { test } from "node:test";
import { compare, decide, decideWithConfirm, type Remeasure } from "../src/solve/decide.ts";
import type { Measurement } from "../src/solve/types.ts";

const m = (runs: number[]): Measurement => {
  const s = [...runs].sort((a, b) => a - b), mid = Math.floor(s.length / 2);
  return { runs, value: s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2 };
};

// A small seeded generator, so the noise tests give the same answer every time.
function noise(seed: number) {
  let s = seed;
  const u = () => { s = (s * 1103515245 + 12345) % 2147483648; return (s + 1) / 2147483649; };
  return (mu: number, n: number) => m(Array.from({ length: n }, () => mu + Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u())));
}

test("an exact measure keeps any real move the right way and nothing else", () => {
  assert.equal(decide("higher", m([10, 10, 10]), m([11, 11, 11])).keep, true);
  assert.equal(decide("higher", m([10, 10, 10]), m([10, 10, 10])).keep, false);
  assert.equal(decide("higher", m([10, 10, 10]), m([9, 9, 9])).keep, false);
  assert.equal(decide("lower", m([10, 10, 10]), m([9, 9, 9])).keep, true);
  assert.equal(decide("lower", m([10]), m([11])).keep, false);
  assert.equal(decide("higher", m([10]), m([11])).keep, true);
  assert.equal(decide("higher", m([0.3]), m([0.1 + 0.2])).keep, false, "floating-point dust is not a gain");
});

test("an exact measure needs no second look", async () => {
  let called = 0;
  const d = await decideWithConfirm("higher", m([1, 1, 1]), m([2, 2, 2]), async () => { called++; return { failed: "x" }; });
  assert.equal(d.keep, true);
  assert.equal(called, 0);
});

test("the reason gives the numbers and the direction", () => {
  assert.match(decide("higher", m([10, 10]), m([8, 8])).reason, /Not better: the score went 10 -> 8, and higher is better/);
  const noisy = decide("higher", m([10, 12, 8]), m([10.5, 12.5, 8.5]));
  assert.equal(noisy.keep, false);
  assert.match(noisy.reason, /Within noise: the score went 10 -> 10.5/);
});

test("a change that passes the screen must pass again on fresh runs", async () => {
  const before = m([9.6, 10, 10.4, 9.8, 10.2]), after = m([10.6, 11, 11.4, 10.8, 11.2]);
  const first = compare("higher", before.runs, after.runs);
  assert.ok(first.p !== null && first.p < 0.1);
  const lucky: Remeasure = async () => ({ before: m([10, 11, 9, 10, 10]), after: m([10, 9, 11, 10, 10]) });
  const d = await decideWithConfirm("higher", before, after, lucky);
  assert.equal(d.keep, false);
  assert.match(d.reason, /on 10 runs each/);
  assert.equal(d.after.runs.length, 10);
  const failed = await decideWithConfirm("higher", before, after, async () => ({ failed: "boom" }));
  assert.equal(failed.keep, false);
  assert.match(failed.reason, /boom/);
  const real = await decideWithConfirm("higher", before, after, async () => ({ before: m([10, 9.9, 10.1, 10, 10]), after: m([11, 10.9, 11.1, 11, 11]) }));
  assert.equal(real.keep, true);
});

// P06 in small: with noise of sd 1 and 5 runs, a no-op is rarely kept and a gain of 2 sd usually is.
test("noisy measures: few no-ops kept, most real gains kept", async () => {
  const draw = noise(7);
  let noop = 0, gain = 0;
  const N = 600;
  for (let i = 0; i < N; i++) {
    if ((await decideWithConfirm("higher", draw(10, 5), draw(10, 5), async () => ({ before: draw(10, 5), after: draw(10, 5) }))).keep) noop++;
    if ((await decideWithConfirm("higher", draw(10, 5), draw(12, 5), async () => ({ before: draw(10, 5), after: draw(12, 5) }))).keep) gain++;
    if ((await decideWithConfirm("lower", draw(10, 5), draw(8, 5), async () => ({ before: draw(10, 5), after: draw(8, 5) }))).keep) gain++;
  }
  assert.ok(noop / N < 0.02, `no-op kept ${noop}/${N}`);
  assert.ok(gain / (2 * N) > 0.85, `gain kept ${gain}/${2 * N}`);
});
