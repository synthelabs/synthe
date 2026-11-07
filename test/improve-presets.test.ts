import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { shellExec, type Exec } from "../src/improve/exec.ts";
import { bundleBytes, countPassed, detectPresets, lastNumber, measureOnce, presetsForRepo } from "../src/improve/presets.ts";
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
  const pytestOut: Exec = async () => ({ ok: false, stdout: "1 failed, 5 passed in 0.3s\n", stderr: "", ms: 5, timedOut: false });
  assert.equal((await measureOnce(pytestOut, "/r", config({ metric: { ...custom("python -m pytest -q").metric, preset: "pytest", runs: 1 } }))).value, 5);
  // Configs saved before the pytest id existed carry test-pass with a pytest command; they measure the same way.
  assert.equal((await measureOnce(pytestOut, "/r", config({ metric: { ...custom("python -m pytest -q").metric, preset: "test-pass", runs: 1 } }))).value, 5);
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

test("countPassed reads pytest -q summaries, including failures, warnings and a run where nothing passed", () => {
  assert.equal(countPassed("....F\n12 passed, 1 failed in 0.3s"), 12);
  assert.equal(countPassed("5 passed in 0.02s"), 5);
  assert.equal(countPassed("1 failed, 5 passed, 2 warnings in 1.20s"), 5);
  assert.equal(countPassed("1 failed, 2 skipped, 7 passed, 1 xfailed in 1.20s (0:00:01)"), 7);
  assert.equal(countPassed("===== 8 passed, 2 failed in 0.4s ====="), 8);
  assert.equal(countPassed("FFF\n3 failed in 0.10s"), 0);
  assert.equal(countPassed("2 failed, 1 error in 0.10s"), 0);
  assert.equal(countPassed("no tests ran in 0.01s"), null);
  assert.equal(countPassed("1 error in 0.10s"), null);
  assert.equal(countPassed("/usr/bin/python3: No module named pytest"), null);
  assert.equal(countPassed("ModuleNotFoundError: No module named 'pkg'\nERROR collecting tests/test_a.py"), null);
});

const pyRepo = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "synthe-py-"));
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), text); }
  return dir;
};
const withPath = <T>(path: string, fn: () => T): T => {
  const before = process.env.PATH;
  process.env.PATH = path;
  try { return fn(); } finally { process.env.PATH = before; }
};
const posix = process.platform === "win32" ? { skip: "paths differ on Windows" } : {};

test("pytest is offered for each Python signal, and for none without one", () => {
  const ids = (files: Record<string, string>) => presetsForRepo(pyRepo(files)).map((p) => p.id);
  for (const files of [
    { "pyproject.toml": "" }, { "pytest.ini": "" }, { "setup.cfg": "" }, { "tox.ini": "" },
    { "tests/test_a.py": "" }, { "tests/unit/a_test.py": "" }, { "test_root.py": "" }, { "thing_test.py": "" },
  ] as Record<string, string>[]) assert.deepEqual(ids(files), ["pytest", "custom"], JSON.stringify(files));
  for (const files of [{ "README.md": "" }, { "tests/helper.py": "" }, { "app.py": "" }, {}] as Record<string, string>[]) assert.deepEqual(ids(files), ["custom"], JSON.stringify(files));
});

test("pytest preset has no separate guard; the custom metric is guarded by the same pytest run", posix, () => {
  const presets = withPath("/nonexistent", () => presetsForRepo(pyRepo({ "pyproject.toml": "" })));
  const [tests, own] = presets;
  assert.deepEqual([tests.label, tests.command, tests.guard, tests.unit, tests.direction, tests.runs], ["tests passing (pytest)", "python -m pytest -q", null, "tests", "higher", 1]);
  assert.equal(own.guard, "python -m pytest -q");
});

test("npm and Python together are both offered and labelled", posix, () => {
  const dir = pyRepo({ "pyproject.toml": "", "package.json": JSON.stringify({ scripts: { test: "node --test", build: "vite build" } }) });
  const presets = withPath("/nonexistent", () => presetsForRepo(dir));
  assert.deepEqual(presets.map((p) => [p.id, p.label, p.command]), [
    ["test-pass", "tests passing (npm test)", "npm test"],
    ["pytest", "tests passing (pytest)", "python -m pytest -q"],
    ["bundle-size", "built JS and CSS, gzipped", "npm run build"],
    ["build-time", "build time", "npm run build"],
    ["custom", "your own command", ""],
  ]);
  assert.equal(presets[2].guard, "npm test");
});

test("the interpreter is the repo's venv, else python3, else python", posix, () => {
  const bin = mkdtempSync(join(tmpdir(), "synthe-bin-"));
  const cmd = (dir: string) => presetsForRepo(dir)[0].command;
  const noVenv = pyRepo({ "pytest.ini": "" });
  assert.equal(withPath(bin, () => cmd(noVenv)), "python -m pytest -q");
  writeFileSync(join(bin, "python3"), "");
  assert.equal(withPath(bin, () => cmd(noVenv)), "python3 -m pytest -q");
  assert.equal(withPath(bin, () => cmd(pyRepo({ "pytest.ini": "", ".venv/bin/python": "" }))), ".venv/bin/python -m pytest -q");
  assert.equal(withPath(bin, () => cmd(pyRepo({ "pytest.ini": "", "venv/bin/python": "" }))), "venv/bin/python -m pytest -q");
  assert.equal(withPath(bin, () => cmd(pyRepo({ "pytest.ini": "", ".venv/bin/python": "", "venv/bin/python": "" }))), ".venv/bin/python -m pytest -q");
  assert.equal(withPath(bin, () => cmd(pyRepo({ "pytest.ini": "", ".venv/notpython": "" }))), "python3 -m pytest -q");
});

test("a src layout puts src/ first on the path so the candidate's code is measured", posix, () => {
  const cmd = (files: Record<string, string>) => withPath("/nonexistent", () => presetsForRepo(pyRepo({ "pytest.ini": "", ...files }))[0].command);
  assert.equal(cmd({ "src/pkg/__init__.py": "" }), "PYTHONPATH=src python -m pytest -q");
  assert.equal(cmd({ "src/mod.py": "" }), "PYTHONPATH=src python -m pytest -q");
  assert.equal(cmd({ "pkg/__init__.py": "" }), "python -m pytest -q");
  assert.equal(cmd({ "src/notes.txt": "" }), "python -m pytest -q");
});
