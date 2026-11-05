import assert from "node:assert/strict";
import { test } from "node:test";
import { explainNoise, measureNoise } from "../src/loop/score.ts";
import { applyEdits, runWrite } from "../src/loop/write.ts";
import { newState } from "../src/core/state.ts";
import { sha256 } from "../src/core/safety.ts";
import type { Ask, Model } from "../src/model/client.ts";
import { goal, scenarios as sharedScenarios } from "./helpers.ts";

const scenarios = sharedScenarios.map((scenario) => ({ ...scenario, input: `${scenario.input} ${scenario.id}` }));
const trainCount = scenarios.filter((scenario) => scenario.split === "train").length;
const check = "Uses a short answer";
const guard = "Keeps every requested fact";

function blindModel(options: { identical?: boolean; positionBias?: boolean; unknown?: boolean; guardsUnknown?: boolean; variableMarks?: boolean } = {}) {
  const asks: Ask[] = [];
  const replies = new Map<string, number>();
  const marks = new Map<string, number>();
  const model: Model = { async ask(ask) {
    asks.push(ask);
    if (!ask.schema) {
      const count = replies.get(ask.user) ?? 0;
      replies.set(ask.user, count + 1);
      return { text: options.identical ? "Same answer" : count === 0 ? "Plain answer" : "Other answer", costUsd: 0.001 };
    }
    if (JSON.stringify(ask.schema).includes('"results"')) {
      const isGuard = ask.user.includes(guard);
      const count = marks.get(ask.user) ?? 0;
      marks.set(ask.user, count + 1);
      if (options.unknown || (isGuard && options.guardsUnknown)) return { text: "unreadable", costUsd: 0.002 };
      return { text: JSON.stringify({ results: [{ check: 1, applies: true, passes: !options.variableMarks || count % 2 === 0 }] }), costUsd: 0.002 };
    }
    if (options.unknown) return { text: null, costUsd: 0.003 };
    const better = options.positionBias ? "A" : /<reply_a>\nOther answer/.test(ask.user) ? "A" : "B";
    return { text: JSON.stringify({ better, a_guardrail_ok: true, b_guardrail_ok: true }), costUsd: 0.003 };
  } };
  return { model, asks };
}

test("noise swaps distinct replies to detect blind position bias without calling it a tie", async () => {
  const { model, asks } = blindModel({ positionBias: true });
  const noise = await measureNoise(goal(), "One prompt", scenarios, model);
  assert.equal(noise.wins, null);
  assert.equal(noise.p, null);
  assert.equal(noise.ties, 0);
  assert.match(explainNoise(noise).join(" "), /inconclusive.*reply-order disagreement/);
  assert.equal(asks.filter((ask) => ask.schema).length, trainCount * 2);
  assert.ok(asks.every((ask) => !ask.user.includes("HOLDOUT-SECRET")));
  for (const ask of asks.filter((ask) => ask.schema)) assert.doesNotMatch(ask.user, /One prompt|challenger|baseline|first sample|second sample/);
  assert.ok(Math.abs(noise.costUsd! - trainCount * 0.008) < 1e-9);
});

test("noise never asks a blind duel judge to invent differences in identical replies", async () => {
  const { model, asks } = blindModel({ identical: true, positionBias: true });
  const noise = await measureNoise(goal(), "One prompt", scenarios, model);
  assert.deepEqual([noise.wins, noise.losses, noise.ties], [0, 0, trainCount]);
  assert.equal(asks.filter((ask) => ask.schema).length, 0);
  assert.match(explainNoise(noise).join(" "), /one sample.*not proof/);
});

test("noise marks identical replies independently instead of sharing cached check and guard verdicts", async () => {
  const { model, asks } = blindModel({ identical: true, variableMarks: true });
  const noise = await measureNoise(goal({ checks: [check], counter_checks: [guard] }), "One prompt", scenarios, model);
  assert.deepEqual([noise.wins, noise.losses], [trainCount, 0]);
  assert.deepEqual(noise.guards, { before: 0, after: 100, spread: 100, margin: 100 });
  assert.equal(asks.filter((ask) => ask.schema).length, trainCount * 4);
  assert.match(explainNoise(noise).join(" "), /spread: 100.00.*no setting was changed.*does not establish the impact or cost gate/);
  assert.ok(Math.abs(noise.costUsd! - trainCount * 0.010) < 1e-9);
});

test("noise reports unknown guards and too few samples honestly with fallback 3", async () => {
  for (const subset of [scenarios, scenarios.slice(0, 2)]) {
    const { model } = blindModel({ identical: true, guardsUnknown: true });
    const noise = await measureNoise(goal({ counter_checks: [guard] }), "One prompt", subset, model);
    assert.equal(noise.guards!.spread, null);
    assert.equal(noise.guards!.margin, 3);
    assert.match(explainNoise(noise).join(" "), /Guard noise is inconclusive.*fallback guard_margin of 3/);
  }
  const small = await measureNoise(goal({ counter_checks: [guard] }), "One prompt", scenarios.slice(0, 2), blindModel({ identical: true }).model);
  assert.equal(small.guards!.before, 100);
  assert.equal(small.guards!.spread, null);
  assert.equal(small.guards!.margin, 3);
  assert.match(explainNoise(small).join(" "), /too few training cases/);
});

test("missing check marks keep noise inconclusive even when the duel would agree", async () => {
  const { model } = blindModel({ identical: true, unknown: true });
  const noise = await measureNoise(goal({ checks: [check] }), "One prompt", scenarios, model);
  assert.equal(noise.wins, null);
  assert.match(explainNoise(noise).join(" "), /inconclusive/);
});

test("noise probability treats a lean in either direction equally", async () => {
  const { model } = blindModel();
  const noise = await measureNoise(goal(), "One prompt", scenarios, model);
  assert.equal(noise.wins, trainCount);
  assert.equal(noise.losses, 0);
  assert.equal(noise.p, 2 / 2 ** trainCount);
});

test("writer receives no guards, attacks, evidence, hidden cases or protected history", async () => {
  const state = newState();
  state.rounds.push({ round: 1, outcome: "skipped", reasons: ["GUARD-PRIVATE ATTACK-PRIVATE EVIDENCE-PRIVATE"], costUsd: 0, at: "2026-11-04" });
  state.lessons = { promptHash: sha256("Base"), rows: [{ id: "b", reply: "HIDDEN-LESSON", violation: true }] };
  const asks: Ask[] = [];
  await runWrite(goal({ counter_checks: ["GUARD-PRIVATE"] }), state, "Base", scenarios, { async ask(ask) {
    asks.push(ask);
    return { text: JSON.stringify({ edits: [{ find: "", replace: "Be helpful." }], summary: "Help", title: "help" }), costUsd: 0 };
  } });
  assert.equal(asks.length, 2);
  for (const ask of asks) assert.doesNotMatch(ask.user, /GUARD-PRIVATE|ATTACK-PRIVATE|EVIDENCE-PRIVATE|HOLDOUT-SECRET|HIDDEN-LESSON/);
  for (const phrase of ["counter_checks", "counter-checks", "guard checks", "attack cases", "evidence files"]) {
    assert.ok("problem" in applyEdits("Be kind.", [{ find: "", replace: `Use the ${phrase} to pass.` }]), phrase);
    assert.ok("text" in applyEdits(`Explain ${phrase}.`, [{ find: "", replace: `Discuss ${phrase} clearly.` }]), phrase);
  }
});

test("writer cannot read a guard config, attacks, evidence or scenarios disguised as its prompt", async () => {
  for (const path of ["synthe.json", ".synthe/attacks.jsonl", ".synthe/evidence/prompt.md", "s.jsonl"]) {
    let calls = 0;
    const result = await runWrite(goal({ prompt: { kind: "file", path } }), newState(), "PRIVATE-FILE", scenarios, {
      async ask() { calls++; throw new Error("must not be called"); },
    });
    assert.equal(calls, 0, path);
    assert.equal(result.candidates.length, 0);
    assert.equal(result.costUsd, 0);
  }
});
