import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ask, Model, Reply } from "../src/model/client.ts";
import { judgeOutputs } from "../src/solve/judge.ts";
import { SetupError } from "../src/solve/loop.ts";
import { modelCompare, winnerIn } from "../src/solve/model-compare.ts";
import type { Problem } from "../src/solve/types.ts";

const KEY = "sk-compare-secret";
const problem = (model = { base_url: "http://127.0.0.1:1/v1", model: "judge-1" }): Problem => ({
  version: 1, name: "p", goal: "Answer politely.", artifact: ["a.txt"], protect: [],
  measure: { judge: { cases: "cases.jsonl", run: "node run.js", compare: "model" }, runs: 1 }, guards: [], split: { holdout: false },
  proposer: { command: "true" }, budget: { max_rounds: 6, max_calls: null }, model, candidates: 1, dir: "/tmp", file: "/tmp/p.json",
});

// A fake model: `answer` sees each request and returns the reply text.
function fake(answer: (a: Ask) => string | null | Error): { model: Model; asks: Ask[] } {
  const asks: Ask[] = [];
  return {
    asks,
    model: {
      async ask(a: Ask): Promise<Reply> {
        asks.push(a);
        const r = answer(a);
        if (r instanceof Error) throw r;
        return { text: r, costUsd: null, stopReason: r === null ? "length" : "stop" };
      },
    },
  };
}

const c = { id: "1", input: "hello" };

test("the model judge sends the goal, the case and both outputs, and reads the winner", async () => {
  const f = fake(() => '{"winner": "b"}');
  const compare = modelCompare(problem(), { SYNTHE_API_KEY: KEY }, f.model);
  assert.equal(await compare(c, "hi", "Hello, how can I help?"), "b");
  const sent = JSON.parse(f.asks[0].user);
  assert.deepEqual(sent, { goal: "Answer politely.", case: c, a: "hi", b: "Hello, how can I help?" });
  assert.equal(f.asks[0].model, "judge-1");
  assert.ok(f.asks[0].schema);
});

test("a bad or missing answer is a failed comparison with a reason, and the key never shows", async () => {
  const cases: [string | null | Error, RegExp][] = [
    ["I like b more.", /did not answer/],
    ['{"winner": "c"}', /did not answer/],
    [null, /cut off/],
    [new Error(`401 bad key ${KEY}`), /request failed/],
  ];
  for (const [reply, why] of cases) {
    const compare = modelCompare(problem(), { SYNTHE_API_KEY: KEY }, fake(() => reply).model);
    const r = await compare(c, "x", "y");
    assert.ok(typeof r === "object" && "failed" in r, String(reply));
    assert.match(r.failed, why);
    assert.ok(!r.failed.includes(KEY));
  }
});

test("winnerIn reads a winner with text around it", () => {
  assert.equal(winnerIn('Thinking...\n{"winner": "tie"}'), "tie");
  assert.equal(winnerIn('{"winner":"a"}'), "a");
  assert.equal(winnerIn("b"), null);
});

test("a model judge that always picks the first position cannot win a change", async () => {
  const cases = Array.from({ length: 12 }, (_, i) => ({ id: String(i), input: i }));
  const kept = Object.fromEntries(cases.map((x) => [x.id, "same"]));
  const cand = Object.fromEntries(cases.map((x) => [x.id, "other"]));
  const compare = modelCompare(problem(), { SYNTHE_API_KEY: KEY }, fake(() => '{"winner": "a"}').model);
  const d = await judgeOutputs(cases, kept, cand, compare);
  assert.equal(d.keep, false);
  assert.equal(d.calls, 24);
});

test("a model judge that truly prefers the change keeps it", async () => {
  const cases = Array.from({ length: 12 }, (_, i) => ({ id: String(i), input: i }));
  const kept = Object.fromEntries(cases.map((x) => [x.id, "bad"]));
  const cand = Object.fromEntries(cases.map((x) => [x.id, "goo"]));
  const compare = modelCompare(problem(), { SYNTHE_API_KEY: KEY }, fake((a) => {
    const { a: first } = JSON.parse(a.user) as { a: string };
    return JSON.stringify({ winner: first.startsWith("goo") ? "a" : "b" });
  }).model);
  const d = await judgeOutputs(cases, kept, cand, compare);
  assert.equal(d.keep, true, d.reason);
});

test("no key or no model is a SetupError before any call", () => {
  assert.throws(() => modelCompare(problem(), {}), (e) => e instanceof SetupError && /SYNTHE_API_KEY/.test(e.message));
  assert.throws(() => modelCompare(problem({ base_url: "http://127.0.0.1:1/v1", model: "" }), { SYNTHE_API_KEY: KEY }), SetupError);
});
