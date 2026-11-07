import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { guide } from "../src/cli/guide.ts";

// Most hackathon apps have no AI prompt an hour in. The guide must send those repos to improve mode before any
// prompt-mode step runs, and the generated copy must match the document the e2e test prints.
test("the guide routes repos without an AI prompt to improve mode before any prompt-mode step", () => {
  const zero = guide.indexOf("## 0. Which mode");
  const one = guide.indexOf("## 1. Prerequisites");
  const nine = guide.indexOf("## 9. Improve mode");
  assert.ok(zero > -1 && zero < one && nine > one);
  const improve = guide.slice(nine);
  assert.ok(improve.includes("Never guess the goal, the metric or the mode."));
  assert.ok(improve.includes("git worktree add --detach /tmp/synthe-base HEAD"));
  assert.ok(improve.includes("Run the metric command 3 times"));
  assert.ok(improve.includes("gh pr create --base <default branch>"));
  assert.ok(improve.includes("gh pr merge --squash --delete-branch"));
  assert.ok(improve.includes("Never loosen a test or the metric"));
  assert.equal(guide, readFileSync("docs/AGENT-SETUP.md", "utf8"));
});
