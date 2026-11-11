// Statistics for the pilot's baseline and experiment analysis. Lane: metric and experiment evaluation.
//
// Written here rather than taken from a package, so every number in a decision can be traced to a few dozen lines.
// Every function is pure and returns null, never NaN, when its inputs cannot support an answer: a null reads as
// "cannot tell" in the decision rules, while a NaN would compare false and could pass a check by accident.
import type { Direction } from "./types.ts";

export interface Ci { lo: number; hi: number; level: number }

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const TINY = 1e-300;

// Lanczos approximation (g = 7, 9 terms), about 15 significant digits for x > 0.
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];
export function lnGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const y = x - 1;
  let a = LANCZOS[0];
  const t = y + 7.5;
  for (let i = 1; i < 9; i++) a += LANCZOS[i] / (y + i);
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(a);
}

// Regularized upper incomplete gamma Q(a, x). Series below a + 1, Lentz continued fraction above, so the upper tail
// keeps its relative precision far out (a tiny p-value stays a tiny positive number, never 0 - 0).
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  const front = Math.exp(-x + a * Math.log(x) - lnGamma(a));
  if (x < a + 1) {
    let ap = a;
    let del = 1 / a;
    let sum = del;
    for (let n = 0; n < 10_000; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-16) break;
    }
    return 1 - sum * front;
  }
  let b = x + 1 - a;
  let c = 1 / TINY;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 10_000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return front * h;
}

// Continued fraction for the regularized incomplete beta function (Numerical Recipes, modified Lentz).
function betaCf(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m < 10_000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return h;
}

function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (front * betaCf(a, b, x)) / a : 1 - (front * betaCf(b, a, 1 - x)) / b;
}

// Standard normal CDF through Q(1/2, z^2/2), which equals erfc(|z|/sqrt 2).
export function normalCdf(z: number): number | null {
  if (!finite(z)) return null;
  const tail = 0.5 * gammaQ(0.5, (z * z) / 2);
  return z < 0 ? tail : 1 - tail;
}

// Acklam's rational approximation, then one Halley step against normalCdf, which takes it to near double precision.
export function normalQuantile(p: number): number | null {
  if (!finite(p) || p <= 0 || p >= 1) return null;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  let x: number;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - low) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  // In the upper half the error is measured on the upper tail, so 1 - p does not lose the digits that matter.
  const e = x > 0 ? (1 - p) - 0.5 * gammaQ(0.5, (x * x) / 2) : 0.5 * gammaQ(0.5, (x * x) / 2) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

export function studentTCdf(t: number, df: number): number | null {
  if (!finite(t) || !finite(df) || df <= 0) return null;
  const tail = 0.5 * incompleteBeta(df / 2, 0.5, df / (df + t * t));
  return t > 0 ? 1 - tail : tail;
}

// Inverts the t CDF by bisection: slower than a series, but it cannot diverge and it works for the fractional
// degrees of freedom Welch's interval produces.
export function studentTQuantile(p: number, df: number): number | null {
  if (!finite(p) || p <= 0 || p >= 1 || !finite(df) || df <= 0) return null;
  if (df > 1e7) return normalQuantile(p);
  if (p === 0.5) return 0;
  const upper = p > 0.5;
  const target = upper ? 1 - p : p; // lower-tail probability of -|t|
  let lo = 0;
  let hi = 1;
  while ((studentTCdf(-hi, df) as number) > target) { lo = hi; hi *= 2; if (hi > 1e12) return null; }
  for (let i = 0; i < 200 && hi - lo > 1e-13 * Math.max(1, hi); i++) {
    const mid = (lo + hi) / 2;
    if ((studentTCdf(-mid, df) as number) > target) lo = mid; else hi = mid;
  }
  const t = (lo + hi) / 2;
  return upper ? t : -t;
}

// P(X >= x) for X chi-square with df degrees of freedom.
export function chiSquareUpper(x: number, df: number): number | null {
  if (!finite(x) || x < 0 || !finite(df) || df < 1) return null;
  return gammaQ(df / 2, x / 2);
}

const zFor = (level: number): number | null => (finite(level) && level > 0 && level < 1 ? normalQuantile(1 - (1 - level) / 2) : null);

// Wilson score interval for x successes out of n.
export function wilsonInterval(x: number, n: number, level: number): Ci | null {
  const z = zFor(level);
  if (z === null || !finite(x) || !finite(n) || n <= 0 || x < 0 || x > n) return null;
  const p = x / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half), level };
}

// Newcombe's hybrid score interval (1998, method 10) for p1 - p2 from two independent samples: each arm's Wilson
// interval, combined as a square-and-add. Holds its coverage near 0 and 1 and with small arms, where Wald fails.
export function newcombeInterval(x1: number, n1: number, x2: number, n2: number, level: number): Ci | null {
  const a = wilsonInterval(x1, n1, level);
  const b = wilsonInterval(x2, n2, level);
  if (a === null || b === null) return null;
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const d = p1 - p2;
  return {
    lo: d - Math.sqrt((p1 - a.lo) ** 2 + (b.hi - p2) ** 2),
    hi: d + Math.sqrt((a.hi - p1) ** 2 + (p2 - b.lo) ** 2),
    level,
  };
}

// n, mean and sample standard deviation (n - 1 denominator). sd is null below two values.
export interface MeanStats { n: number; mean: number | null; sd: number | null }

export function meanSummary(values: number[]): MeanStats {
  const n = values.length;
  if (n === 0) return { n, mean: null, sd: null };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  if (n < 2) return { n, mean, sd: null };
  const ss = values.reduce((s, v) => s + (v - mean) ** 2, 0);
  return { n, mean, sd: Math.sqrt(ss / (n - 1)) };
}

// One-sample t interval for a mean.
export function oneSampleT(s: MeanStats, level: number): Ci | null {
  if (!finite(level) || level <= 0 || level >= 1 || s.n < 2 || !finite(s.mean) || !finite(s.sd)) return null;
  const t = studentTQuantile(1 - (1 - level) / 2, s.n - 1);
  if (t === null) return null;
  const half = (t * s.sd) / Math.sqrt(s.n);
  return { lo: s.mean - half, hi: s.mean + half, level };
}

// Welch interval for mean1 - mean2, with Welch-Satterthwaite degrees of freedom. Does not assume equal variances.
export function welchInterval(a: MeanStats, b: MeanStats, level: number): (Ci & { df: number }) | null {
  if (!finite(level) || level <= 0 || level >= 1) return null;
  if (a.n < 2 || b.n < 2 || !finite(a.mean) || !finite(b.mean) || !finite(a.sd) || !finite(b.sd)) return null;
  const va = (a.sd * a.sd) / a.n;
  const vb = (b.sd * b.sd) / b.n;
  const se2 = va + vb;
  if (!(se2 > 0)) return null;
  const df = (se2 * se2) / ((va * va) / (a.n - 1) + (vb * vb) / (b.n - 1));
  const t = studentTQuantile(1 - (1 - level) / 2, df);
  if (t === null) return null;
  const d = a.mean - b.mean;
  const half = t * Math.sqrt(se2);
  return { lo: d - half, hi: d + half, level, df };
}

export interface ChiSquare { statistic: number; df: number; p: number }

// Pearson goodness of fit of observed counts against intended shares (sample ratio mismatch).
export function chiSquareGof(observed: number[], shares: number[]): ChiSquare | null {
  if (observed.length < 2 || observed.length !== shares.length) return null;
  const total = observed.reduce((s, v) => s + v, 0);
  const shareSum = shares.reduce((s, v) => s + v, 0);
  if (!(total > 0) || !(shareSum > 0)) return null;
  let statistic = 0;
  for (let i = 0; i < observed.length; i++) {
    const expected = (total * shares[i]) / shareSum;
    if (!(expected > 0)) return null;
    statistic += (observed[i] - expected) ** 2 / expected;
  }
  const df = observed.length - 1;
  const p = chiSquareUpper(statistic, df);
  return p === null ? null : { statistic, df, p };
}

// Pearson test of independence for a table of counts (rows x columns). The caller pools sparse columns first.
export function chiSquareIndependence(table: number[][]): ChiSquare | null {
  const r = table.length;
  const c = r > 0 ? table[0].length : 0;
  if (r < 2 || c < 2 || table.some((row) => row.length !== c)) return null;
  const rowT = table.map((row) => row.reduce((s, v) => s + v, 0));
  const colT = Array.from({ length: c }, (_, j) => table.reduce((s, row) => s + row[j], 0));
  const total = rowT.reduce((s, v) => s + v, 0);
  if (!(total > 0)) return null;
  let statistic = 0;
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) {
      const expected = (rowT[i] * colT[j]) / total;
      if (!(expected > 0)) return null;
      statistic += (table[i][j] - expected) ** 2 / expected;
    }
  }
  const df = (r - 1) * (c - 1);
  const p = chiSquareUpper(statistic, df);
  return p === null ? null : { statistic, df, p };
}

// Conversations per arm for a two-sided test of two proportions (normal approximation, no continuity correction):
// n = (z_{1-a/2} sqrt(2 pbar qbar) + z_{power} sqrt(p1 q1 + p2 q2))^2 / (p1 - p2)^2, with p2 = p1 + delta in the good
// direction, clamped inside (0, 1). Null when the clamped target leaves no change to detect.
export const PROPORTION_CLAMP = 1e-6;
export function sampleSizeProportions(p1: number, delta: number, direction: Direction, alpha: number, power: number): number | null {
  if (!finite(p1) || p1 < 0 || p1 > 1 || !finite(delta) || delta <= 0) return null;
  const za = normalQuantile(1 - alpha / 2);
  const zb = normalQuantile(power);
  if (za === null || zb === null) return null;
  const raw = direction === "higher_is_better" ? p1 + delta : p1 - delta;
  const p2 = Math.min(1 - PROPORTION_CLAMP, Math.max(PROPORTION_CLAMP, raw));
  const diff = Math.abs(p2 - p1);
  if (diff < PROPORTION_CLAMP || Math.sign(p2 - p1) !== Math.sign(raw - p1)) return null;
  const pbar = (p1 + p2) / 2;
  const top = za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((top * top) / (diff * diff) - 1e-9);
}

// Conversations per arm for a two-sided test of two means with a common sd (normal approximation):
// n = 2 (z_{1-a/2} + z_{power})^2 sd^2 / delta^2. Null when sd is unknown or 0 (a constant baseline is no basis
// for sizing).
export function sampleSizeMeans(sd: number | null, delta: number, alpha: number, power: number): number | null {
  if (!finite(sd) || sd <= 0 || !finite(delta) || delta <= 0) return null;
  const za = normalQuantile(1 - alpha / 2);
  const zb = normalQuantile(power);
  if (za === null || zb === null) return null;
  return Math.ceil((2 * (za + zb) ** 2 * sd * sd) / (delta * delta) - 1e-9);
}
