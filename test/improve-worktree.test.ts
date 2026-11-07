import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { shellExec } from "../src/improve/exec.ts";
import { measureAt, withWorktree } from "../src/improve/worktree.ts";
import { config, custom } from "./improve-helpers.ts";

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

function repo(score = "console.log(3)", testJs = "process.exit(0)") {
  const dir = mkdtempSync(join(tmpdir(), "synthe-wt-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { metric: "node score.js", test: "node test.js" } }));
  writeFileSync(join(dir, "score.js"), score);
  writeFileSync(join(dir, "test.js"), testJs);
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return { dir, head: git(dir, "rev-parse", "HEAD") };
}

const worktrees = (dir: string) => git(dir, "worktree", "list").split("\n").length;

test("measureAt measures the committed code in a throwaway worktree and leaves the repo untouched", async () => {
  const { dir, head } = repo();
  writeFileSync(join(dir, "score.js"), "console.log(99)");   // an uncommitted edit must NOT be measured
  const said: string[] = [];
  const out = await measureAt(shellExec, dir, head, config({ metric: { ...custom("node score.js").metric, runs: 3 }, guard: { command: "node test.js" } }), (l) => said.push(l));
  assert.deepEqual(out.measurement?.runs, [3, 3, 3]);
  assert.equal(out.measurement?.median, 3);
  assert.equal(out.measurement?.commit, head);
  assert.equal(out.guardPassed, true);
  assert.equal(worktrees(dir), 1);
  assert.deepEqual(said, [
    `Measuring valid signups at ${head.slice(0, 7)}, run 1 of 3...`,
    `Measuring valid signups at ${head.slice(0, 7)}, run 2 of 3...`,
    `Measuring valid signups at ${head.slice(0, 7)}, run 3 of 3...`,
    "Running the regression check (node test.js)...",
  ]);
  assert.equal(git(dir, "status", "--porcelain"), "M score.js");
});

test("measureAt reports a failing guard and a metric that prints nothing", async () => {
  const failing = repo("console.log(3)", "process.exit(1)");
  const guarded = await measureAt(shellExec, failing.dir, failing.head, config({ metric: custom("node score.js").metric, guard: { command: "node test.js" } }));
  assert.equal(guarded.guardPassed, false);
  assert.equal(guarded.measurement?.median, 3);
  const silent = repo("console.log('n/a')");
  const said: string[] = [];
  const none = await measureAt(shellExec, silent.dir, silent.head, config({ metric: custom("node score.js").metric, guard: { command: "node test.js" } }), (l) => said.push(l));
  assert.equal(none.measurement, null);
  assert.equal(none.reason, "The metric command printed no number.");
  assert.equal(said.length, 1);   // stops at the first run that gives no number, and skips the guard
  assert.equal(worktrees(silent.dir), 1);
});

test("withWorktree links node_modules from the main checkout and removes the worktree even when the work throws", async () => {
  const { dir, head } = repo();
  mkdirSync(join(dir, "node_modules/x"), { recursive: true });
  let seen = "";
  await withWorktree(shellExec, dir, head, async (wt) => { seen = wt; assert.ok(existsSync(join(wt, "node_modules/x"))); });
  assert.ok(!existsSync(seen));
  assert.ok(existsSync(join(dir, "node_modules/x")));   // the real folder survives the cleanup
  await assert.rejects(withWorktree(shellExec, dir, head, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(worktrees(dir), 1);
  await assert.rejects(withWorktree(shellExec, dir, "0000000000000000000000000000000000000000", async () => 1), /^Error: Could not check out 0000000/);
});
