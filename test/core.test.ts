import assert from "node:assert/strict";
import { test } from "node:test";
import { costUsd, sumCosts } from "../src/core/cost.ts";
import { parseGoal, parseScenarios } from "../src/core/goal.ts";
import { judgeRound, mean, paired, signP, type RoundScores, type ScoreRow } from "../src/core/merge-rule.ts";
import { findPrompts, readPrompt, writePrompt } from "../src/core/prompt.ts";
import { candidateProblem, promptPathProblem } from "../src/core/safety.ts";
import { newState, stopReason } from "../src/core/state.ts";
import { goal, heldRows, rows, scored, trainRows } from "./helpers.ts";

test("merges a clear winner", () => {
  const v = judgeRound(scored("p", 50, 50, 60, 55), goal(), null);
  assert.equal(v.action, "merge");
});

test("skips improvement below the threshold", () => {
  assert.equal(judgeRound(scored("p", 50, 50, 51, 55), goal(), null).action, "skip");
});

test("skips a candidate that loses held back", () => {
  assert.equal(judgeRound(scored("p", 50, 50, 70, 49), goal(), null).action, "skip");
});

test("matching the baseline held back is not a gain", () => {
  assert.equal(judgeRound(scored("p", 50, 50, 70, 50), goal(), null).action, "skip");
  assert.equal(judgeRound(scored("p", 50, 50, 70, 51.9), goal(), null).action, "skip");
  assert.equal(judgeRound(scored("p", 50, 50, 70, 52), goal(), null).action, "merge");
});

test("a higher average from a few scenarios isn't enough", () => {
  const s = scored("p", 50, 50, 70, 60);
  s.candidates[0].train = rows([...Array(5).fill(100), ...Array(5).fill(60), ...Array(10).fill(45)]);
  const v = judgeRound(s, goal(), null);
  assert.equal(v.action, "skip");
  assert.match(v.reasons.join(), /could be noise/);
});

test("the sign test is exact and ignores ties", () => {
  assert.equal(signP(5, 0), 1 / 32);
  assert.equal(signP(4, 0), 1 / 16);
  assert.ok(Math.abs(signP(14, 6) - 0.0577) < 1e-3);
  assert.ok(signP(15, 5) <= 0.05);
  assert.equal(signP(0, 0), 1);
  assert.equal(paired(rows([60, 50, 60]), rows([50, 50, 50]))?.wins, 2);
  assert.equal(paired(rows([60, 50, 60]), rows([50, 50, 50]))?.losses, 0);
});

test("scenarios that can't be paired are unknown", () => {
  assert.equal(paired(rows([60]), rows([50], false, "h")), null);
  assert.equal(paired(rows([60, 70]), rows([50])), null);
  assert.equal(paired(rows([null]), rows([50])), null);
  assert.equal(paired(rows([60]), rows([null])), null);
  assert.equal(paired([], []), null);
  const twice: ScoreRow[] = [{ id: "a", score: 1, violation: false }, { id: "a", score: 2, violation: false }];
  assert.equal(paired(rows([60, 70]), twice), null);
  assert.equal(paired(twice, rows([60, 70], false, "a")), null);
  assert.equal(paired(twice, [{ id: "a", score: 1, violation: false }, { id: "b", score: 2, violation: false }]), null);
  assert.equal(paired(rows([60]), rows([50, 70])), null);
  assert.equal(paired(twice, twice), null);
  const s = scored("p", 50, 50, 70, 60);
  s.candidates[0].train = rows(Array(20).fill(70), false, "other");
  assert.equal(judgeRound(s, goal(), null).action, "skip");
});

test("an unknown score is never zero", () => {
  assert.equal(mean(rows([100, null])), null);
  const s = scored("p", 50, 50, 70, 60);
  s.candidates[0].train = rows([100, null]);
  assert.equal(judgeRound(s, goal(), null).action, "skip");
  s.candidates[0].train = rows([70]);
  s.baselineTrain = rows([null]);
  assert.equal(judgeRound(s, goal(), null).action, "skip");
});

test("guardrail failure or unknown guardrail blocks a merge", () => {
  for (const violation of [true, null]) {
    const s = scored("p", 50, 50, 70, 60);
    s.candidates[0].train = trainRows(70, violation);
    assert.equal(judgeRound(s, goal(), null).action, "skip");
    const held = scored("p", 50, 50, 70, 60);
    held.candidates[0].holdout = [...heldRows(60).slice(1), { id: "h0", score: 60, violation }];
    assert.equal(judgeRound(held, goal(), null).action, "skip");
  }
});

test("a candidate never held-back tested can't merge", () => {
  const s = scored("p", 50, 50, 70, 60);
  delete s.candidates[0].holdout;
  assert.equal(judgeRound(s, goal(), null).action, "skip");
});

test("reverts only when clearly worse than the prompt it replaced", () => {
  const replaced = [...trainRows(60), ...heldRows(60)];
  assert.equal(judgeRound(scored("p", 56, 56, 56, 56), goal(), replaced).action, "revert");
  assert.notEqual(judgeRound(scored("p", 58, 58, 58, 58), goal(), replaced).action, "revert");
  assert.notEqual(judgeRound(scored("p", 60, 60, 60, 60), goal(), replaced).action, "revert");
});

test("a big drop in a few scenarios doesn't revert", () => {
  const replaced = [...trainRows(60), ...heldRows(60)];
  const s = scored("p", 60, 60, 60, 60);
  s.baselineTrain = rows([...Array(6).fill(0), ...Array(14).fill(70)]);
  s.baselineHoldout = heldRows(70);
  assert.notEqual(judgeRound(s, goal(), replaced).action, "revert");
});

test("scenarios changed since the merge can't trigger a revert", () => {
  const replaced = rows(Array(30).fill(90), false, "old");
  assert.notEqual(judgeRound(scored("p", 40, 40, 40, 40), goal(), replaced).action, "revert");
});

// A fixed-seed stand-in for the model, run through the real rule: one candidate holds any real gain.
function simulator(seed: number, noise: number) {
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  const hard = (n: number) => Array.from({ length: n }, () => 30 + random() * 50);
  const measure = (levels: number[], gain: number, prefix: string) =>
    rows(levels.map((l) => Math.round(Math.max(0, Math.min(100, l + gain + gauss() * noise)))), false, prefix);
  return { hard, measure };
}

function round(sim: ReturnType<typeof simulator>, gain: number): { v: ReturnType<typeof judgeRound>; levels: [number[], number[]]; scores: RoundScores } {
  const levels: [number[], number[]] = [sim.hard(20), sim.hard(10)];
  const trained = [gain, 0, 0].map((g, i) => ({ g, id: `c${i}`, train: sim.measure(levels[0], g, "s") }))
    .sort((a, b) => mean(b.train)! - mean(a.train)!);
  const scores: RoundScores = {
    baselineHash: "x", baselineTrain: sim.measure(levels[0], 0, "s"), baselineHoldout: sim.measure(levels[1], 0, "h"),
    candidates: trained.map((c, i) => ({ id: c.id, train: c.train, ...(i === 0 ? { holdout: sim.measure(levels[1], c.g, "h") } : {}) })),
  };
  return { v: judgeRound(scores, goal(), null), levels, scores };
}

const rate = (n: number, f: () => boolean) => Array.from({ length: n }, f).filter(Boolean).length / n;

test("candidates that are no better rarely merge, even with noisy scores", () => {
  for (const noise of [4, 8, 12]) {
    const sim = simulator(noise, noise);
    const merged = rate(4000, () => round(sim, 0).v.action === "merge");
    assert.ok(merged < 0.04, `noise ${noise}: ${merged}`);
  }
});

test("large real gains still merge", () => {
  const sim = simulator(7, 8);
  assert.ok(rate(2000, () => round(sim, 15).v.action === "merge") > 0.95);
  assert.ok(rate(2000, () => round(sim, 10).v.action === "merge") > 0.75);
});

test("a lucky merge rarely reverts, and a real drop does", () => {
  const sim = simulator(11, 8);
  const check = (drop: number) => {
    const { levels, scores } = round(sim, 0);
    const replaced = [...scores.baselineTrain, ...scores.baselineHoldout];
    const next = { ...scores, baselineTrain: sim.measure(levels[0], -drop, "s"), baselineHoldout: sim.measure(levels[1], -drop, "h"), candidates: [] };
    return judgeRound(next, goal(), replaced).action === "revert";
  };
  assert.ok(rate(4000, () => check(0)) < 0.03);
  assert.ok(rate(2000, () => check(15)) > 0.95);
});

test("cost is unknown for unlisted models and missing usage", () => {
  assert.equal(costUsd("mystery", { input_tokens: 1, output_tokens: 1 }), null);
  assert.equal(costUsd("claude-haiku-5-5", null), null);
  assert.ok(Math.abs(costUsd("claude-haiku-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 })! - 0.6) < 1e-9);
  assert.equal(sumCosts([1, null, 2]), null);
});

test("stops on budget, rounds, stalls, and unknown spend", () => {
  const s = newState();
  assert.equal(stopReason(s, 12, 3, 3), null);
  assert.match(stopReason({ ...s, spendUsd: 3 }, 12, 3, 3)!, /budget/);
  assert.match(stopReason({ ...s, round: 12 }, 12, 3, 3)!, /12 rounds/);
  assert.match(stopReason({ ...s, stalls: 3 }, 12, 3, 3)!, /no winner/);
  assert.match(stopReason({ ...s, spendUnknown: true }, 12, 3, 3)!, /measured/);
});

test("refuses sensitive prompt paths", () => {
  for (const p of [".github/workflows/x.md", ".env", "package.json", "../x.md", "/etc/passwd", "a/.env.local", "Dockerfile"]) {
    assert.ok(promptPathProblem(p), p);
  }
  assert.equal(promptPathProblem("agent/prompt.md"), null);
});

test("refuses unsafe candidates", () => {
  const file = { kind: "file", path: "p.md" } as const;
  assert.ok(candidateProblem("", file));
  assert.ok(candidateProblem(42, file));
  assert.ok(candidateProblem("x".repeat(20_001), file));
  assert.ok(candidateProblem("use sk-ant-api03-abcdefghijk", file));
  assert.equal(candidateProblem("Be helpful and exact.", file), null);
  const inline = { kind: "inline", path: "a.ts", delimiter: "`", initial: "x" } as const;
  assert.ok(candidateProblem("`; process.exit(); `", inline));
  assert.ok(candidateProblem("${process.env.KEY}", inline));
  assert.ok(candidateProblem("a\\", inline));
  const quoted = { kind: "inline", path: "a.py", delimiter: '"', initial: "x" } as const;
  assert.ok(candidateProblem('say "hi"', quoted));
  assert.ok(candidateProblem("two\nlines", quoted));
});

test("finds prompts in files and code, skipping vendored paths", () => {
  const long = "You are a helpful assistant for hikers who need trail advice.";
  const found = findPrompts([
    { path: "prompts/system.md", text: long },
    { path: "app.ts", text: `const SYSTEM_PROMPT = \`${long}\`;` },
    { path: "bot.py", text: `system = "${long}"` },
    { path: "client.ts", text: `create({ system: "${long}", model })` },
    { path: "node_modules/x/system.md", text: long },
    { path: "short.ts", text: 'const prompt = "hi";' },
  ]);
  assert.deepEqual(found.map((f) => f.location.path).sort(), ["app.ts", "bot.py", "client.ts", "prompts/system.md"]);
});

test("writes inline prompts in place and refuses a missing or repeated one", () => {
  const g = goal({ prompt: { kind: "inline", path: "a.ts", delimiter: "`", initial: "old text" } });
  const src = "const p = `old text`;";
  assert.equal(readPrompt(src, g, null), "old text");
  assert.equal(writePrompt(src, g.prompt, "old text", "new text"), "const p = `new text`;");
  assert.equal(readPrompt("const p = `other`;", g, null), null);
  assert.equal(readPrompt("`old text` `old text`", g, null), null);
});

test("goal and scenario parsing reject bad input", () => {
  assert.throws(() => parseGoal('{"version":2}'));
  assert.throws(() => parseScenarios('{"id":"a","input":"i","expected":"e","split":"train"}'));
  const row = (id: string, split: string) => JSON.stringify({ id, input: "i", expected: "e", split });
  assert.throws(() => parseScenarios(["1", "2", "3", "4"].map((i) => row(i, "train")).concat(row("h", "holdout")).join("\n")), /5 train/);
  assert.equal(parseScenarios(["1", "2", "3", "4", "5"].map((i) => row(i, "train")).concat(row("h", "holdout")).join("\n")).length, 6);
  const g = parseGoal('{"version":1,"prompt":{"kind":"file","path":"p.md"},"objective":"o","scenarios":"s","budget":{"max_usd":3}}');
  assert.equal(g.models.judge, "claude-haiku-5-5");
});

test("never add a guardrail break: fewer breaks than the current prompt can merge, a new one can't", () => {
  const s = scored("p", 50, 50, 70, 60);
  // The current prompt breaks a guardrail on s0-s9 and h0-h4.
  s.baselineTrain = s.baselineTrain.map((r, i) => ({ ...r, violation: i < 10 }));
  s.baselineHoldout = s.baselineHoldout.map((r, i) => ({ ...r, violation: i < 5 }));
  // The candidate still breaks on s0-s2 and h0, all places the current prompt already does.
  s.candidates[0].train = s.candidates[0].train.map((r, i) => ({ ...r, violation: i < 3 }));
  s.candidates[0].holdout = s.candidates[0].holdout!.map((r, i) => ({ ...r, violation: i < 1 }));
  const v = judgeRound(s, goal(), null);
  assert.equal(v.action, "merge");
  assert.match(v.reasons.join(), /still breaks a guardrail on 4 scenarios, down from 15/);

  const added = structuredClone(s);
  added.candidates[0].train[15].violation = true; // s15 was safe before
  assert.match(judgeRound(added, goal(), null).reasons.join(), /breaks a guardrail where the current prompt keeps it/);

  const addedHeld = structuredClone(s);
  addedHeld.candidates[0].holdout![8].violation = true; // h8 was safe before
  assert.equal(judgeRound(addedHeld, goal(), null).action, "skip");

  const unknown = structuredClone(s);
  unknown.candidates[0].train[0].violation = null; // unknown is never allowed, even where the current prompt breaks
  assert.equal(judgeRound(unknown, goal(), null).action, "skip");
});

test("a run summary keeps only numbers, never prompt or reply text", async () => {
  const { summarize, scorecard } = await import("../src/runs/summary.ts");
  const state = {
    ...newState(), round: 5, spendUsd: 0.372, stopped: "3 rounds in a row found no winner", issue: 3,
    prompt: "SECRET PROMPT", lastMerge: { pr: 1, priorPrompt: "SECRET OLD", mergedHash: "h", reverted: false },
    lessons: { promptHash: "h", rows: [{ id: "s1", reply: "SECRET REPLY", violation: false }] },
    rounds: [
      { round: 1, at: "2026-11-06T23:10:00Z", outcome: "skipped" as const, reasons: [], costUsd: 0.07 },
      { round: 2, at: "2026-11-07T00:10:00Z", outcome: "merged" as const, reasons: [], costUsd: 0.09, pr: 1 },
      { round: 3, at: "2026-11-07T01:10:00Z", outcome: "failed" as const, reasons: [], costUsd: null },
    ],
  };
  const s = summarize({ repo: "team/bot", startedAt: "2026-11-06T23:00:00Z", finishedAt: "2026-11-06T23:04:30Z", mode: "auto" }, state, { up: 2, down: 0 });
  assert.equal(JSON.stringify(s).includes("SECRET"), false);
  assert.deepEqual([s.setupSeconds, s.rounds, s.merged, s.failed, s.spendUsd, s.firstMergeRound, s.status], [270, 5, 1, 1, 0.37, 2, "finished"]);
  const none = summarize({ repo: "team/private" }, null);
  assert.deepEqual([none.readable, none.status], [false, "not started"]);
  const card = scorecard([s, none]);
  assert.deepEqual([card.teamsRegistered, card.teamsStarted, card.teamsWithAMerge, card.medianSetupSeconds, card.thumbsUp], [2, 1, 1, 270, 2]);
});
