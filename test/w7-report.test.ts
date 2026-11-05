import assert from "node:assert/strict";
import { test } from "node:test";
import { noWinSection, renderReport } from "../src/loop/report.ts";
import { newState, type RoundRecord, type State } from "../src/core/state.ts";
import { runDecide } from "../src/loop/decide.ts";
import type { RoundScores } from "../src/core/merge-rule.ts";
import { MemoryRepo, goal, heldRows, trainRows } from "./helpers.ts";
import { sha256 } from "../src/core/safety.ts";

const NOT_CLEAR = "Not clearly better: better in 3 test cases, worse in 2, the same in 5.";
const HIDDEN = "Better on the test cases it learned from, but not on the 10 hidden ones (better in 1, worse in 4), so it may only fit the ones it saw.";
const BROKE = "Broke one of your rules in 2 test cases where your current prompt follows it, so it wasn't used.";

const skipped = (round: number, over: Partial<RoundRecord> = {}): RoundRecord => ({
  round, at: "t", outcome: "skipped", reasons: [], costUsd: 0.1,
  plain: "Nothing was clearly better, so your prompt stayed the same.",
  tried: [{ summary: "Shortens the greeting", outcome: NOT_CLEAR }],
  ...over,
});
const stalled = (rounds: RoundRecord[], over: Partial<State> = {}): State => ({
  ...newState(), round: rounds.length, stalls: 3, stopped: "3 rounds in a row found no winner", rounds, ...over,
});

test("a stalled report says what failed most, what the changes did, and what Synthe needs", () => {
  const state = stalled([
    skipped(1, { failedChecks: { "Asks for the order number first": 5, "Stays under three sentences": 3, "Offers an exchange": 1, "Uses the customer's name": 1 } }),
    skipped(2, {
      failedChecks: { "Asks for the order number first": 4, "Offers an exchange": 4 },
      tried: [
        { summary: "Shortens the greeting", outcome: NOT_CLEAR },
        { summary: "Leads with the refund policy", outcome: HIDDEN },
        { summary: "Promises a refund always", outcome: BROKE },
      ],
    }),
    skipped(3, {
      failedChecks: { "Stays under three sentences": 2, "Offers an exchange": 1 },
      tried: [
        { summary: "Shortens the greeting", outcome: NOT_CLEAR },
        { summary: "A change that landed in a different telling", outcome: "Merged." },
        { summary: "An edit that couldn't be applied", outcome: "Not used: no edits returned." },
      ],
    }),
  ]);
  const report = renderReport(goal(), state);
  assert.match(report, /### Why there was no win/);
  // Totals across the three rounds: order number 9, exchange 6, sentences 5, name 1 (cut off).
  const at = (text: string) => report.indexOf(text);
  assert.ok(at('"Asks for the order number first" failed in 9 replies') > -1, report);
  assert.ok(at('"Offers an exchange" failed in 6 replies') > at('"Asks for the order number first"'));
  assert.ok(at('"Stays under three sentences" failed in 5 replies') > at('"Offers an exchange"'));
  assert.ok(!report.includes("Uses the customer's name"), "only the top 3 checks are listed");
  assert.match(report, /- Not clearly better: 3 changes\./);
  assert.match(report, /- Did not hold on the hidden test cases: 1 change\./);
  assert.match(report, /- Broke a rule or a guard: 1 change\./);
  // The ask names the top failing check; the existing restart instructions stay.
  assert.match(report, /\*\*What Synthe needs from you:\*\*/);
  assert.match(report, /Add test cases your agent still gets wrong, especially ones where replies fail "Asks for the order number first"/);
  assert.match(report, /If you want Synthe to keep going, add test cases your agent still gets wrong/);
  assert.match(report, /`npx synthe restart`/);
});

test("a check calibration marks as disagreeing gets a rewrite ask, and only that check", () => {
  const state = stalled([skipped(1), skipped(2), skipped(3)], {
    calibration: [
      { check: "Asks for the order number first", reading: "disagrees with you" },
      { check: "Stays under three sentences", reading: "matches you well" },
    ],
  });
  const section = noWinSection(goal(), state).join("\n");
  assert.match(section, /Rewrite the check "Asks for the order number first" in plainer words/);
  assert.ok(!section.includes('Rewrite the check "Stays under three sentences"'));
});

test("a budget stop shows the section with the budget ask, and how to continue", () => {
  const state = stalled(
    [skipped(1, { failedChecks: { "Asks for the order number first": 2 } }), skipped(2), skipped(3)],
    { stopped: "budget of $3 is used" },
  );
  const report = renderReport(goal(), state);
  assert.match(report, /### Why there was no win/);
  assert.match(report, /Raise `budget\.max_usd` in `synthe\.json` if you want more rounds/);
  // restart resumes a budget stop once budget is available again (a fresh own-key budget or a raised max_usd).
  assert.match(report, /npx synthe key.*raise budget\.max_usd[\s\S]*npx synthe restart/);
});

test("no failed-check data prints a short generic version", () => {
  const section = noWinSection(goal(), stalled([skipped(1, { tried: [] }), skipped(2, { tried: [] }), skipped(3, { tried: [] })]));
  const text = section.join("\n");
  assert.match(text, /### Why there was no win/);
  assert.match(text, /doesn't have per-check failure counts for these rounds/);
  assert.ok(!text.includes("What failed most"));
  assert.ok(!text.includes("What Synthe needs from you"));
});

test("older state without per-round counts falls back to the last round's lessons", () => {
  const state = stalled([skipped(1), skipped(2), skipped(3)], {
    lessons: {
      promptHash: "x",
      rows: [
        { id: "s1", reply: "r", violation: false, failedChecks: ["Asks for the order number first"] },
        { id: "s2", reply: "r", violation: false, failedChecks: ["Asks for the order number first", "Stays under three sentences"] },
      ],
    },
  });
  const text = noWinSection(goal(), state).join("\n");
  assert.match(text, /"Asks for the order number first" failed in 2 replies/);
  assert.match(text, /"Stays under three sentences" failed in 1 reply/);
});

test("reports for other stop reasons have no no-win section", () => {
  for (const stopped of ["reached 12 rounds", "spend could not be measured"]) {
    const state = stalled([skipped(1, { failedChecks: { "Asks for the order number first": 9 } })], { stopped });
    assert.deepEqual(noWinSection(goal(), state), []);
    assert.ok(!renderReport(goal(), state).includes("Why there was no win"), stopped);
  }
  const running = { ...newState(), round: 1, rounds: [skipped(1)] };
  assert.deepEqual(noWinSection(goal(), running), []);
  const waiting = stalled([skipped(1)], { proposal: { branch: "b", kind: "merge" as const, text: "x", priorPrompt: "y", pr: 4, round: 1 } });
  assert.deepEqual(noWinSection(goal(), waiting), [], "a report waiting on a review is not a no-win report");
});

test("decide keeps the round's check failure counts from the score rows", async () => {
  const scores: RoundScores = {
    baselineHash: sha256("Old prompt."), baselineTrain: trainRows(50), baselineHoldout: heldRows(50),
    candidates: [{ id: "c1", train: trainRows(60), holdout: heldRows(55) }],
  };
  scores.baselineTrain[0].failedChecks = ["Asks for the order number first"];
  scores.baselineTrain[1].failedChecks = ["Asks for the order number first"];
  scores.candidates[0].train[0].failedChecks = ["Asks for the order number first", "Stays under three sentences"];
  const repo = new MemoryRepo("Old prompt.");
  const record = await runDecide(goal(), repo, { candidates: [{ id: "c1", text: "Better prompt." }], scores, costUsd: 0.1 });
  assert.deepEqual(record?.failedChecks, { "Asks for the order number first": 3, "Stays under three sentences": 1 });
});

test("calibration readings handed to decide land in state, and the no-win ask can then name the check", async () => {
  const { calibrationReadings } = await import("../src/core/state.ts");
  const file = JSON.stringify({ timestamp: "t", modelIds: { checker: "c", writer: "w" }, checks: [
    { check: "Asks for the order number first", verdict: "disagrees with you" },
    { check: "A check the goal dropped", verdict: "unsure" },
    { check: "Stays under three sentences", verdict: "matches you well" },
  ] });
  const readings = calibrationReadings(file);
  assert.equal(readings?.length, 3);
  assert.equal(calibrationReadings("not json"), null);
  assert.equal(calibrationReadings("{}"), null);
  const scores: RoundScores = {
    baselineHash: sha256("Old prompt."), baselineTrain: trainRows(50), baselineHoldout: heldRows(50),
    candidates: [{ id: "c1", train: trainRows(60), holdout: heldRows(55) }],
  };
  const repo = new MemoryRepo("Old prompt.");
  const g = goal({ checks: ["Asks for the order number first", "Stays under three sentences"] });
  await runDecide(g, repo, { candidates: [{ id: "c1", text: "Better prompt." }], scores, costUsd: 0.1, calibration: readings });
  assert.deepEqual(repo.state.calibration, [
    { check: "Asks for the order number first", reading: "disagrees with you" },
    { check: "Stays under three sentences", reading: "matches you well" },
  ]);
  const stalledState = stalled([skipped(1), skipped(2), skipped(3)], { calibration: repo.state.calibration });
  assert.match(noWinSection(g, stalledState).join("\n"), /Rewrite the check "Asks for the order number first" in plainer words/);
});
