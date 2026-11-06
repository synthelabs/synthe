import assert from "node:assert/strict";
import { test } from "node:test";
import type { RoundScores, ScoreRow } from "../src/core/merge-rule.ts";
import { newState, type RoundRecord, type State } from "../src/core/state.ts";
import { sha256 } from "../src/core/safety.ts";
import type { Repo } from "../src/github/repo.ts";
import { holdoutScorePct, runDecide } from "../src/loop/decide.ts";
import { displaySeries, renderDeltaBlock, renderScoreSvg, scoreSeries, sparkline } from "../src/loop/delta.ts";
import { headline } from "../src/loop/report.ts";
import { DEFAULTS } from "../src/core/goal.ts";
import { MemoryRepo, goal, scored } from "./helpers.ts";

const CHECKS = ["States the order number", "Offers a refund when asked"];

const row = (over: Partial<ScoreRow> = {}): ScoreRow => ({ id: "h0", score: 50, violation: false, ...over });
const rec = (round: number, over: Partial<RoundRecord> = {}): RoundRecord => ({
  round, at: "2026-11-06T00:00:00Z", outcome: "skipped", reasons: [], costUsd: 0.03, ...over,
});
const stateWith = (rounds: RoundRecord[]): State => ({ ...newState(), round: rounds.length, rounds });
const point = (round: number, scorePct: number | null, merged = false) => ({ round, scorePct, merged });

test("holdoutScorePct counts passed applicable checks, excluding checks that don't apply", () => {
  const rows = [
    row({ applicable: 2, failed: 1 }),
    row({ id: "h1", applicable: 0, failed: 0 }), // no check applied to this reply: in neither count
    row({ id: "h2", applicable: 1, failed: 0 }),
  ];
  assert.equal(holdoutScorePct(rows), 66.7); // 2 of 3 applicable checks passed, to one decimal
  assert.equal(holdoutScorePct([row({ applicable: 4, failed: 1 })]), 75);
  assert.equal(holdoutScorePct([row({ applicable: 2, failed: 2 })]), 0);
});

test("holdoutScorePct is null when the round was never marked, like checkRate", () => {
  assert.equal(holdoutScorePct([]), null);
  assert.equal(holdoutScorePct([row({})]), null); // a reply that was never marked
  assert.equal(holdoutScorePct([row({ applicable: 1, failed: 0 }), row({ id: "h1" })]), null); // one unmarked row is enough
  assert.equal(holdoutScorePct([row({ applicable: 0, failed: 0 })]), null); // nothing applied anywhere
});

test("scoreSeries reads old records without a score as unmeasured, and merged from the outcome", () => {
  const state = stateWith([rec(1), rec(2, { scorePct: 50 }), rec(3, { scorePct: 75.5, outcome: "merged" }), rec(4, { scorePct: null, outcome: "proposed" })]);
  assert.deepEqual(scoreSeries(state), [
    { round: 1, scorePct: null, merged: false },
    { round: 2, scorePct: 50, merged: false },
    { round: 3, scorePct: 75.5, merged: true },
    { round: 4, scorePct: null, merged: false },
  ]);
});

test("displaySeries carries the last measured value forward and drops leading unmeasured rounds", () => {
  assert.deepEqual(displaySeries([point(1, null), point(2, 50), point(3, null), point(4, 70, true)]), [
    { round: 2, pct: 50, measured: true, merged: false },
    { round: 3, pct: 50, measured: false, merged: false },
    { round: 4, pct: 70, measured: true, merged: true },
  ]);
  assert.deepEqual(displaySeries([point(1, null), point(2, null)]), []);
  assert.deepEqual(displaySeries([]), []);
});

test("sparkline rises, stays flat, and handles one point and none", () => {
  assert.equal(sparkline([point(1, 0), point(2, 50), point(3, 100)]), "▁▅█");
  assert.equal(sparkline([point(1, 50), point(2, 50), point(3, 50)]), "▅▅▅");
  assert.equal(sparkline([point(1, 25)]), "▃");
  assert.equal(sparkline([]), "");
  assert.equal(sparkline([point(1, null), point(2, null)]), "");
});

test("renderScoreSvg draws one polyline through every point on a fixed 0 to 100 axis", () => {
  const svg = renderScoreSvg([point(1, 50), point(2, 75, true), point(3, null), point(4, 80)]);
  assert.ok(svg.startsWith("<svg") && svg.endsWith("</svg>"));
  assert.equal(svg.match(/<polyline/g)?.length, 1);
  assert.equal(svg.match(/<circle/g)?.length, 4); // one marker per displayed point, carried round included
  assert.ok(svg.includes('viewBox="0 0 640 180"'));
  assert.ok(svg.includes(">100<") && svg.includes(">50<") && svg.includes(">0<"));
  assert.ok(svg.includes(">50%<") && svg.includes(">80%<")); // first and last values labelled
  const single = renderScoreSvg([point(1, 40)]);
  assert.equal(single.match(/<circle/g)?.length, 1);
  assert.ok(single.includes(">40%<"));
});

test("renderDeltaBlock leads with the movement and shows merged and no-change rounds, newest first", () => {
  const state = stateWith([
    rec(1, { scorePct: 50, tried: [{ summary: "A change", outcome: "Not clearly better." }] }),
    rec(2, {
      outcome: "merged", scorePct: 75, costUsd: 0.04, changed: "Adds the order number to every reply",
      examplePair: { input: "Where is my parcel?", beforeReply: "It is on its way.", afterReply: "Order 1234 is on its way.", improvedChecks: ["States the order number"] },
    }),
  ]);
  const block = renderDeltaBlock(goal(), state);
  const lines = block.split("\n");
  assert.equal(lines[0], "Your prompt: 50% → 75% (checks passed on test cases Synthe never trains on)");
  assert.ok(lines[1].startsWith("Score by round: "));
  assert.ok(block.indexOf("Round 2") < block.indexOf("Round 1"), "newest round first");
  assert.ok(block.includes("Round 2 · merged · $0.04"));
  assert.ok(block.includes("  What changed: Adds the order number to every reply"));
  assert.ok(block.includes('  Example from a practice case, on: "Where is my parcel?"'));
  assert.ok(block.includes('    Before: "It is on its way."'));
  assert.ok(block.includes('    After: "Order 1234 is on its way."'));
  assert.ok(block.includes("    Now passes: States the order number"));
  assert.ok(block.includes("Round 1 · no change · $0.03"));
  assert.ok(block.includes("  Tried 1 change, but none was clearly better, so nothing merged."));
});

test("renderDeltaBlock with one measured round scores it instead of showing a movement", () => {
  const block = renderDeltaBlock(goal(), stateWith([rec(1, { scorePct: 50 })]));
  assert.ok(block.startsWith("Your prompt scores 50% (checks passed on test cases Synthe never trains on)"));
});

test("renderDeltaBlock shows only the latest rounds and survives state written before the score fields", () => {
  const rounds = [1, 2, 3, 4, 5].map((n) => rec(n, { scorePct: 40 + n }));
  const block = renderDeltaBlock(goal(), stateWith(rounds));
  assert.ok(block.includes("Round 5") && block.includes("Round 3") && !block.includes("Round 2 ·"));

  // A state file from before scorePct and examplePair existed: no headline, but the rounds still read.
  const old = JSON.parse(JSON.stringify(stateWith([rec(1, { plain: "Nothing was clearly better, so your prompt stayed the same." })]))) as State;
  const oldBlock = renderDeltaBlock(goal(), old);
  assert.ok(!oldBlock.includes("Your prompt"));
  assert.ok(oldBlock.includes("Round 1 · no change · $0.03"));
  assert.ok(oldBlock.includes("Nothing was clearly better, so your prompt stayed the same."));
  assert.equal(renderDeltaBlock(goal(), newState()), "");
});

test("the report headline names the score after a single measured round, and the movement after two", () => {
  const one = headline(goal(), stateWith([rec(1), rec(2, { scorePct: 20.8 })]));
  assert.ok(one.summary.startsWith("Your prompt scores 20.8% (checks passed on test cases Synthe never trains on)."));
  const two = headline(goal(), stateWith([rec(1, { scorePct: 20.8 }), rec(2, { scorePct: 55 })]));
  assert.ok(two.summary.startsWith("Your prompt: 20.8% → 55% (checks passed on test cases Synthe never trains on)."));
  const none = headline(goal(), stateWith([rec(1), rec(2)]));
  assert.ok(!none.summary.includes("Your prompt scores"));
});

// A run ends on its stall rounds. "What did Synthe do?" must still show the change that landed.
test("the delta block always shows rounds that changed the prompt, and counts the quiet ones it leaves out", () => {
  const rounds = [
    rec(1, { scorePct: 20 }), rec(2, { scorePct: 21, outcome: "merged", changed: "Adds the refund window" }),
    rec(3, { scorePct: 60 }), rec(4, { scorePct: 60, outcome: "reverted", plain: "Put back the earlier prompt." }),
    rec(5, { scorePct: 40 }), rec(6, { scorePct: 41 }), rec(7, { scorePct: 40 }), rec(8, { scorePct: 41 }),
  ];
  const block = renderDeltaBlock(goal(), stateWith(rounds));
  const order = ["Round 8 ·", "Round 7 ·", "Round 6 ·", "Round 4 · reverted", "Round 2 · merged"].map((t) => block.indexOf(t));
  assert.ok(order.every((at) => at >= 0), block);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "newest first");
  assert.ok(block.includes("  What changed: Adds the refund window"));
  assert.ok(block.includes("  Score before this change: 21%"));
  assert.ok(!block.includes("Round 5 ·") && !block.includes("Round 3 ·") && !block.includes("Round 1 ·"));
  assert.ok(block.trimEnd().endsWith("Earlier: 3 more rounds with no change."), block);
  // Nothing left out: no count line. One left out: singular.
  assert.ok(!renderDeltaBlock(goal(), stateWith(rounds.slice(5))).includes("Earlier:"));
  assert.ok(renderDeltaBlock(goal(), stateWith([rec(1), rec(2), rec(3), rec(4)])).endsWith("Earlier: 1 more round with no change."));
  // A proposal waiting for review is a change too.
  assert.ok(renderDeltaBlock(goal(), stateWith([rec(1, { outcome: "proposed" }), rec(2), rec(3), rec(4)])).includes("Round 1 · proposed"));
});

// A merged round records the score of the prompt it started with; the merged prompt is measured the round after.
test("the headline gives one score once the current prompt is measured, and labels the practice-case gain before that", () => {
  const merged = (round: number, scorePct: number) => rec(round, { outcome: "merged", scorePct, checks: { before: 20, after: 100 } });
  // The rehearsal run: merged in round 7, then measured at 95.7% on held-back cases. One number only.
  const after = headline(goal(), { ...stateWith([rec(6, { scorePct: 20.8 }), merged(7, 16.7), rec(8, { scorePct: 95.7 })]), stopped: "3 rounds in a row found no winner" });
  assert.ok(after.summary.startsWith("Your prompt: 20.8% → 95.7% (checks passed on test cases Synthe never trains on)."));
  assert.ok(!/checks now pass/.test(after.summary), after.summary);
  assert.ok(after.title.startsWith("Done: your prompt got better"), after.title);
  // Merged in the latest round: the held-back number is still the old prompt's, so the gain stays, labelled.
  const before = headline(goal(), stateWith([rec(1, { scorePct: 20.8 }), merged(2, 22)]));
  assert.ok(before.summary.includes("On the practice cases Synthe learns from, your checks now pass 100% of the time, up from 20%."), before.summary);
  // A revert changes the prompt too: an older measurement no longer counts as current.
  const reverted = headline(goal(), stateWith([rec(1, { scorePct: 20.8 }), merged(2, 22), rec(3, { scorePct: 90 }), rec(4, { outcome: "reverted", scorePct: 60 })]));
  assert.ok(reverted.summary.includes("On the practice cases Synthe learns from"), reverted.summary);
  // A run from before the score series keeps the sentence as it always read.
  const old = headline(goal(), stateWith([rec(1), merged(2, NaN)].map((r) => ({ ...r, scorePct: undefined }))));
  assert.ok(old.summary.startsWith("Your checks now pass 100% of the time, up from 20%."), old.summary);
});

// Decide-level fixtures: 20 training cases and the held-back cases named per test, as JSONL.
const scenarioText = (holdoutIds: string[]) => [
  ...Array.from({ length: 20 }, (_, i) => JSON.stringify({ id: `t${i}`, input: `train question ${i}`, expected: "good", split: "train" })),
  ...holdoutIds.map((id, i) => JSON.stringify({ id, input: `holdout question ${i}`, expected: "good", split: "holdout" })),
].join("\n");

const trainSide = (score: number, failed: number): ScoreRow[] =>
  Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, score, violation: false, reply: "a reply", applicable: 2, failed }));

test("a judged round records its holdout score, saves the chart, and the report embeds it", async () => {
  const g = goal({ checks: CHECKS });
  const repo = new MemoryRepo("Old prompt.");
  (repo as Repo).slug = "acme/widgets";
  repo.files.set("s.jsonl", scenarioText(["h0", "h1", "h2"]));
  // The incumbent passes 3 of 6 applicable held-back checks. The learning rows name no failed checks
  // and the held-back rows keep no replies, exactly as runScore leaves them, so no example pair may
  // be invented.
  const scores: RoundScores = {
    baselineHash: sha256("Old prompt."),
    baselineTrain: trainSide(50, 1),
    baselineHoldout: [
      { id: "h0", score: 50, violation: false, applicable: 2, failed: 2, failedChecks: [...CHECKS] },
      { id: "h1", score: 50, violation: false, applicable: 2, failed: 1, failedChecks: [CHECKS[1]] },
      { id: "h2", score: 50, violation: false, applicable: 2, failed: 0 },
    ],
    candidates: [{
      id: "c1",
      train: trainSide(100, 0),
      holdout: ["h0", "h1", "h2"].map((id) => ({ id, score: 100, violation: false, applicable: 2, failed: 0 })),
    }],
  };
  const record = await runDecide(g, repo, { candidates: [{ id: "c1", text: "Better prompt.", summary: "States the order number" }], scores, costUsd: 0.1 });
  assert.equal(record?.outcome, "merged");
  assert.equal(record?.scorePct, 50);
  assert.equal(record?.examplePair, undefined);
  const svg = repo.stateFiles.get("score.svg");
  assert.ok(svg && svg.includes("<polyline"), "the chart is saved beside state.json on the state branch");
  assert.ok(repo.issue.includes("https://raw.githubusercontent.com/acme/widgets/synthe/state/score.svg?v=1"));
});

test("a merged round records an example pair from the practice cases, whose rows carry both replies", async () => {
  const g = goal({ checks: CHECKS });
  const repo = new MemoryRepo("Old prompt.");
  repo.files.set("s.jsonl", scenarioText(["h0", "h1"]));
  const longAfter = `Order 9 is on its way. ${"x".repeat(400)}`;
  const trainRow = (i: number, over: Partial<ScoreRow>): ScoreRow => ({ id: `t${i}`, score: 50, violation: false, reply: "a reply", applicable: 2, failed: 0, ...over });
  const scores: RoundScores = {
    baselineHash: sha256("Old prompt."),
    baselineTrain: Array.from({ length: 20 }, (_, i) => trainRow(i, {})),
    // The held-back rows keep no replies, exactly as runScore leaves them; the pair must not need them.
    baselineHoldout: [
      { id: "h0", score: 50, violation: false, applicable: 2, failed: 2, failedChecks: [...CHECKS] },
      { id: "h1", score: 50, violation: false, applicable: 2, failed: 1, failedChecks: [CHECKS[1]] },
    ],
    candidates: [{
      id: "c1",
      train: Array.from({ length: 20 }, (_, i) => trainRow(i, { score: 100 })),
      holdout: ["h0", "h1"].map((id) => ({ id, score: 100, violation: false, applicable: 2, failed: 0 })),
    }],
  };
  // On t0 the old reply fails both checks and the new one fails none; on t1 the new reply still fails
  // one named check, so only one check flipped there.
  Object.assign(scores.baselineTrain[0], { failed: 2, failedChecks: [...CHECKS], reply: "It is on its way." });
  Object.assign(scores.baselineTrain[1], { failed: 2, failedChecks: [...CHECKS], reply: "No idea." });
  Object.assign(scores.candidates[0].train[0], { failed: 0, reply: longAfter });
  Object.assign(scores.candidates[0].train[1], { failed: 1, failedChecks: [CHECKS[1]], reply: "Order 9 is on its way." });
  const record = await runDecide(g, repo, { candidates: [{ id: "c1", text: "Better prompt.", summary: "States the order number" }], scores, costUsd: 0.1 });
  assert.equal(record?.outcome, "merged");
  assert.equal(record?.scorePct, 25); // 1 of 4 applicable held-back checks passed
  // t0 wins: two checks flipped there, one at t1. The winning reply is truncated to 300 characters.
  assert.deepEqual(record?.examplePair, {
    input: "train question 0",
    beforeReply: "It is on its way.",
    afterReply: longAfter.slice(0, 300),
    improvedChecks: [...CHECKS],
  });
  // The rendered block labels the pair as the practice case it is.
  const block = renderDeltaBlock(g, { ...newState(), round: 1, rounds: [record!] });
  assert.ok(block.includes('  Example from a practice case, on: "train question 0"'));
  assert.ok(block.includes("    Now passes: States the order number, Offers a refund when asked"));
});

test("a merged round whose practice cases show no flipped check records no pair, even if held-back replies exist", async () => {
  const g = goal({ checks: CHECKS });
  const repo = new MemoryRepo("Old prompt.");
  repo.files.set("s.jsonl", scenarioText(["h0"]));
  const trainRow = (i: number, over: Partial<ScoreRow>): ScoreRow => ({ id: `t${i}`, score: 50, violation: false, reply: "a reply", applicable: 2, failed: 0, ...over });
  const scores: RoundScores = {
    baselineHash: sha256("Old prompt."),
    baselineTrain: Array.from({ length: 20 }, (_, i) => trainRow(i, {})),
    // Held-back rows carrying both replies and a clear flip, as the old selection used. They must be
    // ignored: held-back replies are never kept in production, and the pair comes from practice cases.
    baselineHoldout: [
      { id: "h0", score: 50, violation: false, applicable: 2, failed: 2, failedChecks: [...CHECKS], reply: "It is on its way." },
    ],
    candidates: [{
      id: "c1",
      train: Array.from({ length: 20 }, (_, i) => trainRow(i, { score: 100 })),
      holdout: [{ id: "h0", score: 100, violation: false, applicable: 2, failed: 0, reply: "Order 9 is on its way." }],
    }],
  };
  // The one practice case where the old reply failed a check: the new reply fails the same check.
  Object.assign(scores.baselineTrain[0], { failed: 1, failedChecks: [CHECKS[0]], reply: "It is on its way." });
  Object.assign(scores.candidates[0].train[0], { failed: 1, failedChecks: [CHECKS[0]], reply: "It is on its way, truly." });
  const record = await runDecide(g, repo, { candidates: [{ id: "c1", text: "Better prompt.", summary: "States the order number" }], scores, costUsd: 0.1 });
  assert.equal(record?.outcome, "merged");
  assert.equal(record?.examplePair, undefined);
});

test("a round whose held-back replies were never marked records no score and saves no chart", async () => {
  const repo = new MemoryRepo("Old prompt.");
  const record = await runDecide(goal(), repo, { candidates: [{ id: "c1", text: "Better prompt." }], scores: scored("Old prompt.", 50, 50, 60, 55), costUsd: 0.1 });
  assert.equal(record?.outcome, "merged");
  assert.equal(record?.scorePct, null);
  assert.ok(!repo.stateFiles.has("score.svg"));
  assert.ok(!repo.issue.includes("score.svg"));
});

// The incumbent passes 3 of 6 applicable held-back checks, so the round's score is 50.
const markedScores = (): RoundScores => ({
  baselineHash: sha256("Old prompt."),
  baselineTrain: trainSide(50, 1),
  baselineHoldout: [
    { id: "h0", score: 50, violation: false, applicable: 2, failed: 2, failedChecks: [...CHECKS] },
    { id: "h1", score: 50, violation: false, applicable: 2, failed: 1, failedChecks: [CHECKS[1]] },
    { id: "h2", score: 50, violation: false, applicable: 2, failed: 0 },
  ],
  candidates: [{
    id: "c1",
    train: trainSide(100, 0),
    holdout: ["h0", "h1", "h2"].map((id) => ({ id, score: 100, violation: false, applicable: 2, failed: 0 })),
  }],
});

test("a merged round's pull request body ends with the delta block, including the round itself", async () => {
  const g = goal({ checks: CHECKS });
  const repo = new MemoryRepo("Old prompt.");
  repo.files.set("s.jsonl", scenarioText(["h0", "h1", "h2"]));
  const record = await runDecide(g, repo, { candidates: [{ id: "c1", text: "Better prompt.", summary: "States the order number" }], scores: markedScores(), costUsd: 0.1 });
  assert.equal(record?.outcome, "merged");
  const body = repo.prs[0].body;
  // The body is what GitHub puts in the squash merge commit, so the block has to be in it, after
  // everything the body already said.
  assert.ok(body.includes("Your prompt scores 50% (checks passed on test cases Synthe never trains on)"));
  assert.ok(body.includes("Score by round: "));
  assert.ok(body.includes("Round 1 · merged · $0.10"));
  assert.ok(body.includes("  What changed: States the order number"));
  assert.ok(body.includes("  Score before this change: 50%"), "a merged round measured the prompt it started with");
  assert.ok(body.indexOf("Your prompt scores 50%") > body.indexOf("What this did not test"), "the block is appended after the existing body");
});

test("a proposed round's pull request body carries the delta block, labelled as a proposal", async () => {
  const g = goal({ checks: CHECKS, merge_rule: { ...DEFAULTS.merge_rule, mode: "propose" } });
  const repo = new MemoryRepo("Old prompt.");
  repo.files.set("s.jsonl", scenarioText(["h0", "h1", "h2"]));
  const record = await runDecide(g, repo, { candidates: [{ id: "c1", text: "Better prompt.", summary: "States the order number" }], scores: markedScores(), costUsd: 0.1 });
  assert.equal(record?.outcome, "proposed");
  const body = repo.prs[0].body;
  assert.ok(body.includes("Your prompt scores 50% (checks passed on test cases Synthe never trains on)"));
  assert.ok(body.includes("Round 1 · proposed · $0.10"));
});
