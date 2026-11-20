// Free and deterministic: simulates whole runs, not single rounds, through the real trainingProblem and judgeRound,
// to measure the chance that a run merges at least one change that does nothing, and how merge_rule.run_alpha
// trades that against merging real gains. No model calls; nothing leaves the process.
//
//   node scripts/simulate-run.ts             20,000 runs per cell, seed 1
//   node scripts/simulate-run.ts 2000 7      2,000 runs per cell, seed 7
//
// A run is what the workflow does: rounds until max_rounds, or until stall_rounds rounds in a row merge nothing.
// Each round tries 2 candidates (3 with compose or population). Only the best candidate that passes training gets held-back
// duels, as in runScore. While the last merge is live, the prompt it replaced challenges the current one on every
// case and a clear win puts it back (a revert counts as a round without a winner, as in decide.ts).
// Each duel is independent: a win, loss or tie with the true rates below. Prompts carry a true quality; a change
// that does nothing keeps it, a real gain adds one, and duels between prompts of equal quality are even.
// The "exact" columns are src/core/run-risk.ts at the simulated tie rate, the closed form the report quotes.
import { pathToFileURL } from "node:url";
import { DEFAULTS, type Goal } from "../src/core/goal.ts";
import { judgeRound, mean, trainingProblem, type CandidateScore, type RoundScores, type ScoreRow } from "../src/core/merge-rule.ts";
import { plannedCandidates } from "../src/core/run-alpha.ts";
import { roundFalseMergeChances } from "../src/core/run-risk.ts";

// mulberry32: a small seeded generator, so every table can be reproduced exactly.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rates { win: number; loss: number } // the rest are ties
export const NO_EFFECT: Rates = { win: 0.375, loss: 0.375 };
export const REAL_GAIN: Rates = { win: 0.5, loss: 0.25 };

export interface RunSetup {
  train: number;
  holdout: number;
  goal: Goal; // the rule candidates are judged by
  revertGoal?: Goal; // the rule the revert check uses, when a scheme changes max_p for candidates only
  gainShare: number; // share of rounds in which one candidate carries a real gain
  none?: Rates;
  gain?: Rates;
  runs: number;
  seed: number;
}

export interface RunStats {
  runs: number;
  rounds: number; // mean rounds per run
  anyFalse: number; // share of runs that merged at least one change that does nothing
  falseMerges: number; // mean no-effect merges per run
  realMerges: number; // mean real gains merged per run
  gainsOffered: number; // mean real gains tried per run
  reverts: number; // mean reverts per run
}

export function simulateRuns(s: RunSetup): RunStats {
  const rng = mulberry32(s.seed);
  const none = s.none ?? NO_EFFECT, gain = s.gain ?? REAL_GAIN;
  const { goal } = s;
  const revertGoal = s.revertGoal ?? goal;
  const { max_rounds, stall_rounds } = goal.merge_rule;
  const k = plannedCandidates(goal);
  // effect: the challenger's true quality minus the prompt it is dueled against.
  const duel = (effect: number) => {
    const r = effect === 0 ? none : effect > 0 ? gain : { win: gain.loss, loss: gain.win };
    const x = rng();
    return x < r.win ? 100 : x < r.win + r.loss ? 0 : 50;
  };
  const rows = (n: number, pre: string, effect: number): ScoreRow[] => Array.from({ length: n }, (_, i) => ({ id: `${pre}${i}`, score: duel(effect), violation: false }));
  const even = (n: number, pre: string): ScoreRow[] => Array.from({ length: n }, (_, i) => ({ id: `${pre}${i}`, score: 50, violation: false }));
  const baselineTrain = even(s.train, "t"), baselineHoldout = even(s.holdout, "h");
  const total = { rounds: 0, anyFalse: 0, falseMerges: 0, realMerges: 0, gainsOffered: 0, reverts: 0 };

  for (let run = 0; run < s.runs; run++) {
    let quality = 0, stalls = 0, falseHere = 0;
    let live: { priorQuality: number } | null = null;
    for (let round = 1; round <= max_rounds; round++) {
      total.rounds++;
      const gainRound = rng() < s.gainShare;
      if (gainRound) total.gainsOffered++;
      const effects = Array.from({ length: k }, (_, i) => (gainRound && i === 0 ? 1 : 0));
      const candidates: CandidateScore[] = effects.map((e, i) => ({ id: `c${i}`, train: rows(s.train, "t", e) }));
      const scores: RoundScores = { baselineHash: "x", baselineTrain, baselineHoldout, candidates };
      const leader = candidates.filter((c) => trainingProblem(c, baselineTrain, goal) === null).sort((a, b) => mean(b.train)! - mean(a.train)!)[0];
      if (leader) leader.holdout = rows(s.holdout, "h", effects[candidates.indexOf(leader)]);
      // judgeRound checks the revert first and merges nothing that round if it reverts; asked separately here so a
      // scheme that tightens max_p for candidates leaves the revert check as it is.
      let merged = false;
      if (live) {
        const replaced = [...rows(s.train, "t", live.priorQuality - quality), ...rows(s.holdout, "h", live.priorQuality - quality)];
        if (judgeRound({ ...scores, candidates: [] }, revertGoal, replaced).action === "revert") {
          total.reverts++;
          quality = live.priorQuality;
          live = null;
          stalls++;
          if (stalls >= stall_rounds) break;
          continue;
        }
      }
      const v = judgeRound(scores, goal, null);
      if (v.action === "merge") {
        const effect = effects[candidates.findIndex((c) => c.id === v.candidateId)];
        if (effect === 0) { total.falseMerges++; falseHere++; } else total.realMerges++;
        live = { priorQuality: quality };
        quality += effect;
        merged = true;
      }
      stalls = merged ? 0 : stalls + 1;
      if (stalls >= stall_rounds) break;
    }
    if (falseHere > 0) total.anyFalse++;
  }
  const per = (n: number) => n / s.runs;
  return { runs: s.runs, rounds: per(total.rounds), anyFalse: per(total.anyFalse), falseMerges: per(total.falseMerges), realMerges: per(total.realMerges), gainsOffered: per(total.gainsOffered), reverts: per(total.reverts) };
}

export const GRID: [number, number][] = [[10, 5], [20, 10], [20, 20], [30, 15], [60, 20]];

export interface Scheme { name: string; goal: (compose: boolean) => Goal; revertGoal?: (compose: boolean) => Goal }
const base = (compose: boolean, rule: Partial<Goal["merge_rule"]> = {}): Goal =>
  ({ version: 1, prompt: { kind: "file", path: "p" }, objective: "", guardrails: [], scenarios: "", models: DEFAULTS.models, budget: DEFAULTS.budget, merge_rule: { ...DEFAULTS.merge_rule, ...rule }, ...(compose ? { compose: true } : {}) });
// Bonferroni on both tests, as first proposed: each comparison at run_alpha / (max_rounds x candidates).
const bonferroniBoth = (alpha: number) => (compose: boolean): Goal => {
  const g = base(compose);
  const each = alpha / (g.merge_rule.max_rounds * plannedCandidates(g));
  return base(compose, { max_p: Math.min(g.merge_rule.max_p, each), holdout_max_p: Math.min(g.merge_rule.holdout_max_p, each) });
};
export const SCHEMES: Scheme[] = [
  { name: "today (unset)", goal: (c) => base(c) },
  { name: "run_alpha 0.05", goal: (c) => base(c, { run_alpha: 0.05 }) },
  { name: "run_alpha 0.10", goal: (c) => base(c, { run_alpha: 0.1 }) },
  { name: "Bonferroni both 0.05", goal: bonferroniBoth(0.05), revertGoal: (c) => base(c) },
];

const pct = (x: number, d = 2) => `${(100 * x).toFixed(d)}%`;

function main() {
  const runs = Number(process.argv[2] ?? 20000);
  const seed = Number(process.argv[3] ?? 1);
  const tie = 1 - NO_EFFECT.win - NO_EFFECT.loss;
  let cell = 0;
  const next = () => seed * 1000 + cell++;
  for (const compose of [false, true]) {
    const k = compose ? 3 : 2;
    console.log(`\nEvery change does nothing (true win/loss/tie ${NO_EFFECT.win * 100}/${NO_EFFECT.loss * 100}/${Math.round(tie * 100)}), ${k} candidates a round, ${runs} runs per cell, seed ${seed}`);
    console.log("P = chance a run merges at least one; merges = mean per run; exact = src/core/run-risk.ts at this tie rate");
    console.log("train/held".padEnd(11) + SCHEMES.map((sc) => sc.name.padStart(27)).join(""));
    console.log("".padEnd(11) + SCHEMES.map(() => `${"P".padStart(9)}${"merges".padStart(9)}${"exact".padStart(9)}`).join(""));
    for (const [train, holdout] of GRID) {
      let line = `${train}/${holdout}`.padEnd(11);
      for (const sc of SCHEMES) {
        const goal = sc.goal(compose);
        const r = simulateRuns({ train, holdout, goal, revertGoal: sc.revertGoal?.(compose), gainShare: 0, runs, seed: next() });
        const [m] = roundFalseMergeChances(goal, train, holdout, [tie]);
        const exact = 1 - (1 - m) ** Math.min(goal.merge_rule.stall_rounds, goal.merge_rule.max_rounds);
        line += `${pct(r.anyFalse).padStart(9)}${r.falseMerges.toFixed(4).padStart(9)}${pct(exact).padStart(9)}`;
      }
      console.log(line);
    }
    const share = 0.3;
    console.log(`\nMixed: ${share * 100}% of rounds have one candidate with a real gain (true ${REAL_GAIN.win * 100}/${REAL_GAIN.loss * 100}/${Math.round((1 - REAL_GAIN.win - REAL_GAIN.loss) * 100)}), the rest do nothing; ${k} candidates a round, ${runs} runs per cell`);
    console.log("power = share of real gains tried that merged; false = no-effect merges per run; P = chance a run merges at least one no-effect change");
    console.log("train/held".padEnd(11) + SCHEMES.map((sc) => sc.name.padStart(27)).join(""));
    console.log("".padEnd(11) + SCHEMES.map(() => `${"power".padStart(9)}${"false".padStart(9)}${"P".padStart(9)}`).join(""));
    for (const [train, holdout] of GRID) {
      let line = `${train}/${holdout}`.padEnd(11);
      for (const sc of SCHEMES) {
        const r = simulateRuns({ train, holdout, goal: sc.goal(compose), revertGoal: sc.revertGoal?.(compose), gainShare: share, runs, seed: next() });
        line += `${pct(r.gainsOffered ? r.realMerges / r.gainsOffered : 0, 1).padStart(9)}${r.falseMerges.toFixed(4).padStart(9)}${pct(r.anyFalse).padStart(9)}`;
      }
      console.log(line);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
