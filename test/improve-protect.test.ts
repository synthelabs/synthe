import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promptModeProtect, protectedChanges, protectedPathProblem } from "../src/improve/protect.ts";
import { config, custom } from "./improve-helpers.ts";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

test("protected paths: tests, metric inputs, config, lockfiles and --protect entries are off limits; product code is not", () => {
  const cfg = config({ protect: ["data/seed.json"], metric: { ...custom("x").metric, command: "node scoring/score.js --fast" }, guard: { command: "npm test" } });
  for (const p of ["src/validate.js", "public/index.html", "README.md", "src/testing.js", "scoring/other.js"]) assert.equal(protectedPathProblem(p, cfg), null, p);
  for (const p of ["test/email.test.js", "metrics/score.js", "metrics/valid-signups.json", "scoring/score.js", "package.json", "package-lock.json", ".synthe/scenarios.jsonl", "synthe.json", ".github/workflows/ci.yml", "data/seed.json", "data/seed.json/x", "vite.config.ts", ".env.local", "src/a.spec.ts", "apps/web/yarn.lock", "requirements-dev.txt", "Dockerfile", "src/.hidden", "bin/run", "certs/server.pem"]) {
    assert.match(protectedPathProblem(p, cfg) ?? "", new RegExp(`^${escape(p)} `), p);
  }
  assert.equal(protectedPathProblem("test/email.test.js", cfg), "test/email.test.js is a test file; Synthe measures with the tests as they are.");
  assert.match(protectedPathProblem("scoring/score.js", cfg)!, /metric or the regression check \(scoring\/score\.js\)/);
  assert.match(protectedPathProblem("data/seed.json", cfg)!, /--protect data\/seed\.json/);
  assert.deepEqual(protectedChanges(["src/a.js", "test/b.test.js"], cfg).length, 1);
  assert.deepEqual(protectedChanges(["z/x.test.js", "a/y.test.js", "src/ok.js"], cfg).map((p) => p.split(" ")[0]), ["a/y.test.js", "z/x.test.js"]);
});

test("Python tests and pytest settings are protected; product modules are not", () => {
  const cfg = config();
  for (const p of ["src/pkg/core.py", "pkg/test_utils_helpers/x.py", "attest.py"]) assert.equal(protectedPathProblem(p, cfg), null, p);
  for (const p of ["test_core.py", "pkg/core_test.py", "conftest.py", "pkg/conftest.py", "pytest.ini", "tox.ini", "setup.cfg", "tests/helpers.py"]) assert.match(protectedPathProblem(p, cfg) ?? "", new RegExp(`^${escape(p)} `), p);
});

const promptRepo = (goal?: string) => {
  const dir = mkdtempSync(join(tmpdir(), "synthe-pm-"));
  if (goal !== undefined) writeFileSync(join(dir, "synthe.json"), goal);
  return dir;
};

test("promptModeProtect names the prompt file and test cases from synthe.json, and nothing otherwise", () => {
  const goal = (over: object) => JSON.stringify({ version: 1, prompt: { kind: "file", path: "prompts/agent.md" }, objective: "o", scenarios: ".synthe/scenarios.jsonl", ...over });
  assert.deepEqual(promptModeProtect(promptRepo(goal({}))), ["prompts/agent.md", ".synthe/scenarios.jsonl"]);
  assert.deepEqual(promptModeProtect(promptRepo(goal({ prompt: { kind: "file", path: "./a/../b.md" } }))), [".synthe/scenarios.jsonl"]);
  assert.deepEqual(promptModeProtect(promptRepo(goal({ prompt: { kind: "inline", path: "src/agent.ts", delimiter: "`", initial: "x" }, scenarios: undefined }))), ["src/agent.ts"]);
  assert.deepEqual(promptModeProtect(promptRepo(goal({ prompt: { kind: "file", path: "/etc/passwd" }, scenarios: 3 }))), []);
  assert.deepEqual(promptModeProtect(promptRepo()), []);
  assert.deepEqual(promptModeProtect(promptRepo("{ not json")), []);
  assert.deepEqual(promptModeProtect(promptRepo("null")), []);
  assert.deepEqual(promptModeProtect(promptRepo(JSON.stringify({ prompt: "text" }))), []);
  assert.deepEqual(promptModeProtect("/definitely/not/a/folder"), []);
});

test("a change to prompt mode's prompt file is refused", () => {
  const dir = promptRepo(JSON.stringify({ version: 1, prompt: { kind: "file", path: "prompts/agent.md" }, objective: "o" }));
  const cfg = config({ promptFiles: promptModeProtect(dir) });
  assert.equal(protectedChanges(["src/ok.py", "prompts/agent.md"], cfg).length, 1);
  assert.equal(protectedChanges(["prompts/agent.md"], cfg)[0], "prompts/agent.md is the prompt file Synthe's prompt mode tunes (named in synthe.json); improve mode leaves it alone.");
  assert.doesNotMatch(protectedChanges(["prompts/agent.md"], cfg)[0], /--protect/);
  assert.equal(protectedChanges(["prompts/other.md"], cfg).length, 0);
});
