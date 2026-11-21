import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const CLI = join(import.meta.dirname, "..", "src", "cli", "main.ts");
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

// More interrupt cases than test/solve-interrupt.test.ts (a slow measure): a stop while the proposer runs, and a
// stop after a kept change, which must keep that branch and nothing else.

// A repository with a problem whose proposer offers a real gain each round, except in round `hangAt`: there it
// hangs until it is stopped.
function setup(hangAt: number) {
  const base = mkdtempSync(join(tmpdir(), "synthe-interrupt-"));
  const repo = join(base, "repo");
  const pids = join(base, "pids");
  mkdirSync(join(repo, "p"), { recursive: true });
  mkdirSync(pids);
  // Its own temp folder for scratch checkouts, so this run never shows up in another test's count of them.
  mkdirSync(join(base, "tmp"));
  const files: Record<string, string> = {
    "README.md": "hello\n",
    "p/config.json": '{"level": 10}\n',
    "p/measure.js": `const fs = require("fs");
const level = JSON.parse(fs.readFileSync("config.json", "utf8")).level;
console.log(level);
`,
    "p/propose.js": `const fs = require("fs");
const req = JSON.parse(fs.readFileSync(0, "utf8"));
const hang = ${hangAt};
if (req.round === hang) {
  fs.writeFileSync(${JSON.stringify(join(pids, "proposer"))}, String(process.pid));
  setTimeout(() => {}, 120000);
} else {
  const text = req.files.find((f) => f.path === "config.json").text;
  const level = JSON.parse(text).level;
  const edits = [{ path: "config.json", search: '"level": ' + level, replace: '"level": ' + (level + 5) }];
  process.stdout.write(JSON.stringify({ proposals: [{ summary: "raise the level", edits }] }));
}
`,
    "p/problem.json": JSON.stringify({
      version: 1, name: "stop", goal: "Raise the level.", artifact: ["config.json"],
      measure: { command: "node measure.js", direction: "higher", runs: 3 }, proposer: { command: "node propose.js" }, budget: { max_rounds: 5 },
    }),
  };
  for (const [p, text] of Object.entries(files)) writeFileSync(join(repo, p), text);
  git(repo, "init", "-q", "-b", "work");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return { base, repo, pids };
}

async function waitFor(file: string, ms = 30_000): Promise<number> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(file)) { const pid = Number(readFileSync(file, "utf8")); if (pid) return pid; }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${file} did not appear`);
}

// A killed process can stay a zombie until its new parent reaps it; a zombie runs nothing.
const running = (pid: number) => {
  try { process.kill(pid, 0); } catch { return false; }
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return true; }
};
async function alive(pid: number): Promise<boolean> {
  for (let i = 0; i < 50 && running(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return running(pid);
}

async function interrupted(hangAt: number, signal: NodeJS.Signals) {
  const s = setup(hangAt);
  const head = git(s.repo, "rev-parse", "HEAD");
  const child = spawn(process.execPath, [CLI, "solve", "p/problem.json", "--out", join(s.base, "out")], { cwd: s.repo, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: join(s.base, "tmp") } });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const exited = new Promise<number | null>((r) => child.on("close", (code) => r(code)));
  const pid = await waitFor(join(s.pids, "proposer"));
  child.kill(signal);
  const code = await exited;
  return { ...s, head, code, out, pid };
}

function assertClean(r: { repo: string; head: string }) {
  assert.equal(git(r.repo, "status", "--porcelain"), "", "the working tree did not change");
  assert.equal(git(r.repo, "rev-parse", "HEAD"), r.head);
  assert.equal(git(r.repo, "branch", "--show-current"), "work");
  assert.equal(git(r.repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1, "no scratch worktree is left");
}

test("Ctrl-C before any keep: the proposer stops, and no worktree, no branch and no change are left", { skip: process.platform === "win32" }, async (t) => {
  const r = await interrupted(1, "SIGINT");
  t.after(() => rmSync(r.base, { recursive: true, force: true }));
  assert.equal(r.code, 130, r.out);
  assert.match(r.out, /Stopped\. .*kept no change/);
  assert.equal(await alive(r.pid), false, "the proposer was stopped");
  assertClean(r);
  assert.deepEqual(readdirSync(join(r.base, "tmp")), [], "no scratch folder is left");
  assert.equal(git(r.repo, "branch", "--list", "synthe/*"), "", "no empty branch is left");
});

test("a kill after one keep: the branch with the kept change stays; nothing else is left", { skip: process.platform === "win32" }, async (t) => {
  const r = await interrupted(2, "SIGTERM");
  t.after(() => rmSync(r.base, { recursive: true, force: true }));
  assert.equal(r.code, 130, r.out);
  assert.match(r.out, /on the branch synthe\/solve-stop-1/);
  assertClean(r);
  assert.deepEqual(readdirSync(join(r.base, "tmp")), [], "no scratch folder is left");
  assert.equal(git(r.repo, "branch", "--list", "--format=%(refname:short)", "synthe/*"), "synthe/solve-stop-1");
  assert.equal(git(r.repo, "show", "synthe/solve-stop-1:p/config.json"), '{"level": 15}');
  assert.equal(readFileSync(join(r.repo, "p/config.json"), "utf8"), '{"level": 10}\n');
});
