import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { judgeCandidate, judgeOutputs, padTo, parseWinner, readCases, signTestP, type Compare, type JudgeCase, type Outputs } from "../src/solve/judge.ts";
import type { Problem } from "../src/solve/types.ts";

const cases: JudgeCase[] = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, input: `question ${i}` }));
const outputs = (f: (i: number) => string): Outputs => Object.fromEntries(cases.map((c, i) => [c.id, f(i)]));
const kept = outputs((i) => `Answer ${i}.`);

// A judge that truly prefers outputs that say "because"; ties otherwise.
const truthful: Compare = async (_c, a, b) => {
  const ga = a.includes("because"), gb = b.includes("because");
  return ga === gb ? "tie" : ga ? "a" : "b";
};
// Always picks the first output.
const firstPosition: Compare = async () => "a";
// Always picks the longer output.
const longer: Compare = async (_c, a, b) => (a.length === b.length ? "tie" : a.length > b.length ? "a" : "b");
// Picks the output that says "because"; if both or neither do, picks the longer one.
const truthfulButLong: Compare = async (c, a, b) => {
  const t = await truthful(c, a, b);
  return t !== "tie" ? t : longer(c, a, b);
};

test("a change the judge truly prefers is kept, and every comparison is asked in both orders", async () => {
  const seen: [string, string][] = [];
  const spy: Compare = async (c, a, b) => { seen.push([a, b]); return truthful(c, a, b); };
  const cand = outputs((i) => `Answer ${i}, because of the rule.`);
  const d = await judgeOutputs(cases, kept, cand, spy);
  assert.equal(d.keep, true, d.reason);
  assert.equal(d.raw?.wins, 10);
  assert.ok(d.share > 0.9);
  // Each case asked as (kept, cand) and (cand, kept).
  for (let i = 0; i < 10; i++) {
    assert.ok(seen.some(([a, b]) => a === kept[`c${i}`] && b === cand[`c${i}`]));
    assert.ok(seen.some(([a, b]) => a === cand[`c${i}`] && b === kept[`c${i}`]));
  }
});

test("a win that comes only from the judge's position bias is refused", async () => {
  const cand = outputs((i) => `Answer ${i} again.`);
  const d = await judgeOutputs(cases, kept, cand, firstPosition);
  assert.equal(d.keep, false);
  assert.match(d.reason, /position/);
  assert.equal(d.raw?.splits, 10);
});

test("a win that comes only from longer output is refused, and the reason says so", async () => {
  const padded = outputs((i) => `Answer ${i}. This answer is now much longer, with more words that add nothing at all.`);
  const letters = (s: string) => (s.match(/[a-z]/gi) ?? []).length;
  const by = (n: (s: string) => number): Compare => async (_c, a, b) => (n(a) === n(b) ? "tie" : n(a) > n(b) ? "a" : "b");
  for (const judge of [longer, truthfulButLong, by(letters)]) {
    const d = await judgeOutputs(cases, kept, padded, judge);
    assert.equal(d.keep, false);
    assert.match(d.reason, /same length/);
    assert.match(d.reason, /longer output/);
  }
});

test("a real gain that is also longer is still kept by a judge with a length bias", async () => {
  const cand = outputs((i) => `Answer ${i}, because of the rule, which is explained here at length.`);
  const d = await judgeOutputs(cases, kept, cand, truthfulButLong);
  assert.equal(d.keep, true, d.reason);
});

test("a no-op, a loss and a too-small win are refused", async () => {
  assert.equal((await judgeOutputs(cases, kept, kept, truthfulButLong)).keep, false);
  const worse = await judgeOutputs(cases, outputs((i) => `A ${i} because.`), kept, truthful);
  assert.equal(worse.keep, false);
  assert.equal(worse.raw?.losses, 10);
  // Wins 2 cases, ties the rest: not enough evidence.
  const two = await judgeOutputs(cases, kept, outputs((i) => (i < 2 ? `Answer ${i} because.` : `Answer ${i}.`)), truthful);
  assert.equal(two.keep, false);
  assert.match(two.reason, /did not clearly prefer/);
});

test("a failing judge becomes a reason, not a crash", async () => {
  const broken: Compare = async () => ({ failed: "no answer" });
  const d = await judgeOutputs(cases, kept, kept, broken);
  assert.equal(d.keep, false);
  assert.match(d.reason, /judge failed: no answer/);
});

test("helpers: sign test, padding and the judge's reply", () => {
  assert.equal(signTestP(0, 0), 1);
  assert.ok(Math.abs(signTestP(5, 0) - 1 / 32) < 1e-12);
  assert.ok(Math.abs(signTestP(8, 2) - 56 / 1024) < 1e-12);
  assert.equal(padTo("abc", 10).length, 10);
  assert.equal(padTo("ab", 4), "ab l");
  assert.equal(padTo("abc", 9), "abc lorem");
  assert.ok(!/\s$/.test(padTo("x", 7)), "the filler never ends in white space");
  assert.equal(padTo("abcdef", 4), "abcdef");
  assert.equal(padTo("ab", 3), "ab.");
  assert.equal(parseWinner('log line\n{"winner": "b"}\n'), "b");
  assert.equal(parseWinner('{"winner":"x"}'), null);
});

test("judgeCandidate runs the real commands in each checkout", async () => {
  const root = mkdtempSync(join(tmpdir(), "solve-judge-"));
  const make = (name: string, style: string) => {
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(join(dir, "style.txt"), style);
    writeFileSync(join(dir, "cases.jsonl"), cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
    writeFileSync(join(dir, "run.mjs"), `import {readFileSync} from "node:fs"; const c = JSON.parse(readFileSync(0, "utf8")); console.log("Answer " + c.id + readFileSync("style.txt", "utf8"));`);
    writeFileSync(join(dir, "judge.mjs"), `import {readFileSync} from "node:fs"; const q = JSON.parse(readFileSync(0, "utf8")); const g = (s) => s.includes("because"); console.log(JSON.stringify({winner: g(q.a) === g(q.b) ? "tie" : g(q.a) ? "a" : "b"}));`);
    return dir;
  };
  const a = make("kept", ".");
  const b = make("cand", ", because of the rule.");
  const problem = { measure: { judge: { cases: "cases.jsonl", run: "node run.mjs", compare: "node judge.mjs" }, runs: 1 } } as unknown as Problem;
  const d = await judgeCandidate(a, b, problem);
  assert.equal(d.keep, true, d.reason);
  assert.equal(d.calls, 40); // 10 cases, 2 orders, raw and length-matched
  const back = await judgeCandidate(b, a, problem);
  assert.equal(back.keep, false);

  writeFileSync(join(a, "cases.jsonl"), '{"id":1}\n');
  assert.match((readCases(a, "cases.jsonl") as { failed: string }).failed, /needs an "id" and an "input"/);
  const bad = { measure: { judge: { cases: "cases.jsonl", run: "node run.mjs", compare: "echo nope" }, runs: 1 } } as unknown as Problem;
  writeFileSync(join(a, "cases.jsonl"), cases.map((c) => JSON.stringify(c)).join("\n"));
  assert.match((await judgeCandidate(a, b, bad)).reason, /did not print \{"winner"/);
});
