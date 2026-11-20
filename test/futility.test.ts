import assert from "node:assert/strict";
import { test } from "node:test";
import type { Scenario } from "../src/core/goal.ts";
import { judgeRound, mean, trainingProblem, type ScoreRow } from "../src/core/merge-rule.ts";
import { couldStillPass, inChunks } from "../src/loop/futility.ts";
import { explainScores, runScore } from "../src/loop/score.ts";
import { runDecide } from "../src/loop/decide.ts";
import type { Ask, Model } from "../src/model/client.ts";
import { goal, MemoryRepo } from "./helpers.ts";

// Futility stopping: a candidate stops being dueled once it could no longer pass training even by winning every
// case left. These tests count model calls with fake models; nothing reaches a real API.

const cases = (train: number, held = 4): Scenario[] => [
  ...Array.from({ length: train }, (_, i): Scenario => ({ id: `t${i}`, input: `q-t${i}`, expected: "good", split: "train" })),
  ...Array.from({ length: held }, (_, i): Scenario => ({ id: `h${i}`, input: `q-h${i}`, expected: "good", split: "holdout" })),
];

// The agent quotes its prompt; the judge looks up each prompt's result on the case in a table (missing: a tie with
// the current prompt). No usage is reported, like every fake Model, and that works.
function world(table: Record<string, (id: string) => "win" | "loss" | "tie">): Model & { seen: Ask[] } {
  const seen: Ask[] = [];
  return {
    seen,
    async ask(a) {
      seen.push(a);
      const schema = JSON.stringify(a.schema ?? {});
      if (schema.includes('"better"')) {
        const id = /Situation: q-(\w+)/.exec(a.user)![1];
        const who = (tag: string) => new RegExp(`<${tag}>\\n(\\S+) says`).exec(a.user)![1];
        const result = (p: string) => table[p]?.(id) ?? "tie";
        const [ra, rb] = [result(who("reply_a")), result(who("reply_b"))];
        // A prompt in the table plays against the current one, so its result decides; the other side is "Base".
        const aBetter = who("reply_a") !== "Base" ? ra === "win" : rb === "loss";
        const tie = (who("reply_a") !== "Base" ? ra : rb) === "tie";
        return { text: JSON.stringify({ better: tie ? "tie" : aBetter ? "A" : "B", a_guardrail_ok: true, b_guardrail_ok: true }), costUsd: 0.001 };
      }
      if (schema.includes('"breaks"')) return { text: JSON.stringify({ breaks: false, guardrail: "", quote: "" }), costUsd: 0.001 };
      return { text: `${a.system} says ${a.user}`, costUsd: 0.001 };
    },
  };
}
const duels = (m: { seen: Ask[] }, prompt: string) => m.seen.filter((a) => JSON.stringify(a.schema ?? {}).includes('"better"') && a.user.includes(`${prompt} says`)).length;
const replies = (m: { seen: Ask[] }, prompt: string) => m.seen.filter((a) => a.system === prompt).length;
const idx = (id: string) => Number(id.slice(1));

test("a candidate that loses early stops after the first chunk where it can no longer pass, and saves those calls", async () => {
  // On 24 cases: losing the first six still leaves 18-6 possible (p 0.011), so the loser stops after twelve. The
  // fader wins six, then loses: 18-6 is still possible after twelve cases, 12-12 is all that is left after eighteen.
  const m = world({ Loser: () => "loss", Fader: (id) => (idx(id) < 6 ? "win" : "loss") });
  const full = world({ Loser: () => "loss", Fader: (id) => (idx(id) < 6 ? "win" : "loss") });
  const set = cases(24);
  const cands = [{ id: "loser", text: "Loser" }, { id: "fader", text: "Fader" }];
  const stopped = await runScore(goal(), "Base", cands, set, m, null, () => 0.3);
  const everything = await runScore(goal(), "Base", cands, set, full, null, () => 0.3, [], null, null, false);

  const loser = stopped.scores.candidates.find((c) => c.id === "loser")!;
  const fader = stopped.scores.candidates.find((c) => c.id === "fader")!;
  assert.equal(loser.stoppedAfter, 12);
  assert.equal(fader.stoppedAfter, 18);
  assert.equal([replies(m, "Loser"), duels(m, "Loser")].join(), "12,12");
  assert.equal([replies(m, "Fader"), duels(m, "Fader")].join(), "18,18");
  assert.equal([replies(full, "Loser"), duels(full, "Loser"), replies(full, "Fader"), duels(full, "Fader")].join(), "24,24,24,24");
  // 24 current-prompt replies, plus each candidate's replies and duels: 24 + 24 + 36 = 84 calls instead of 120.
  assert.equal(stopped.calls, 84);
  assert.equal(everything.calls, 120);
  // Each could still have passed by winning the rest one chunk before it stopped, and could not when it stopped.
  const base = set.filter((s) => s.split === "train").map((s): ScoreRow => ({ id: s.id, score: 50, violation: null }));
  const train = set.filter((s) => s.split === "train");
  const lost = everything.scores.candidates.find((c) => c.id === "loser")!.train;
  assert.equal(couldStillPass("loser", lost.slice(0, 6), train.slice(6), base, goal()), true);
  assert.equal(couldStillPass("loser", lost.slice(0, 12), train.slice(12), base, goal()), false);
  const rows = everything.scores.candidates.find((c) => c.id === "fader")!.train;
  assert.equal(couldStillPass("fader", rows.slice(0, 12), train.slice(12), base, goal()), true);
  assert.equal(couldStillPass("fader", rows.slice(0, 18), train.slice(18), base, goal()), false);
  // The rows it did duel are exactly what full scoring found for those cases.
  assert.deepEqual(fader.train.slice(0, 18), rows.slice(0, 18));
});

test("rows a stopped candidate never dueled are unknown, never wins, and the round says why in a plain sentence", async () => {
  const m = world({ Fader: (id) => (idx(id) < 6 ? "win" : "loss") });
  const set = cases(24);
  const cands = [{ id: "fader", text: "Fader" }];
  const { scores, costUsd } = await runScore(goal(), "Base", cands, set, m, null, () => 0.3);
  const c = scores.candidates[0];
  assert.equal(c.stoppedAfter, 18);
  assert.ok(c.train.slice(18).every((r) => r.score === null && r.violation === null && r.reply === undefined));
  assert.equal(c.train.filter((r) => r.score === 100).length, 6);
  assert.equal(mean(c.train), null);
  assert.match(trainingProblem(c, scores.baselineTrain, goal())!, /stopped after 18 test cases, it could no longer pass/);
  const verdict = judgeRound(scores, goal(), null);
  assert.equal(verdict.action, "skip");
  assert.equal(verdict.notes.fader, "Stopped after 18 cases: it could no longer pass.");
  assert.ok(explainScores(scores, set).some((l) => l === "fader training: won 6, lost 12, tied 0, unknown 0; stopped after 18 of 24 cases: it could no longer pass"));

  const repo = new MemoryRepo("Base");
  const record = await runDecide(goal(), repo, { candidates: cands, scores, costUsd });
  assert.equal(record?.outcome, "skipped");
  assert.deepEqual(record?.tried, [{ summary: "A change to the prompt", outcome: "Stopped after 18 cases: it could no longer pass." }]);
  // Only real duels are counted, and the writer's lessons only quote cases the candidate really won.
  assert.deepEqual(record?.duels, { better: 6, worse: 12, same: 0 });
  const lessons = repo.state.lessons!.rows;
  assert.ok(lessons.length > 0 && lessons.every((l) => idx(l.id) < 6 && l.better !== undefined));
});

test("futility stopping gives the same verdict as full scoring, and never touches a candidate that could pass", async () => {
  // Seeded worlds of three candidates each, with a mix of strong, middling and weak ones.
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  let stoppedSome = 0, merged = 0;
  for (let w = 0; w < 40; w++) {
    const train = [6, 12, 18, 20, 30][w % 5];
    const set = cases(train);
    const table: Record<string, Record<string, "win" | "loss" | "tie">> = {};
    const cands = ["P", "Q", "R"].map((p) => {
      const skill = rand();
      table[p] = Object.fromEntries(set.map((s) => { const r = rand(); return [s.id.slice(0), r < skill * 0.8 ? "win" : r < skill * 0.8 + 0.15 ? "tie" : "loss"]; }));
      return { id: p.toLowerCase(), text: p };
    });
    const lookup = Object.fromEntries(Object.entries(table).map(([p, t]) => [p, (id: string) => t[id]]));
    const flip = rand();
    const a = await runScore(goal(), "Base", cands, set, world(lookup), null, () => flip);
    const b = await runScore(goal(), "Base", cands, set, world(lookup), null, () => flip, [], null, null, false);
    const strip = (v: ReturnType<typeof judgeRound>) => ({ ...v, reasons: undefined, notes: undefined });
    const va = judgeRound(a.scores, goal(), null), vb = judgeRound(b.scores, goal(), null);
    assert.deepEqual(strip(va), strip(vb), `world ${w}`);
    if (va.action === "merge") merged++;
    for (const full of b.scores.candidates) {
      const early = a.scores.candidates.find((c) => c.id === full.id)!;
      if (early.stoppedAfter !== undefined) stoppedSome++;
      if (trainingProblem(full, b.scores.baselineTrain, goal()) === null) {
        assert.equal(early.stoppedAfter, undefined, `world ${w}: ${full.id} could pass, so it must not stop`);
        assert.deepEqual(early, full, `world ${w}: ${full.id} is scored exactly as before`);
      } else {
        assert.notEqual(trainingProblem(early, a.scores.baselineTrain, goal()), null);
      }
    }
    assert.ok(a.calls <= b.calls);
  }
  // The worlds exercise both paths.
  assert.ok(stoppedSome > 0 && merged > 0, `stopped ${stoppedSome}, merged ${merged}`);
});

test("with compose on, the writer's candidates are scored in full, since compose reads every training row", async () => {
  const m = world({ Loser: () => "loss" });
  const { scores } = await runScore(goal({ compose: true }), "Base", [{ id: "loser", text: "Loser" }], cases(24), m, null, () => 0.3);
  assert.equal(scores.candidates[0].stoppedAfter, undefined);
  assert.equal(duels(m, "Loser"), 24);
});

test("chunks run in order, stop between chunks, and must be even to keep the reply order balanced", async () => {
  const ran: number[] = [];
  const done = await inChunks([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => { ran.push(n); return n; }, (d) => d.length < 8);
  assert.deepEqual(done, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(ran, [0, 1, 2, 3, 4, 5, 6, 7]);
  // The last chunk is never followed by a check that could cut it short.
  assert.deepEqual(await inChunks([0, 1, 2], 2, async (n) => n, () => false), [0, 1]);
  await assert.rejects(inChunks([1, 2, 3], 3, async (n) => n, () => true), /even/);
});
