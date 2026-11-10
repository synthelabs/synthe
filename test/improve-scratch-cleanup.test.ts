import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { removeScratchCheckouts } from "../src/improve/loop.ts";

// Found in review: the interrupt cleanup removed any worktree whose folder name started with synthe-improve-,
// including the person's own checkout. It must remove only Synthe's own temp checkouts.
test("the interrupt cleanup never removes the person's checkout, whatever its folder is called", () => {
  const parent = mkdtempSync(join(tmpdir(), "cleanup-test-"));
  const own = join(parent, "synthe-improve-myapp");
  mkdirSync(own);
  const git = (...args: string[]) => execFileSync("git", ["-C", own, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(own, "app.js"), "1\n");
  git("add", ".");
  git("commit", "-qm", "app");
  const scratch = mkdtempSync(join(tmpdir(), "synthe-improve-"));
  rmSync(scratch, { recursive: true });
  git("worktree", "add", "-q", "--detach", scratch, "HEAD");
  const sibling = join(parent, "synthe-improve-feature");
  git("worktree", "add", "-q", "--detach", sibling, "HEAD");

  removeScratchCheckouts(own);

  assert.ok(existsSync(join(own, "app.js")), "the person's checkout must stay");
  assert.ok(existsSync(join(sibling, "app.js")), "the person's other worktrees must stay");
  assert.equal(existsSync(scratch), false, "Synthe's temp checkout is removed");
  rmSync(parent, { recursive: true, force: true });
});
