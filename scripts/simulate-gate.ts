// Free: simulates head-to-head rounds with known true win rates and runs the real merge rule on them, so the
// gate settings and scenario counts can be tuned without any model calls. Run with: npm run simulate
import { judgeRound } from "../src/core/merge-rule.ts";
import { DEFAULTS } from "../src/core/goal.ts";
const goal: any = { version: 1, prompt: { kind: "file", path: "p" }, objective: "", guardrails: [], scenarios: "", ...DEFAULTS };
const duel = (w: number, l: number) => { const r = Math.random(); return r < w ? 100 : r < w + l ? 0 : 50; };
const rows = (n: number, pre: string, f: () => number | null) => Array.from({ length: n }, (_, i) => ({ id: `${pre}${i}`, score: f(), violation: false }));
function mergeRate(T: number, H: number, w: number, l: number, cands = 2, runs = 4000) {
  let merged = 0;
  for (let k = 0; k < runs; k++) {
    const candidates = Array.from({ length: cands }, (_, c) => ({ id: `c${c}`, train: rows(T, "t", () => duel(w, l)) as any, holdout: undefined as any }));
    const scores: any = { baselineHash: "x", baselineTrain: rows(T, "t", () => 50), baselineHoldout: rows(H, "h", () => 50), candidates };
    // like the scorer: only the best candidate that passes training gets held-back duels
    const pass = candidates.filter((c) => judgeRound({ ...scores, candidates: [{ ...c, holdout: rows(H, "h", () => 100) }] }, goal, null).action === "merge");
    const lead = pass.sort((a, b) => b.train.reduce((s: number, r: any) => s + r.score, 0) - a.train.reduce((s: number, r: any) => s + r.score, 0))[0];
    if (lead) lead.holdout = rows(H, "h", () => duel(w, l));
    if (judgeRound(scores, goal, null).action === "merge") merged++;
  }
  return Math.round((100 * merged) / runs);
}
const cases = [["no real gain (37/37/25)", 0.375, 0.375], ["small gain (45/30/25)", 0.45, 0.30], ["real gain (50/25/25)", 0.5, 0.25], ["clear gain (60/15/25)", 0.6, 0.15]] as const;
console.log("chance a round merges, by training/held-back scenario counts (2 candidates)");
console.log("true win/loss/tie".padEnd(26) + ["30/15", "45/15", "60/20", "80/30"].map((s) => s.padStart(8)).join(""));
for (const [name, w, l] of cases) console.log(name.padEnd(26) + [[30, 15], [45, 15], [60, 20], [80, 30]].map(([T, H]) => `${mergeRate(T, H, w, l)}%`.padStart(8)).join(""));
