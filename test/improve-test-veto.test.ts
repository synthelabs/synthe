import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseImproveConfig, type ImproveConfig, type Measurement } from "../src/improve/config.ts";
import { shellExec } from "../src/improve/exec.ts";
import { runLoop } from "../src/improve/loop.ts";
import { countFailed, failingTests } from "../src/improve/presets.ts";
import { brokenTests, verdict } from "../src/improve/verdict.ts";
import { measureAt } from "../src/improve/worktree.ts";
import type { Model } from "../src/model/client.ts";
import { config } from "./improve-helpers.ts";

// With the test-pass and pytest metrics there is no separate regression check, so the tests are the check:
// a change that fixes two failing tests and breaks a passing one must not win by one.

const m = (median: number, failing?: string[] | null): Measurement => ({ commit: "c", median, runs: [median, median, median], at: "", ...(failing !== undefined && { failing }) });

test("verdict: a change that breaks a test that passed before is not kept, even when more tests pass", () => {
  const broke = verdict("higher", m(2, ["double", "square"]), m(3, ["neg"]), null);
  assert.deepEqual([broke.win, broke.reason], [false, "tests"]);
  assert.equal(broke.why, "It breaks a test that passed in every run before: neg.");
  // Still failing, but only tests that failed before: a real gain.
  assert.equal(verdict("higher", m(2, ["double", "square"]), m(3, ["square"]), null).win, true);
  assert.equal(verdict("higher", m(2, ["double", "square"]), m(4, []), null).win, true);
  // Many broken tests: three named, the rest counted.
  const many = verdict("higher", m(1, []), m(9, ["a", "b", "c", "d", "e"]), null);
  assert.equal(many.why, "It breaks 5 tests that passed in every run before: a; b; c; and 2 more.");
  // Worse anyway: the plain reason comes first.
  assert.equal(verdict("higher", m(5, []), m(4, ["x"]), null).reason, "worse");
  // A failed regression check still wins the explanation.
  assert.equal(verdict("higher", m(2, []), m(3, ["x"]), false).reason, "guard");
});

test("verdict: when the output does not say which tests fail, a change with failing tests is not kept", () => {
  const unknown = verdict("higher", m(2, ["double"]), m(3, null), null);
  assert.deepEqual([unknown.win, unknown.reason], [false, "tests"]);
  assert.equal(unknown.why, "Some tests still fail, and Synthe could not tell which ones from the test output, so a fixed test could be hiding a newly broken one.");
  assert.equal(verdict("higher", m(2, null), m(3, ["double"]), null).reason, "tests");
  // Nothing fails any more: safe whatever the baseline said.
  assert.equal(verdict("higher", m(2, null), m(4, []), null).win, true);
  // A baseline saved before this field existed: say how to fix it.
  assert.match(brokenTests(m(2), m(3, ["double"]))!, /measured before Synthe recorded which tests fail.*Run npx synthe improve again/);
  // Metrics that are not test counts carry no list and are judged as before.
  assert.equal(verdict("higher", m(2), m(3), null).win, true);
  assert.equal(brokenTests(m(2), m(3)), null);
});

test("failingTests names the failing tests for each runner, and gives null when it can't name them all", () => {
  const nodeSpec = "✔ add (0.4ms)\n✖ double (0.9ms)\n  AssertionError [ERR_ASSERTION]\n✖ square (0.2ms)\nℹ tests 4\nℹ pass 2\nℹ fail 2\n\n✖ failing tests:\n\ntest at test/lib.test.js:3:1\n✖ double (1.3ms)\n";
  assert.deepEqual(failingTests(nodeSpec), ["double", "square"]);
  const tap = "TAP version 13\nok 1 - add\nnot ok 2 - double\n  ---\n  duration_ms: 0.9\n  ...\nnot ok 3 - square\nnot ok 4 - later # TODO\n# tests 4\n# pass 2\n# fail 2\n";
  assert.deepEqual(failingTests(tap), ["double", "square"]);
  const jest = "FAIL src/a.test.js\n  ● math › doubles\n\n    expect(received).toBe(expected)\n  ● Console\n  ● math › squares\nTests:       2 failed, 7 passed, 9 total\n";
  assert.deepEqual(failingTests(jest), ["math › doubles", "math › squares", "src/a.test.js"]);
  const vitest = " FAIL  src/a.test.ts > math > doubles\n × math > doubles 3ms\n Tests  1 failed | 3 passed (4)\n";
  assert.deepEqual(failingTests(vitest), ["math > doubles", "src/a.test.ts > math > doubles"]);
  const mocha = "  math\n    ✓ adds\n    1) doubles\n\n  1 passing (5ms)\n  1 failing\n\n  1) math\n       doubles:\n     AssertionError\n";
  assert.deepEqual(failingTests(mocha), ["doubles", "math"]);
  const pytest = "..F.E\nFAILED tests/test_a.py::test_double - assert 7 == 10\nERROR tests/test_a.py::test_db - fixture 'db' not found\n1 failed, 3 passed, 1 error in 0.3s\n";
  assert.deepEqual(failingTests(pytest), ["tests/test_a.py::test_db", "tests/test_a.py::test_double"]);
  assert.deepEqual(failingTests("tests/test_a.py::test_double FAILED\n===== 1 failed, 2 passed in 0.4s =====\n"), ["tests/test_a.py::test_double"]);
  // Durations differ from run to run; names must not.
  assert.deepEqual(failingTests("✖ double (12.5ms)\nℹ pass 1\nℹ fail 1\n"), failingTests("✖ double (0.7ms)\nℹ pass 1\nℹ fail 1\n"));
  // Nothing failed.
  assert.deepEqual(failingTests("ℹ pass 4\nℹ fail 0\n"), []);
  assert.deepEqual(failingTests("5 passed in 0.02s\n"), []);
  // Two failed but none named (a quiet reporter), or no summary at all: unknown.
  assert.equal(failingTests("ℹ pass 2\nℹ fail 2\n"), null);
  assert.equal(failingTests("✖ double\nℹ pass 2\nℹ fail 2\n"), null);
  assert.equal(failingTests("all good\n"), null);
});

test("countFailed reads the failure count from the same summaries countPassed reads", () => {
  assert.equal(countFailed("ℹ tests 5\nℹ pass 4\nℹ fail 1"), 1);
  assert.equal(countFailed("# tests 5\n# pass 5\n# fail 0"), 0);
  assert.equal(countFailed("Tests:       2 failed, 7 passed, 9 total"), 2);
  assert.equal(countFailed("Tests:       7 passed, 7 total"), 0);
  assert.equal(countFailed("  3 passing (40ms)\n  1 failing"), 1);
  assert.equal(countFailed("  3 passing (40ms)"), 0);
  assert.equal(countFailed("===== 8 passed, 2 failed in 0.4s ====="), 2);
  assert.equal(countFailed("2 failed, 1 error in 0.10s"), 3);
  assert.equal(countFailed("12 passed in 0.3s"), 0);
  assert.equal(countFailed("nothing here"), null);
});

test("the saved baseline keeps its failing tests; a bad list is refused", () => {
  const base = { ...config(), baseline: { ...config().baseline, failing: ["double"] } };
  assert.deepEqual(parseImproveConfig(JSON.stringify(base)).baseline.failing, ["double"]);
  assert.equal(parseImproveConfig(JSON.stringify({ ...base, baseline: { ...base.baseline, failing: null } })).baseline.failing, null);
  assert.equal(parseImproveConfig(JSON.stringify(config())).baseline.failing, undefined);
  assert.throws(() => parseImproveConfig(JSON.stringify({ ...base, baseline: { ...base.baseline, failing: [1] } })), /baseline.failing must be a list of test names or null/);
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "synthe-veto-"));
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env: gitEnv }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  return { dir, git, gitEnv };
}

test("measureAt keeps every test that failed in any run, and null when one run named none", async () => {
  const { dir, git } = repo();
  // Each run gets a fresh checkout, so the run count lives outside it: run 1 fails a, run 2 fails b, run 3 fails a.
  // One counter file per measurement, named on the command line.
  const counter = () => join(mkdtempSync(join(tmpdir(), "synthe-counter-")), "n");
  writeFileSync(join(dir, "runs.js"), `const fs = require("fs");\nconst f = process.argv[3];\nconst n = (fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0) + 1;\nfs.writeFileSync(f, String(n));\nconst quiet = process.argv[2] === "quiet" && n === 2;\nconsole.log((quiet ? "" : "not ok 1 - " + (n === 2 ? "b" : "a") + "\\n") + "# pass 3\\n# fail 1");\n`);
  git("add", ".");
  git("commit", "-qm", "runs");
  const tests = (command: string) => config({ metric: { preset: "test-pass", label: "tests passing", unit: "tests", command, direction: "higher", runs: 3 } });
  const out = await measureAt(shellExec, dir, git("rev-parse", "HEAD"), tests(`node runs.js loud ${JSON.stringify(counter())}`));
  assert.deepEqual(out.measurement?.failing, ["a", "b"]);
  const quiet = await measureAt(shellExec, dir, git("rev-parse", "HEAD"), tests(`node runs.js quiet ${JSON.stringify(counter())}`));
  assert.equal(quiet.measurement?.failing, null);
  const custom = await measureAt(shellExec, dir, git("rev-parse", "HEAD"), config({ metric: { ...config().metric, command: "echo 3", runs: 1 } }));
  assert.equal("failing" in custom.measurement!, false);
});

// The loop on a repo with two failing tests, run by node's real test runner. Round 1 fixes both and breaks a third
// (3 passing instead of 2, beyond a noise of 0): before this rule it was kept. Round 2 fixes both without breaking anything.
test("the loop does not keep a change that fixes two failing tests and breaks a passing one", async () => {
  const { dir, git, gitEnv } = repo();
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "lib.js"), "exports.add = (a, b) => a + b;\nexports.double = (n) => n + 2;\nexports.square = (n) => n + n;\nexports.neg = (n) => -n;\n");
  writeFileSync(join(dir, "test", "lib.test.js"), `const test = require("node:test");\nconst assert = require("node:assert");\nconst lib = require("../lib.js");\ntest("add", () => assert.equal(lib.add(2, 3), 5));\ntest("double", () => assert.equal(lib.double(5), 10));\ntest("square", () => assert.equal(lib.square(5), 25));\ntest("neg", () => assert.equal(lib.neg(4), -4));\n`);
  git("add", ".");
  git("commit", "-qm", "lib");
  const draft: ImproveConfig = {
    version: 1, goal: "More tests passing", guard: { command: null }, protect: [], mode: "review",
    metric: { preset: "test-pass", label: "tests passing", unit: "tests", command: "node --test test/lib.test.js", direction: "higher", runs: 1 },
    baseline: { commit: "x", median: 0, runs: [0], at: "" },
  };
  const measured = await measureAt(shellExec, dir, git("rev-parse", "HEAD"), draft);
  assert.equal(measured.measurement?.median, 2);
  assert.deepEqual(measured.measurement?.failing, ["double", "square"]);
  const cfg = parseImproveConfig(JSON.stringify({ ...draft, baseline: measured.measurement }));

  const breaks = { summary: "fix double and square", edits: [{ path: "lib.js", search: "n + 2", replace: "n * 2" }, { path: "lib.js", search: "n + n", replace: "n * n" }, { path: "lib.js", search: "=> -n", replace: "=> n" }] };
  const fixes = { summary: "fix double and square only", edits: [{ path: "lib.js", search: "n + 2", replace: "n * 2" }, { path: "lib.js", search: "n + n", replace: "n * n" }] };
  const proposals = [breaks, fixes, { summary: "nothing more", edits: [] }];
  let round = -1;
  const model: Model = {
    async ask(a) {
      const picking = Boolean((a.schema as any)?.properties?.paths);
      if (picking) round++;
      return { text: JSON.stringify(picking ? { paths: ["lib.js"], why: "the functions under test" } : proposals[round]), costUsd: 0.001 };
    },
  };
  const said: string[] = [];
  const io = { say: (t: string) => said.push(t), exec: shellExec, run: async (cmd: string, args: string[], stdin?: string) => execFileSync(cmd, args, { cwd: dir, encoding: "utf8", input: stdin, env: gitEnv, stdio: ["pipe", "pipe", "pipe"] }) };
  const result = await runLoop(io, { top: dir, gitDir: join(dir, ".git"), config: cfg, model, rounds: 2, budgetUsd: 1 });

  assert.equal(result.rounds[0].kept, false);
  assert.equal(result.rounds[0].value, 3);
  assert.match(result.rounds[0].why, /but it breaks a test that passed in every run before: neg$/);
  assert.ok(said.some((l) => /^Round 1: not kept \(.*but it breaks a test that passed in every run before: neg\)/.test(l)), said.join("\n"));
  assert.equal(result.rounds[1].kept, true);
  assert.equal(result.best.median, 4);
  assert.deepEqual(result.best.failing, []);
});
