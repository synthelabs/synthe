// P15 checks this statement from swarm/milestones.json: "synthe.self.json at the repository root is a valid problem
// file that points Synthe at its own src/, measures with `npm run bench -- --score` (which prints one number), guards
// with typecheck and tests, and protects bench/, test/, swarm/ and spec/."
//
// How it decides: `problem check synthe.self.json` must exit 0, and a copy without its goal must exit 1 and name the
// field, so the validation is real. The file's fields are read as JSON: every artifact glob is inside src/; the
// measure command is `npm run bench -- --score`; one guard runs the typecheck and one runs the tests; protect globs
// cover files in bench/, test/, swarm/ and spec/. Then `npm run --silent bench -- --score` must exit 0 and print exactly
// one number. (Without --silent, npm adds its own header lines to stdout.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, globToRegExp, gitRepo, isObject, isolatedEnv, readJson, run, synthe, tail, tempDir } from "./helpers-c.ts";

const FILE = join(ROOT, "synthe.self.json");
const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;

test("P15: synthe.self.json is a valid problem file for Synthe's own src/", { timeout: 180_000 }, async () => {
  assert.ok(existsSync(FILE), "synthe.self.json is missing at the repository root");
  const self = readJson(FILE);
  assert.ok(isObject(self), "synthe.self.json is not a JSON object");

  const home = tempDir("p15-home");
  const ok = await synthe(["problem", "check", "synthe.self.json"], { cwd: ROOT, env: isolatedEnv(home), timeoutMs: 30_000 });
  assert.equal(ok.code, 0, `problem check synthe.self.json exited ${ok.code}:\n${tail(ok.stdout + ok.stderr)}`);

  // The same file without its goal must be refused, so a check that accepts everything does not pass.
  const repo = tempDir("p15-broken");
  const { goal: _goal, ...broken } = self;
  gitRepo(repo, { "synthe.self.json": JSON.stringify(broken, null, 2) });
  const bad = await synthe(["problem", "check", "synthe.self.json"], { cwd: repo, env: isolatedEnv(home), timeoutMs: 30_000 });
  assert.equal(bad.code, 1, `problem check must refuse a copy of synthe.self.json without "goal"; it exited ${bad.code}`);
  assert.match(bad.stdout + bad.stderr, /goal/, "the refusal must name the goal field");

  assert.equal(self.version, 1, "version must be 1");
  assert.ok(typeof self.name === "string" && /^[A-Za-z0-9-]+$/.test(self.name), "name must be letters, digits and -");
  assert.ok(typeof self.goal === "string" && self.goal.trim().length > 0, "goal must be a sentence");

  const artifact = self.artifact;
  assert.ok(Array.isArray(artifact) && artifact.length > 0 && artifact.every((g) => typeof g === "string"), "artifact must be a list of globs");
  for (const g of artifact as string[]) assert.ok(g.replace(/^\.\//, "").startsWith("src/"), `artifact glob ${g} is not inside src/`);
  assert.ok((artifact as string[]).some((g) => globToRegExp(g).test("src/cli/main.ts")), "no artifact glob covers Synthe's own code, such as src/cli/main.ts");

  const measure = self.measure;
  assert.ok(isObject(measure) && typeof measure.command === "string", "measure.command is missing");
  assert.equal(measure.command.trim().replace(/\s+/g, " "), "npm run bench -- --score", "measure.command must be `npm run bench -- --score`");

  const guards = self.guards;
  assert.ok(Array.isArray(guards) && guards.every((g) => typeof g === "string"), "guards must be a list of commands");
  assert.ok((guards as string[]).some((g) => /\btypecheck\b|\btsc\b/.test(g)), "no guard runs the typecheck (npm run typecheck)");
  assert.ok((guards as string[]).some((g) => /\bnpm (run )?test\b|\bnpm t\b|node --test/.test(g)), "no guard runs the tests (npm test)");

  const protect = self.protect;
  assert.ok(Array.isArray(protect) && protect.every((g) => typeof g === "string"), "protect must be a list of globs");
  for (const dir of ["bench", "test", "swarm", "spec"]) {
    for (const file of [`${dir}/a.json`, `${dir}/deep/er/b.ts`]) {
      assert.ok((protect as string[]).some((g) => globToRegExp(g).test(file)), `protect does not cover ${file}`);
    }
  }

  const score = await run("npm", ["run", "--silent", "bench", "--", "--score"], { cwd: ROOT, timeoutMs: 120_000 });
  assert.ok(!score.timedOut, "npm run bench -- --score did not finish in 120 s");
  assert.equal(score.code, 0, `npm run bench -- --score exited ${score.code}:\n${tail(score.stderr || score.stdout)}`);
  const numbers = score.stdout.match(NUMBER) ?? [];
  assert.equal(numbers.length, 1, `npm run bench -- --score must print exactly one number; it printed:\n${tail(score.stdout)}`);
  assert.ok(Number.isFinite(Number(numbers[0])), `the score ${numbers[0]} is not a finite number`);
});
