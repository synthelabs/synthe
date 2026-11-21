import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nextBranch, openScratch } from "../src/solve/scratch.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function repo(): string {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "solve-scratch-")));
  git(top, "init", "-q", "-b", "main");
  git(top, "config", "user.name", "T");
  git(top, "config", "user.email", "t@example.com");
  mkdirSync(join(top, "prob"));
  writeFileSync(join(top, "prob", "config.json"), '{"x":1}\n');
  mkdirSync(join(top, "node_modules"));
  writeFileSync(join(top, ".gitignore"), "node_modules\n");
  git(top, "add", "-A");
  git(top, "commit", "-qm", "init");
  return top;
}

test("a kept change lands on synthe/solve-<name>-1; the working tree and branch do not change", async () => {
  const top = repo();
  writeFileSync(join(top, "prob", "config.json"), '{"x":"dirty"}\n'); // an uncommitted edit stays out
  const s = await openScratch(top, join(top, "prob"), "demo");
  assert.equal(s.branch, "synthe/solve-demo-1");
  assert.equal(s.dir, join(s.root, "prob"));
  assert.equal(s.base, git(top, "rev-parse", "HEAD"));
  assert.equal(readFileSync(join(s.dir, "config.json"), "utf8"), '{"x":1}\n');
  assert.ok(existsSync(join(s.root, "node_modules")), "dependencies are linked");

  writeFileSync(join(s.dir, "config.json"), '{"x":2}\n');
  writeFileSync(join(s.dir, "other.txt"), "not named, so not committed");
  const sha = await s.commit(["prob/config.json"], "Raise x");
  assert.equal(git(s.root, "diff", "--name-only", s.base, "HEAD"), "prob/config.json");

  writeFileSync(join(s.dir, "config.json"), '{"x":3}\n');
  writeFileSync(join(s.dir, "junk.txt"), "made by the measure");
  await s.reset();
  assert.equal(readFileSync(join(s.dir, "config.json"), "utf8"), '{"x":2}\n');
  assert.ok(!existsSync(join(s.dir, "junk.txt")));
  assert.ok(!existsSync(join(s.dir, "other.txt")));
  assert.ok(existsSync(join(s.root, "node_modules")), "reset keeps the dependency link");

  await s.close(true);
  await s.close(true); // a second close is harmless
  assert.ok(!existsSync(s.root));
  assert.ok(existsSync(join(top, "node_modules")), "cleanup never reaches into the real node_modules");
  assert.equal(git(top, "rev-parse", "synthe/solve-demo-1"), sha);
  assert.equal(git(top, "show", "synthe/solve-demo-1:prob/config.json"), '{"x":2}');
  assert.equal(git(top, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(readFileSync(join(top, "prob", "config.json"), "utf8"), '{"x":"dirty"}\n');
  assert.equal(git(top, "worktree", "list").split("\n").length, 1);
  assert.equal(nextBranch(top, "demo"), "synthe/solve-demo-2");
});

test("a run that keeps nothing leaves no branch; the next run reuses the number", async () => {
  const top = repo();
  const s = await openScratch(top, join(top, "prob"), "demo");
  await s.close(false);
  assert.equal(git(top, "branch", "--list", "synthe/*"), "");
  const t = await openScratch("", join(top, "prob"), "demo");
  assert.equal(t.branch, "synthe/solve-demo-1");
  await t.close(true);
  const u = await openScratch(top, join(top, "prob"), "demo");
  assert.equal(u.branch, "synthe/solve-demo-2");
  await u.close(false);
});

test("a folder outside git, or not committed, is a plain setup error", async () => {
  const plain = mkdtempSync(join(tmpdir(), "solve-nogit-"));
  await assert.rejects(openScratch("", plain, "demo"), /not inside a git repository/);
  const top = repo();
  mkdirSync(join(top, "fresh"));
  writeFileSync(join(top, "fresh", "a.txt"), "a");
  await assert.rejects(openScratch(top, join(top, "fresh"), "demo"), /not committed/);
});
