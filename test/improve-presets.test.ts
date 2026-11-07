import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { shellExec, type Exec } from "../src/improve/exec.ts";
import { bundleBytes, countPassed, detectPresets, lastNumber, measureOnce } from "../src/improve/presets.ts";
import { config, custom } from "./improve-helpers.ts";

test("lastNumber takes the last bare-number line and ignores npm banners", () => {
  assert.equal(lastNumber("\n> app@1.0.0 metric\n> node metrics/score.js\n\n3\n"), 3);
  assert.equal(lastNumber("12 valid\n"), null);
  assert.equal(lastNumber("1.5e3\n"), 1500);
  assert.equal(lastNumber(""), null);
  assert.equal(lastNumber("4\r\n-2.5\r\n"), -2.5);
});

test("countPassed reads the four common runners", () => {
  assert.equal(countPassed("ℹ tests 5\nℹ pass 4\nℹ fail 1"), 4);
  assert.equal(countPassed("# tests 5\n# pass 4\n# fail 1"), 4);
  assert.equal(countPassed("Tests:       2 failed, 7 passed, 9 total"), 7);
  assert.equal(countPassed("  3 passing (40ms)\n  1 failing"), 3);
  assert.equal(countPassed("===== 8 passed, 2 failed in 0.4s ====="), 8);
  assert.equal(countPassed("nothing here"), null);
});

test("detectPresets offers only what the repo can run and always ends with custom", () => {
  const ids = (pkg: object) => detectPresets([{ path: "package.json", text: JSON.stringify(pkg) }]).map((p) => p.id);
  assert.deepEqual(ids({ scripts: { test: "node --test", build: "vite build" } }), ["test-pass", "bundle-size", "build-time", "custom"]);
  assert.deepEqual(ids({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }), ["custom"]);
  assert.deepEqual(detectPresets([]).map((p) => p.id), ["custom"]);
  assert.deepEqual(detectPresets([{ path: "package.json", text: "{" }]).map((p) => p.id), ["custom"]);
  const [testPass, bundle, time, own] = detectPresets([{ path: "package.json", text: JSON.stringify({ scripts: { test: "x", build: "y" } }) }]);
  assert.deepEqual([testPass.guard, bundle.guard, time.guard, own.guard], [null, "npm test", "npm test", "npm test"]);
  assert.deepEqual([testPass.runs, bundle.runs, time.runs], [1, 1, 3]);
  assert.deepEqual([bundle.direction, bundle.unit], ["lower", "bytes"]);
});

test("measureOnce turns a run into a number or a plain reason", async () => {
  const exec: Exec = async (_cwd, command) => command === "slow"
    ? { ok: false, stdout: "", stderr: "", ms: 600_000, timedOut: true }
    : command === "fail" ? { ok: false, stdout: "9\n", stderr: "boom", ms: 5, timedOut: false }
    : command === "words" ? { ok: true, stdout: "fine\n", stderr: "", ms: 5, timedOut: false }
    : { ok: true, stdout: "> banner\n7\n", stderr: "", ms: 10, timedOut: false };
  assert.deepEqual((await measureOnce(exec, "/r", custom("fast"))).value, 7);
  assert.equal((await measureOnce(exec, "/r", custom("slow"))).reason, "The metric command took longer than 10 minutes.");
  assert.equal((await measureOnce(exec, "/r", custom("fail"))).reason, "The metric command failed (exit code not 0).");
  assert.equal((await measureOnce(exec, "/r", custom("words"))).reason, "The metric command printed no number.");
  const failingTests: Exec = async () => ({ ok: false, stdout: "ℹ pass 2\nℹ fail 1\n", stderr: "", ms: 5, timedOut: false });
  const testPass = config({ metric: { ...custom("npm test").metric, preset: "test-pass", runs: 1 } });
  assert.equal((await measureOnce(failingTests, "/r", testPass)).value, 2);
  const timed = config({ metric: { ...custom("npm run build").metric, preset: "build-time" } });
  assert.equal((await measureOnce(async () => ({ ok: true, stdout: "", stderr: "", ms: 1234, timedOut: false }), "/r", timed)).value, 1234);
  const bundle = config({ metric: { ...custom("npm run build").metric, preset: "bundle-size" } });
  assert.equal((await measureOnce(exec, mkdtempSync(join(tmpdir(), "synthe-empty-")), bundle)).reason, "No built JS or CSS was found under dist, build, out, .next/static or public/build.");
});

test("shellExec runs in the directory, times out, and hides Synthe secrets from the child", async () => {
  const dir = mkdtempSync(join(tmpdir(), "synthe-exec-"));
  process.env.SYNTHE_EVENT_CODE = "secret-code";
  process.env.GH_TOKEN = "gh-secret";
  try {
    process.env.NODE_TEST_CONTEXT ??= "child-v8";
    const out = await shellExec(dir, "pwd && echo \"${SYNTHE_EVENT_CODE:-unset}\" \"${GH_TOKEN:-unset}\" \"${NODE_TEST_CONTEXT:-unset}\"", 5_000);
    assert.ok(out.ok && out.stdout.includes("unset unset unset") && !out.stdout.includes("secret"), out.stdout);
    assert.ok(out.stdout.includes(dir.split("/").at(-1)!));
    const slow = await shellExec(dir, "sleep 2", 200);
    assert.ok(!slow.ok && slow.timedOut);
    const failed = await shellExec(dir, "exit 3", 5_000);
    assert.ok(!failed.ok && !failed.timedOut);
  } finally {
    delete process.env.SYNTHE_EVENT_CODE;
    delete process.env.GH_TOKEN;
  }
});

test("bundleBytes sums gzipped js and css under the first output folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "synthe-bundle-"));
  mkdirSync(join(dir, "dist/assets"), { recursive: true });
  mkdirSync(join(dir, "build"), { recursive: true });
  writeFileSync(join(dir, "dist/a.js"), "console.log('hello');\n".repeat(500));
  writeFileSync(join(dir, "dist/assets/b.css"), "body { color: red; }\n".repeat(100));
  writeFileSync(join(dir, "dist/c.map"), "x".repeat(5000));
  writeFileSync(join(dir, "build/ignored.js"), "y".repeat(5000));
  const expected = ["dist/a.js", "dist/assets/b.css"].reduce((s, f) => s + gzipSync(readFileSync(join(dir, f))).length, 0);
  const bytes = bundleBytes(dir)!;
  assert.ok(bytes > 0 && bytes < 20480);
  assert.equal(bytes, expected);
});
