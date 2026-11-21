// GOAL-2.md: a drafted rubric is used in solve through "compare": "model" with "rubric" in measure.judge. The model
// judge reads the rubric; no command gets a key; a proposal cannot change the rubric.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Ask, Model, Reply } from "../src/model/client.ts";
import { measurePathsOf } from "../src/solve/edits.ts";
import { SetupError } from "../src/solve/loop.ts";
import { modelCompare } from "../src/solve/model-compare.ts";
import { validateProblem } from "../src/solve/problem.ts";
import { isJudged, type Problem } from "../src/solve/types.ts";

function folder() {
  const dir = mkdtempSync(join(tmpdir(), "synthe-rubric-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "cases.jsonl"), '{"id":"1","input":"hi"}\n');
  writeFileSync(join(dir, "rubric.md"), "# Rubric\n\n1. RUBRIC-TOKEN: the reply names the next step.\n");
  return dir;
}

const judged = (judge: Record<string, unknown>) => ({
  version: 1, name: "r", goal: "Better replies.", artifact: ["prompt.md"], proposer: "model",
  model: { provider: "anthropic", model: "m-1" },
  measure: { judge: { cases: "cases.jsonl", run: "node run.js", ...judge } },
});

test("problem check: rubric with compare model is valid; with a command, missing or outside it is one line", () => {
  const dir = folder();
  const file = join(dir, "p.json");
  const ok = validateProblem(judged({ compare: "model", rubric: "rubric.md" }), file);
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.ok(isJudged(ok.problem.measure) && ok.problem.measure.judge.rubric === "rubric.md");
  for (const [judge, why] of [
    [{ compare: "node judge.js", rubric: "rubric.md" }, /works only with "compare": "model"/],
    [{ compare: "model", rubric: "missing.md" }, /can't find missing\.md/],
    [{ compare: "model", rubric: "../rubric.md" }, /uses "\.\."/],
    [{ compare: "model", rubric: 3 }, /must be the path of a rubric file/],
  ] as const) {
    const r = validateProblem(judged(judge), file);
    assert.equal(r.ok, false);
    if (!r.ok) { assert.equal(r.problems.length, 1, r.problems.join("\n")); assert.match(r.problems[0], /^measure\.judge\.rubric: /); assert.match(r.problems[0], why); }
  }
});

function fakeModel(): { model: Model; asks: Ask[] } {
  const asks: Ask[] = [];
  return { asks, model: { async ask(a: Ask): Promise<Reply> { asks.push(a); return { text: '{"winner": "a"}', costUsd: null, stopReason: "end_turn" }; } } };
}

test("the model judge sends the rubric with the goal, before the case and the outputs; a is before b", async () => {
  const dir = folder();
  const r = validateProblem(judged({ compare: "model", rubric: "rubric.md" }), join(dir, "p.json"));
  assert.ok(r.ok);
  if (!r.ok) return;
  const f = fakeModel();
  assert.equal(await modelCompare(r.problem, { SYNTHE_ANTHROPIC_KEY: "sk-ant-x" }, f.model)({ id: "1", input: "hi" }, "first", "second"), "a");
  const user = f.asks[0].user;
  assert.match(user, /RUBRIC-TOKEN/);
  assert.deepEqual(Object.keys(JSON.parse(user)), ["goal", "rubric", "case", "a", "b"]);
  assert.ok(user.indexOf('"a": "first"') < user.indexOf('"b": "second"'));
  assert.match(f.asks[0].system ?? "", /rubric/);

  // With no rubric, the request has no rubric key.
  const plain = validateProblem(judged({ compare: "model" }), join(dir, "p.json"));
  assert.ok(plain.ok);
  if (!plain.ok) return;
  const g = fakeModel();
  await modelCompare(plain.problem, { SYNTHE_ANTHROPIC_KEY: "sk-ant-x" }, g.model)({ id: "1", input: "hi" }, "x", "y");
  assert.deepEqual(Object.keys(JSON.parse(g.asks[0].user)), ["goal", "case", "a", "b"]);
});

test("a rubric that cannot be read stops setup before any model call; the rubric file is protected from edits", () => {
  const dir = folder();
  const r = validateProblem(judged({ compare: "model", rubric: "rubric.md" }), join(dir, "p.json"));
  assert.ok(r.ok);
  if (!r.ok) return;
  const gone: Problem = { ...r.problem, dir: join(dir, "elsewhere") };
  const f = fakeModel();
  assert.throws(() => modelCompare(gone, { SYNTHE_ANTHROPIC_KEY: "sk-ant-x" }, f.model), (e) => e instanceof SetupError && /rubric\.md/.test(e.message));
  assert.equal(f.asks.length, 0);
  assert.ok(measurePathsOf(r.problem).includes("rubric.md"));
});
