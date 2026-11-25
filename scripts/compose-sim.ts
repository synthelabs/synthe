// Run: node scripts/compose-sim.ts. Offline only, no model calls.
// Offline comparison: compose off vs on, using the real merge rule (judgeRound) on synthetic duel outcomes.
// No model calls. Each case's outcome vs the current prompt is win/loss/tie drawn from a per-case probability.
import { judgeRound, trainingProblem, mean, type RoundScores, type ScoreRow, type CandidateScore } from "../src/core/merge-rule.ts";
import { DEFAULTS, type Goal } from "../src/core/goal.ts";

const baseGoal = { version: 1, prompt: { kind: "file", path: "p" }, objective: "x", guardrails: [], scenarios: "s", ...DEFAULTS } as Goal;
// Each scenario runs under the old rule (no sign test on the hidden cases, holdout_max_p 1) and today's default.
const RULES: [string, Goal][] = [
  ["old rule, no hidden sign test", { ...baseGoal, merge_rule: { ...DEFAULTS.merge_rule, holdout_max_p: 1 } }],
  [`hidden sign test p<=${DEFAULTS.merge_rule.holdout_max_p}`, baseGoal],
];
let goal = baseGoal;
let seed = 12345; // mulberry32
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const TIE = 0.4;
// lift: how much more likely a decided case is a win than a loss (0 = no real effect)
const draw = (id: string, lift: number): ScoreRow => {
  if (rnd() < TIE) return { id, score: 50, violation: false };
  return { id, score: rnd() < 0.5 + lift / 2 ? 100 : 0, violation: false };
};
const NT = 20, NH = 20; // the setup default
const tIds = Array.from({ length: NT }, (_, i) => "t" + i), hIds = Array.from({ length: NH }, (_, i) => "h" + i);

// effect(caseIndex, isHidden) -> lift for one candidate
type Eff = (i: number, hidden: boolean) => number;
function round(cands: Eff[]): { merged: string | null; leader: number | null } {
  const scores: RoundScores = { baselineHash: "b", baselineTrain: tIds.map((id) => ({ id, score: 50, violation: false })), baselineHoldout: hIds.map((id) => ({ id, score: 50, violation: false })), candidates: [] };
  scores.candidates = cands.map((e, k) => ({ id: "c" + k, train: tIds.map((id, i) => draw(id, e(i, false))) }));
  const leader = scores.candidates.filter((c) => trainingProblem(c, scores.baselineTrain, goal) === null).sort((a, b) => mean(b.train)! - mean(a.train)!)[0];
  if (leader) { const k = Number(leader.id.slice(1)); leader.holdout = hIds.map((id, i) => draw(id, cands[k](i, true))); }
  const v = judgeRound(scores, goal, null);
  return { merged: v.action === "merge" ? v.candidateId : null, leader: leader ? Number(leader.id.slice(1)) : null };
}

function run(name: string, off: Eff[], on: Eff[], good: (id: string, set: Eff[]) => boolean, n = 20000) {
  const tally = (set: Eff[]) => { let m = 0, g = 0, comp = 0;
    for (let r = 0; r < n; r++) { const x = round(set); if (x.merged) { m++; if (good(x.merged, set)) g++; if (x.merged === "c" + (set.length - 1) && set.length > off.length) comp++; } }
    return { mergeRate: (100 * m / n).toFixed(1) + "%", goodMerges: (100 * g / n).toFixed(1) + "%", badMerges: (100 * (m - g) / n).toFixed(1) + "%", composedWon: (100 * comp / n).toFixed(1) + "%" }; };
  console.log(name);
  for (const [label, g] of RULES) { goal = g; console.log(`  ${label}`); console.log("    off:", JSON.stringify(tally(off))); console.log("    on: ", JSON.stringify(tally(on))); }
}
const nul: Eff = () => 0;
const half = (lo: number, hi: number, lift: number): Eff => (i, h) => (h ? (i % 2 === (lo % 2) ? lift : 0) : (i >= lo && i < hi ? lift : 0));
// "good" = the merged candidate truly helps on average over all cases (train and hidden)
const truly = (id: string, set: Eff[]) => { const e = set[Number(id.slice(1))]; let s = 0; for (let i = 0; i < NH; i++) s += e(i, true); return s > 0; };

run("1. Null world, composer is just one more fresh guess", [nul, nul], [nul, nul, nul], truly);
// Overfit: composed truly wins the training cases it was written from (lift 0.5 on train) but does nothing on hidden.
run("2. Null world, composer overfits the training cases (lift 0.5 on train, 0 on hidden)", [nul, nul], [nul, nul, (i, h) => (h ? 0 : 0.5)], truly);
run("3. Null world, composer overfits hard (lift 0.9 on train, 0 on hidden)", [nul, nul], [nul, nul, (i, h) => (h ? 0 : 0.9)], truly);
// Real effects: each writer edit helps half the cases a little; the composed one helps both halves.
const A: Eff = (i, h) => (h ? (i % 2 ? 0.5 : 0) : i < NT / 2 ? 0.5 : 0);
const B: Eff = (i, h) => (h ? (i % 2 ? 0 : 0.5) : i >= NT / 2 ? 0.5 : 0);
const AB: Eff = () => 0.5;
run("4. Real but partial edits (each helps half the cases, lift 0.5); composer combines both", [A, B], [A, B, AB], truly);
const Abad: Eff = (i, h) => (h ? (i % 2 ? 0.3 : -0.9) : i < NT / 2 ? 0.9 : 0.3);
run("5. Composed edit looks great on training (+0.9/+0.3) but is net harmful on unseen cases (+0.3/-0.9)", [A, B], [A, B, Abad], truly);
