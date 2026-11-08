// Holds the decision code to the Lean model in spec/, whose guarantees are proved (spec/SyntheSpec/Proofs.lean).
// Seeded random inputs go to both sides; any disagreement fails with the input that caused it. Skipped when the
// Lean binary hasn't been built (`cd spec && lake build`), so a machine without Lean still runs everything else.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { addedBreaks, guardRate, judgeRound, mean, paired, signP, trainingProblem, type CandidateScore, type ScoreRow } from "../src/core/merge-rule.ts";
import { median, range, verdict } from "../src/improve/verdict.ts";

const BIN = "spec/.lake/build/bin/synthe-spec";
const CASES = Number(process.env.LEAN_SPEC_CASES ?? 400);
const skip = existsSync(BIN) ? false : "Lean spec not built: run `cd spec && lake build`";

// Small, seeded, so a failure names an input that reproduces.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const rand = rng(Number(process.env.LEAN_SPEC_SEED ?? 20261107));
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)];
const chance = (p: number) => rand() < p;

type Exact = { n: string; d: string };
const exact = (q: Exact) => Number(q.n) / Number(q.d);
const close = (a: number, q: Exact) => Math.abs(a - exact(q)) <= 1e-9 * Math.max(1, Math.abs(exact(q)));

function ask(requests: object[]): unknown[] {
  const out = spawnSync(BIN, { input: requests.map((r) => JSON.stringify(r)).join("\n") + "\n", encoding: "utf8", maxBuffer: 1 << 28 });
  assert.equal(out.status, 0, out.stderr);
  const lines = out.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, requests.length);
  return lines.map((l, i) => {
    if ("error" in l) assert.fail(`Lean rejected request ${JSON.stringify(requests[i])}: ${l.error}`);
    return l.ok;
  });
}

// Scenario rows the way scoring makes them: head-to-head scores, guardrail marks, guard counts. Edges on purpose:
// unknown scores and marks, repeated and missing ids, impossible guard counts.
const SCORES = [0, 50, 100] as const;
function rows(ids: string[], opts: { unknown?: number } = {}): ScoreRow[] {
  const out: ScoreRow[] = ids.map((id) => {
    const r: ScoreRow = { id, score: chance(opts.unknown ?? 0.04) ? null : pick(SCORES), violation: chance(0.05) ? null : chance(0.15) };
    if (!chance(0.05)) {
      const a = int(0, 3);
      r.guardApplicable = chance(0.02) ? -1 : a;
      r.guardFailed = chance(0.02) ? a + 1 : int(0, a);
    }
    return r;
  });
  if (out.length && chance(0.04)) out.push({ ...out[0] }); // a repeated id
  if (out.length > 1 && chance(0.04)) out.pop(); // a missing one
  return out.sort(() => rand() - 0.5);
}
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

// The same rows, nudged better or worse, so candidates sit near the merge rule's thresholds.
function challenger(base: ScoreRow[], lean: number): ScoreRow[] {
  const at = rows(base.map((r) => r.id));
  for (const r of at) if (r.score !== null) r.score = chance(lean) ? 100 : chance(0.5) ? 50 : 0;
  return at;
}

// Thresholds include exact binary fractions such as 11/1024, so p-values land exactly on max_p.
const rule = () => ({
  min_improvement: pick([0, 2, 2.5, 5]),
  max_p: pick([0.05, 0.1, 0.5, 11 / 1024, 1 / 64, 1]),
  noise_margin: pick([0, 3]),
  guard_margin: pick([0, 3, 0.5]),
  counterChecks: chance(0.4),
});
const goalOf = (r: ReturnType<typeof rule>) => ({
  merge_rule: { mode: "auto", min_improvement: r.min_improvement, max_p: r.max_p, noise_margin: r.noise_margin, max_rounds: 12, stall_rounds: 3, guard_margin: r.guard_margin },
  ...(r.counterChecks ? { counter_checks: ["a guard"] } : {}),
}) as never;

function round() {
  const trainIds = ids("t", int(1, 10));
  const holdIds = ids("h", int(1, 6));
  const baselineTrain = rows(trainIds, { unknown: 0.01 });
  const baselineHoldout = rows(holdIds, { unknown: 0.01 });
  const attackIds = ids("a", int(1, 4));
  const failedSome = () => attackIds.filter(() => chance(0.25));
  const candidates: CandidateScore[] = ids("c", int(0, 3)).map((id) => {
    const lean = rand();
    const c: CandidateScore = { id, train: challenger(baselineTrain, lean) };
    if (!chance(0.1)) c.holdout = challenger(baselineHoldout, lean);
    const a = rand();
    if (a < 0.08) c.attackFailed = null;
    else if (a < 0.9) c.attackFailed = failedSome();
    return c;
  });
  const attacks = chance(0.4) ? { total: attackIds.length, baselineFailed: chance(0.08) ? null : failedSome(), inputs: {} } : undefined;
  const replaced = chance(0.3) ? challenger([...baselineTrain, ...baselineHoldout], rand()) : null;
  return { baselineTrain, baselineHoldout, candidates, attacks, replaced };
}

// JSON drops undefined fields and keeps null, which is how the Lean side tells "missing" from "null" apart where
// TS does (it doesn't, for these fields).
const wire = <T>(x: T): T => JSON.parse(JSON.stringify(x));

test("sign test matches the exact binomial tail", { skip }, () => {
  const cases = Array.from({ length: CASES }, () => [int(0, 60), int(0, 60)] as const).concat([[0, 0], [200, 3], [3, 200]]);
  const lean = ask(cases.map(([wins, losses]) => ({ fn: "signP", wins, losses }))) as Exact[];
  cases.forEach(([w, l], i) => assert.ok(close(signP(w, l), lean[i]), `signP(${w}, ${l}) = ${signP(w, l)}, exact ${lean[i].n}/${lean[i].d}`));
});

test("mean, pairing, added breaks and guard rate match the model", { skip }, () => {
  const cases = Array.from({ length: CASES }, () => {
    const base = rows(ids("s", int(0, 8)));
    return { base, other: chance(0.8) ? challenger(base, rand()) : rows(ids(pick(["s", "x"]), int(0, 8))) };
  });
  const lean = ask(cases.flatMap(({ base, other }) => [
    { fn: "mean", rows: wire(other) },
    { fn: "paired", after: wire(other), before: wire(base) },
    { fn: "addedBreaks", rows: wire(other), current: wire(base) },
    { fn: "guardRate", rows: wire(other) },
  ]));
  cases.forEach(({ base, other }, i) => {
    const [m, p, a, g] = lean.slice(4 * i, 4 * i + 4) as [Exact | null, { wins: number; losses: number } | null, number, Exact | null];
    const input = JSON.stringify({ base, other });
    const tsMean = mean(other);
    assert.ok(m === null ? tsMean === null : tsMean !== null && close(tsMean, m), `mean: ${tsMean} vs ${JSON.stringify(m)} for ${input}`);
    const tsPaired = paired(other, base);
    assert.deepEqual(tsPaired && { wins: tsPaired.wins, losses: tsPaired.losses }, p, `paired for ${input}`);
    assert.equal(addedBreaks(other, base), a, `addedBreaks for ${input}`);
    const tsGuard = guardRate(other, false);
    assert.ok(g === null ? tsGuard === null : tsGuard !== null && close(tsGuard, g), `guardRate: ${tsGuard} vs ${JSON.stringify(g)} for ${input}`);
  });
});

test("training gate and the whole round's decision match the model", { skip }, () => {
  const cases = Array.from({ length: CASES }, () => ({ r: rule(), rd: round() }));
  const lean = ask(cases.flatMap(({ r, rd }) => [
    { fn: "judgeRound", rule: r, round: wire({ ...rd, replaced: undefined }), replaced: wire(rd.replaced) },
    ...rd.candidates.map((c) => ({ fn: "trainingOk", rule: r, candidate: wire(c), baselineTrain: wire(rd.baselineTrain) })),
  ]));
  let at = 0;
  for (const { r, rd } of cases) {
    const goal = goalOf(r);
    const input = JSON.stringify({ rule: r, round: rd });
    const v = judgeRound({ baselineHash: "h", baselineTrain: rd.baselineTrain, baselineHoldout: rd.baselineHoldout, candidates: rd.candidates, ...(rd.attacks ? { attacks: rd.attacks } : {}) }, goal, rd.replaced);
    assert.equal(v.action === "merge" ? `merge:${v.candidateId}` : v.action, lean[at++], `judgeRound for ${input}`);
    for (const c of rd.candidates) assert.equal(trainingProblem(c, rd.baselineTrain, goal) === null, lean[at++], `trainingProblem(${c.id}) for ${input}`);
  }
});

test("improve mode: median, range and the keep-or-drop verdict match the model", { skip }, () => {
  // Metrics like build seconds or a test count: whole numbers and one or two decimals, where float subtraction
  // and exact arithmetic can disagree right at the noise threshold.
  const num = () => (chance(0.5) ? int(0, 20) : int(0, 300) / pick([10, 100]));
  const meas = () => {
    const runs = Array.from({ length: int(1, 5) }, num);
    return { median: chance(0.9) ? median(runs) : num(), runs };
  };
  const cases = Array.from({ length: CASES }, () => ({ d: pick(["higher", "lower"] as const), b: meas(), c: meas(), g: pick([true, false, null]) }));
  const lean = ask(cases.flatMap(({ d, b, c, g }) => [
    { fn: "median", xs: c.runs },
    { fn: "range", xs: c.runs },
    { fn: "improveWin", direction: d, baseline: b, candidate: c, guard: g },
  ]));
  cases.forEach(({ d, b, c, g }, i) => {
    const [med, rng, win] = lean.slice(3 * i, 3 * i + 3) as [Exact, Exact, boolean];
    const input = JSON.stringify({ d, b, c, g });
    assert.ok(close(median(c.runs), med), `median for ${input}`);
    assert.ok(close(range(c.runs), rng), `range for ${input}`);
    const m = (x: typeof b) => ({ commit: "c", at: "t", median: x.median, runs: x.runs });
    assert.equal(verdict(d, m(b), m(c), g).win, win, `verdict for ${input}`);
  });
});
