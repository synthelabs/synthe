import { test } from "node:test";
import assert from "node:assert/strict";
import { runLoop, SetupError, type LoopSteps } from "../src/solve/loop.ts";
import type { Attempt, Proposal } from "../src/solve/types.ts";

// A fake world: the "file" is one number; a proposal's summary is "+N" or "-N"; higher is better.
function world(rounds: Proposal[][] | ((round: number, history: Attempt[]) => Proposal[]), opts: { guardFails?: (v: number) => boolean } = {}) {
  let kept = 10, live = 10;
  const log: string[] = [];
  const recorded: Attempt[] = [];
  const seen: { round: number; history: Attempt[]; candidates: number }[] = [];
  const steps: LoopSteps = {
    async propose(round, history, candidates) {
      seen.push({ round, history, candidates });
      const list = typeof rounds === "function" ? rounds(round, history) : rounds[round - 1] ?? [];
      return { ok: true, proposals: list };
    },
    async reset() { live = kept; },
    async apply(p) {
      if (p.summary === "bad") return { ok: false, reason: "The search text does not match in a.txt." };
      live += Number(p.summary);
      return { ok: true };
    },
    async guards() { return opts.guardFails?.(live) ? { ok: false, reason: "The guard `check` failed." } : { ok: true }; },
    async measure() { return { ok: true, value: live }; },
    decide(base, cand) {
      const gain = cand.value - base.value;
      return { keep: gain > 0, reason: gain > 0 ? `Up by ${gain}.` : "No gain.", strength: gain };
    },
    async keep(p) { kept = live; log.push(`keep ${p.summary}`); },
    record(a) { recorded.push(a); },
  };
  return { steps, log, recorded, seen, kept: () => kept };
}

test("keeps gains, refuses losses, stops when the proposer has nothing more", async () => {
  const w = world([[{ summary: "+2", edits: [] }], [{ summary: "-1", edits: [] }], [{ summary: "+3", edits: [] }]]);
  const r = await runLoop(w.steps, { maxRounds: 6 });
  assert.equal(r.baseline, 10);
  assert.equal(r.final, 15);
  assert.equal(r.stopped, "The proposer had nothing more to try.");
  assert.deepEqual(r.attempts.map((a) => [a.round, a.kept]), [[1, true], [2, false], [3, true]]);
  assert.deepEqual(r.attempts[1], { round: 2, summary: "-1", kept: false, reason: "No gain.", before: 12, after: 11 });
  assert.equal(w.recorded.length, 3);
  assert.equal(w.seen[2].history.length, 2);
});

test("stops at max_rounds and after 3 rounds that keep nothing", async () => {
  const always = (s: string) => () => [{ summary: s, edits: [] }];
  const a = await runLoop(world(always("+1")).steps, { maxRounds: 4 });
  assert.equal(a.rounds, 4);
  assert.match(a.stopped, /round limit \(4 rounds\)/);
  const b = await runLoop(world(always("-1")).steps, { maxRounds: 10 });
  assert.equal(b.rounds, 3);
  assert.equal(b.stopped, "3 rounds in a row kept nothing.");
});

test("stops at max_calls", async () => {
  const w = world(() => [{ summary: "+1", edits: [] }]);
  let calls = 0;
  const propose = w.steps.propose;
  w.steps.propose = (...args) => { calls += 2; return propose(...args); };
  w.steps.calls = () => calls;
  const r = await runLoop(w.steps, { maxRounds: 10, maxCalls: 5 });
  assert.equal(r.rounds, 3);
  assert.equal(r.stopped, "Reached the model call limit (5 calls).");
});

test("a failed proposal, a bad edit and a failing guard are attempts with reasons, not crashes", async () => {
  const w = world([[{ summary: "bad", edits: [] }], [{ summary: "+5", edits: [] }], [{ summary: "+1", edits: [] }]], { guardFails: (v) => v === 15 });
  w.steps.propose = async (round) => round === 3 ? { ok: false, reason: "The reply is not valid JSON." } : { ok: true, proposals: round === 1 ? [{ summary: "bad", edits: [] }] : [{ summary: "+5", edits: [] }] };
  const r = await runLoop(w.steps, { maxRounds: 3 });
  assert.deepEqual(r.attempts.map((a) => a.reason), [
    "The search text does not match in a.txt.",
    "The guard `check` failed.",
    "The proposal failed: The reply is not valid JSON.",
  ]);
  assert.equal(r.final, 10);
  assert.equal(r.attempts.some((a) => a.kept), false);
});

test("a guard that fails at the start is a setup error", async () => {
  const w = world([], { guardFails: () => true });
  await assert.rejects(runLoop(w.steps, { maxRounds: 3 }), SetupError);
});

test("several candidates: each is measured, the strongest passing one is kept", async () => {
  const w = world([[{ summary: "+1", edits: [] }, { summary: "+4", edits: [] }, { summary: "-2", edits: [] }]]);
  const r = await runLoop(w.steps, { maxRounds: 1, candidates: 3 });
  assert.equal(w.seen[0].candidates, 3);
  assert.deepEqual(r.attempts.map((a) => [a.summary, a.kept, a.after]), [["+1", false, 11], ["+4", true, 14], ["-2", false, 8]]);
  assert.match(r.attempts[0].reason, /stronger change in the same round/);
  assert.deepEqual(w.log, ["keep +4"]);
  assert.equal(r.final, 14);
});

test("earlier history goes to the proposer", async () => {
  const w = world([[{ summary: "+1", edits: [] }]]);
  const old: Attempt = { round: 1, summary: "old", kept: false, reason: "No gain." };
  await runLoop(w.steps, { maxRounds: 1, history: [old] });
  assert.deepEqual(w.seen[0].history, [old]);
});
