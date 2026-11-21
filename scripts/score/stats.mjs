// The arithmetic of the Synthe score. No file access and no processes, so the self-test can check each rule.

export const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// Sample variance (n - 1). 0 for fewer than 2 values.
export function variance(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1);
}

function logGamma(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.001208650973866179, -0.000005395239384953];
  let y = x, t = x + 5.5, s = 1.000000000190015;
  t -= (x + 0.5) * Math.log(t);
  for (const k of c) s += k / ++y;
  return -t + Math.log((2.5066282746310005 * s) / x);
}

// The regularized incomplete beta function I_x(a, b), by Lentz's continued fraction.
function incompleteBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x > (a + 1) / (a + b + 2)) return 1 - incompleteBeta(1 - x, b, a);
  const tiny = 1e-300;
  let f = 1, c = 1, d = 0;
  for (let i = 0; i <= 300; i++) {
    const m = Math.floor(i / 2);
    const num = i === 0 ? 1 : i % 2 === 0 ? (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m)) : -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + num * d; if (Math.abs(d) < tiny) d = tiny; d = 1 / d;
    c = 1 + num / c; if (Math.abs(c) < tiny) c = tiny;
    f *= c * d;
    if (Math.abs(1 - c * d) < 1e-12) break;
  }
  return (front * (f - 1)) / a;
}

/** P(T <= t) for Student's t distribution with `df` degrees of freedom. */
export function studentTCdf(t, df) {
  const half = 0.5 * incompleteBeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? 1 - half : half;
}

/** One-sided Welch t-test: the p-value for "the gain is not above 0". `gains` are already signed by direction. */
export function welchP(before, after, sign) {
  const va = variance(after) / after.length, vb = variance(before) / before.length;
  const se2 = va + vb;
  const gain = sign * (mean(after) - mean(before));
  if (se2 === 0) return gain > 0 ? 0 : 1;
  const df = (se2 * se2) / ((va * va) / Math.max(1, after.length - 1) + (vb * vb) / Math.max(1, before.length - 1));
  return 1 - studentTCdf(gain / Math.sqrt(se2), df);
}

export const FALSE_KEEP_ALPHA = 0.05;

// A false keep: a kept change whose effect on the holdout split is not a real gain. For an exact measure (no spread
// in either sample) the effect must be above 0. For a noisy measure the mean effect must be above 0 and the
// one-sided Welch test must give p <= 0.05. A sample with a failed run (NaN) is never a real gain.
export function isFalseKeep(before, after, direction) {
  if (!before.length || !after.length || [...before, ...after].some((x) => !Number.isFinite(x))) return true;
  const sign = direction === "lower" ? -1 : 1;
  const effect = sign * (mean(after) - mean(before));
  if (effect <= 0) return true;
  if (variance(before) === 0 && variance(after) === 0) return false;
  return welchP(before, after, sign) > FALSE_KEEP_ALPHA;
}

// The gain share of one problem: (f - b) / (r - b) with the direction taken into account, clamped to [-1, 1].
// null when the reference is not better than the baseline: such a problem cannot be scored.
export function gainShare(b, f, r, direction) {
  const sign = direction === "lower" ? -1 : 1;
  const room = sign * (r - b);
  if (!(room > 0) || !Number.isFinite(room)) return null;
  if (!Number.isFinite(f)) return -1;
  return Math.max(-1, Math.min(1, (sign * (f - b)) / room));
}

export const MAX_FALSE_KEEP_RATE = 0.05;

// The Synthe score from the per-problem records. `shares` holds one gain share for each scored problem.
export function syntheScore(shares, kept, falseKeeps, costUsd) {
  const meanShare = shares.length ? mean(shares) : 0;
  const rate = kept > 0 ? falseKeeps / kept : 0;
  const score = meanShare - 2 * rate;
  return {
    score, meanShare, kept, falseKeeps, rate,
    valid: rate <= MAX_FALSE_KEEP_RATE,
    costUsd,
    perDollar: costUsd !== null && costUsd > 0 ? score / costUsd : null,
  };
}
