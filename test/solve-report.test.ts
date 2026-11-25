import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { renderReport, writeReport } from "../src/solve/report.ts";
import type { SolveResult } from "../src/solve/types.ts";

const result: SolveResult = {
  problem: "demo",
  stopped: "the proposer had nothing more to try",
  baseline: 10,
  final: 12.5,
  branch: "synthe/solve-demo-1",
  attempts: [
    { round: 1, summary: "Raise x", kept: true, reason: "better on every run", before: 10, after: 12.5 },
    { round: 2, summary: "Edit a | b\nsecond line", kept: false, reason: "the guard `pytest -q` failed", before: 12.5 },
  ],
};

test("result.json has the contract fields in order; report.md names each attempt and reason", () => {
  const out = join(mkdtempSync(join(tmpdir(), "solve-report-")), "nested", "out");
  const paths = writeReport(out, result, { unit: "points", direction: "higher", goal: "Raise the score." });
  const json = JSON.parse(readFileSync(paths.json, "utf8"));
  assert.deepEqual(Object.keys(json), ["problem", "stopped", "baseline", "final", "branch", "attempts"]);
  assert.deepEqual(json, result);
  const md = readFileSync(paths.md, "utf8");
  assert.match(md, /Raise x \| kept \| 10 points \| 12\.5 points \| better on every run/);
  assert.match(md, /Edit a \\\| b second line \| not kept \| 12\.5 points \| - \|/);
  assert.match(md, /the guard `pytest -q` failed/);
  assert.match(md, /Stopped: the proposer had nothing more to try/);
  assert.match(md, /synthe\/solve-demo-1/);
});

test("a run with no kept change says so and gives a next step", () => {
  const md = renderReport({ ...result, branch: null, final: 10, attempts: [] });
  assert.match(md, /No change was kept/);
  assert.match(md, /No attempts were made/);
  assert.match(md, /run `synthe solve` again/);
});

test("report.md says 'kept' or 'not kept' for each attempt, in plain words", () => {
  const md = renderReport({
    problem: "words", stopped: "The proposer had nothing more to try.", baseline: 1, final: 2, branch: "synthe/solve-words-1",
    attempts: [
      { round: 1, summary: "raise it", kept: true, reason: "Better.", before: 1, after: 2 },
      { round: 2, summary: "lower it", kept: false, reason: "Not better.", before: 2, after: 1 },
    ],
  });
  assert.match(md, /\| raise it \| kept \|/);
  assert.match(md, /\| lower it \| not kept \|/);
});

test("report.md says how many input tokens came from the prompt cache", () => {
  const md = renderReport({ ...result, cost: { calls: 1, input_tokens: 20_040, output_tokens: 100, cache_write_tokens: 20_000, usd: 0.002554 } });
  assert.match(md, /Model calls: 1 \(20040 input tokens, 20000 of them from the prompt cache, 100 output tokens\), 0\.0026 US dollars/);
  assert.doesNotMatch(renderReport({ ...result, cost: { calls: 1, input_tokens: 40, output_tokens: 100, usd: 0.000054 } }), /prompt cache/);
});
