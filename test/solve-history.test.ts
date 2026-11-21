import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendHistory, gitCommonDir, historyFile, nextRun, readHistory, readStored } from "../src/solve/history.ts";

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "synthe-history-")));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

test("a new problem has no history and run 1", () => {
  const dir = repo();
  assert.deepEqual(readHistory(dir, "tune"), []);
  assert.equal(nextRun(dir, "tune"), 1);
});

test("attempts from an earlier run come back in order, with only the four proposer fields", () => {
  const dir = repo();
  appendHistory(dir, "tune", 1, { round: 1, summary: "raise rate", kept: true, reason: "score 10 -> 12" });
  appendHistory(dir, "tune", 1, { round: 2, summary: "lower depth", kept: false, reason: "no gain" });
  assert.equal(nextRun(dir, "tune"), 2);
  appendHistory(dir, "tune", 2, { round: 1, summary: "try again", kept: false, reason: "guard failed" });
  assert.deepEqual(readHistory(dir, "tune"), [
    { round: 1, summary: "raise rate", kept: true, reason: "score 10 -> 12" },
    { round: 2, summary: "lower depth", kept: false, reason: "no gain" },
    { round: 1, summary: "try again", kept: false, reason: "guard failed" },
  ]);
  assert.deepEqual(readStored(dir, "tune").map((e) => e.run), [1, 1, 2]);
  assert.equal(nextRun(dir, "tune"), 3);
});

test("history lives in the git dir, so the working tree stays clean", () => {
  const dir = repo();
  appendHistory(dir, "tune", 1, { round: 1, summary: "s", kept: false, reason: "r" });
  assert.ok(historyFile(dir, "tune").startsWith(join(dir, ".git")));
  assert.equal(git(dir, "status", "--porcelain"), "");
});

test("a worktree of the repository shares the same history", () => {
  const dir = repo();
  const wt = join(realpathSync(mkdtempSync(join(tmpdir(), "synthe-history-wt-"))), "wt");
  git(dir, "worktree", "add", "-q", "--detach", wt);
  appendHistory(wt, "tune", 1, { round: 1, summary: "from worktree", kept: true, reason: "r" });
  assert.equal(gitCommonDir(wt), gitCommonDir(dir));
  assert.deepEqual(readHistory(dir, "tune").map((e) => e.summary), ["from worktree"]);
});

test("problems keep separate histories, and a bad name never becomes a path", () => {
  const dir = repo();
  appendHistory(dir, "a", 1, { round: 1, summary: "for a", kept: false, reason: "r" });
  assert.deepEqual(readHistory(dir, "b"), []);
  assert.throws(() => historyFile(dir, "../escape"), /letters, digits/);
  assert.throws(() => appendHistory(dir, "a/b", 1, { round: 1, summary: "s", kept: false, reason: "r" }), /letters, digits/);
});

test("a torn or foreign line is skipped, and the rest of the memory survives", () => {
  const dir = repo();
  appendHistory(dir, "tune", 1, { round: 1, summary: "good", kept: true, reason: "r" });
  const file = historyFile(dir, "tune");
  appendFileSync(file, '{"round": 2, "summ\n');
  appendFileSync(file, '{"other": true}\n');
  appendHistory(dir, "tune", 1, { round: 3, summary: "after", kept: false, reason: "r" });
  assert.deepEqual(readHistory(dir, "tune").map((e) => e.summary), ["good", "after"]);
});

test("a subfolder of the repository finds the same git dir", () => {
  const dir = repo();
  const sub = join(dir, "problems", "x");
  mkdirSync(sub, { recursive: true });
  appendHistory(sub, "tune", 1, { round: 1, summary: "s", kept: false, reason: "r" });
  assert.ok(existsSync(historyFile(dir, "tune")));
});
