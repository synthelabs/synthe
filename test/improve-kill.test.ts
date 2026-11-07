import assert from "node:assert/strict";
import { test } from "node:test";
import { killRunning, shellExec } from "../src/improve/exec.ts";

// Found in review: an interrupted run left model-written metric processes running in their own process group.
test("killRunning stops a running metric command and everything it started", { skip: process.platform === "win32" }, async () => {
  const started = Date.now();
  const run = shellExec(process.cwd(), "sleep 30; echo done", 60_000);
  await new Promise((r) => setTimeout(r, 200));
  killRunning();
  const result = await run;
  assert.equal(result.ok, false);
  assert.ok(Date.now() - started < 10_000, "the command should stop at once");
  assert.doesNotMatch(result.stdout, /done/);
});
