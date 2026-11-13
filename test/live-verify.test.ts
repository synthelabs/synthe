import assert from "node:assert/strict";
import { test } from "node:test";
import { scopeProblem, TASK_FILES } from "../scripts/verify-live.mjs";

test("scope: a file outside the task's list is named", () => {
  assert.equal(scopeProblem(["src/live/rule.ts"], ["src/live/rule.ts"]), null);
  assert.equal(scopeProblem(["src/live/rule.ts", "src/core/goal.ts"], ["src/live/rule.ts"]), "Changed outside this task: src/core/goal.ts");
});

test("scope: every task 0 to 7 has a file list", () => {
  for (const id of ["0", "1", "2", "3", "4", "5", "6", "7"]) assert.ok(TASK_FILES[id]?.length, id);
});
