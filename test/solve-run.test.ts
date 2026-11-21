import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { runCommand } from "../src/solve/run.ts";

test("runCommand passes stdin and returns stdout", async () => {
  const r = await runCommand(tmpdir(), "cat", { stdin: "hello" });
  assert.equal(r.ok, true);
  assert.equal(r.stdout, "hello");
});

test("runCommand hides Synthe's own values and passes only the named ones", async () => {
  process.env.SYNTHE_API_KEY = "not-a-real-key";
  try {
    const r = await runCommand(tmpdir(), 'echo "[$SYNTHE_API_KEY][$SYNTHE_SPLIT]"', { env: { SYNTHE_SPLIT: "train" } });
    assert.equal(r.stdout.trim(), "[][train]");
  } finally { delete process.env.SYNTHE_API_KEY; }
});

test("runCommand reports a failing command and a timeout without throwing", async () => {
  const failed = await runCommand(tmpdir(), "exit 3");
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 3);
  const slow = await runCommand(tmpdir(), "sleep 5", { timeoutMs: 100 });
  assert.equal(slow.timedOut, true);
  assert.equal(slow.ok, false);
});
