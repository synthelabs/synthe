import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { scopeProblem, staleDistProblem, statusPaths, TASK_FILES, testRunProblem } from "../scripts/verify-live.mjs";

test("scope: a file outside the task's list is named", () => {
  assert.equal(scopeProblem(["src/live/rule.ts"], ["src/live/rule.ts"]), null);
  assert.equal(scopeProblem(["src/live/rule.ts", "src/core/goal.ts"], ["src/live/rule.ts"]), "Changed outside this task: src/core/goal.ts");
});

test("scope: every task 0 to 7 has a file list", () => {
  for (const id of ["0", "1", "2", "3", "4", "5", "6", "7"]) assert.ok(TASK_FILES[id]?.length, id);
});

test("G3: a test file that ran no test of its own is named", () => {
  const out = "TAP version 13\nok 1 - test/live-plan.test.ts\n# tests 1\n# skipped 0\n# todo 0\n";
  assert.match(testRunProblem(out, ["test/live-plan.test.ts"]) ?? "", /test\/live-plan\.test\.ts/);
});

test("G3: a normal run with tests passes", () => {
  const out = "TAP version 13\n# Subtest: test/live-plan.test.ts\n    ok 1 - adds up\n    ok 2 - orders\n# tests 2\n# skipped 0\n# todo 0\n";
  assert.equal(testRunProblem(out, ["test/live-plan.test.ts"]), null);
});

test("G3: a skipped test is a problem", () => {
  const out = "TAP version 13\nok 1 - adds up # SKIP\n# tests 1\n# skipped 1\n# todo 0\n";
  assert.ok(testRunProblem(out, ["test/live-plan.test.ts"]));
});

test("G3: a run with no tests summary is a problem", () => {
  assert.ok(testRunProblem("TAP version 13\n", ["test/live-plan.test.ts"]));
});

test("G1 and G7 read renames as delete plus add", () => {
  assert.equal(statusPaths([" D src/old.ts", "A  src/new.ts", "?? test/x.test.ts"]).join(","), "src/old.ts,src/new.ts,test/x.test.ts");
  const source = readFileSync(new URL("../scripts/verify-live.mjs", import.meta.url), "utf8");
  assert.ok((source.match(/"--no-renames"/g) ?? []).length >= 3, "two git diff calls and one git status call need --no-renames");
});

test("G4: dist/ that changed during npm test is not a fresh build", () => {
  assert.equal(
    staleDistProblem({ "dist/cli.js": "a", "dist/action.mjs": "b" }, { "dist/cli.js": "a", "dist/action.mjs": "b" }),
    null,
  );
  assert.equal(
    staleDistProblem({ "dist/cli.js": "a", "dist/action.mjs": "b" }, { "dist/cli.js": "x", "dist/action.mjs": "b" }),
    "dist/ is not a fresh build of src/: run npm run build and include dist/ in the commit.",
  );
});
