import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { runBuilder, type BuilderInput } from "../src/builder/engine.ts";

function fixture(t: TestContext) {
  const repo = mkdtempSync(join(tmpdir(), "synthe-builder-fixture-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, "checks"));
  writeFileSync(join(repo, "app.cjs"), "module.exports = 2;\n");
  writeFileSync(join(repo, "checks", "metric.cjs"), "if (process.env.SYNTHE_EVENT_CODE) process.exit(3); console.log(require('../app.cjs'));\n");
  writeFileSync(join(repo, "checks", "guard.cjs"), "if (require('../app.cjs') > 8) process.exit(5);\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", "--", "app.cjs", "checks");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Seed product");
  const input: BuilderInput = {
    repo, goal: "Improve capacity", metricCommand: "node checks/metric.cjs", direction: "higher",
    target: 5, guardCommand: "node checks/guard.cjs", mode: "review", refine: async () => "Improve capacity while preserving correctness",
    runAgent: async (cwd, prompt) => {
      assert.equal(readFileSync(join(cwd, "app.cjs"), "utf8"), "module.exports = 2;\n");
      assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim(), git("rev-parse", "HEAD"));
      writeFileSync(join(cwd, "app.cjs"), `module.exports = ${prompt.includes("correctness") ? 7 : 5};\n`);
      if (prompt.includes("correctness")) writeFileSync(join(cwd, "helper.bin"), Buffer.from([0, 255, 127]));
    },
  };
  return { repo, git, input };
}

test("review measures a fixed baseline and both independent trials without leaking event codes or writing back", async (t) => {
  const { input, git, repo } = fixture(t);
  const previous = process.env.SYNTHE_EVENT_CODE;
  process.env.SYNTHE_EVENT_CODE = "fixture-only";
  t.after(() => {
    if (previous === undefined) delete process.env.SYNTHE_EVENT_CODE;
    else process.env.SYNTHE_EVENT_CODE = previous;
  });
  const result = await runBuilder(input);
  assert.deepEqual([result.baseline.value, result.original.value, result.refined.value], [2, 5, 7]);
  assert.equal(result.winner, "refined");
  assert.equal(result.applied, false);
  assert.ok(result.patchPath);
  t.after(() => rmSync(dirname(result.patchPath!), { recursive: true, force: true }));
  const patch = readFileSync(result.patchPath, "utf8");
  assert.match(patch, /GIT binary patch/);
  assert.match(patch, /module.exports = 7/);
  assert.equal(git("status", "--short"), "");
  assert.equal(existsSync(join(repo, "helper.bin")), false);
});

test("auto rejects a guard regression and applies only a passing local patch, leaving HEAD unchanged", async (t) => {
  const { input, git, repo } = fixture(t);
  const before = git("rev-parse", "HEAD");
  const result = await runBuilder({
    ...input, mode: "auto",
    runAgent: async (cwd, prompt) => writeFileSync(join(cwd, "app.cjs"), `module.exports = ${prompt === input.goal ? 5 : 9};\n`),
  });
  assert.equal(result.winner, "original");
  assert.equal(result.refined.guardsPassed, false);
  assert.match(result.refined.reason!, /regression check/);
  assert.equal(result.applied, true);
  assert.equal(readFileSync(join(repo, "app.cjs"), "utf8"), "module.exports = 5;\n");
  assert.equal(git("rev-parse", "HEAD"), before);
  t.after(() => rmSync(dirname(result.patchPath!), { recursive: true, force: true }));
});

test("the agent cannot win by editing an approved evaluator or aiming below the target", async (t) => {
  const { input } = fixture(t);
  const result = await runBuilder({
    ...input,
    runAgent: async (cwd, prompt) => {
      if (prompt === input.goal) writeFileSync(join(cwd, "checks", "metric.cjs"), "console.log(20);\n");
      else writeFileSync(join(cwd, "app.cjs"), "module.exports = 4;\n");
    },
  });
  assert.equal(result.winner, null);
  assert.match(result.original.reason!, /protected file/);
  assert.match(result.refined.reason!, /did not reach/);
});

test("candidate commands cannot access host files or credentials and get separate scratch space", async (t) => {
  const { input, git, repo } = fixture(t);
  const canary = mkdtempSync(join(tmpdir(), "synthe-evaluator-canary-"));
  const canaryFile = join(canary, "host-only.txt");
  writeFileSync(canaryFile, "host-only");
  t.after(() => rmSync(canary, { recursive: true, force: true }));
  const oldCanary = process.env.SYNTHE_BUILDER_HOST_CANARY;
  process.env.SYNTHE_BUILDER_HOST_CANARY = "host-only";
  t.after(() => {
    if (oldCanary === undefined) delete process.env.SYNTHE_BUILDER_HOST_CANARY;
    else process.env.SYNTHE_BUILDER_HOST_CANARY = oldCanary;
  });
  writeFileSync(join(repo, "checks", "metric.cjs"), `
    const fs = require('node:fs');
    fs.writeFileSync('metric-scratch', 'only in this check');
    console.log(require('../app.cjs'));
  `);
  writeFileSync(join(repo, "checks", "guard.cjs"), `
    const fs = require('node:fs');
    if (fs.existsSync('metric-scratch')) process.exit(1);
    if (require('../app.cjs') > 8) process.exit(2);
  `);
  git("add", "--", "checks");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Isolate checks");
  const result = await runBuilder({
    ...input,
    runAgent: async (cwd, prompt) => {
      writeFileSync(join(cwd, "app.cjs"), `
        const fs = require('node:fs');
        const assert = require('node:assert/strict');
        assert.equal(process.env.SYNTHE_BUILDER_HOST_CANARY, undefined);
        assert.equal(fs.existsSync(${JSON.stringify(canaryFile)}), false);
        assert.equal(fs.existsSync('.git'), false);
        assert.equal(fs.existsSync('/var/run/docker.sock'), false);
        assert.equal(process.getuid(), 1000);
        assert.throws(() => fs.writeFileSync('/outside-scratch', 'candidate'));
        assert.ok(Object.values(require('node:os').networkInterfaces()).flat().every(address => address.internal));
        module.exports = ${prompt === input.goal ? 5 : 7};
      `);
    },
  });
  assert.equal(result.winner, "refined");
  assert.equal(result.refined.guardsPassed, true);
  assert.equal(git("status", "--short"), "");
  assert.equal(readFileSync(canaryFile, "utf8"), "host-only");
  if (result.patchPath) t.after(() => rmSync(dirname(result.patchPath!), { recursive: true, force: true }));
});

test("a remote Docker endpoint stops before the refinement and coding attempts", async (t) => {
  const { input } = fixture(t);
  const host = process.env.DOCKER_HOST, context = process.env.DOCKER_CONTEXT;
  process.env.DOCKER_HOST = "tcp://127.0.0.1:1";
  delete process.env.DOCKER_CONTEXT;
  t.after(() => {
    if (host === undefined) delete process.env.DOCKER_HOST;
    else process.env.DOCKER_HOST = host;
    if (context !== undefined) process.env.DOCKER_CONTEXT = context;
  });
  await assert.rejects(runBuilder({
    ...input,
    refine: async () => assert.fail("refinement must wait for the evaluator"),
    runAgent: async () => assert.fail("the agent must wait for the evaluator"),
  }), /local Docker context/);
});
