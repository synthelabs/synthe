import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lastNumber, measure, runGuards } from "../src/solve/measure.ts";

const dir = mkdtempSync(join(tmpdir(), "solve-measure-"));

test("the last number on stdout is the score", () => {
  assert.equal(lastNumber("cases: 10\nscore: 7.5\n"), 7.5);
  assert.equal(lastNumber("-3"), -3);
  assert.equal(lastNumber("1e3 then .25"), 0.25);
  assert.equal(lastNumber("2.5e-1"), 0.25);
  assert.equal(lastNumber("no score here"), null);
});

test("measure runs the command `runs` times and keeps every score", async () => {
  writeFileSync(join(dir, "count.js"), "const fs=require('fs');const f='n.txt';const n=fs.existsSync(f)?+fs.readFileSync(f,'utf8')+1:1;fs.writeFileSync(f,String(n));console.log('score', n)");
  const m = await measure({ cwd: dir, command: "node count.js", runs: 4 });
  assert.deepEqual(m, { ok: true, runs: [1, 2, 3, 4] });
});

test("measure defaults to 3 runs", async () => {
  const m = await measure({ cwd: dir, command: "echo 5" });
  assert.deepEqual(m, { ok: true, runs: [5, 5, 5] });
});

test("measure sets SYNTHE_SPLIT only when a split is given", async () => {
  const cmd = `node -e "console.log(process.env.SYNTHE_SPLIT === 'holdout' ? 2 : process.env.SYNTHE_SPLIT === 'train' ? 1 : 0)"`;
  assert.deepEqual(await measure({ cwd: dir, command: cmd, runs: 1, split: "holdout" }), { ok: true, runs: [2] });
  assert.deepEqual(await measure({ cwd: dir, command: cmd, runs: 1, split: "train" }), { ok: true, runs: [1] });
  assert.deepEqual(await measure({ cwd: dir, command: cmd, runs: 1 }), { ok: true, runs: [0] });
});

test("a measure that fails or prints no number gives a plain reason", async () => {
  const failed = await measure({ cwd: dir, command: "echo broken >&2; exit 3", runs: 2 });
  assert.equal(failed.ok, false);
  assert.match(!failed.ok ? failed.reason : "", /`echo broken >&2; exit 3` failed: broken/);
  const silent = await measure({ cwd: dir, command: "echo none", runs: 1 });
  assert.match(!silent.ok ? silent.reason : "", /printed no number/);
  const slow = await measure({ cwd: dir, command: "sleep 5", runs: 1, timeoutMs: 200 });
  assert.match(!slow.ok ? slow.reason : "", /did not finish/);
});

test("guards stop at the first failure and name it", async () => {
  assert.deepEqual(await runGuards(dir, ["true", "exit 0"]), { ok: true });
  assert.deepEqual(await runGuards(dir, []), { ok: true });
  const r = await runGuards(dir, ["true", "echo tests failed; exit 1", "false"]);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.guard, "echo tests failed; exit 1");
  assert.match(!r.ok ? r.reason : "", /The guard `echo tests failed; exit 1` failed: tests failed/);
});
