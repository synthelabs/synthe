// "Isn't worse" for shorter prompts (merge_rule.allow_shorter). The merge rule's sign test asks whether a change is
// better; a deletion only has to show it is not clearly worse, which needs its own test: a non-inferiority test.
//
// Every test case counts, ties included. On case i the shorter prompt wins, ties or loses against the current one.
// With P(win) = a, P(loss) = b and P(tie) = 1 - a - b, the hypothesis to reject is "b - a >= margin": over all cases
// it loses at least `margin` more often than it wins. Ties are evidence here, not noise to drop: a deletion that
// changes nothing ties almost everywhere, and a prompt that really lost 30% more cases than it won would rarely
// tie 20 cases in a row (at most 0.7^20). Leaving ties out, as the sign test does, made exactly those deletions
// impossible to pass.
//
// The test is an exact unconditional one, the kind used for non-inferiority with matched pairs (paired binary
// outcomes, where ties are the concordant pairs). It is exact rather than approximate in both of its two steps:
//
// 1. Order the outcomes. Outcomes (wins w, losses l, ties t) are ranked by the score statistic for b - a with a and
//    b fitted under the hypothesis (b = a + margin): Z = (l - w - n*margin) / sqrt(n * (2a + margin - margin^2)).
//    The fitted a is the positive root of 2n a^2 - B a - w margin (1 - margin) = 0, with
//    B = w (1 - 3 margin) + l (1 - margin) - 2 t margin. Z uses the spread the hypothesis allows, so many ties
//    (little spread) make the same net loss stronger evidence than an even split does: 0 wins, 0 losses and 20
//    ties ranks far below 10 wins and 10 losses. Ranking by l - w alone could not tell those two apart.
//
// 2. Bound the chance, under the hypothesis, of an outcome at least as good as the one seen. The p-value is the
//    largest chance over every (a, b) the hypothesis allows; no estimate is plugged in, so the test keeps its level
//    exactly, whatever the true tie rate. Two facts make that largest chance computable:
//    - "At least as good" is taken as every outcome with no more losses and no fewer wins than some outcome ranked
//      at or below the one seen. That set only grows when a loss becomes a tie or a tie a win, so moving chance
//      from loss to tie can only raise the chance of landing in it. Any (a, b) with b - a above the margin is
//      reached that way from (a, a + margin), so the largest chance is on the edge b = a + margin, a in
//      [0, (1 - margin) / 2]: one unknown.
//    - On that edge each outcome's chance, C * a^w (a + margin)^l (1 - margin - 2a)^t, has a concave logarithm, so
//      the tangent of the log at the middle of an interval bounds it on the whole interval, and the bounds' sum,
//      convex in a, peaks at an interval end. Halving the interval with the highest bound until that bound is
//      within 0.01% of the best chance found gives a p-value that is never below the true one: if anything, the
//      test is very slightly conservative.
//
// At the edge's end a = (1 - margin) / 2 nothing ties, and the chance there is the exact binomial test of losses
// among decided cases against 0.5 + margin / 2 (0.65 at the default margin), the test used before ties counted.
// So for a split with no ties the p-value is never below that test's; up to 60 test cases, wherever either gives
// 0.1 or less, the two agree (test/shorter.test.ts checks up to 40).

// The margin, in P(loss) - P(win) over all test cases. A shorter prompt passes only if a prompt losing 30% more
// cases than it wins would rarely look this good. Why 0.30: it is the earlier margin of 0.15 on decided cases
// (0.65 losses among decided cases) restated over all cases, so with no ties nothing changes. At 20 test cases
// and no ties a shorter prompt may lose at most 8 (12 wins, 8 losses: p 0.0196; 11 and 9 gives p 0.0532), and an
// exactly even 10-10 split gives p 0.122, refused at both limits (max_p 0.05 and holdout_max_p 0.1). 0.40 would
// pass that 10-10 split at max_p 0.05 (p 0.048), where a real 60/40 loss is still quite likely. Ties add
// evidence: 20 cases that all tie give p 0.003, and all ties passes from 7 test cases at holdout_max_p 0.1 and from
// 10 at max_p 0.05. Anything that slips through is checked again the round after by the revert test, like any merge.
export const NON_INFERIORITY_MARGIN = 0.3;

// The edge search stops once its bound is within 0.01% (or 0.000001, whichever is larger) of the best chance found,
// or after MAX_SPLITS halvings. Either way it returns the bound, never the estimate, so stopping early only makes
// the test stricter, and reasons show p to 3 decimals.
const RELATIVE_TOLERANCE = 1e-4;
const ABSOLUTE_TOLERANCE = 1e-6;
const MAX_SPLITS = 500;

const logFactorials: number[] = [0];
function logFactorial(k: number): number {
  for (let i = logFactorials.length; i <= k; i++) logFactorials[i] = logFactorials[i - 1] + Math.log(i);
  return logFactorials[k];
}

// k * log(x), with 0 * log(0) = 0: an outcome with no wins has chance 1 for its wins part even when a is 0.
const kLog = (k: number, x: number) => (k === 0 ? 0 : k * Math.log(x));

// Step 1: the score statistic for wins w and losses l out of n. Lower is better for the shorter prompt.
export function nonInferiorityZ(w: number, l: number, n: number, margin = NON_INFERIORITY_MARGIN): number {
  const t = n - w - l;
  const B = w * (1 - 3 * margin) + l * (1 - margin) - 2 * t * margin;
  const a = (B + Math.sqrt(B * B + 8 * n * w * margin * (1 - margin))) / (4 * n);
  return (l - w - n * margin) / Math.sqrt(n * (2 * a + margin - margin * margin));
}

// Exact one-sided p-value that the shorter prompt is no worse: the largest chance, over every win and loss rate
// with P(loss) - P(win) >= margin, of an outcome at least as good as `wins`, `losses` and `ties`. No test cases, or
// counts that aren't whole numbers: no evidence, so p is 1 and nothing passes.
export function nonInferiorityP(wins: number, losses: number, ties: number, margin = NON_INFERIORITY_MARGIN): number {
  const n = wins + losses + ties;
  if (![wins, losses, ties].every((k) => Number.isSafeInteger(k) && k >= 0) || n === 0) return 1;
  // A round asks for the same split several times (scoring, the verdict, its reasons); the answer never changes.
  const key = `${wins},${losses},${ties},${margin}`;
  const known = memo.get(key);
  if (known !== undefined) return known;
  const p = searchEdge(wins, losses, n, margin);
  if (memo.size >= 1000) memo.clear();
  memo.set(key, p);
  return p;
}
const memo = new Map<string, number>();

function searchEdge(wins: number, losses: number, n: number, margin: number): number {
  // Outcomes at least as good as the one seen (step 2): for each loss count l from most to fewest, the fewest wins
  // of any outcome ranked at or below it with l or more losses. Z ties within rounding count as at or below.
  const seen = nonInferiorityZ(wins, losses, n, margin);
  const limit = seen + 1e-9 * Math.max(1, Math.abs(seen));
  const region: { w: number; l: number; t: number; c: number }[] = [];
  let fewestWins = Infinity;
  for (let l = n; l >= 0; l--) {
    for (let w = 0; w + l <= n && w < fewestWins; w++) if (nonInferiorityZ(w, l, n, margin) <= limit) { fewestWins = w; break; }
    for (let w = fewestWins; w + l <= n; w++) region.push({ w, l, t: n - w - l, c: logFactorial(n) - logFactorial(w) - logFactorial(l) - logFactorial(n - w - l) });
  }
  const top = (1 - margin) / 2;
  const logChance = (o: { w: number; l: number; t: number; c: number }, a: number) => o.c + kLog(o.w, a) + kLog(o.l, a + margin) + kLog(o.t, Math.max(0, 1 - margin - 2 * a));
  const chance = (a: number) => region.reduce((sum, o) => sum + Math.exp(logChance(o, a)), 0);
  // The tangent bound on [lo, hi], and the chance at its middle, which is a lower bound on the largest chance.
  const interval = (lo: number, hi: number) => {
    const mid = (lo + hi) / 2;
    let atLo = 0;
    let atHi = 0;
    let atMid = 0;
    for (const o of region) {
      const g = logChance(o, mid);
      const slope = o.w / mid + o.l / (mid + margin) - (2 * o.t) / (1 - margin - 2 * mid);
      atLo += Math.exp(g + slope * (lo - mid));
      atHi += Math.exp(g + slope * (hi - mid));
      atMid += Math.exp(g);
    }
    return { lo, hi, bound: Math.min(1, Math.max(atLo, atHi)), atMid };
  };
  const first = interval(0, top);
  let best = Math.max(chance(0), chance(top), first.atMid);
  let open = [first];
  for (let splits = 0; open.length > 0; splits++) {
    let i = 0;
    for (let j = 1; j < open.length; j++) if (open[j].bound > open[i].bound) i = j;
    const highest = open[i];
    if (highest.bound <= best + Math.max(RELATIVE_TOLERANCE * best, ABSOLUTE_TOLERANCE) || splits >= MAX_SPLITS) return Math.min(1, Math.max(best, highest.bound));
    const mid = (highest.lo + highest.hi) / 2;
    const halves = [interval(highest.lo, mid), interval(mid, highest.hi)];
    best = Math.max(best, ...halves.map((h) => h.atMid));
    open = [...open.slice(0, i), ...open.slice(i + 1), ...halves].filter((h) => h.bound > best);
  }
  return Math.min(1, best);
}

// Why a shorter candidate fails the test on one set of test cases, or null when it passes. split is the
// candidate's wins, losses and ties against the current prompt, null when some case couldn't be compared. The text
// goes into verdict reasons, which `npx synthe verify` recomputes word for word, so it names only numbers the
// evidence record holds.
export function notWorseProblem(id: string, split: { w: number; l: number; t: number } | null, maxP: number, where: "test cases" | "hidden test cases"): string | null {
  if (split === null) return `${id}: ${where} could not be compared`;
  const p = nonInferiorityP(split.w, split.l, split.t);
  if (p > maxP) return `${id}: shorter, but better in ${split.w}, worse in ${split.l} and the same in ${split.t} ${where} doesn't rule out a loss (p ${p.toFixed(3)} that it is no worse, needs ${maxP})`;
  return null;
}

// The team's sentence for a shorter candidate that wasn't used because it might be worse.
export function notWorseNote(t: { w: number; l: number; t: number } | null, where: "" | " hidden"): string {
  if (!t) return "Some replies couldn't be judged, so it wasn't used.";
  return `Shorter, but it may do worse on your${where} test cases: better in ${t.w}, worse in ${t.l}, the same in ${t.t}, so it wasn't used.`;
}

// "Removed 412 characters (9%) from the prompt with no measured loss: better in 6, worse in 5, the same in 9."
export function shorterSentence(chars: { before: number; after: number } | undefined, t: { w: number; l: number; t: number }): string {
  const removed = chars ? chars.before - chars.after : 0;
  const what = chars && removed > 0 && chars.before > 0
    ? `Removed ${removed} characters (${Math.round((100 * removed) / chars.before)}%) from the prompt`
    : "Shortened the prompt";
  return `${what} with no measured loss: better in ${t.w}, worse in ${t.l}, the same in ${t.t}.`;
}
