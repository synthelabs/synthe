import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { init, type Io } from "../src/cli/init.ts";
import { DEFAULTS, parseGoal, type Scenario } from "../src/core/goal.ts";
import { guardRate, judgeRound, type RoundScores, type ScoreRow } from "../src/core/merge-rule.ts";
import { sha256 } from "../src/core/safety.ts";
import { runDecide } from "../src/loop/decide.ts";
import { explainScores, runScore } from "../src/loop/score.ts";
import type { Ask, Model } from "../src/model/client.ts";
import { MemoryRepo, goal, heldRows, trainRows } from "./helpers.ts";

const CHECKS = ["Mentions the order number"];
const GUARDS = ["Stays on the customer's question instead of adding filler"];
const cases: Scenario[] = [
  ...Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, input: `where is my order ${i}`, expected: "mentions the order number", split: "train" as const })),
  ...Array.from({ length: 10 }, (_, i) => ({ id: `h${i}`, input: `my parcel ${i} is late`, expected: "mentions the order number", split: "holdout" as const })),
];
const guarded = (g = {}) => goal({ checks: CHECKS, counter_checks: GUARDS, scenarios: "s.jsonl", ...g });

// The agent answers by prompt, and the judge always prefers the current prompt's reply, so only the checks can make
// a challenger win. "New" is the padded reply: it passes the check and, by default, fails the guard; "Old" fails the
// check and passes the guard. newPassesGuard and oldPassesGuard change that; guardAnswer replaces the guard's answer.
function model(over: { newPassesGuard?: boolean; oldPassesGuard?: boolean; guardAnswer?: () => string } = {}): Model & { asks: Ask[] } {
  const asks: Ask[] = [];
  return {
    asks,
    async ask(a) {
      asks.push(a);
      const schema = JSON.stringify(a.schema ?? {});
      if (schema.includes('"results"')) {
        const isNew = a.user.includes("<reply>\nreply from New");
        if (a.user.includes(GUARDS[0])) {
          if (over.guardAnswer) return { text: over.guardAnswer(), costUsd: 0.001 };
          const passes = isNew ? over.newPassesGuard ?? false : over.oldPassesGuard ?? true;
          return { text: JSON.stringify({ results: [{ check: 1, applies: true, passes }] }), costUsd: 0.001 };
        }
        return { text: JSON.stringify({ results: [{ check: 1, applies: true, passes: isNew }] }), costUsd: 0.001 };
      }
      if (schema.includes('"better"')) {
        const aIsOld = /<reply_a>\nreply from Old/.test(a.user);
        return { text: JSON.stringify({ better: aIsOld ? "A" : "B", a_guardrail_ok: true, b_guardrail_ok: true }), costUsd: 0.001 };
      }
      if (schema.includes('"breaks"')) return { text: JSON.stringify({ breaks: false, guardrail: "", quote: "" }), costUsd: 0.001 };
      return { text: `reply from ${a.system}${a.system === "New" ? ", padded with filler" : ""}`, costUsd: 0.001 };
    },
  };
}

// Rows where every case has 100 guard-applicable marks and failedPer of them failed, so the rate is 100 - failedPer.
const marked = (rows: ScoreRow[], failedPer: number): ScoreRow[] => rows.map((r) => ({ ...r, guardFailed: failedPer, guardApplicable: 100 }));
const scoresWith = (before: number, after: number): RoundScores => ({
  baselineHash: sha256("Old"),
  baselineTrain: marked(trainRows(50), before), baselineHoldout: marked(heldRows(50), before),
  candidates: [{ id: "c1", train: marked(trainRows(100), after), holdout: marked(heldRows(100), after) }],
});

test("a padded reply that wins the main check but fails a guard is not merged", async () => {
  const g = guarded();
  const { scores } = await runScore(g, "Old", [{ id: "c1", text: "New" }], cases, model());
  const c = scores.candidates[0];
  assert.ok(c.train.every((r) => r.score === 100 && r.failed === 0), "the padded reply passes the check, so it wins every case");
  assert.ok(c.train.every((r) => r.guardFailed === 1 && r.guardApplicable === 1), "and the guard marked it as failing");
  assert.equal(guardRate(scores.baselineTrain), 100);
  assert.equal(guardRate(c.train), 0);
  assert.ok(explainScores(scores, cases).includes("guards passed on learned-from cases: current 100%, c1 0%"));

  const verdict = judgeRound(scores, g, null);
  assert.equal(verdict.action, "skip");
  assert.match(verdict.reasons.join(" "), /c1: guards passed 0% against 100% for the current prompt, a drop of 100 points where 3 is allowed/);
  assert.match(verdict.notes.c1, /pass your guards less often \(0% against 100%\)/);

  const repo = new MemoryRepo("Old");
  repo.files.set("s.jsonl", cases.map((x) => JSON.stringify(x)).join("\n"));
  const record = await runDecide(g, repo, { candidates: [{ id: "c1", text: "New", summary: "Pads every reply" }], scores, costUsd: 0.05 });
  assert.equal(record?.outcome, "skipped");
  assert.equal(repo.prs.length, 0);
  assert.equal(repo.commits.length, 0);
});

test("the same padded reply merges when the team has no guards, so the guard is what stopped it", async () => {
  const g = goal({ checks: CHECKS, scenarios: "s.jsonl" });
  const m = model();
  const { scores } = await runScore(g, "Old", [{ id: "c1", text: "New" }], cases, m);
  assert.ok(!m.asks.some((a) => a.user.includes(GUARDS[0])), "no guard calls are made without counter_checks");
  assert.ok(scores.candidates[0].train.every((r) => r.guardFailed === undefined && r.guardApplicable === undefined));
  const verdict = judgeRound(scores, g, null);
  assert.equal(verdict.action, "merge");
  if (verdict.action === "merge") assert.equal("guards" in verdict, false);
});

test("guards only measure: they never change which reply wins a case", async () => {
  const { scores } = await runScore(guarded(), "Old", [{ id: "c1", text: "New" }], cases, model());
  const { scores: plain } = await runScore(goal({ checks: CHECKS, scenarios: "s.jsonl" }), "Old", [{ id: "c1", text: "New" }], cases, model());
  assert.deepEqual(scores.candidates[0].train.map((r) => r.score), plain.candidates[0].train.map((r) => r.score));
});

test("each reply is marked against the guards once, however many challengers share it", async () => {
  const m = model();
  await runScore(guarded(), "Old", [{ id: "c1", text: "New" }, { id: "c2", text: "New2" }], cases.slice(0, 6).concat(cases.slice(20)), m);
  const guardCalls = m.asks.filter((a) => a.user.includes(GUARDS[0]));
  const old = guardCalls.filter((a) => a.user.includes("<reply>\nreply from Old"));
  assert.equal(old.length, new Set(old.map((a) => a.user)).size, "Old's reply to each case is marked for guards once");
});

test("a change that wins more checks but drops the guards by more than the margin is skipped", () => {
  const verdict = judgeRound(scoresWith(4, 8), guarded(), null);
  assert.equal(verdict.action, "skip");
  assert.match(verdict.reasons.join(" "), /guards passed 92% against 96% for the current prompt, a drop of 4 points where 3 is allowed/);
});

test("a guard drop of exactly the margin still merges, and the report says so", () => {
  const verdict = judgeRound(scoresWith(4, 7), guarded(), null);
  assert.equal(verdict.action, "merge");
  if (verdict.action !== "merge") return;
  assert.deepEqual(verdict.guards, { before: 96, after: 93 });
  assert.match(verdict.plain, / Your guards held at 93%, down from 96%\.$/);
  assert.equal(guarded().merge_rule.guard_margin, DEFAULTS.merge_rule.guard_margin);

  const wider = judgeRound(scoresWith(4, 8), guarded({ merge_rule: { ...DEFAULTS.merge_rule, guard_margin: 4 } }), null);
  assert.equal(wider.action, "merge", "the margin is the team's to set");
  const none = judgeRound(scoresWith(4, 5), guarded({ merge_rule: { ...DEFAULTS.merge_rule, guard_margin: 0 } }), null);
  assert.equal(none.action, "skip", "a margin of 0 allows no drop at all");
});

test("a guard that improves says so", () => {
  const verdict = judgeRound(scoresWith(10, 5), guarded(), null);
  assert.equal(verdict.action, "merge");
  if (verdict.action === "merge") {
    assert.deepEqual(verdict.guards, { before: 90, after: 95 });
    assert.match(verdict.plain, /Your guards improved from 90% to 95%\.$/);
  }
});

test("a missing guard verdict blocks the merge when the team has guards", async () => {
  // The guard answer skips nothing the schema can catch except a missing item: an empty list is an unchecked reply.
  const { scores } = await runScore(guarded(), "Old", [{ id: "c1", text: "New" }], cases, model({ guardAnswer: () => JSON.stringify({ results: [] }) }));
  assert.ok(scores.candidates[0].train.every((r) => r.score === 100 && r.guardFailed === undefined), "the check still wins the case");
  assert.equal(guardRate(scores.candidates[0].train), null);
  const verdict = judgeRound(scores, guarded(), null);
  assert.equal(verdict.action, "skip");
  assert.match(verdict.reasons.join(" "), /c1: guard verdicts missing/);

  // The same when only one side is unknown, or only some rows were marked.
  const half = scoresWith(0, 0);
  half.candidates[0].holdout![3] = { ...half.candidates[0].holdout![3], guardFailed: undefined, guardApplicable: undefined };
  assert.equal(judgeRound(half, guarded(), null).action, "skip");
  const baseline = scoresWith(0, 0);
  baseline.baselineTrain[0] = { ...baseline.baselineTrain[0], guardFailed: undefined, guardApplicable: undefined };
  assert.equal(judgeRound(baseline, guarded(), null).action, "skip");
  // No guard applied to any case: nothing was measured, so it isn't a pass.
  const none = (rows: ScoreRow[]) => rows.map((r) => ({ ...r, guardFailed: 0, guardApplicable: 0 }));
  const nothing: RoundScores = { ...scoresWith(0, 0), baselineTrain: none(trainRows(50)), baselineHoldout: none(heldRows(50)) };
  assert.equal(judgeRound(nothing, guarded(), null).action, "skip");
});

test("without counter_checks, guard numbers on the rows change nothing", () => {
  const verdict = judgeRound(scoresWith(0, 50), goal({ scenarios: "s.jsonl" }), null);
  assert.equal(verdict.action, "merge");
  if (verdict.action === "merge") {
    assert.equal("guards" in verdict, false);
    assert.doesNotMatch(verdict.plain, /guards/);
  }
  const bare: RoundScores = { baselineHash: "h", baselineTrain: trainRows(50), baselineHoldout: heldRows(50), candidates: [{ id: "c1", train: trainRows(100), holdout: heldRows(100) }] };
  assert.equal(judgeRound(bare, goal({ scenarios: "s.jsonl" }), null).action, "merge");
  assert.equal(judgeRound(bare, guarded(), null).action, "skip", "with guards set and no verdicts, nothing merges");
});

test("a merged change that held its guards puts that in the record, the issue and the pull request", async () => {
  const g = guarded();
  const { scores } = await runScore(g, "Old", [{ id: "c1", text: "New" }], cases, model({ newPassesGuard: true, oldPassesGuard: false }));
  const repo = new MemoryRepo("Old");
  repo.files.set("s.jsonl", cases.map((x) => JSON.stringify(x)).join("\n"));
  const record = await runDecide(g, repo, { candidates: [{ id: "c1", text: "New", summary: "Asks for the order number" }], scores, costUsd: 0.05 });
  assert.equal(record?.outcome, "merged");
  assert.deepEqual(record?.guards, { before: 0, after: 100 });
  assert.match(record!.plain!, /Your guards improved from 0% to 100%\./);
  assert.match(repo.issue, /Your guards improved from 0% to 100%\./);
  assert.match(repo.prs[0].body, /Your guards improved from 0% to 100%\./);
  assert.match(repo.issue, /Your checks now pass 100% of the time, up from 0%\. Your guards improved from 0% to 100%\./);
});

test("synthe.json guards: up to 5 sentences, none empty, none repeating a check", () => {
  const base = { version: 1, prompt: { kind: "file", path: "p.md" }, objective: "x", scenarios: "s.jsonl", budget: { max_usd: 3 }, checks: ["Asks for the order number first"] };
  const parse = (extra: object) => parseGoal(JSON.stringify({ ...base, ...extra }));
  assert.deepEqual(parse({ counter_checks: ["a", "b", "c", "d", "e"] }).counter_checks, ["a", "b", "c", "d", "e"]);
  assert.equal(parse({}).counter_checks, undefined);
  assert.throws(() => parse({ counter_checks: ["a", "b", "c", "d", "e", "f"] }), /counter_checks must be a list of up to 5 sentences/);
  assert.throws(() => parse({ counter_checks: [""] }), /counter_checks must be a list of up to 5 sentences/);
  assert.throws(() => parse({ counter_checks: ["   "] }), /counter_checks must be a list/);
  assert.throws(() => parse({ counter_checks: ["x".repeat(301)] }), /counter_checks must be a list/);
  assert.throws(() => parse({ counter_checks: "be honest" }), /counter_checks must be a list/);
  assert.throws(() => parse({ counter_checks: [7] }), /counter_checks must be a list/);
  assert.throws(() => parse({ counter_checks: ["Fine", "Asks for the order number first"] }), /counter_checks repeats a check/);
  assert.throws(() => parse({ counter_checks: ["  asks for the ORDER number first "] }), /counter_checks repeats a check/, "case and spacing don't make it a new sentence");
  assert.equal(parse({ counter_checks: ["x".repeat(300)] }).counter_checks![0].length, 300);
});

test("guard_margin defaults to 3, and must be 0 or more", () => {
  const base = { version: 1, prompt: { kind: "file", path: "p.md" }, objective: "x", scenarios: "s.jsonl", budget: { max_usd: 3 } };
  assert.equal(parseGoal(JSON.stringify(base)).merge_rule.guard_margin, 3);
  assert.equal(parseGoal(JSON.stringify({ ...base, merge_rule: { mode: "propose" } })).merge_rule.guard_margin, 3);
  assert.equal(parseGoal(JSON.stringify({ ...base, merge_rule: { guard_margin: 0 } })).merge_rule.guard_margin, 0);
  assert.equal(parseGoal(JSON.stringify({ ...base, merge_rule: { guard_margin: 7.5 } })).merge_rule.guard_margin, 7.5);
  assert.throws(() => parseGoal(JSON.stringify({ ...base, merge_rule: { guard_margin: -1 } })), /guard_margin must be 0 or more/);
  assert.throws(() => parseGoal(JSON.stringify({ ...base, merge_rule: { guard_margin: "3" } })), /guard_margin must be 0 or more/);
});

// --- init ---

const repoDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "synthe-guards-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "prompt.md"), "You are a very helpful assistant for hikers needing trail advice.");
  execFileSync("git", ["add", "prompt.md"], { cwd: dir });
  return dir;
};

const SETUP_CHECKS = ["Asks for the order number first", "Stays under three sentences", "Offers a remake before a refund"];
const scenarioReply = JSON.stringify({
  guardrails: ["Never lie"], policy: "", brief: "Order-help bot for a pizza shop.", checks: SETUP_CHECKS,
  scenarios: Array.from({ length: 30 }, (_, i) => ({ input: `q${i}`, expected: `a${i}` })),
});
const GUARD_REPLY = ["Asks only when the order number isn't already given", "Still answers the question fully", "Offers a remake only when the order was wrong"];

function setup(answers: Record<string, string> = {}, guardsReply: () => string | null = () => JSON.stringify({ guards: GUARD_REPLY })) {
  const dir = repoDir();
  const said: string[] = [];
  const asked: Ask[] = [];
  const io: Io = {
    say: (t) => said.push(t),
    ask: async (q) => Object.entries({ "automatically?": "y", "Real message": "", "Use these checks": "y", "Use these guards": "y", ...answers }).find(([k]) => q.includes(k))?.[1] ?? "Answer returns correctly",
    askSecret: async () => "sk-ant-test-team-key",
    template: () => readFileSync("templates/synthe.yml", "utf8"),
    sleep: async () => {},
    model: () => ({
      async ask(a) {
        if (JSON.stringify(a.schema ?? {}).includes('"guards"')) { asked.push(a); const text = guardsReply(); return { text, costUsd: 0.001 }; }
        return { text: scenarioReply, costUsd: 0.01 };
      },
    }),
    async run(cmd, args) {
      if (cmd === "git" && args[0] === "ls-files") return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
      return cmd === "git" ? "" : "o/r\n";
    },
  };
  return { dir, io, said, asked, saved: () => parseGoal(readFileSync(join(dir, "synthe.json"), "utf8")) };
}

test("init proposes one guard per check with the writer model and saves them when the team says yes", async () => {
  const { dir, io, said, asked, saved } = setup();
  assert.equal(await init(io, dir), true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].model, DEFAULTS.models.writer);
  assert.match(asked[0].user, /What the agent is for: Order-help bot for a pizza shop\./);
  for (const c of SETUP_CHECKS) assert.ok(asked[0].user.includes(c), `the request names the check "${c}"`);
  const text = said.join("\n");
  assert.match(text, /won't merge a change that passes them clearly less often:\n  1\. Asks only when the order number isn't already given\n  2\. Still answers the question fully\n  3\. Offers a remake only when the order was wrong/);
  assert.deepEqual(saved().counter_checks, GUARD_REPLY);
  assert.equal(saved().merge_rule.guard_margin, 3);
});

test("a team can replace the proposed guards with its own", async () => {
  const typed = ["Mentions the order number only once", "Asks for the order number first", "Mentions the order number only once", ""];
  const { dir, io, said, saved } = setup({ "Use these guards": "n" });
  const ask = io.ask;
  io.ask = async (q) => (q.startsWith("Guard ") ? typed.shift() ?? "" : ask(q));
  assert.equal(await init(io, dir), true);
  assert.deepEqual(saved().counter_checks, ["Mentions the order number only once"], "a repeat of a check or of an earlier guard is skipped, so synthe.json stays valid");
  assert.match(said.join("\n"), /That repeats a check or a guard you already have, so it was skipped\./);
});

test("typing nothing at the rewrite keeps the suggested guards", async () => {
  const { dir, io, said, saved } = setup({ "Use these guards": "n" });
  const ask = io.ask;
  io.ask = async (q) => (q.startsWith("Guard ") ? "" : ask(q));
  assert.equal(await init(io, dir), true);
  assert.deepEqual(saved().counter_checks, GUARD_REPLY);
  assert.match(said.join("\n"), /No guards typed, so Synthe keeps its suggestions\./);
});

test("when the guard request fails or can't be used, init goes on with no guards and says so", async () => {
  const bad: [string, () => string | null][] = [
    ["an unusable answer", () => "not json"],
    ["no answer", () => null],
    ["the wrong shape", () => JSON.stringify({ guards: "be careful" })],
    ["only blanks and repeats of the checks", () => JSON.stringify({ guards: ["", "  ", SETUP_CHECKS[0].toUpperCase(), 4] })],
    ["a thrown error", () => { throw new Error("529 overloaded"); }],
  ];
  for (const [name, reply] of bad) {
    const { dir, io, said, saved } = setup({}, reply);
    assert.equal(await init(io, dir), true, name);
    assert.match(said.join("\n"), /Synthe couldn't propose guards this time, so it will run with your checks alone\./, name);
    assert.equal("counter_checks" in saved(), false, name);
    assert.deepEqual(saved().checks, SETUP_CHECKS, name);
  }
});

test("a guard answer with extras is trimmed: no more than one per check, none repeated", async () => {
  const reply = () => JSON.stringify({ guards: ["  One  ", "One", "Two", "Three", "Four"] });
  const { dir, io, saved } = setup({}, reply);
  assert.equal(await init(io, dir), true);
  assert.deepEqual(saved().counter_checks, ["One", "Two", "Three"]);
});
