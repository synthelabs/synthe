import assert from "node:assert/strict";
import { test } from "node:test";
import {
  interval,
  meanTest,
  meanVariance,
  msprt,
  msprtHalfWidth,
  msprtLog,
  normalQuantile,
  normalSf,
  rateTest,
  rateVariance,
  srmP,
} from "../src/live/stats.ts";

const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
const relNear = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol * Math.abs(b), `${a} vs ${b}`);
// Small seeded generator (mulberry32) so the random cases repeat exactly.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
test("normal: tail and quantile", () => {
  near(normalSf(1.96), 0.0249978951, 1e-7); near(normalSf(0), 0.5, 1e-9); near(normalSf(-1.96), 0.9750021049, 1e-7);
  near(normalQuantile(0.975), 1.959963985, 1e-6); near(normalQuantile(0.5), 0, 1e-9);
});
test("rate: 300/10000 against 360/10000", () => {
  const t = rateTest({ units: 10000, events: 300 }, { units: 10000, events: 360 })!;
  near(t.diff, 0.006, 1e-12); near(t.se, 0.0025263016, 1e-9); near(t.z, 2.3750133, 1e-6); near(t.p, 0.0175483, 1e-6);
});
test("rate: equal arms give p 1; empty arm gives null", () => {
  near(rateTest({ units: 10000, events: 300 }, { units: 10000, events: 300 })!.p, 1, 1e-12);
  assert.equal(rateTest({ units: 0, events: 0 }, { units: 10, events: 1 }), null);
  assert.equal(rateTest({ units: 10, events: 0 }, { units: 10, events: 0 }), null);
});
test("mean: from sums", () => {
  const t = meanTest({ units: 1000, sum: 12000, sum_sq: 244000 }, { units: 1000, sum: 11000, sum_sq: 221000 })!;
  near(t.diff, -1, 1e-12); near(t.se, 0.4474373701, 1e-9); near(t.z, -2.2349497, 1e-6); near(t.p, 0.0254207, 1e-6);
  assert.equal(meanTest({ units: 1, sum: 5, sum_sq: 25 }, { units: 1000, sum: 11000, sum_sq: 221000 }), null);
});
test("split check", () => {
  near(srmP([5000, 5000], [1, 1])!, 1, 1e-12); near(srmP([4900, 5100], [1, 1])!, 0.0455003, 1e-6);
  assert.ok(srmP([5000, 5400], [1, 1])! < 0.001);
  near(srmP([9000, 1000], [90, 10])!, 1, 1e-12); assert.equal(srmP([10, 10], [0, 1]), null);
});
test("interval", () => {
  const [lo, hi] = interval({ diff: 0.006, se: 0.0025263016, z: 0, p: 0 }, 0.05);
  near(lo, 0.0010485, 1e-6); near(hi, 0.0109515, 1e-6);
});
test("mean: constant arms give null, not a rounding-noise se", () => {
  assert.equal(meanTest({ units: 1000, sum: 700, sum_sq: 490 }, { units: 1000, sum: 100, sum_sq: 10 }), null);
});
test("mean: impossible sums (sum_sq below sum^2/n) give null", () => {
  assert.equal(meanTest({ units: 1000, sum: 12000, sum_sq: 0 }, { units: 1000, sum: 11200, sum_sq: 225340 }), null);
});
test("msprt: reference values R1, R2, R3", () => {
  relNear(msprt(0.03, 0.0001, 0.02)!, 16.367228, 1e-6);
  near(msprtHalfWidth(0.0001, 0.02, 0.05)!, 0.030824, 1e-6);
  relNear(msprt(0.02, 0.0000979, 0.01)!, 1.974632, 1e-6);
  near(msprtHalfWidth(0.0000979, 0.01, 0.05)!, 0.036016, 1e-6);
  relNear(msprt(0.05, 0.0001, 0.02)!, 9850.535, 1e-6);
});
test("msprt: symmetric in d", () => {
  assert.equal(msprt(-0.03, 0.0001, 0.02), msprt(0.03, 0.0001, 0.02));
});
test("msprt: huge evidence stays finite in log form", () => {
  const l = msprtLog(1, 1e-12, 0.02)!;
  assert.ok(Number.isFinite(l), `${l}`);
  assert.ok(l > Math.log(20), `${l}`);
});
test("msprt: bad input gives null", () => {
  const badLogs: [number, number, number][] = [
    [0.03, 0, 0.02], [0.03, -1, 0.02], [0.03, 0.0001, 0], [Number.NaN, 0.0001, 0.02],
    [0.03, 0.0001, -0.02], [0.03, Number.NaN, 0.02], [0.03, 0.0001, Number.NaN],
    [Number.POSITIVE_INFINITY, 0.0001, 0.02], [Number.NEGATIVE_INFINITY, 0.0001, 0.02],
    [0.03, Number.POSITIVE_INFINITY, 0.02], [0.03, 0.0001, Number.POSITIVE_INFINITY],
  ];
  for (const [d, v, tau] of badLogs) {
    assert.equal(msprtLog(d, v, tau), null, `msprtLog(${d}, ${v}, ${tau})`);
    assert.equal(msprt(d, v, tau), null, `msprt(${d}, ${v}, ${tau})`);
  }
  const badHalf: [number, number][] = [[0, 0.02], [-1, 0.02], [0.0001, 0], [0.0001, -0.02], [Number.NaN, 0.02], [0.0001, Number.NaN], [0.0001, Number.POSITIVE_INFINITY]];
  for (const [v, tau] of badHalf) assert.equal(msprtHalfWidth(v, tau, 0.05), null, `msprtHalfWidth(${v}, ${tau})`);
  for (const alpha of [0, 1, 1.5, -0.1, Number.NaN]) {
    assert.equal(msprtHalfWidth(0.0001, 0.02, alpha), null, `alpha ${alpha}`);
  }
});
test("msprt: promotes exactly when |d| reaches the half-width (A1 3.1)", () => {
  const rand = mulberry32(20261117);
  let checked = 0;
  for (let i = 0; i < 200; i++) {
    const d = (rand() * 2 - 1) * 0.1;
    const v = 10 ** (-7 + rand() * 4);
    const tau = 0.001 + rand() * 0.099;
    const h = msprtHalfWidth(v, tau, 0.05)!;
    if (Math.abs(Math.abs(d) - h) <= 1e-9) continue;
    checked++;
    assert.equal(msprt(d, v, tau)! >= 20, Math.abs(d) >= h, `d=${d} v=${v} tau=${tau} h=${h}`);
    // Just outside and just inside the boundary, compared in logs as the gate will compare.
    const lnTwenty = Math.log(20);
    assert.ok(msprtLog(h * (1 + 1e-7), v, tau)! >= lnTwenty, `outside v=${v} tau=${tau} h=${h}`);
    assert.ok(msprtLog(h * (1 - 1e-7), v, tau)! < lnTwenty, `inside v=${v} tau=${tau} h=${h}`);
  }
  assert.ok(checked >= 150, `${checked}`);
});
test("rateVariance: unpooled, and not the pooled se squared", () => {
  const base = { units: 10000, events: 300 };
  const test2 = { units: 10000, events: 360 };
  relNear(rateVariance(base, test2)!, 6.38103810381038e-6, 1e-9);
  const se = rateTest(base, test2)!.se;
  relNear(rateVariance(base, test2)!, 6.38103810381038e-6, 1e-9);
  assert.ok(Math.abs(rateVariance(base, test2)! - se * se) / (se * se) > 1e-4);
  assert.equal(rateVariance({ units: 1, events: 0 }, { units: 10, events: 1 }), null);
  const badRates: { units: number; events: number }[] = [
    { units: 10, events: 11 }, { units: 10, events: -1 }, { units: Number.NaN, events: 1 },
    { units: 10, events: Number.NaN }, { units: Number.POSITIVE_INFINITY, events: 1 },
  ];
  for (const bad of badRates) {
    assert.equal(rateVariance(bad, { units: 10, events: 5 }), null, JSON.stringify(bad));
    assert.equal(rateVariance({ units: 10, events: 5 }, bad), null, JSON.stringify(bad));
  }
  assert.equal(rateVariance({ units: 10, events: 11 }, { units: 10, events: 5 }), null);
});
test("meanVariance: Welch variance per arm, summed", () => {
  relNear(meanVariance({ units: 1000, sum: 12000, sum_sq: 244000 }, { units: 1000, sum: 11000, sum_sq: 221000 })!, 0.2002002002, 1e-9);
  assert.equal(meanVariance({ units: 1, sum: 5, sum_sq: 25 }, { units: 1000, sum: 11000, sum_sq: 221000 }), null);
  assert.equal(meanVariance({ units: 1000, sum: 12000, sum_sq: 0 }, { units: 1000, sum: 11200, sum_sq: 225340 }), null);
  assert.equal(meanVariance({ units: 10, sum: 100, sum_sq: 500 }, { units: 1000, sum: 11000, sum_sq: 221000 }), null);
});
