import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chiSquareGof, chiSquareIndependence, chiSquareUpper, meanSummary, newcombeInterval, normalCdf, normalQuantile, oneSampleT,
  sampleSizeMeans, sampleSizeProportions, studentTCdf, studentTQuantile, welchInterval, wilsonInterval,
} from "../src/pilot/stats.ts";

const near = (actual: number | null | undefined, expected: number, tol: number, what = "") => {
  assert.ok(typeof actual === "number" && Number.isFinite(actual), `${what}: expected a number, got ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} is not within ${tol} of ${expected}`);
};

test("normal CDF and quantile match published values", () => {
  near(normalQuantile(0.975), 1.959964, 1e-6, "z(0.975)");
  near(normalQuantile(0.8), 0.841621, 1e-6, "z(0.8)");
  near(normalQuantile(0.9995), 3.290527, 1e-6, "z(0.9995)");
  near(normalQuantile(0.025), -1.959964, 1e-6, "z(0.025)");
  near(normalQuantile(0.5), 0, 1e-12, "z(0.5)");
  near(normalCdf(1.959964), 0.975, 1e-7, "Phi(1.96)");
  near(normalCdf(0), 0.5, 1e-15, "Phi(0)");
  near(normalCdf(-3), 0.001349898, 1e-9, "Phi(-3)");
  near(normalCdf(-8), 6.220961e-16, 1e-20, "Phi(-8) keeps relative precision in the tail");
  for (const p of [1e-10, 0.001, 0.1, 0.3, 0.7, 0.99, 1 - 1e-10]) near(normalCdf(normalQuantile(p)!), p, p * 1e-9 + 1e-15, `round trip ${p}`);
  assert.equal(normalQuantile(0), null);
  assert.equal(normalQuantile(1), null);
  assert.equal(normalQuantile(Number.NaN), null);
});

test("Student t quantile matches published tables to 3 decimals for df >= 2", () => {
  const table: [number, number, number][] = [
    [0.975, 10, 2.228139], [0.975, 2, 4.302653], [0.975, 5, 2.570582], [0.975, 30, 2.042272], [0.975, 120, 1.979930],
    [0.95, 4, 2.131847], [0.995, 3, 5.840909], [0.9995, 2, 31.599055], [0.9995, 20, 3.849516], [0.995, 1, 63.656741],
  ];
  for (const [p, df, t] of table) near(studentTQuantile(p, df), t, 1e-5, `t(${p}, ${df})`);
  near(studentTQuantile(0.025, 10), -2.228139, 1e-5, "lower tail is symmetric");
  // Welch degrees of freedom are fractional: the quantile must sit between the neighbouring integer values.
  const t = studentTQuantile(0.975, 10.5)!;
  assert.ok(t < 2.228139 && t > 2.200985, `t(0.975, 10.5) = ${t}`);
  near(studentTCdf(2.228139, 10), 0.975, 1e-6, "t CDF");
  near(studentTQuantile(0.975, 1e9), 1.959964, 1e-5, "huge df tends to z");
  assert.equal(studentTQuantile(0.975, 0), null);
  assert.equal(studentTQuantile(1, 10), null);
});

test("chi-square upper tail matches published values", () => {
  near(chiSquareUpper(3.841459, 1), 0.05, 1e-7, "df 1");
  near(chiSquareUpper(5.991465, 2), 0.05, 1e-7, "df 2");
  near(chiSquareUpper(10.827566, 1), 0.001, 1e-8, "df 1 at 0.001");
  near(chiSquareUpper(18.307038, 10), 0.05, 1e-7, "df 10");
  near(chiSquareUpper(0, 3), 1, 1e-15, "zero statistic");
  assert.ok(chiSquareUpper(200, 1)! > 0 && chiSquareUpper(200, 1)! < 1e-40);
  assert.equal(chiSquareUpper(1, 0), null);
  assert.equal(chiSquareUpper(-1, 1), null);
});

test("Wilson score interval", () => {
  const ci = wilsonInterval(15, 50, 0.95)!;
  near(ci.lo, 0.1910, 5e-5, "lo");
  near(ci.hi, 0.4375, 5e-5, "hi");
  assert.equal(ci.level, 0.95);
  // Boundaries stay inside [0, 1] and are not degenerate, unlike the Wald interval.
  const zero = wilsonInterval(0, 20, 0.95)!;
  near(zero.lo, 0, 1e-15, "0/20 lo");
  near(zero.hi, 0.16113, 5e-5, "0/20 hi");
  const all = wilsonInterval(20, 20, 0.95)!;
  near(all.hi, 1, 1e-12, "20/20 hi");
  assert.equal(wilsonInterval(0, 0, 0.95), null);
  assert.equal(wilsonInterval(5, 4, 0.95), null);
});

test("Newcombe hybrid score interval for a difference of proportions (Newcombe 1998, method 10)", () => {
  const ci = newcombeInterval(56, 70, 48, 80, 0.95)!;
  near(ci.lo, 0.0524, 5e-5, "lo");
  near(ci.hi, 0.3339, 5e-5, "hi");
  // Newcombe's table: 9/10 vs 3/10 -> 0.6, [0.1705, 0.8090].
  const second = newcombeInterval(9, 10, 3, 10, 0.95)!;
  near(second.lo, 0.1705, 5e-5, "9/10 vs 3/10 lo");
  near(second.hi, 0.8090, 5e-5, "9/10 vs 3/10 hi");
  // Swapping the arms mirrors the interval.
  const swapped = newcombeInterval(48, 80, 56, 70, 0.95)!;
  near(swapped.lo, -ci.hi, 1e-12, "mirror lo");
  near(swapped.hi, -ci.lo, 1e-12, "mirror hi");
  assert.equal(newcombeInterval(1, 0, 3, 10, 0.95), null);
  assert.equal(newcombeInterval(1, 10, 0, 0, 0.95), null);
});

test("Welch interval for a difference of means", () => {
  // Hand-computed: n1=10 mean 20 sd 4, n2=12 mean 17 sd 3. se^2 = 1.6 + 0.75 = 2.35;
  // df = 2.35^2 / (1.6^2/9 + 0.75^2/11) = 5.5225 / 0.335585 = 16.4563; t(0.975, 16.4563) ~ 2.1150.
  const w = welchInterval({ n: 10, mean: 20, sd: 4 }, { n: 12, mean: 17, sd: 3 }, 0.95)!;
  near(w.df, 16.4563, 1e-3, "df");
  const half = studentTQuantile(0.975, w.df)! * Math.sqrt(2.35);
  near(w.lo, 3 - half, 1e-9, "lo");
  near(w.hi, 3 + half, 1e-9, "hi");
  near(w.hi - 3, 3.2426, 2e-3, "half width");
  assert.equal(welchInterval({ n: 1, mean: 1, sd: null }, { n: 12, mean: 17, sd: 3 }, 0.95), null);
  assert.equal(welchInterval({ n: 5, mean: 1, sd: 0 }, { n: 5, mean: 2, sd: 0 }, 0.95), null, "zero variance in both arms");
});

test("one-sample t interval and mean summary", () => {
  const s = meanSummary([2, 4, 4, 4, 5, 5, 7, 9]);
  near(s.mean, 5, 1e-12, "mean");
  near(s.sd, Math.sqrt(32 / 7), 1e-12, "sample sd uses n - 1");
  const ci = oneSampleT(s, 0.95)!;
  const half = 2.364624 * Math.sqrt(32 / 7) / Math.sqrt(8);
  near(ci.lo, 5 - half, 1e-5, "lo");
  near(ci.hi, 5 + half, 1e-5, "hi");
  assert.equal(meanSummary([3]).sd, null);
  assert.equal(oneSampleT(meanSummary([3]), 0.95), null);
  assert.equal(oneSampleT(meanSummary([]), 0.95), null);
  assert.equal(meanSummary([]).mean, null);
});

test("goodness of fit for sample ratio mismatch", () => {
  // 520 vs 480 against 50/50: chi2 = 2 * 20^2 / 500 = 1.6, df 1.
  near(chiSquareGof([520, 480], [0.5, 0.5])!.statistic, 1.6, 1e-12, "statistic");
  near(chiSquareGof([520, 480], [0.5, 0.5])!.p, chiSquareUpper(1.6, 1)!, 1e-15, "p");
  near(chiSquareGof([520, 480], [0.5, 0.5])!.p, 0.205903, 1e-6, "p value");
  assert.equal(chiSquareGof([0, 0], [0.5, 0.5]), null, "no rows");
  assert.equal(chiSquareGof([3, 4], [1, 0]), null, "expected count of 0");
  assert.equal(chiSquareGof([3], [1]), null, "one category");
});

test("chi-square test of independence", () => {
  // Classic 2x2: [[10, 20], [30, 40]]: expected [[12, 18], [28, 42]]; chi2 = 4/12 + 4/18 + 4/28 + 4/42 = 0.79365.
  const r = chiSquareIndependence([[10, 20], [30, 40]])!;
  near(r.statistic, 0.793651, 1e-6, "statistic");
  assert.equal(r.df, 1);
  near(r.p, chiSquareUpper(0.793651, 1)!, 1e-6, "p");
  assert.equal(chiSquareIndependence([[10, 0], [30, 0]]), null, "an empty column gives an expected count of 0");
  assert.equal(chiSquareIndependence([[10, 20]]), null, "one row");
});

test("sample size per arm", () => {
  // Two proportions, 0.5 -> 0.6, alpha 0.05, power 0.8 (Fleiss, no continuity correction):
  // (1.959964*sqrt(2*0.55*0.45) + 0.841621*sqrt(0.25+0.24))^2 / 0.01 = 387.3 -> 388.
  assert.equal(sampleSizeProportions(0.5, 0.1, "higher_is_better", 0.05, 0.8), 388);
  // Lower is better moves the target down: 0.5 -> 0.4 is symmetric to 0.5 -> 0.6.
  assert.equal(sampleSizeProportions(0.5, 0.1, "lower_is_better", 0.05, 0.8), 388);
  // 0.2 -> 0.25: (1.959964*sqrt(2*.225*.775) + 0.841621*sqrt(.16+.1875))^2 / .0025 = 1093.7 -> 1094.
  assert.equal(sampleSizeProportions(0.2, 0.05, "higher_is_better", 0.05, 0.8), 1094);
  // A target past 1 is clamped inside (0, 1), so the size is finite.
  const clamped = sampleSizeProportions(0.95, 0.1, "higher_is_better", 0.05, 0.8);
  assert.ok(clamped !== null && clamped > 0 && Number.isFinite(clamped));
  // Nothing to improve: a zero rate cannot go lower.
  assert.equal(sampleSizeProportions(0, 0.05, "lower_is_better", 0.05, 0.8), null);
  assert.equal(sampleSizeProportions(Number.NaN, 0.05, "higher_is_better", 0.05, 0.8), null);
  // Two means, sd 1, delta 0.5: 2 * (1.959964 + 0.841621)^2 / 0.25 = 62.79 -> 63.
  assert.equal(sampleSizeMeans(1, 0.5, 0.05, 0.8), 63);
  // sd 10, delta 2, alpha 0.05, power 0.9: 2 * (1.959964 + 1.281552)^2 * 100 / 4 = 525.4 -> 526.
  assert.equal(sampleSizeMeans(10, 2, 0.05, 0.9), 526);
  assert.equal(sampleSizeMeans(null, 0.5, 0.05, 0.8), null);
  assert.equal(sampleSizeMeans(0, 0.5, 0.05, 0.8), null);
});
