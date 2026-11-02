import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256 } from "../src/core/safety.ts";
import { runDecide } from "../src/loop/decide.ts";
import { measureNoise, runScore } from "../src/loop/score.ts";
import { judgeRound } from "../src/core/merge-rule.ts";
import { runWrite } from "../src/loop/write.ts";
import { newState } from "../src/core/state.ts";
import type { Ask, Model } from "../src/model/client.ts";
import type { Scenario } from "../src/core/goal.ts";
import { MemoryRepo, goal, heldRows, rows, scenarios, scored, trainRows } from "./helpers.ts";

const candidates = [{ id: "c1", text: "Better prompt." }];
const round = (s: ReturnType<typeof scored>) => ({ candidates, scores: s, costUsd: 0.1 });

test("merges exactly one file, pinned to the scored commit", async () => {
  const repo = new MemoryRepo("Old prompt.");
  const r = await runDecide(goal(), repo, round(scored("Old prompt.", 50, 50, 60, 55)));
  assert.equal(r?.outcome, "merged");
  assert.deepEqual(repo.commits, [{ path: "prompt.md", content: "Better prompt." }]);
  assert.deepEqual(repo.merges, [{ pr: 1, sha: "sha-1" }]);
  assert.equal(repo.state.spendUsd, 0.1);
  assert.equal(repo.branches.size, 0);
  assert.match(repo.issue, /\| 55\.0 \| 20 \/ 0 \|/);
});

test("evil candidates never merge", async () => {
  const evil = ["", "x".repeat(20_001), "key sk-ant-api03-abcdefghijklmnop", 7 as unknown as string];
  for (const text of evil) {
    const repo = new MemoryRepo("Old prompt.");
    await runDecide(goal(), repo, { candidates: [{ id: "c1", text }], scores: scored("Old prompt.", 50, 50, 90, 90), costUsd: 0.1 });
    assert.equal(repo.commits.length, 0);
  }
});

test("extra fields on a candidate can't reach another file", async () => {
  const repo = new MemoryRepo("Old prompt.");
  const c = [{ id: "c1", text: "Better.", path: ".github/workflows/x.yml", files: { ".env": "A=1" } }];
  await runDecide(goal(), repo, { candidates: c, scores: scored("Old prompt.", 50, 50, 60, 55), costUsd: 0.1 });
  assert.deepEqual(repo.commits.map((x) => x.path), ["prompt.md"]);
});

test("a goal aimed at CI or secrets stops without committing", async () => {
  for (const path of [".github/workflows/ci.yml", ".env"]) {
    const repo = new MemoryRepo("Old prompt.", path);
    const g = goal({ prompt: { kind: "file", path } });
    await runDecide(g, repo, round(scored("Old prompt.", 50, 50, 60, 55)));
    assert.equal(repo.commits.length, 0);
    assert.match(repo.state.stopped!, /sensitive/);
  }
});

test("a dropped score does not merge", async () => {
  const repo = new MemoryRepo("Old prompt.");
  await runDecide(goal(), repo, round(scored("Old prompt.", 50, 50, 40, 40)));
  assert.equal(repo.commits.length, 0);
  assert.equal(repo.state.stalls, 1);
});

test("a teammate's edit during the round wins", async () => {
  const repo = new MemoryRepo("Teammate's edit.");
  const r = await runDecide(goal(), repo, round(scored("Old prompt.", 50, 50, 60, 55)));
  assert.equal(repo.commits.length, 0);
  assert.match(r!.reasons.join(), /changed during/);
});

test("unknown cost blocks the merge and stops the run", async () => {
  const repo = new MemoryRepo("Old prompt.");
  await runDecide(goal(), repo, { candidates, scores: scored("Old prompt.", 50, 50, 60, 55), costUsd: null });
  assert.equal(repo.commits.length, 0);
  assert.ok(repo.state.stopped);
});

test("a failed round counts toward stopping, so a revoked key ends the run", async () => {
  const repo = new MemoryRepo("Old prompt.");
  for (let i = 0; i < 3; i++) await runDecide(goal(), repo, { candidates: null, scores: null, costUsd: null });
  assert.match(repo.state.stopped!, /no winner/);
  assert.equal(await runDecide(goal(), repo, { candidates: null, scores: null, costUsd: null }), null);
});

test("budget used ends the run", async () => {
  const repo = new MemoryRepo("Old prompt.");
  await runDecide(goal(), repo, { candidates, scores: scored("Old prompt.", 50, 50, 60, 55), costUsd: 3.1 });
  assert.match(repo.state.stopped!, /budget/);
});

test("a candidate identical to the current prompt never merges", async () => {
  const repo = new MemoryRepo("Old prompt.");
  const r = await runDecide(goal(), repo, { candidates: [{ id: "c1", text: " Old prompt.\n" }], scores: scored("Old prompt.", 50, 50, 90, 90), costUsd: 0.1 });
  assert.equal(repo.commits.length, 0);
  assert.match(r!.reasons.join(), /current prompt/);
});

test("a merge falling back to the old score stays", async () => {
  const repo = new MemoryRepo("Old prompt.");
  await runDecide(goal(), repo, round(scored("Old prompt.", 50, 50, 60, 55)));
  const r = await runDecide(goal(), repo, round(scored("Better prompt.", 50, 50, 50, 50)));
  assert.equal(r?.outcome, "skipped");
  assert.equal(repo.files.get("prompt.md"), "Better prompt.");
});

test("a teammate's later edit is never reverted", async () => {
  const repo = new MemoryRepo("Old prompt.");
  await runDecide(goal(), repo, round(scored("Old prompt.", 50, 50, 60, 55)));
  repo.files.set("prompt.md", "Teammate's edit.");
  const next = scored("Teammate's edit.", 50, 50, 50, 50);
  next.prior = [...trainRows(90), ...heldRows(90)]; // even a clear win for the old prompt over the teammate's edit
  const r = await runDecide(goal(), repo, round(next));
  assert.notEqual(r?.outcome, "reverted");
  assert.equal(repo.files.get("prompt.md"), "Teammate's edit.");
});

test("merge then slump reverts to the prior prompt when it wins head to head", async () => {
  const repo = new MemoryRepo("Old prompt.");
  await runDecide(goal(), repo, round(scored("Old prompt.", 50, 50, 60, 55)));
  const other = new MemoryRepo("Old prompt.");
  await runDecide(goal(), other, round(scored("Old prompt.", 50, 50, 60, 55)));
  const quiet = scored("Better prompt.", 50, 50, 50, 50);
  assert.notEqual((await runDecide(goal(), other, round(quiet)))?.outcome, "reverted"); // no challenge, no revert
  const next = scored("Better prompt.", 50, 50, 50, 50);
  next.prior = [...trainRows(60), ...heldRows(60)];
  const r = await runDecide(goal(), repo, round(next));
  assert.equal(r?.outcome, "reverted");
  assert.equal(repo.files.get("prompt.md"), "Old prompt.");
  assert.equal(repo.state.lastMerge?.reverted, true);
});

test("a repo that requires review gets the winning pull request left open as a proposal, not a stopped run", async () => {
  const repo = new MemoryRepo("Old prompt.");
  repo.mergeResult = { merged: false, why: "405", problem: "blocked" };
  const r = await runDecide(goal(), repo, round(scored("Old prompt.", 50, 50, 60, 55)));
  assert.equal(r?.outcome, "proposed");
  assert.equal(repo.prs[0].closed, false);
  assert.equal(repo.state.stopped, null);
  assert.equal(repo.state.proposal?.pr, 1);
  assert.match(r!.reasons.join(), /requires a review to merge, so Synthe left #1 open/);
});

test("inline prompts track their text across rounds", async () => {
  const g = goal({ prompt: { kind: "inline", path: "a.ts", delimiter: "`", initial: "Old prompt." } });
  const repo = new MemoryRepo("const p = `Old prompt.`;", "a.ts");
  await runDecide(g, repo, round(scored("Old prompt.", 50, 50, 60, 55)));
  assert.equal(repo.files.get("a.ts"), "const p = `Better prompt.`;");
  assert.equal(repo.state.prompt, "Better prompt.");
});

const fake = (over: Partial<Record<string, string | null>> = {}): Model & { seen: Ask[] } => {
  const seen: Ask[] = [];
  return {
    seen,
    async ask(a) {
      seen.push(a);
      if (a.schema && JSON.stringify(a.schema).includes("guardrail_ok")) {
        const good = (tag: string) => a.user.includes(`<${tag}>\ngood reply`);
        const better = good("reply_a") === good("reply_b") ? "tie" : good("reply_a") ? "A" : "B";
        return { text: over.judge !== undefined ? over.judge : JSON.stringify({ better, a_guardrail_ok: true, b_guardrail_ok: true }), costUsd: 0.001 };
      }
      if (a.schema) return { text: JSON.stringify({ edits: [{ find: "Old", replace: "Improved." }], summary: "Says it better." }), costUsd: 0.01 };
      return { text: a.system === "Improved." ? "good reply" : "weak reply", costUsd: 0.001 };
    },
  };
};

test("the writer never sees held-back scenarios", async () => {
  const m = fake();
  const out = await runWrite(goal(), newState(), "Old", scenarios, m);
  assert.equal(out.candidates.length, 2);
  assert.ok(m.seen.every((a) => !a.user.includes("HOLDOUT-SECRET")));
  assert.ok(Math.abs(out.costUsd! - 0.02) < 1e-9);
});

test("write, score and decide work together", async () => {
  const m = fake();
  const repo = new MemoryRepo("Old");
  const w = await runWrite(goal(), newState(), "Old", scenarios, m);
  const { scores, costUsd } = await runScore(goal(), "Old", w.candidates, scenarios, m);
  assert.equal(scores.baselineHash, sha256("Old"));
  assert.equal(scores.candidates.filter((c) => c.holdout).length, 1);
  const r = await runDecide(goal(), repo, { candidates: w.candidates, scores, costUsd: costUsd! + w.costUsd! });
  assert.equal(r?.outcome, "merged");
  assert.equal(repo.files.get("prompt.md"), "Improved.");
});

test("an identical candidate isn't scored, and noise is measured", async () => {
  const m = fake();
  const { scores } = await runScore(goal(), "Old", [{ id: "c1", text: "Old" }], scenarios, m);
  assert.equal(scores.candidates.length, 0);
  const noise = await measureNoise(goal(), "Old", scenarios, fake());
  assert.deepEqual([noise.wins, noise.losses, noise.ties], [0, 0, scenarios.length]);
  assert.ok(noise.costUsd! > 0);
});

test("a judge that fails or lies about its range yields unknown", async () => {
  for (const judge of [null, "not json", '{"better":"C","a_guardrail_ok":true,"b_guardrail_ok":true}', '{"better":"A"}']) {
    const { scores } = await runScore(goal(), "Old", candidates, scenarios, fake({ judge }));
    assert.equal(scores.candidates[0].train[0].score, null);
    assert.equal(judgeRound(scores, goal(), null).action, "skip");
  }
});

test("a refused or empty reply yields unknown and blocks the merge", async () => {
  const m = fake();
  const ask = m.ask;
  m.ask = async (a) => (a.schema ? ask(a) : { text: null, costUsd: 0.001 });
  const { scores } = await runScore(goal(), "Old", candidates, scenarios, m);
  const repo = new MemoryRepo("Old");
  await runDecide(goal(), repo, { candidates, scores, costUsd: 0.1 });
  assert.equal(repo.commits.length, 0);
  assert.deepEqual(rows([null], null)[0].score, scores.baselineTrain[0].score);
});

const stall = (r: ReturnType<typeof scored>) => ({ candidates, scores: r, costUsd: 0.1 });

test("a run that stops finding winners reads as finished and says how to continue", async () => {
  const repo = new MemoryRepo("Old prompt.");
  await runDecide(goal(), repo, round(scored("Old prompt.", 50, 50, 60, 55)));
  for (let i = 0; i < 3; i++) await runDecide(goal(), repo, stall(scored("Better prompt.", 60, 55, 60, 55)));
  assert.match(repo.state.stopped!, /no winner/);
  assert.match(repo.issue, /\*\*Status:\*\* finished\. Merged 1 improvement\. Each beat the prompt before it head to head/);
  assert.match(repo.issue, /add more or harder scenarios to `s\.jsonl`/);
});

test("failed rounds read as stopped, not finished", async () => {
  const repo = new MemoryRepo("Old prompt.");
  for (let i = 0; i < 3; i++) await runDecide(goal(), repo, { candidates: null, scores: null, costUsd: null });
  assert.match(repo.issue, /\*\*Status:\*\* stopped: the last 3 rounds failed/);
  assert.doesNotMatch(repo.issue, /finished/);
});

test("a repo where Actions may not merge reads as stopped, with the setting to change", async () => {
  const repo = new MemoryRepo("Old prompt.");
  repo.mergeResult = { merged: false, why: "403", problem: "permission" };
  await runDecide(goal(), repo, round(scored("Old prompt.", 50, 50, 60, 55)));
  assert.match(repo.issue, /\*\*Status:\*\* stopped: GitHub Actions isn't allowed to merge/);
});

test("a stalled run resumes when the scenarios change, and only then", async () => {
  const repo = new MemoryRepo("Old prompt.");
  repo.files.set("s.jsonl", "easy");
  for (let i = 0; i < 3; i++) await runDecide(goal(), repo, stall(scored("Old prompt.", 60, 55, 60, 55)));
  assert.match(repo.state.stopped!, /no winner/);
  assert.equal(await runDecide(goal(), repo, stall(scored("Old prompt.", 60, 55, 60, 55))), null);
  repo.files.set("s.jsonl", "harder");
  const r = await runDecide(goal(), repo, round(scored("Old prompt.", 50, 50, 60, 55)));
  assert.equal(r?.outcome, "merged");
  assert.equal(repo.state.stopped, null);
  assert.equal(repo.state.stalls, 0);
});

test("a run stopped for another reason doesn't resume on new scenarios", async () => {
  const repo = new MemoryRepo("Old prompt.");
  repo.files.set("s.jsonl", "easy");
  repo.mergeResult = { merged: false, why: "403", problem: "permission" };
  await runDecide(goal(), repo, round(scored("Old prompt.", 50, 50, 60, 55)));
  repo.mergeResult = { merged: true };
  repo.files.set("s.jsonl", "harder");
  assert.equal(await runDecide(goal(), repo, round(scored("Old prompt.", 50, 50, 60, 55))), null);
});

// Scenarios whose inputs name themselves, so a fake judge can score each prompt per scenario.
const named: Scenario[] = [..."abcdef"].map((id): Scenario => ({ id, input: `q-${id}`, expected: "good", split: "train" }))
  .concat([{ id: "h", input: "q-h", expected: "good", split: "holdout" }]);
type Check = (reply: string) => { breaks: boolean; guardrail: string; quote: string } | string;
const scripted = (table: Record<string, Record<string, number>>, check?: Check): Model & { seen: Ask[] } => {
  const seen: Ask[] = [];
  return {
    seen,
    async ask(a) {
      seen.push(a);
      if (a.schema && JSON.stringify(a.schema).includes("quote")) {
        const reply = /<reply>\n([^\n]*)/.exec(a.user)![1];
        const v = check ? check(reply) : { breaks: false, guardrail: "", quote: "" };
        return { text: typeof v === "string" ? v : JSON.stringify(v), costUsd: 0.001 };
      }
      if (a.schema) {
        const id = /Situation: q-(\w)/.exec(a.user)![1];
        const score = (tag: string) => table[new RegExp(`<${tag}>\\n(\\S+) answers`).exec(a.user)![1]]?.[id] ?? 50;
        const [sa, sb] = [score("reply_a"), score("reply_b")];
        return { text: JSON.stringify({ better: sa === sb ? "tie" : sa > sb ? "A" : "B", a_guardrail_ok: true, b_guardrail_ok: true }), costUsd: 0.001 };
      }
      return { text: `${a.system} answers ${a.user}`, costUsd: 0.001 };
    },
  };
};

test("the held-back test goes to the best candidate that passed training, not the highest average", async () => {
  // Spiky averages higher but wins only half its scenarios; Steady wins all six by a little.
  const m = scripted({
    Spiky: { a: 100, b: 100, c: 100, d: 40, e: 40, f: 40 },
    Steady: { a: 60, b: 60, c: 60, d: 60, e: 60, f: 60, h: 60 },
  });
  const cands = [{ id: "spiky", text: "Spiky" }, { id: "steady", text: "Steady" }];
  const { scores } = await runScore(goal(), "Base", cands, named, m);
  assert.equal(scores.candidates.find((c) => c.id === "spiky")!.holdout, undefined);
  assert.ok(scores.candidates.find((c) => c.id === "steady")!.holdout);
  const repo = new MemoryRepo("Base");
  const r = await runDecide(goal(), repo, { candidates: cands, scores, costUsd: 0.1 });
  assert.equal(r?.outcome, "merged");
  assert.equal(repo.files.get("prompt.md"), "Steady");
});

test("no held-back scenarios are spent when no candidate passes training", async () => {
  const m = scripted({ Meh: { a: 51, b: 50, c: 50, d: 50, e: 50, f: 50 } });
  const { scores } = await runScore(goal(), "Base", [{ id: "meh", text: "Meh" }], named, m);
  assert.equal(scores.candidates[0].holdout, undefined);
  const heldCalls = m.seen.filter((a) => a.user.includes("q-h"));
  assert.equal(heldCalls.length, 0); // not even the current prompt's reply: nothing would be judged against it
});

test("the writer studies the training cases a rewrite won, with both replies, never held-back ones", async () => {
  const m = scripted({
    Base: { a: 10, b: 80, c: 30, d: 80, e: 80, f: 80, h: 0 },
    Other: { a: 90, b: 20, c: 90, d: 80, e: 80, f: 80, h: 90 },
  });
  const { scores } = await runScore(goal(), "Base", [{ id: "x", text: "Other" }], named, m);
  const repo = new MemoryRepo("Base");
  await runDecide(goal(), repo, { candidates: [{ id: "x", text: "Other" }], scores, costUsd: 0.1 });
  const lessons = repo.state.lessons!;
  assert.equal(lessons.promptHash, sha256("Base"));
  assert.deepEqual(lessons.rows.map((r) => r.id), ["a", "c"]); // b was a loss for the rewrite, d-f ties
  assert.ok(lessons.rows.every((r) => r.id !== "h"));

  const w = fake();
  await runWrite(goal(), repo.state, "Base", named, w);
  assert.ok(w.seen.every((a) => a.user.includes("Base answers q-a") && a.user.includes("Other answers q-a")));
  assert.ok(w.seen.every((a) => !a.user.includes("q-h")));

  // Once the prompt has changed, last round's replies say nothing about it.
  const w2 = fake();
  await runWrite(goal(), repo.state, "Newer prompt", named, w2);
  assert.ok(w2.seen.every((a) => !a.user.includes("Base answers")));
});

test("held-back rows planted in saved lessons still never reach the writer", async () => {
  const state = { ...newState(), lessons: { promptHash: sha256("Base"), rows: [{ id: "h", reply: "LEAKED", better: "LEAKED TOO", violation: true }] } };
  const w = fake();
  await runWrite(goal(), state, "Base", named, w);
  assert.ok(w.seen.every((a) => !a.user.includes("LEAKED") && !a.user.includes("q-h")));
});

test("the report shows each round's cost and how much went to writing", async () => {
  const repo = new MemoryRepo("Old prompt.");
  await runDecide(goal(), repo, { ...round(scored("Old prompt.", 50, 50, 50, 50)), costUsd: 0.12, writeUsd: 0.08 });
  assert.match(repo.issue, /\| \$0\.12 \(writing \$0\.08\) \|/);
});

test("a judge that always picks the first reply can't manufacture a winner", async () => {
  const m = scripted({});
  const ask = m.ask;
  m.ask = async (a) => (a.schema ? { text: JSON.stringify({ better: "A", a_guardrail_ok: true, b_guardrail_ok: true }), costUsd: 0.001 } : ask(a));
  const many = [...Array(40)].map((_, i): Scenario => ({ id: `s${i}`, input: `q-${i}`, expected: "good", split: i < 30 ? "train" : "holdout" }));
  const { scores } = await runScore(goal(), "Base", [{ id: "c", text: "Other" }], many, m);
  const wins = scores.candidates[0].train.filter((r) => r.score === 100).length;
  assert.ok(wins > 5 && wins < 25, `position decided ${wins} of 30`); // both orders are used
  assert.notEqual(judgeRound(scores, goal(), null).action, "merge");
});

test("after a merge, the replaced prompt challenges the new one and wins a revert when it's clearly better", async () => {
  const m = scripted({ Old: { a: 90, b: 90, c: 90, d: 90, e: 90, f: 90, h: 90 }, Base: { a: 40, b: 40, c: 40, d: 40, e: 40, f: 40, h: 40 } });
  const { scores } = await runScore(goal(), "Base", [], named, m, "Old");
  assert.ok(scores.prior?.every((r) => r.score === 100));
  const repo = new MemoryRepo("Base");
  repo.state.lastMerge = { pr: 1, priorPrompt: "Old", mergedHash: sha256("Base"), reverted: false };
  const r = await runDecide(goal(), repo, { candidates: [], scores, costUsd: 0.1 });
  assert.equal(r?.outcome, "reverted");
  assert.equal(repo.files.get("prompt.md"), "Old");
});

// A judge that flags Bold's reply to q-c as breaking a guardrail while comparing, with a re-check that answers as told.
const flagsC = (check?: Check) => {
  const m = scripted({ Bold: { a: 99, b: 99, c: 99, d: 99, e: 99, f: 99, h: 99 } }, check);
  const ask = m.ask;
  m.ask = async (a) => {
    const r = await ask(a);
    if (!a.schema || JSON.stringify(a.schema).includes("quote")) return r;
    const v = JSON.parse(r.text!);
    const boldIsA = /<reply_a>\nBold/.test(a.user);
    return { ...r, text: JSON.stringify({ ...v, [boldIsA ? "a_guardrail_ok" : "b_guardrail_ok"]: !a.user.includes("q-c") }) };
  };
  return m;
};
const decideBold = async (m: Model) => {
  const { scores } = await runScore(goal(), "Base", [{ id: "bold", text: "Bold" }], named, m);
  const repo = new MemoryRepo("Base");
  return runDecide(goal(), repo, { candidates: [{ id: "bold", text: "Bold" }], scores, costUsd: 0.1 });
};

test("a new guardrail break confirmed on re-check, with a real quote, blocks the merge", async () => {
  const r = await decideBold(flagsC(() => ({ breaks: true, guardrail: "no lies", quote: "Bold answers q-c" })));
  assert.notEqual(r?.outcome, "merged");
  assert.match(r!.reasons.join(), /guardrail/);
});

test("a guardrail flag the re-check dismisses doesn't block a clear winner", async () => {
  assert.equal((await decideBold(flagsC(() => ({ breaks: false, guardrail: "", quote: "" }))))?.outcome, "merged");
});

test("a re-check that claims a break but quotes words not in the reply is dismissed", async () => {
  assert.equal((await decideBold(flagsC(() => ({ breaks: true, guardrail: "no lies", quote: "We will refund you in full today" }))))?.outcome, "merged");
});

test("a re-check that fails still blocks", async () => {
  assert.notEqual((await decideBold(flagsC(() => "not json")))?.outcome, "merged");
});

test("(old) a candidate the judge catches breaking a guardrail never merges, however much it wins", async () => {
  const m = scripted({ Bold: { a: 99, b: 99, c: 99, d: 99, e: 99, f: 99, h: 99 } }, () => ({ breaks: true, guardrail: "x", quote: "Bold answers q-c" }));
  const ask = m.ask;
  m.ask = async (a) => {
    const r = await ask(a);
    if (!a.schema || JSON.stringify(a.schema).includes("quote")) return r;
    const v = JSON.parse(r.text!);
    const boldIsA = /<reply_a>\nBold/.test(a.user);
    return { ...r, text: JSON.stringify({ ...v, [boldIsA ? "a_guardrail_ok" : "b_guardrail_ok"]: !a.user.includes("q-c") }) };
  };
  const { scores } = await runScore(goal(), "Base", [{ id: "bold", text: "Bold" }], named, m);
  const repo = new MemoryRepo("Base");
  const r = await runDecide(goal(), repo, { candidates: [{ id: "bold", text: "Bold" }], scores, costUsd: 0.1 });
  assert.notEqual(r?.outcome, "merged");
  assert.match(r!.reasons.join(), /guardrail/);
});

const win = () => round(scored("Old prompt.", 50, 50, 60, 55));

test("spend and the round are saved before decide touches the repo, so a crash can't freeze the run", async () => {
  const repo = new MemoryRepo("Old prompt.");
  repo.crashOn = "openPr";
  await assert.rejects(runDecide(goal(), repo, win()));
  assert.equal(repo.state.round, 1);
  assert.equal(repo.state.spendUsd, 0.1);
  assert.equal(repo.state.stalls, 1);
  assert.equal(repo.state.pending?.land?.branch, "synthe/round-1");
  // The next round cleans up the leftover branch, logs the crash, and carries on with a new round number.
  const r = await runDecide(goal(), repo, win());
  assert.equal(r?.round, 2);
  assert.equal(r?.outcome, "merged");
  assert.equal(repo.state.rounds[0].outcome, "failed");
  assert.equal(repo.state.pending, null);
  assert.ok(!repo.branches.has("synthe/round-1"));
});

test("a pull request left open by a crash is closed on the next round", async () => {
  const repo = new MemoryRepo("Old prompt.");
  repo.crashOn = "mergePr";
  repo.mergeResult = { merged: false, why: "409", problem: "moved" };
  await assert.rejects(runDecide(goal(), repo, win()));
  repo.mergeResult = { merged: true };
  await runDecide(goal(), repo, round(scored("Old prompt.", 50, 50, 50, 50)));
  assert.equal(repo.prs[0].closed, true);
  assert.equal(repo.state.rounds[0].outcome, "failed");
});

test("a merge that landed just before a crash is recovered, so the revert check still protects it", async () => {
  const repo = new MemoryRepo("Old prompt.");
  repo.crashOn = "upsertIssue";
  await assert.rejects(runDecide(goal(), repo, win()));
  assert.equal(repo.files.get("prompt.md"), "Better prompt.");
  assert.equal(repo.state.lastMerge, null); // lost with the crash...
  await runDecide(goal(), repo, round(scored("Better prompt.", 50, 50, 50, 50)));
  assert.equal(repo.state.rounds[0].outcome, "merged"); // ...and recovered
  const recovered = repo.state.lastMerge as { priorPrompt: string; mergedHash: string } | null;
  assert.equal(recovered?.priorPrompt, "Old prompt.");
  assert.equal(recovered?.mergedHash, sha256("Better prompt."));
});

test("decide crashing every round still stops the run after the stall limit", async () => {
  const repo = new MemoryRepo("Old prompt.");
  for (let i = 0; i < 3; i++) { repo.crashOn = "upsertIssue"; await runDecide(goal(), repo, round(scored("Old prompt.", 50, 50, 50, 50))).catch(() => {}); }
  repo.crashOn = null;
  assert.equal(await runDecide(goal(), repo, win()), null);
  assert.match(repo.state.stopped!, /no winner/);
});

test("permission and token problems stop with a fix; rate limits and moved branches just fail the round", async () => {
  for (const [problem, stops] of [["permission", /Allow GitHub Actions/], ["token", /token/], ["rate_limited", null], ["moved", null]] as const) {
    const repo = new MemoryRepo("Old prompt.");
    repo.mergeResult = { merged: false, why: "x", problem };
    await runDecide(goal(), repo, win());
    if (stops) assert.match(repo.state.stopped!, stops);
    else assert.equal(repo.state.stopped, null);
  }
});

test("edits apply only where their text appears exactly once", async () => {
  const { applyEdits } = await import("../src/loop/write.ts");
  assert.deepEqual(applyEdits("A. B. C.", [{ find: "B.", replace: "Bee." }]), { text: "A. Bee. C." });
  assert.deepEqual(applyEdits("A.", [{ find: "", replace: "New rule." }]), { text: "A.\n\nNew rule.\n" });
  assert.match((applyEdits("A. A.", [{ find: "A.", replace: "X" }]) as any).problem, /more than once/);
  assert.match((applyEdits("A.", [{ find: "Z", replace: "X" }]) as any).problem, /isn't in the prompt/);
  assert.match((applyEdits("A.", [1, 2, 3].map(() => ({ find: "", replace: "x" }))) as any).problem, /more than 2/);
  assert.match((applyEdits("A.", []) as any).problem, /no edits/);
  assert.match((applyEdits("A.", [{ find: "A.", replace: "A." }]) as any).problem, /change nothing/);
  assert.match((applyEdits("A.", [{ find: "A.", replace: "x".repeat(1501) }]) as any).problem, /too long/);
});

test("a candidate with a bad edit is dropped and the report says why", async () => {
  const m = fake();
  m.ask = async (a) => ({ text: JSON.stringify({ edits: [{ find: "not there", replace: "x" }], summary: "s" }), costUsd: 0.01 });
  const w = await runWrite(goal(), newState(), "Old", scenarios, m);
  assert.equal(w.candidates.length, 0);
  assert.match(w.rejected!.join(), /isn't in the prompt/);
  const repo = new MemoryRepo("Old prompt.");
  await runDecide(goal(), repo, { candidates: [], scores: scored("Old prompt.", 50, 50, 50, 50), costUsd: 0.1, rejected: w.rejected });
  assert.match(repo.issue, /isn't in the prompt/);
});

test("the merged pull request says what changed", async () => {
  const repo = new MemoryRepo("Old prompt.");
  await runDecide(goal(), repo, { ...win(), candidates: [{ id: "c1", text: "Better prompt.", summary: "Adds the refund rule." }] });
  assert.match(repo.prs[0].body, /What changed: Adds the refund rule\./);
});

test("the Actions log explains each candidate: its edits, its record, new guardrail breaks and sample losses", async () => {
  const { explainWrite } = await import("../src/loop/write.ts");
  const { explainScores } = await import("../src/loop/score.ts");
  const w = explainWrite({ candidates: [{ id: "c1", text: "x", summary: "Stops approving refunds.", edits: [{ find: "approve it", replace: "check the window" }] }], costUsd: 0.01, rejected: ["c2: edit too long"] });
  assert.deepEqual(w, ["c1: Stops approving refunds.", '  replace "approve it" -> "check the window"', "rejected c2: edit too long"]);
  const s = scored("p", 50, 50, 0, 50);
  s.baselineTrain[0].reply = "Sure, approved!";
  s.candidates[0].train[0] = { ...s.candidates[0].train[0], reply: "Let me check.", violation: true };
  s.candidates[0].train[1] = { ...s.candidates[0].train[1], violation: null };
  const lines = explainScores(s, [{ id: "s0", input: "Refund my coat?", expected: "x", split: "train" }]);
  assert.ok(lines.some((l) => /c1 training: won 0, lost 20/.test(l)));
  assert.ok(lines.some((l) => /s0 guardrail broken \(NEW\): Refund my coat\?/.test(l)));
  assert.ok(lines.some((l) => /s1 guardrail unknown/.test(l)));
  assert.ok(lines.some((l) => /current: +Sure, approved!/.test(l)) && lines.some((l) => /candidate: Let me check\./.test(l)));
});

test("the guardrail re-check runs on the checker model and sees what a good response does", async () => {
  const m = flagsC(() => ({ breaks: false, guardrail: "", quote: "" }));
  await decideBold(m);
  const checks = (m as any).seen?.filter?.((a: Ask) => JSON.stringify(a.schema ?? "").includes("quote")) ?? [];
  assert.ok(checks.length > 0);
  assert.ok(checks.every((a: Ask) => a.model === "claude-sonnet-5-5" && a.user.includes("A good response: good")));
});


const propose = () => goal({ merge_rule: { ...goal().merge_rule, mode: "propose" } });

test("propose mode opens the winning pull request with its evidence and leaves the merge to a person", async () => {
  const repo = new MemoryRepo("Old prompt.");
  const r = await runDecide(propose(), repo, win());
  assert.equal(r?.outcome, "proposed");
  assert.equal(repo.merges.length, 0);
  assert.equal(repo.files.get("prompt.md"), "Old prompt.");
  assert.equal(repo.state.lastMerge, null);
  assert.match(repo.prs[0].body, /Merge it to keep the change, or close it to decline/);
  assert.match(repo.issue, /waiting for review\. Synthe proposed #1/);
});

test("while a proposal waits, nothing is scored, spent or proposed again", async () => {
  const repo = new MemoryRepo("Old prompt.");
  await runDecide(propose(), repo, win());
  const spent = repo.state.spendUsd;
  assert.equal(await runDecide(propose(), repo, { candidates: null, scores: null, costUsd: null }), null);
  assert.equal(await runDecide(propose(), repo, win()), null);
  assert.equal(repo.prs.length, 1);
  assert.equal(repo.state.spendUsd, spent);
  assert.equal(repo.state.rounds.length, 1);
});

test("a proposal merged by a person is tracked like a merge, so the revert check protects it", async () => {
  const repo = new MemoryRepo("Old prompt.");
  await runDecide(propose(), repo, win());
  repo.prs[0].merged = true;
  repo.files.set("prompt.md", "Better prompt.");
  assert.equal(await runDecide(propose(), repo, { candidates: null, scores: null, costUsd: null }), null);
  assert.equal(repo.state.proposal, null);
  assert.equal(repo.state.rounds[0].outcome, "merged");
  assert.equal((repo.state.lastMerge as any)?.mergedHash, sha256("Better prompt."));
  assert.equal(repo.state.rounds.length, 1); // settling isn't a round
  const next = scored("Better prompt.", 50, 50, 50, 50);
  next.prior = [...trainRows(90), ...heldRows(90)];
  assert.equal((await runDecide(propose(), repo, round(next)))?.outcome, "proposed"); // a revert is proposed too
});

test("a proposal closed without merging is recorded as declined, and rounds go on", async () => {
  const repo = new MemoryRepo("Old prompt.");
  await runDecide(propose(), repo, win());
  repo.prs[0].closed = true;
  await runDecide(propose(), repo, { candidates: null, scores: null, costUsd: null });
  assert.equal(repo.state.rounds[0].outcome, "declined");
  assert.equal(repo.state.proposal, null);
  assert.equal((await runDecide(propose(), repo, win()))?.outcome, "proposed");
});

test("a proposal opened just before a crash is kept open for review, not closed", async () => {
  const repo = new MemoryRepo("Old prompt.");
  repo.crashOn = "upsertIssue";
  await assert.rejects(runDecide(propose(), repo, win()));
  await runDecide(propose(), repo, { candidates: null, scores: null, costUsd: null });
  assert.equal(repo.prs[0].closed, false);
  assert.equal(repo.state.proposal?.pr, 1);
  assert.equal(repo.state.rounds[0].outcome, "proposed");
});

test("the goal file rejects an unknown merge mode", async () => {
  const { parseGoal } = await import("../src/core/goal.ts");
  const base = { version: 1, prompt: { kind: "file", path: "p.md" }, objective: "x", scenarios: "s", budget: { max_usd: 1 } };
  assert.equal(parseGoal(JSON.stringify(base)).merge_rule.mode, "auto");
  assert.equal(parseGoal(JSON.stringify({ ...base, merge_rule: { mode: "propose" } })).merge_rule.mode, "propose");
  assert.throws(() => parseGoal(JSON.stringify({ ...base, merge_rule: { mode: "yolo" } })), /auto or propose/);
});
