import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { solveCommand } from "../src/cli/solve.ts";

function problemDir(extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "solve-proposer-"));
  writeFileSync(join(dir, "knob.txt"), "level=1\n");
  writeFileSync(join(dir, "problem.json"), JSON.stringify({
    version: 1, name: "flag", goal: "Raise the level.", artifact: ["knob.txt"],
    measure: { command: "echo 1", direction: "higher", runs: 1 }, proposer: { agent: "claude" }, ...extra,
  }));
  for (const a of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "start"]]) execFileSync("git", ["-C", dir, ...a]);
  return dir;
}

async function run(args: string[], cwd: string) {
  const lines: string[] = [];
  const code = await solveCommand(args, cwd, (l) => lines.push(l), {});
  return { code, out: lines.join("\n") };
}

test("solve --proposer with a value other than model exits 1 and names the one value", async () => {
  const dir = problemDir();
  for (const args of [["problem.json", "--proposer", "agent"], ["problem.json", "--proposer"]]) {
    const r = await run(args, dir);
    assert.equal(r.code, 1);
    assert.match(r.out, /--proposer model/);
  }
});

test("solve --proposer model without a model block exits 1 and names the model field", async () => {
  const dir = problemDir();
  const r = await run(["problem.json", "--proposer", "model"], dir);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /"model" block/);
});
