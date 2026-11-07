import assert from "node:assert/strict";
import { test } from "node:test";
import { protectedChanges, protectedPathProblem } from "../src/improve/protect.ts";
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
