import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { failedGuard, guardFailure, lastNumber, measure, median } from "../src/solve/measure.ts";
import type { Problem } from "../src/solve/types.ts";

const dir = mkdtempSync(join(tmpdir(), "solve-measure-"));

function problem(command: string, runs = 3, guards: string[] = []): Problem {
  return {
    version: 1, name: "t", goal: "g", artifact: ["*.txt"], protect: [], measure: { command, direction: "higher", runs },
    guards, split: { holdout: false }, proposer: { command: "true" }, budget: { max_rounds: 6, max_calls: null },
    candidates: 1, dir, file: join(dir, "p.json"),
  };
}

test("the last number on stdout is the score", () => {
  assert.equal(lastNumber("cases: 10\nscore: 7.5\n"), 7.5);
  assert.equal(lastNumber("-3"), -3);
  assert.equal(lastNumber("1e3 then .25"), 0.25);
  assert.equal(lastNumber("2.5e-1"), 0.25);
  assert.equal(lastNumber("no score here"), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test("measure runs the command `runs` times, keeps every score, and reports the median", async () => {
  writeFileSync(join(dir, "count.js"), "const fs=require('fs');const f='n.txt';const n=fs.existsSync(f)?+fs.readFileSync(f,'utf8')+1:1;fs.writeFileSync(f,String(n));console.log('score', n)");
  assert.deepEqual(await measure(dir, problem("node count.js", 4)), { value: 2.5, runs: [1, 2, 3, 4] });
});

test("measure sets SYNTHE_SPLIT and SYNTHE_SEED only when asked", async () => {
  const cmd = `node -e "console.log((process.env.SYNTHE_SPLIT || 'none') + ' ' + (process.env.SYNTHE_SEED || 0))"`;
  assert.deepEqual(await measure(dir, problem(cmd, 1), { split: "holdout", seed: 7 }), { value: 7, runs: [7] });
  const split = `node -e "console.log({train:1,holdout:2}[process.env.SYNTHE_SPLIT] || 0)"`;
  assert.deepEqual(await measure(dir, problem(split, 1), { split: "train" }), { value: 1, runs: [1] });
  assert.deepEqual(await measure(dir, problem(split, 1), { split: "holdout" }), { value: 2, runs: [2] });
  assert.deepEqual(await measure(dir, problem(split, 1)), { value: 0, runs: [0] });
});

test("a measure that fails or prints no number gives a plain reason", async () => {
  const failed = await measure(dir, problem("echo broken >&2; exit 3", 2));
  assert.match("failed" in failed ? failed.failed : "", /`echo broken >&2; exit 3` failed: broken/);
  const silent = await measure(dir, problem("echo none", 1));
  assert.match("failed" in silent ? silent.failed : "", /printed no number/);
});

test("guards stop at the first failure and name it", async () => {
  assert.equal(await failedGuard(dir, problem("echo 1", 1, ["true", "exit 0"])), null);
  assert.equal(await failedGuard(dir, problem("echo 1", 1, [])), null);
  const p = problem("echo 1", 1, ["true", "echo tests failed; exit 1", "false"]);
  assert.equal(await failedGuard(dir, p), "echo tests failed; exit 1");
  const g = await guardFailure(dir, p);
  assert.match(g?.reason ?? "", /The guard `echo tests failed; exit 1` failed: tests failed/);
});

test("a guard's reason names the failing test, not the totals", async () => {
  const out = "TAP version 13\\nok 1 - adds\\nnot ok 2 - rounds to two places\\n# tests 2\\n# pass 1\\n# fail 1\\n# duration_ms 5";
  const p = problem("echo 1", 1, [`printf '${out}'; echo 'npm error Lifecycle script failed' >&2; exit 1`]);
  const g = await guardFailure(dir, p);
  assert.match(g?.reason ?? "", /failed: not ok 2 - rounds to two places\.$/);
  const plain = await guardFailure(dir, problem("echo 1", 1, ["echo building; echo 'Error: missing semicolon'; exit 2"]));
  assert.match(plain?.reason ?? "", /failed: Error: missing semicolon\.$/);
  const quiet = await guardFailure(dir, problem("echo 1", 1, ["echo just this; exit 2"]));
  assert.match(quiet?.reason ?? "", /failed: just this\.$/);
});

test("lastNumber reads comma thousands separators as one number", () => {
  assert.equal(lastNumber("Total size: 12,168,000 bytes\n"), 12168000);
  assert.equal(lastNumber("score 1,234.5"), 1234.5);
  assert.equal(lastNumber("pairs 3,4"), 4, "not groups of three digits: two numbers");
  assert.equal(lastNumber("x 12,34"), 34);
  assert.equal(lastNumber("-20"), -20);
  assert.equal(lastNumber("tiny-lib 2.10.3\nscore 7"), 7);
});
