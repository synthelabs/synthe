import assert from "node:assert/strict";
import { test } from "node:test";
import { interval, meanTest, normalQuantile, normalSf, rateTest, srmP } from "../src/live/stats.ts";

const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
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
