import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256 } from "../src/core/safety.ts";
import { runDecide } from "../src/loop/decide.ts";
import { measureNoise, runScore } from "../src/loop/score.ts";
import { runWrite } from "../src/loop/write.ts";
import { newState } from "../src/core/state.ts";
import type { Ask, Model } from "../src/model/client.ts";
import { MemoryRepo, goal, rows, scenarios, scored } from "./helpers.ts";

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
  assert.match(repo.issue, /\| 50\.0 to 55\.0 \| 20 \/ 0 \|/);
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
  const r = await runDecide(goal(), repo, round(scored("Teammate's edit.", 30, 30, 30, 30)));
  assert.notEqual(r?.outcome, "reverted");
  assert.equal(repo.files.get("prompt.md"), "Teammate's edit.");
});

test("merge then slump reverts to the prior prompt", async () => {
  const repo = new MemoryRepo("Old prompt.");
  await runDecide(goal(), repo, round(scored("Old prompt.", 50, 50, 60, 55)));
  const r = await runDecide(goal(), repo, round(scored("Better prompt.", 40, 40, 41, 41)));
  assert.equal(r?.outcome, "reverted");
  assert.equal(repo.files.get("prompt.md"), "Old prompt.");
  assert.equal(repo.state.lastMerge?.reverted, true);
});

test("blocked merges close the PR and explain the fix", async () => {
  const repo = new MemoryRepo("Old prompt.");
  repo.mergeResult = { merged: false, why: "405", blocked: true };
  const r = await runDecide(goal(), repo, round(scored("Old prompt.", 50, 50, 60, 55)));
  assert.equal(r?.outcome, "skipped");
  assert.equal(repo.prs[0].closed, true);
  assert.match(repo.state.stopped!, /blocks automatic merges/);
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
        const score = a.user.includes("good reply") ? 90 : 50;
        return { text: over.judge !== undefined ? over.judge : JSON.stringify({ score, guardrail_ok: true }), costUsd: 0.001 };
      }
      if (a.schema) return { text: JSON.stringify({ prompt: "Improved." }), costUsd: 0.01 };
      return { text: a.system === "Improved." ? "good reply" : "weak reply", costUsd: 0.001 };
    },
  };
};

test("the writer never sees held-back scenarios", async () => {
  const m = fake();
  const out = await runWrite(goal(), newState(), "Old", scenarios, m);
  assert.equal(out.candidates.length, 3);
  assert.ok(m.seen.every((a) => !a.user.includes("HOLDOUT-SECRET")));
  assert.ok(Math.abs(out.costUsd! - 0.03) < 1e-9);
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
  assert.equal(noise.points, 0);
  assert.ok(noise.costUsd! > 0);
});

test("a judge that fails or lies about its range yields unknown", async () => {
  for (const judge of [null, "not json", '{"score":900,"guardrail_ok":true}']) {
    const { scores } = await runScore(goal(), "Old", candidates, scenarios, fake({ judge }));
    assert.equal(scores.baselineTrain[0].score, null);
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
  assert.match(repo.issue, /\*\*Status:\*\* finished\. Merged 1 improvement\. Held-back score went from 50\.0 to 55\.0\./);
  assert.match(repo.issue, /add harder scenarios to `s\.jsonl`/);
});

test("failed rounds read as stopped, not finished", async () => {
  const repo = new MemoryRepo("Old prompt.");
  for (let i = 0; i < 3; i++) await runDecide(goal(), repo, { candidates: null, scores: null, costUsd: null });
  assert.match(repo.issue, /\*\*Status:\*\* stopped: the last 3 rounds failed/);
  assert.doesNotMatch(repo.issue, /finished/);
});

test("a blocked repo reads as stopped", async () => {
  const repo = new MemoryRepo("Old prompt.");
  repo.mergeResult = { merged: false, why: "405", blocked: true };
  await runDecide(goal(), repo, round(scored("Old prompt.", 50, 50, 60, 55)));
  assert.match(repo.issue, /\*\*Status:\*\* stopped: this repo blocks/);
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
  repo.mergeResult = { merged: false, why: "405", blocked: true };
  await runDecide(goal(), repo, round(scored("Old prompt.", 50, 50, 60, 55)));
  repo.mergeResult = { merged: true };
  repo.files.set("s.jsonl", "harder");
  assert.equal(await runDecide(goal(), repo, round(scored("Old prompt.", 50, 50, 60, 55))), null);
});
