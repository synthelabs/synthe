import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Ctrl-C in the middle of a solve run: the measure command is stopped, the scratch worktree is removed, no empty
// branch is left, and the person's working tree does not change. A branch that holds a kept change stays.
const CLI = join(import.meta.dirname, "..", "src", "cli", "main.ts");

function fixture(hangAt: number, proposals: { from: number; to: number }[]) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "synthe-interrupt-")));
  const dir = join(base, "repo");
  mkdirSync(join(dir, "measure"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "T");
  const pidFile = join(base, "measure.pid");
  // solve makes its scratch checkout here, not in the shared temp folder, where other test files that run at the
  // same time make and remove their own: only this run's leftovers count.
  const tmp = join(base, "tmp");
  mkdirSync(tmp);
  writeFileSync(join(dir, "knob.txt"), "level=10\n");
  // The measure hangs (and says so in pidFile) when the level is `hangAt`. Otherwise it prints the level.
  writeFileSync(join(dir, "measure", "score.js"), `const fs = require("fs"), path = require("path");
const v = Number(fs.readFileSync(path.join(__dirname, "..", "knob.txt"), "utf8").match(/level=(\\d+)/)[1]);
if (v === ${hangAt}) { fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 120000); }
else console.log(v);
`);
  writeFileSync(join(dir, "propose.js"), `let raw = ""; process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  const input = JSON.parse(raw);
  const all = ${JSON.stringify(proposals)};
  const p = all[input.round - 1];
  process.stdout.write(JSON.stringify({ proposals: p ? [{ summary: "level " + p.to, edits: [{ path: "knob.txt", search: "level=" + p.from, replace: "level=" + p.to }] }] : [] }));
});
`);
  writeFileSync(join(dir, ".gitignore"), ".synthe/\n");
  writeFileSync(join(dir, "problem.json"), JSON.stringify({
    version: 1, name: "stop", goal: "Raise the level.", artifact: ["knob.txt"], protect: ["measure/**"],
    measure: { command: "node measure/score.js", direction: "higher", runs: 1 }, proposer: { command: "node propose.js" },
  }));
  git("add", "-A");
  git("commit", "-qm", "start");
  return { base, dir, git, pidFile, tmp };
}

const scratchDirs = (tmp: string) => new Set(readdirSync(tmp).filter((n) => n.startsWith("synthe-solve-")));

async function interrupt(f: ReturnType<typeof fixture>) {
  const before = scratchDirs(f.tmp);
  const env = { ...process.env, TMPDIR: f.tmp, TMP: f.tmp, TEMP: f.tmp };
  const child = spawn(process.execPath, [CLI, "solve", "problem.json"], { cwd: f.dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const closed = new Promise<number | null>((ok) => child.on("close", ok));
  const deadline = Date.now() + 30_000;
  while (!existsSync(f.pidFile)) {
    assert.ok(Date.now() < deadline, `the measure never started its slow run\n${out}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill("SIGINT");
  const code = await closed;
  const measurePid = Number(readFileSync(f.pidFile, "utf8"));
  const isAlive = () => { try { process.kill(measurePid, 0); return true; } catch { return false; } };
  // A killed process can take a moment to go away.
  for (let i = 0; i < 60 && isAlive(); i++) await new Promise((r) => setTimeout(r, 50));
  const alive = isAlive();
  const leftover = [...scratchDirs(f.tmp)].filter((n) => !before.has(n));
  return { code, out, alive, leftover };
}

test("Ctrl-C before any kept change: no worktree, no branch, no working-tree change", async (t) => {
  const f = fixture(11, [{ from: 10, to: 11 }]);
  t.after(() => rmSync(f.base, { recursive: true, force: true }));
  const head = f.git("rev-parse", "HEAD");
  const r = await interrupt(f);
  assert.equal(r.code, 130, r.out);
  assert.match(r.out, /Stopped/);
  assert.equal(r.alive, false, "the slow measure was stopped");
  assert.deepEqual(r.leftover, [], "no scratch folder is left");
  assert.equal(f.git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1, "only the person's worktree");
  assert.equal(f.git("for-each-ref", "refs/heads/synthe/"), "", "no empty branch");
  assert.equal(f.git("rev-parse", "HEAD"), head);
  assert.equal(f.git("branch", "--show-current"), "main");
  assert.equal(f.git("status", "--porcelain"), "");
});

test("Ctrl-C after a kept change: the branch with that change stays, nothing else is left", async (t) => {
  const f = fixture(13, [{ from: 10, to: 12 }, { from: 12, to: 13 }]);
  t.after(() => rmSync(f.base, { recursive: true, force: true }));
  const r = await interrupt(f);
  assert.equal(r.code, 130, r.out);
  assert.match(r.out, /synthe\/solve-stop-1/);
  assert.equal(r.alive, false, "the slow measure was stopped");
  assert.deepEqual(r.leftover, [], "no scratch folder is left");
  assert.equal(f.git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1);
  assert.equal(f.git("show", "synthe/solve-stop-1:knob.txt"), "level=12");
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(readFileSync(join(f.dir, "knob.txt"), "utf8"), "level=10\n");
});
