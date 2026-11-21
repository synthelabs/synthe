// merge_rule.run_alpha: an opt-in cap on the chance that a whole run merges a change that does nothing. Unset, every
// verdict is what it was; set, the held-back limit tightens to fit it (src/core/run-alpha.ts).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULTS, parseGoal, type Goal } from "../src/core/goal.ts";
import { evidencePath, verifyEvidence, type EvidenceRecord } from "../src/core/evidence.ts";
import { judgeRound, trainingProblem, type RoundScores, type ScoreRow } from "../src/core/merge-rule.ts";
import { heldBackLimit, plannedCandidates } from "../src/core/run-alpha.ts";
import { gatePassChances, roundFalseMergeChances, runFalseMergeChance, runLuckLines } from "../src/core/run-risk.ts";
import { runDecide } from "../src/loop/decide.ts";
import { renderReport } from "../src/loop/report.ts";
import { newState } from "../src/core/state.ts";
import { mulberry32, simulateRuns } from "../scripts/simulate-run.ts";
import { MemoryRepo, goal, rows, scored, trainRows } from "./helpers.ts";

const withRule = (rule: Partial<Goal["merge_rule"]>, over: Partial<Goal> = {}) => goal({ merge_rule: { ...DEFAULTS.merge_rule, ...rule }, ...over });
const wins = (w: number, l: number, n: number) => [...Array(w).fill(100), ...Array(l).fill(0), ...Array(n - w - l).fill(50)];
// A clear training win (20 of 20), then the given held-back scores against an even current prompt.
const round = (held: number[], candidates = 1): RoundScores => ({
  baselineHash: "h",
  baselineTrain: trainRows(50),
  baselineHoldout: rows(held.map(() => 50), false, "h"),
  candidates: Array.from({ length: candidates }, (_, i) => ({ id: `c${i + 1}`, train: trainRows(i === 0 ? 100 : 50), ...(i === 0 ? { holdout: rows(held, false, "h") as ScoreRow[] } : {}) })),
});

test("unset, the held-back limit is holdout_max_p whatever the candidate count", () => {
  for (const compose of [false, true]) for (const scored of [0, 1, 2, 3, 5]) {
    const g = goal(compose ? { compose: true } : {});
    assert.equal(heldBackLimit(g, plannedCandidates(g, scored)), 0.1);
    assert.equal(heldBackLimit(withRule({ holdout_max_p: 0.2 }), scored), 0.2);
  }
});

test("unset, verdicts on seeded random rounds are the same as with a run_alpha too loose to bind", () => {
  // run_alpha 1 gives a limit of min(0.1, 1 / (12 x 2 x 0.05)) = 0.1, so it must change nothing, words included.
  const rng = mulberry32(42);
  const pick = () => { const x = rng(); return x < 0.45 ? 100 : x < 0.75 ? 0 : 50; };
  let merges = 0;
  for (let k = 0; k < 400; k++) {
    const n = 5 + Math.floor(rng() * 20);
    const scores: RoundScores = {
      baselineHash: "h", baselineTrain: trainRows(50), baselineHoldout: rows(Array(n).fill(50), false, "h"),
      candidates: [{ id: "c1", train: rows(Array.from({ length: 20 }, pick)), holdout: rows(Array.from({ length: n }, pick), false, "h") }],
    };
    const today = judgeRound(scores, goal(), null);
    assert.deepEqual(judgeRound(scores, withRule({ run_alpha: 1 }), null), today);
    if (today.action === "merge") merges++;
  }
  assert.ok(merges > 0, "the fixture should include merges");
});

test("the limit: run_alpha / (max_rounds x planned candidates x max_p), never looser than holdout_max_p", () => {
  const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} vs ${b}`);
  close(heldBackLimit(withRule({ run_alpha: 0.05 }), 2), 0.05 / (12 * 2 * 0.05));
  close(heldBackLimit(withRule({ run_alpha: 0.05 }, { compose: true }), plannedCandidates(goal({ compose: true }))), 0.05 / (12 * 3 * 0.05));
  close(heldBackLimit(withRule({ run_alpha: 0.12 }), 2), 0.1); // today's defaults already give this bound
  close(heldBackLimit(withRule({ run_alpha: 1 }), 2), 0.1);
  close(heldBackLimit(withRule({ run_alpha: 0.05, max_p: 0.6 }), 2), 0.05 / 12); // training luck can't count above 1
  // The planned count, not the scored one: compose writes its candidate after seeing the others' results.
  assert.equal(plannedCandidates(goal(), 1), 2);
  assert.equal(plannedCandidates(goal({ compose: true }), 2), 3);
  assert.equal(plannedCandidates(goal(), 4), 4);
});

test("set, a held-back split that clears 0.05 but not the run's limit is refused, with a plain reason", () => {
  // 10 wins and 3 losses on 13 held-back cases: p 0.046. Under 0.05 and 0.1, over 0.042 (run_alpha 0.05).
  const scores = round(wins(10, 3, 13));
  assert.equal(judgeRound(scores, goal(), null).action, "merge");
  assert.equal(judgeRound(scores, withRule({ holdout_max_p: 0.05 }), null).action, "merge");
  const v = judgeRound(scores, withRule({ run_alpha: 0.05 }), null);
  assert.equal(v.action, "skip");
  assert.match(v.reasons.join(), /c1: better in 10 and worse in 3 hidden test cases, which could be luck over a whole run \(p 0\.046, needs 0\.042 under merge_rule\.run_alpha 0\.05\)/);
  assert.equal(v.notes.c1, "Better on the hidden test cases (better in 10, worse in 3), but not by enough to rule out luck across a whole run (your merge_rule.run_alpha), so it wasn't used.");
  // A clearer split still merges: 5 of 5 is p 0.031.
  assert.equal(judgeRound(round([100, 100, 100, 100, 100]), withRule({ run_alpha: 0.05 }), null).action, "merge");
});

test("set with compose, the planned third candidate tightens the limit even in a round that scored two", () => {
  // 5 of 5 (p 0.031) clears 0.042 but not 0.028.
  const five = round([100, 100, 100, 100, 100], 2);
  assert.equal(judgeRound(five, withRule({ run_alpha: 0.05 }), null).action, "merge");
  assert.equal(judgeRound(five, withRule({ run_alpha: 0.05 }, { compose: true }), null).action, "skip");
  assert.equal(judgeRound(round(Array(6).fill(100), 2), withRule({ run_alpha: 0.05 }, { compose: true }), null).action, "merge");
});

test("set, the training test is unchanged: a training split at p 0.046 still earns the held-back test", () => {
  const c = { id: "c1", train: rows(wins(10, 3, 20)) };
  assert.equal(trainingProblem(c, trainRows(50), withRule({ run_alpha: 0.05 })), null);
  assert.equal(trainingProblem(c, trainRows(50), goal()), null);
});

test("a goal file without run_alpha leaves it unset; a bad value is refused", () => {
  const base = { version: 1, prompt: { kind: "file", path: "p.md" }, objective: "o", scenarios: "s.jsonl", budget: { max_usd: 1 } };
  assert.equal(parseGoal(JSON.stringify(base)).merge_rule.run_alpha, undefined);
  assert.equal("run_alpha" in parseGoal(JSON.stringify(base)).merge_rule, false);
  for (const ok of [0.05, 0.001, 1]) assert.equal(parseGoal(JSON.stringify({ ...base, merge_rule: { run_alpha: ok } })).merge_rule.run_alpha, ok);
  for (const bad of [0, -0.1, 1.5, "0.05", null, true]) {
    assert.throws(() => parseGoal(JSON.stringify({ ...base, merge_rule: { run_alpha: bad } })), /merge_rule\.run_alpha must be above 0 and at most 1/, String(bad));
  }
});

test("evidence records the limit the round used, so changing run_alpha later doesn't change the recheck", async () => {
  const root = mkdtempSync(join(tmpdir(), "synthe-run-alpha-"));
  const line = (id: string, split: string) => JSON.stringify({ id, input: "a question", expected: "a good answer", split });
  writeFileSync(join(root, "s.jsonl"), `${[...Array(20).keys()].map((i) => line(`s${i}`, "train")).concat([...Array(10).keys()].map((i) => line(`h${i}`, "holdout"))).join("\n")}\n`);
  mkdirSync(join(root, ".synthe/evidence"), { recursive: true });
  const capped = withRule({ run_alpha: 0.05 });
  writeFileSync(join(root, "synthe.json"), JSON.stringify(capped));
  // Four held-back wins and six ties: p 0.0625, which merges at 0.1 but not under run_alpha 0.05.
  const scores = scored("Old prompt.", 50, 50, 100, 50);
  for (const h of scores.candidates[0].holdout!.slice(0, 4)) h.score = 100;
  const repo = new MemoryRepo("Old prompt.");
  await runDecide(capped, repo, { candidates: [{ id: "c1", text: "Better prompt." }], scores, costUsd: 0.1 });
  for (const [path, text] of repo.stateFiles) writeFileSync(join(root, path), text);
  const r: EvidenceRecord = JSON.parse(readFileSync(join(root, evidencePath(1)), "utf8"));
  assert.equal(r.verdict, "skip");
  assert.ok(Math.abs(r.holdoutMaxP! - 0.05 / 1.2) < 1e-12, String(r.holdoutMaxP));
  const check = () => verifyEvidence(join(root, evidencePath(1)), root);
  assert.equal(check().ok, true, JSON.stringify(check()));
  writeFileSync(join(root, "synthe.json"), JSON.stringify(goal())); // the team later removes run_alpha
  assert.equal(check().ok, true, JSON.stringify(check()));
  // The round's case counts ride on its record, for the report.
  assert.deepEqual((await repo.readState()).rounds[0].cases, { train: 20, holdout: 10 });
});

test("the closed form: one gate by hand, and the run figures under run_alpha stay under it", () => {
  // 5 cases, no ties, limit 0.1, needing a 2-point lead: only 5 wins (p 1/32) pass, so the chance is 1/32.
  assert.ok(Math.abs(gatePassChances(5, [0], 2, 0.1)[0] - 1 / 32) < 1e-12);
  // All ties never pass; an impossible limit never passes.
  assert.equal(gatePassChances(10, [1], 2, 0.1)[0], 0);
  assert.equal(gatePassChances(10, [0.25], 2, 1e-9)[0], 0);
  for (const [train, holdout] of [[10, 5], [20, 10], [20, 20], [30, 15], [60, 20], [100, 50]]) {
    for (const alpha of [0.01, 0.05, 0.1]) {
      const r = runFalseMergeChance(withRule({ run_alpha: alpha }), train, holdout);
      assert.ok(r.anyRun <= alpha && r.nothingWorks <= r.anyRun, `${train}/${holdout} at ${alpha}: ${JSON.stringify(r)}`);
    }
  }
});

test("the simulation is deterministic for a seed, and agrees with the closed form", () => {
  const loose = withRule({ max_p: 0.3, holdout_max_p: 0.3 });
  const setup = { train: 10, holdout: 5, goal: loose, gainShare: 0, runs: 3000, seed: 7 };
  const a = simulateRuns(setup);
  assert.deepEqual(simulateRuns(setup), a);
  assert.notDeepEqual(simulateRuns({ ...setup, seed: 8 }), a);
  // Nothing works, so a run stops after stall_rounds rounds unless something merges by luck.
  const [m] = roundFalseMergeChances(loose, 10, 5, [0.25]);
  const exact = 1 - (1 - m) ** 3;
  assert.ok(exact > 0.05, `the loose rule should merge by luck often enough to compare (${exact})`);
  assert.ok(Math.abs(a.anyFalse - exact) < 4 * Math.sqrt((exact * (1 - exact)) / setup.runs), `simulated ${a.anyFalse}, exact ${exact}`);
  assert.equal(a.realMerges, 0);
});

test("the simulation's corner cases: a sure gain merges every round, all ties never merge", () => {
  const sure = simulateRuns({ train: 10, holdout: 5, goal: goal(), gainShare: 1, gain: { win: 1, loss: 0 }, runs: 50, seed: 1 });
  assert.deepEqual([sure.rounds, sure.realMerges, sure.gainsOffered, sure.falseMerges, sure.reverts], [12, 12, 12, 0, 0]);
  const flat = simulateRuns({ train: 10, holdout: 5, goal: goal(), gainShare: 0, none: { win: 0, loss: 0 }, runs: 50, seed: 1 });
  assert.deepEqual([flat.rounds, flat.anyFalse, flat.falseMerges], [3, 0, 0]);
});

test("the report says the run-level chance for the team's case counts, once a round has recorded them", () => {
  const record = { round: 1, at: "t", outcome: "skipped" as const, reasons: [], costUsd: 0.1 };
  const state = { ...newState(), round: 1, rounds: [{ ...record, cases: { train: 20, holdout: 20 } }] };
  const line = /- Luck across a whole run: with your 20 learned-from and 20 hidden test cases, the chance that a run merges a change that does nothing is at most (\d+\.\d)% when nothing Synthe tries really helps, and at most (\d+\.\d)% in any run of up to 12 rounds\. To cap it lower, set `merge_rule\.run_alpha` in `synthe\.json`/;
  const m = renderReport(goal(), state).match(line);
  assert.ok(m, renderReport(goal(), state));
  assert.ok(Number(m[1]) <= Number(m[2]));
  assert.match(renderReport(withRule({ run_alpha: 0.05 }), state), /in any run of up to 12 rounds\. `merge_rule\.run_alpha` caps it at 5%\./);
  assert.doesNotMatch(renderReport(goal(), { ...state, rounds: [record] }), /Luck across a whole run/);
  assert.deepEqual(runLuckLines(goal(), []), []);
});
