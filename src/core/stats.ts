// Statistics that Solve uses to compare a measure before and after a change (src/solve/decide.ts).
//
// Written here rather than taken from a package, so every number in a decision can be traced to a few dozen lines.
// Every function is pure and returns null, never NaN, when its inputs cannot support an answer: a null reads as
// "cannot tell" in the decision rules, while a NaN would compare false and could pass a check by accident.

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

// Student's t CDF through the regularized incomplete beta function.
export function studentTCdf(t: number, df: number): number | null {
  if (!finite(t) || !finite(df) || df <= 0) return null;
  const tail = 0.5 * incompleteBeta(df / 2, 0.5, df / (df + t * t));
  return t > 0 ? 1 - tail : tail;
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
