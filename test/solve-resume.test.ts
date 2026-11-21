import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const CLI = join(import.meta.dirname, "..", "src", "cli", "main.ts");
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

// A problem whose proposer raises the level by 5 in rounds 1 and 2 and then has nothing more. In round `hangAt`
// it hangs, once, until the test kills the whole solve run with SIGKILL: no cleanup code can run.
function setup(hangAt: number) {
  const base = mkdtempSync(join(tmpdir(), "synthe-resume-"));
  const repo = join(base, "repo");
  const side = join(base, "side");
  mkdirSync(join(repo, "p"), { recursive: true });
  mkdirSync(side);
  const files: Record<string, string> = {
    "p/config.json": '{"level": 10}\n',
    "p/measure.js": 'console.log(JSON.parse(require("fs").readFileSync("config.json", "utf8")).level);\n',
    "p/propose.js": `const fs = require("fs");
const req = JSON.parse(fs.readFileSync(0, "utf8"));
fs.appendFileSync(${JSON.stringify(join(side, "rounds.log"))}, req.round + "\\n");
const hang = ${JSON.stringify(join(side, "hung"))};
if (req.round === ${hangAt} && !fs.existsSync(hang)) {
  fs.writeFileSync(hang, String(process.pid));
  setTimeout(() => {}, 120000);
} else if (req.round > 2) {
  process.stdout.write(JSON.stringify({ proposals: [] }));
} else {
  const level = JSON.parse(req.files.find((f) => f.path === "config.json").text).level;
  const edits = [{ path: "config.json", search: '"level": ' + level, replace: '"level": ' + (level + 5) }];
  process.stdout.write(JSON.stringify({ proposals: [{ summary: "raise the level in round " + req.round, edits }] }));
}
`,
    "p/problem.json": JSON.stringify({
      version: 1, name: "res", goal: "Raise the level.", artifact: ["config.json"],
      measure: { command: "node measure.js", direction: "higher", runs: 3 }, proposer: { command: "node propose.js" }, budget: { max_rounds: 6 },
    }),
  };
  for (const [p, text] of Object.entries(files)) writeFileSync(join(repo, p), text);
  git(repo, "init", "-q", "-b", "work");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return { base, repo, side, out: join(base, "out"), head: git(repo, "rev-parse", "HEAD") };
}

type Setup = ReturnType<typeof setup>;

function solve(s: Setup, extra: string[] = []) {
  const child = spawn(process.execPath, [CLI, "solve", "p/problem.json", "--out", s.out, ...extra], { cwd: s.repo, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const done = new Promise<{ code: number | null; out: string }>((r) => child.on("close", (code) => r({ code, out })));
  return { child, done };
}

async function killWhenHung(s: Setup, signal: NodeJS.Signals = "SIGKILL") {
  const run = solve(s);
  const hung = join(s.side, "hung");
  const end = Date.now() + 60_000;
  while (!existsSync(hung) || !readFileSync(hung, "utf8")) {
    if (Date.now() > end) throw new Error("the proposer never hung");
    await new Promise((r) => setTimeout(r, 50));
  }
  run.child.kill(signal);
  await run.done;
  // The proposer is in its own process group, so it outlives a SIGKILL of solve. Stop it like a person would.
  try { process.kill(-Number(readFileSync(hung, "utf8")), "SIGKILL"); } catch { try { process.kill(Number(readFileSync(hung, "utf8")), "SIGKILL"); } catch { /* gone */ } }
}

const rounds = (s: Setup) => readFileSync(join(s.side, "rounds.log"), "utf8").trim().split("\n").map(Number);
const result = (s: Setup) => JSON.parse(readFileSync(join(s.out, "result.json"), "utf8"));
const worktrees = (s: Setup) => git(s.repo, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length;

function assertTreeUnchanged(s: Setup) {
  assert.equal(git(s.repo, "status", "--porcelain"), "", "the working tree did not change");
  assert.equal(git(s.repo, "rev-parse", "HEAD"), s.head);
  assert.equal(git(s.repo, "branch", "--show-current"), "work");
}

test("--resume after a SIGKILL in round 2 keeps round 1's change and attempt, and does not repeat round 1", { skip: process.platform === "win32" }, async () => {
  const s = setup(2);
  await killWhenHung(s);
  assert.equal(existsSync(join(s.out, "result.json")), false, "the killed run wrote no result.json");
  assert.equal(git(s.repo, "show", "synthe/solve-res-1:p/config.json"), '{"level": 15}');

  const r = await solve(s, ["--resume"]).done;
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Resuming run \d+ of res on synthe\/solve-res-1 after round 1/);
  assert.deepEqual(rounds(s), [1, 2, 2, 3], "round 1 was not asked again; round 2 was asked again because it never finished");
  const res = result(s);
  assert.equal(res.problem, "res");
  assert.equal(res.baseline, 10, "the baseline is the first run's");
  assert.equal(res.final, 20);
  assert.equal(res.branch, "synthe/solve-res-1");
  assert.match(res.stopped, /nothing more/);
  assert.deepEqual(res.attempts.map((a: { round: number; kept: boolean; summary: string }) => [a.round, a.kept, a.summary]),
    [[1, true, "raise the level in round 1"], [2, true, "raise the level in round 2"]]);
  assert.ok(existsSync(join(s.out, "report.md")));
  assert.equal(git(s.repo, "show", "synthe/solve-res-1:p/config.json"), '{"level": 20}');
  assert.equal(git(s.repo, "branch", "--list", "--format=%(refname:short)", "synthe/*"), "synthe/solve-res-1", "no second branch");
  assert.equal(worktrees(s), 1, "the killed run's scratch checkout is gone");
  assertTreeUnchanged(s);
});

test("--resume after a SIGKILL in round 1, before any keep, goes on with the same branch name", { skip: process.platform === "win32" }, async () => {
  const s = setup(1);
  await killWhenHung(s);
  const r = await solve(s, ["--resume"]).done;
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /after round 0/);
  const res = result(s);
  assert.equal(res.baseline, 10);
  assert.equal(res.final, 20);
  assert.equal(res.branch, "synthe/solve-res-1");
  assert.deepEqual(res.attempts.map((a: { round: number }) => a.round), [1, 2]);
  assert.equal(worktrees(s), 1);
  assertTreeUnchanged(s);
});

test("--resume after a Ctrl-C before any keep (the empty branch was removed) makes the branch again and goes on", { skip: process.platform === "win32" }, async () => {
  const s = setup(1);
  await killWhenHung(s, "SIGINT");
  assert.equal(git(s.repo, "branch", "--list", "synthe/*"), "", "the stop removed the empty branch");
  const r = await solve(s, ["--resume"]).done;
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Resuming run/);
  assert.equal(result(s).branch, "synthe/solve-res-1");
  assert.equal(result(s).final, 20);
  assertTreeUnchanged(s);
});

test("--resume after a run that ended normally starts a new run and says so", { skip: process.platform === "win32" }, async () => {
  const s = setup(0);
  const first = await solve(s).done;
  assert.equal(first.code, 0, first.out);
  assert.equal(result(s).branch, "synthe/solve-res-1");
  const again = await solve(s, ["--resume"]).done;
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /The last run of res ended normally, so --resume starts a new run/);
  assert.equal(result(s).baseline, 10, "the new run starts from the person's HEAD, not from the old branch");
  assert.equal(result(s).branch, "synthe/solve-res-2");
  assertTreeUnchanged(s);
});

test("--resume with no earlier run starts a new run and says so", { skip: process.platform === "win32" }, async () => {
  const s = setup(0);
  const r = await solve(s, ["--resume"]).done;
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /There is no earlier run of res, so --resume starts a new run/);
  assert.equal(result(s).final, 20);
});
