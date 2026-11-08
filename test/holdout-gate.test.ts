// The held-back sign test (merge_rule.holdout_max_p): a held-back win must be unlikely to be luck, not only ahead on
// the mean. Before it, a change with no real effect passed the held-back check about half the time.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, parseGoal } from "../src/core/goal.ts";
import { judgeRound, type RoundScores, type ScoreRow } from "../src/core/merge-rule.ts";
import { goal, rows, trainRows } from "./helpers.ts";

// A clear training win (20 of 20), then the given held-back scores against an even current prompt.
const round = (held: number[]): RoundScores => ({
  baselineHash: "h",
  baselineTrain: trainRows(50),
  baselineHoldout: rows(held.map(() => 50), false, "h"),
  candidates: [{ id: "c1", train: trainRows(100), holdout: rows(held, false, "h") as ScoreRow[] }],
});

test("the default limit is 0.2", () => {
  assert.equal(DEFAULTS.merge_rule.holdout_max_p, 0.2);
});

test("three held-back wins in a row merge (p 0.125); two do not (p 0.25), and the reason says it could be luck", () => {
  assert.equal(judgeRound(round([100, 100, 100]), goal(), null).action, "merge");
  const v = judgeRound(round([100, 100, 50]), goal(), null);
  assert.equal(v.action, "skip");
  assert.match(v.reasons.join(), /better in 2 and worse in 0 hidden test cases, which could be luck \(p 0\.250, needs 0\.2\)/);
  assert.match(v.notes.c1, /not by enough to rule out luck/);
});

test("a held-back mean that is ahead but split close to even no longer merges", () => {
  // 5 wins, 3 losses, 2 ties: mean 60 against 50, so the old check passed it. p = 0.36.
  const held = [100, 100, 100, 100, 100, 0, 0, 0, 50, 50];
  assert.equal(judgeRound(round(held), goal(), null).action, "skip");
  assert.equal(judgeRound(round(held), goal({ merge_rule: { ...DEFAULTS.merge_rule, holdout_max_p: 1 } }), null).action, "merge");
});

test("the limit is inclusive, like max_p: p exactly at the limit merges", () => {
  const at = goal({ merge_rule: { ...DEFAULTS.merge_rule, holdout_max_p: 0.125 } });
  assert.equal(judgeRound(round([100, 100, 100]), at, null).action, "merge");
  const below = goal({ merge_rule: { ...DEFAULTS.merge_rule, holdout_max_p: 0.124 } });
  assert.equal(judgeRound(round([100, 100, 100]), below, null).action, "skip");
});

test("a goal file without the field gets the default; a bad value is refused", () => {
  const base = { version: 1, prompt: { kind: "file", path: "p.md" }, objective: "o", scenarios: "s.jsonl", budget: { max_usd: 1 } };
  assert.equal(parseGoal(JSON.stringify(base)).merge_rule.holdout_max_p, 0.2);
  assert.equal(parseGoal(JSON.stringify({ ...base, merge_rule: { holdout_max_p: 0.05 } })).merge_rule.holdout_max_p, 0.05);
  for (const bad of [0, -0.1, 1.5, "0.2", null]) {
    assert.throws(() => parseGoal(JSON.stringify({ ...base, merge_rule: { holdout_max_p: bad } })), /holdout_max_p must be above 0 and at most 1/, String(bad));
  }
});
