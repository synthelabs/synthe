import assert from "node:assert/strict";
import { test } from "node:test";
import { compare, decide, type Remeasure } from "../src/solve/decide.ts";

// A small seeded generator, so the noise tests give the same answer every time.
function noise(seed: number) {
  let s = seed;
  const u = () => { s = (s * 1103515245 + 12345) % 2147483648; return (s + 1) / 2147483649; };
  return (mu: number, n: number) => Array.from({ length: n }, () => mu + Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u()));
}

test("an exact measure keeps any real move the right way and nothing else", async () => {
  assert.equal((await decide("higher", [10, 10, 10], [11, 11, 11])).keep, true);
  assert.equal((await decide("higher", [10, 10, 10], [10, 10, 10])).keep, false);
  assert.equal((await decide("higher", [10, 10, 10], [9, 9, 9])).keep, false);
  assert.equal((await decide("lower", [10, 10, 10], [9, 9, 9])).keep, true);
  assert.equal((await decide("lower", [10], [11])).keep, false);
  assert.equal((await decide("higher", [0.3], [0.1 + 0.2])).keep, false, "floating-point dust is not a gain");
});

test("an exact measure needs no second look", async () => {
  let called = 0;
  const d = await decide("higher", [1, 1, 1], [2, 2, 2], async () => { called++; return { baseline: [], candidate: [] }; });
  assert.equal(d.keep, true);
  assert.equal(called, 0);
});

test("the reason gives the numbers and the direction", async () => {
  const worse = await decide("higher", [10, 10], [8, 8]);
  assert.match(worse.reason, /Not better: the score went 10 -> 8, and higher is better/);
  const noisy = await decide("higher", [10, 12, 8], [10.5, 12.5, 8.5]);
  assert.equal(noisy.keep, false);
  assert.match(noisy.reason, /Within noise/);
  assert.equal(noisy.before, 10);
  assert.equal(noisy.after, 10.5);
});

test("a change that passes the screen must pass again on fresh runs", async () => {
  const lucky: Remeasure = async () => ({ baseline: [10, 11, 9, 10, 10], candidate: [10, 9, 11, 10, 10] });
  const first = compare("higher", [9.6, 10, 10.4, 9.8, 10.2], [10.6, 11, 11.4, 10.8, 11.2]);
  assert.ok(first.p !== null && first.p < 0.1);
  const d = await decide("higher", [9.6, 10, 10.4, 9.8, 10.2], [10.6, 11, 11.4, 10.8, 11.2], lucky);
  assert.equal(d.keep, false);
  assert.match(d.reason, /second look/);
  const failed = await decide("higher", [9.6, 10, 10.4, 9.8, 10.2], [10.6, 11, 11.4, 10.8, 11.2], async () => ({ error: "boom" }));
  assert.equal(failed.keep, false);
  assert.match(failed.reason, /boom/);
});

// P06 in small: with noise of sd 1 and 5 runs, a no-op is rarely kept and a gain of 2 sd usually is.
test("noisy measures: few no-ops kept, most real gains kept", async () => {
  const draw = noise(7);
  let noop = 0, gain = 0;
  const N = 600;
  for (let i = 0; i < N; i++) {
    if ((await decide("higher", draw(10, 5), draw(10, 5), async () => ({ baseline: draw(10, 5), candidate: draw(10, 5) }))).keep) noop++;
    if ((await decide("higher", draw(10, 5), draw(12, 5), async () => ({ baseline: draw(10, 5), candidate: draw(12, 5) }))).keep) gain++;
    if ((await decide("lower", draw(10, 5), draw(8, 5), async () => ({ baseline: draw(10, 5), candidate: draw(8, 5) }))).keep) gain++;
  }
  assert.ok(noop / N < 0.02, `no-op kept ${noop}/${N}`);
  assert.ok(gain / (2 * N) > 0.85, `gain kept ${gain}/${2 * N}`);
});
