// "Isn't worse" for shorter prompts (merge_rule.allow_shorter). The merge rule's sign test asks whether a change is
// better; a deletion only has to show it is not clearly worse, which needs its own test: a non-inferiority test.
//
// Over the decided test cases (ties carry no evidence either way and are left out, as in the sign test), the
// hypothesis to reject is "the shorter prompt loses at least 0.5 + margin of them". It is rejected when the losses
// seen are few enough that a prompt that really lost that often would rarely show so few: an exact one-sided
// binomial test, P(X <= losses) for X ~ Binomial(decided, 0.5 + margin).

// The margin d. A shorter prompt passes only if a prompt losing 65% of decided cases would rarely look this good.
// Why 0.15: the margin sets how many decided cases a prompt needs to show it isn't worse, and at the default limits
// (max_p 0.05) that number has to be one teams have. At 0.15 an exactly even split passes from 36 decided cases;
// at 0.10 it needs 76 and at 0.05 it needs 290, more than any team writes, so nothing would ever be shortened.
// It is not loose: at 20 decided cases a shorter prompt may lose at most 8 (12 wins, 8 losses: p 0.0196; 11 and 9
// gives p 0.0532), and at 10 at most 3, so it has to win more than it loses on small sets. 0.20 would pass an even
// 10-10 split, where a real 60/40 loss is still quite likely. Anything that slips through is checked again the
// round after by the revert test, like any merge.
export const NON_INFERIORITY_MARGIN = 0.15;

// Exact one-sided p-value: the chance a prompt that loses (0.5 + margin) of decided cases shows `losses` or fewer.
// Summed in log space so it stays exact to double precision for any number of test cases. No decided cases: no
// evidence, so p is 1 and nothing passes.
export function nonInferiorityP(wins: number, losses: number, margin = NON_INFERIORITY_MARGIN): number {
  const n = wins + losses;
  if (!Number.isSafeInteger(wins) || !Number.isSafeInteger(losses) || wins < 0 || losses < 0 || n === 0) return 1;
  const p = 0.5 + margin;
  let logTerm = n * Math.log(1 - p); // P(X = 0)
  let tail = Math.exp(logTerm);
  for (let k = 0; k < losses; k++) {
    logTerm += Math.log(n - k) - Math.log(k + 1) + Math.log(p) - Math.log(1 - p);
    tail += Math.exp(logTerm);
  }
  return Math.min(1, tail);
}

// Why a shorter candidate fails the test on one set of test cases, or null when it passes. split is the
// candidate's wins and losses against the current prompt, null when some case couldn't be compared. The text
// goes into verdict reasons, which `npx synthe verify` recomputes word for word, so it names only numbers the
// evidence record holds.
export function notWorseProblem(id: string, split: { wins: number; losses: number } | null, maxP: number, where: "test cases" | "hidden test cases"): string | null {
  if (split === null) return `${id}: ${where} could not be compared`;
  const p = nonInferiorityP(split.wins, split.losses);
  if (p > maxP) return `${id}: shorter, but better in ${split.wins} and worse in ${split.losses} ${where} doesn't rule out a loss (p ${p.toFixed(3)} that it is no worse, needs ${maxP})`;
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
