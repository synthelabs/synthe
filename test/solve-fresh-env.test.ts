// Every measure, guard, `run` and `compare` command runs with PYTHONDONTWRITEBYTECODE=1, so Python never measures
// a same-size edit with a stale .pyc file. The proposer does not get the setting: it measures nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardFailure, measure } from "../src/solve/measure.ts";
import { commandCompare, runCases } from "../src/solve/judge.ts";
import { FRESH_ENV, runCommand } from "../src/solve/run.ts";
import type { Problem } from "../src/solve/types.ts";

const PRINT = `node -e "console.log(process.env.PYTHONDONTWRITEBYTECODE === '1' ? 1 : 0)"`;
const FAIL_UNLESS = `node -e "process.exit(process.env.PYTHONDONTWRITEBYTECODE === '1' ? 0 : 1)"`;

test("measure, guard, run and compare commands run with PYTHONDONTWRITEBYTECODE=1", async () => {
  const saved = process.env.PYTHONDONTWRITEBYTECODE;
  delete process.env.PYTHONDONTWRITEBYTECODE;
  try {
    const dir = mkdtempSync(join(tmpdir(), "synthe-fresh-"));
    const problem = { measure: { command: PRINT, direction: "higher", runs: 2 }, guards: [FAIL_UNLESS] } as unknown as Problem;
    const m = await measure(dir, problem, { split: "train", seed: 3 });
    assert.deepEqual(m, { value: 1, runs: [1, 1] }, "the measure command must see PYTHONDONTWRITEBYTECODE=1");
    assert.equal(await guardFailure(dir, problem), null, "the guard command must see PYTHONDONTWRITEBYTECODE=1");
    assert.deepEqual(await runCases(dir, PRINT, [{ id: "c1", input: 1 }]), { c1: "1" }, "the run command must see it");
    const compare = commandCompare(dir, `node -e "console.log(JSON.stringify({ winner: process.env.PYTHONDONTWRITEBYTECODE === '1' ? 'a' : 'b' }))"`);
    assert.equal(await compare({ id: "c1", input: 1 }, "x", "y"), "a", "the compare command must see it");
    // A plain command, such as the proposer's, keeps the person's environment as it is.
    assert.equal((await runCommand(dir, PRINT)).stdout.trim(), "0");
    assert.deepEqual(FRESH_ENV, { PYTHONDONTWRITEBYTECODE: "1" });
  } finally {
    if (saved !== undefined) process.env.PYTHONDONTWRITEBYTECODE = saved;
  }
});
