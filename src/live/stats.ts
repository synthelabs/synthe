// Two-sample tests for live experiments. Everything here is a normal approximation: it is meant for
// the sample sizes a live rule sees, not for tiny samples.

export interface Test {
  diff: number; // test minus base
  se: number;
  z: number;
  p: number; // two-sided
}

// erfc is needed to 1e-12 or better. Abramowitz-Stegun 7.1.26 sums to 0.999999999 at 0, so it would
// make equal arms read p = 0.999999999. Instead: a series for erf on [0, 3), which has only positive
// terms and so no cancellation, and a continued fraction for erfc on [3, inf). Negative x uses the
// reflection erfc(-x) = 2 - erfc(x).
function erfc(x: number): number {
  if (x < 0) return 2 - erfc(-x);
  if (x < 3) {
    // erf(x) = 2/sqrt(pi) * exp(-x^2) * sum_n x * (2x^2)^n / (1*3*...*(2n+1))
    let term = x;
    let sum = x;
    for (let n = 1; n < 500 && term > 1e-18 * sum; n++) {
      term *= (2 * x * x) / (2 * n + 1);
      sum += term;
    }
    return 1 - (2 / Math.sqrt(Math.PI)) * Math.exp(-x * x) * sum;
  }
  // erfc(x) = exp(-x^2) / sqrt(pi) / (x + (1/2)/(x + 1/(x + (3/2)/(x + ...)))), evaluated bottom-up.
  let f = x;
  for (let k = 200; k >= 1; k--) f = x + k / 2 / f;
  return Math.exp(-x * x) / (Math.sqrt(Math.PI) * f);
}

// Upper tail of the standard normal.
export function normalSf(z: number): number {
  return 0.5 * erfc(z / Math.SQRT2);
}

// Acklam's rational approximation (relative error about 1e-9). Not refined: the tests allow 1e-6.
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function twoSided(z: number): number {
  return Math.min(1, 2 * normalSf(Math.abs(z)));
}

// Two-proportion z-test with a pooled rate. Null when an arm is empty or the pooled rate leaves no variance.
export function rateTest(
  base: { units: number; events: number },
  test: { units: number; events: number },
): Test | null {
  const n1 = base.units;
  const n2 = test.units;
  if (n1 <= 0 || n2 <= 0) return null;
  const pooled = (base.events + test.events) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0) return null;
  const diff = test.events / n2 - base.events / n1;
  const z = diff / se;
  return { diff, se, z, p: twoSided(z) };
}

// Welch-style z-test for a mean, built from sums so a rule never needs the raw values.
export function meanTest(
  base: { units: number; sum: number; sum_sq: number },
  test: { units: number; sum: number; sum_sq: number },
): Test | null {
  if (base.units < 2 || test.units < 2) return null;
  const arm = (a: { units: number; sum: number; sum_sq: number }) => {
    const m = a.sum / a.units;
    // The subtraction cancels to rounding noise when every value in the arm is the same. Treat a
    // numerator that small relative to sum_sq as zero, so a constant arm gives se 0 and a null test.
    const num = a.sum_sq - a.units * m * m;
    const v = num <= 1e-12 * a.sum_sq ? 0 : num / (a.units - 1);
    return { m, v: v / a.units };
  };
  const b = arm(base);
  const t = arm(test);
  const se = Math.sqrt(b.v + t.v);
  if (se === 0) return null;
  const diff = t.m - b.m;
  const z = diff / se;
  return { diff, se, z, p: twoSided(z) };
}

// Sample ratio mismatch: chi-square with one degree of freedom on the unit counts against the
// configured weights. A small p means the split is not what it was set to be.
export function srmP(units: [number, number], weights: [number, number]): number | null {
  if (weights[0] <= 0 || weights[1] <= 0) return null;
  const total = units[0] + units[1];
  if (total === 0) return null;
  const weightSum = weights[0] + weights[1];
  let x = 0;
  for (let i = 0; i < 2; i++) {
    const expected = (total * weights[i]) / weightSum;
    x += (units[i] - expected) ** 2 / expected;
  }
  return erfc(Math.sqrt(x / 2));
}

// Confidence interval for the difference: diff plus or minus the normal quantile times se.
export function interval(t: Test, alpha: number): [number, number] {
  const q = normalQuantile(1 - alpha / 2);
  return [t.diff - q * t.se, t.diff + q * t.se];
}
