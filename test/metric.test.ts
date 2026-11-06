import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRate, judgeRound } from "../src/core/merge-rule.ts";
import { parseGoal, type Scenario } from "../src/core/goal.ts";
import { runScore } from "../src/loop/score.ts";
import { runDecide } from "../src/loop/decide.ts";
import { runWrite } from "../src/loop/write.ts";
import { newState } from "../src/core/state.ts";
import type { Ask, Model } from "../src/model/client.ts";
import { MemoryRepo, goal } from "./helpers.ts";

const CHECKS = ["Asks for the order number first", "Stays under three sentences"];
const cases: Scenario[] = [
  ...Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, input: `where is my order ${i}`, expected: "asks for the order number", split: "train" as const })),
  ...Array.from({ length: 10 }, (_, i) => ({ id: `h${i}`, input: `my parcel ${i} is late`, expected: "asks for the order number", split: "holdout" as const })),
];

// The agent answers by prompt; the judge always prefers the current prompt's reply; the checks fail "Old" replies on
// the first check and pass "New" ones. failChecks: how many checks a New reply fails instead.
function model(over: { newFails?: number; checkAnswer?: (a: Ask) => string | null } = {}): Model & { asks: Ask[] } {
  const asks: Ask[] = [];
  return {
    asks,
    async ask(a) {
      asks.push(a);
      const schema = JSON.stringify(a.schema ?? {});
      if (schema.includes('"results"')) {
        if (over.checkAnswer) return { text: over.checkAnswer(a), costUsd: 0.001 };
        const isNew = a.user.includes("reply from New");
        const fails = isNew ? over.newFails ?? 0 : 1;
        return { text: JSON.stringify({ results: CHECKS.map((_, i) => ({ check: i + 1, applies: true, passes: i >= fails })) }), costUsd: 0.001 };
      }
      if (schema.includes('"better"')) {
        // Always prefer the current prompt's reply, wherever it is shown.
        const aIsOld = /<reply_a>\nreply from Old/.test(a.user);
        return { text: JSON.stringify({ better: aIsOld ? "A" : "B", a_guardrail_ok: true, b_guardrail_ok: true }), costUsd: 0.001 };
      }
      if (schema.includes('"breaks"')) return { text: JSON.stringify({ breaks: false, guardrail: "", quote: "" }), costUsd: 0.001 };
      return { text: `reply from ${a.system}`, costUsd: 0.001 };
    },
  };
}

const withChecks = (checks = CHECKS) => goal({ checks, scenarios: "s.jsonl" });

test("the team's checks decide each test case, even against the judge's preference", async () => {
  const { scores } = await runScore(withChecks(), "Old", [{ id: "c1", text: "New" }], cases, model());
  const c = scores.candidates[0];
  assert.ok(c.train.every((r) => r.score === 100 && r.failed === 0 && r.applicable === 2), "New passes more checks, so it wins every case");
  assert.equal(checkRate(scores.baselineTrain), 50);
  const { explainScores } = await import("../src/loop/score.ts");
  assert.ok(explainScores(scores, cases).includes("checks passed on learned-from cases: current 50%, c1 100%"));
  assert.deepEqual(scores.baselineTrain[0].failedChecks, ["Asks for the order number first"]);
  const verdict = judgeRound(scores, withChecks(), null);
  assert.equal(verdict.action, "merge");
  if (verdict.action === "merge") {
    assert.deepEqual(verdict.checks, { before: 50, after: 100 });
    assert.match(verdict.plain, /^Your checks passed 100% of the time, up from 50%\. /);
  }
});

test("when both replies fail the same checks, the judge breaks the tie", async () => {
  const { scores } = await runScore(withChecks(), "Old", [{ id: "c1", text: "New" }], cases, model({ newFails: 1 }));
  assert.ok(scores.candidates[0].train.every((r) => r.score === 0), "same checks failed, and the judge prefers the current prompt");
  assert.equal(judgeRound(scores, withChecks(), null).action, "skip");
});

test("a check answer that skips a check leaves the case to the judge, and the rate unknown", async () => {
  const half = () => JSON.stringify({ results: [{ check: 1, applies: true, passes: true }] });
  const { scores } = await runScore(withChecks(), "Old", [{ id: "c1", text: "New" }], cases, model({ checkAnswer: half }));
  assert.ok(scores.candidates[0].train.every((r) => r.score === 0 && r.failed === undefined));
  assert.equal(checkRate(scores.baselineTrain), null);
});

test("checks that don't apply to a message neither pass nor fail", () => {
  assert.equal(checkRate([{ id: "a", score: 50, violation: false, failed: 1, applicable: 2 }, { id: "b", score: 50, violation: false, failed: 0, applicable: 0 }]), 50);
  assert.equal(checkRate([{ id: "a", score: 50, violation: false, failed: 0, applicable: 0 }]), null);
});

test("without checks, scoring makes no check calls and works as before", async () => {
  const m = model();
  await runScore(goal({ scenarios: "s.jsonl" }), "Old", [{ id: "c1", text: "New" }], cases, m);
  assert.ok(!m.asks.some((a) => JSON.stringify(a.schema ?? {}).includes('"results"')));
});

test("the round record and report lead with the team's number", async () => {
  const g = withChecks();
  const { scores } = await runScore(g, "Old", [{ id: "c1", text: "New" }], cases, model());
  const repo = new MemoryRepo("Old");
  repo.files.set("s.jsonl", cases.map((c) => JSON.stringify(c)).join("\n"));
  const record = await runDecide(g, repo, { candidates: [{ id: "c1", text: "New", summary: "Asks for the order number first" }], scores, costUsd: 0.05 });
  assert.equal(record?.outcome, "merged");
  assert.deepEqual(record?.checks, { before: 50, after: 100 });
  // Only the merge round is measured, and it measured the old prompt, so the practice-case gain stays, labelled.
  assert.match(repo.issue, /On the practice cases Synthe learns from, your checks now pass 100% of the time, up from 50%\./);
  assert.match(repo.prs[0].body, /\*\*Why:\*\* Your checks passed 100% of the time, up from 50%\./);
  assert.deepEqual(repo.state.lessons?.rows.find((r) => r.id === "t0")?.failedChecks, ["Asks for the order number first"]);
});

test("the writer is told the checks, what the agent is for, and which checks each lesson failed", async () => {
  const g = { ...withChecks(), brief: "Order-help bot for a pizza shop." };
  const state = { ...newState(), lessons: { promptHash: (await import("../src/core/safety.ts")).sha256("Old"), rows: [{ id: "t0", reply: "Hi!", violation: false, failedChecks: ["Asks for the order number first"] }] } };
  const m = model();
  m.ask = async (a) => { m.asks.push(a); return { text: JSON.stringify({ edits: [{ find: "Old", replace: "New" }], summary: "s", title: "t" }), costUsd: 0.01 }; };
  await runWrite(g, state, "Old", cases, m);
  assert.match(m.asks[0].user, /What the agent is for: Order-help bot for a pizza shop\./);
  assert.match(m.asks[0].user, /these checks; a change wins by making replies pass more of them:\n- Asks for the order number first\n- Stays under three sentences/);
  assert.match(m.asks[0].user, /It failed these checks: Asks for the order number first/);
});

test("synthe.json checks must be a short list of sentences", () => {
  const base = { version: 1, prompt: { kind: "file", path: "p.md" }, objective: "x", scenarios: "s.jsonl", budget: { max_usd: 3 } };
  assert.deepEqual(parseGoal(JSON.stringify({ ...base, checks: CHECKS })).checks, CHECKS);
  assert.throws(() => parseGoal(JSON.stringify({ ...base, checks: "be nice" })), /checks must be a list/);
  assert.throws(() => parseGoal(JSON.stringify({ ...base, checks: Array(6).fill("x") })), /up to 5/);
  assert.throws(() => parseGoal(JSON.stringify({ ...base, checks: [""] })), /checks must be a list/);
});

// A real run on Nov 6 found nothing better in three rounds, so the held-back cases were never run and the prompt's
// score was never recorded: no headline, no graph. The current prompt is now marked there on its own.
test("when no change passes the learned-from cases, the current prompt is still scored on the held-back cases", async () => {
  const m = model({ newFails: 1 }); // New fails the same checks as Old and the judge prefers Old: nothing passes training
  const { scores } = await runScore(withChecks(), "Old", [{ id: "c1", text: "New" }], cases, m);
  assert.equal(scores.candidates[0].holdout, undefined, "no candidate is judged on the held-back cases");
  assert.ok(scores.baselineHoldout.every((r) => r.applicable === 2 && r.failed === 1 && r.score === 50 && r.reply === undefined));
  const { holdoutScorePct } = await import("../src/loop/decide.ts");
  assert.equal(holdoutScorePct(scores.baselineHoldout), 50);
  const held = m.asks.filter((a) => a.user.includes("my parcel"));
  assert.equal(held.filter((a) => a.system === "Old").length, 10, "one current-prompt reply per held-back case");
  assert.equal(held.filter((a) => JSON.stringify(a.schema ?? {}).includes('"results"')).length, 10, "one check call per held-back case");
  assert.ok(!held.some((a) => a.system === "New" || JSON.stringify(a.schema ?? {}).includes('"better"')), "nothing is judged or run for a challenger there");
  // The decision is unchanged, and the skipped round now records the score.
  const repo = new MemoryRepo("Old");
  repo.files.set("s.jsonl", cases.map((c) => JSON.stringify(c)).join("\n"));
  const record = await runDecide(withChecks(), repo, { candidates: [{ id: "c1", text: "New", summary: "s" }], scores, costUsd: 0.05 });
  assert.equal(record?.outcome, "skipped");
  assert.equal(record?.scorePct, 50);
  assert.match(repo.issue, /Your prompt scores 50% \(checks passed on test cases Synthe never trains on\)/);
});

test("without checks, a round with no winner still spends nothing on the held-back cases", async () => {
  const m = model({ newFails: 1 });
  await runScore(goal({ scenarios: "s.jsonl" }), "Old", [{ id: "c1", text: "New" }], cases, m);
  assert.ok(!m.asks.some((a) => a.user.includes("my parcel")));
});
