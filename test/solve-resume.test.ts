import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readState, stateFile, writeState } from "../src/solve/resume.ts";

// `solve --resume` (S03): a run that a kill stopped continues where its last finished round ended.
const MAIN = join(process.cwd(), "src/cli/main.ts");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// A repo whose measure prints the number in level.json, and a proposer that adds 1 to it every round. In the round
// named by the file `block`, the proposer logs that it started and then waits, so the test can kill solve there.
function project(t: { after(fn: () => void): void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "synthe-resume-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "measure"), { recursive: true });
  writeFileSync(join(repo, "level.json"), `{ "level": 1 }\n`);
  writeFileSync(join(repo, "measure/score.js"), `console.log(JSON.parse(require("fs").readFileSync("level.json", "utf8")).level);\n`);
  const log = join(root, "proposer.log");
  const block = join(root, "block");
  writeFileSync(join(root, "propose.cjs"), `const fs = require("fs");
let raw = "";
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  const input = JSON.parse(raw);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ round: input.round, history: input.history, pid: process.pid }) + "\\n");
  const reply = () => {
    const text = input.files.find((f) => f.path === "level.json").text;
    const n = JSON.parse(text).level;
    process.stdout.write(JSON.stringify({ proposals: [{ summary: "raise the level to " + (n + 1), edits: [{ path: "level.json", search: '"level": ' + n, replace: '"level": ' + (n + 1) }] }] }));
  };
  if (fs.existsSync(${JSON.stringify(block)}) && Number(fs.readFileSync(${JSON.stringify(block)}, "utf8")) === input.round) setTimeout(reply, 60000);
  else reply();
});
`);
  writeFileSync(join(repo, "problem.json"), JSON.stringify({
    version: 1, name: "resume-demo", goal: "Raise the level.",
    artifact: ["level.json"], protect: ["measure/**"],
    measure: { command: "node measure/score.js", direction: "higher", unit: "levels", runs: 1 },
    proposer: { command: `node ${JSON.stringify(join(root, "propose.cjs"))}` },
    budget: { max_rounds: 5 },
  }, null, 2));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-qm", "start");
  const calls = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { root, repo, log, block, out: join(root, "out"), calls };
}

function solve(repo: string, out: string, ...extra: string[]) {
  // Scratch checkouts go to a temp folder of this test's own: a hard kill leaves one behind until the resume, and
  // other test files look for leftovers in the shared temp folder.
  const tmp = join(repo, "..", "tmp");
  mkdirSync(tmp, { recursive: true });
  const env = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
  const child = spawn(process.execPath, [MAIN, "solve", join(repo, "problem.json"), "--out", out, ...extra], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  child.stdout.on("data", (d) => { text += d; });
  child.stderr.on("data", (d) => { text += d; });
  const done = new Promise<{ code: number | null; text: string }>((ok) => child.on("close", (code) => ok({ code, text })));
  return { child, done };
}

async function until(check: () => boolean, ms = 30000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function killInRound(p: ReturnType<typeof project>, round: number, signal: NodeJS.Signals) {
  writeFileSync(p.block, String(round));
  const first = solve(p.repo, p.out);
  await until(() => p.calls().some((c) => c.round === round));
  first.child.kill(signal);
  const stopped = await first.done;
  for (const c of p.calls()) try { process.kill(c.pid, "SIGKILL"); } catch { /* already gone */ }
  unlinkSync(p.block);
  return stopped;
}

test("after a hard kill in round 3, --resume keeps rounds 1 and 2, does not repeat them, and finishes the run", async (t) => {
  const p = project(t);
  const headBefore = git(p.repo, "rev-parse", "HEAD");
  await killInRound(p, 3, "SIGKILL");
  assert.equal(readState(join(p.repo, ".git"), "resume-demo")?.status, "running");
  const before = p.calls().length;

  const resumed = await solve(p.repo, p.out, "--resume").done;
  assert.equal(resumed.code, 0, resumed.text);
  assert.match(resumed.text, /Resuming run 1 of resume-demo after round 2/);
  const later = p.calls().slice(before);
  assert.deepEqual(later.map((c) => c.round), [3, 4, 5], "rounds 1 and 2 are not asked again");
  // The proposer hears each earlier attempt once.
  assert.deepEqual(later[0].history.map((h: { round: number }) => h.round), [1, 2]);

  const result = JSON.parse(readFileSync(join(p.out, "result.json"), "utf8"));
  assert.deepEqual(result.attempts.map((a: { round: number; kept: boolean }) => [a.round, a.kept]), [[1, true], [2, true], [3, true], [4, true], [5, true]]);
  assert.equal(result.baseline, 1, "the baseline is the first run's starting score");
  assert.equal(result.final, 6);
  assert.equal(result.branch, "synthe/solve-resume-demo-1");
  assert.match(result.stopped, /round limit/);
  assert.equal(git(p.repo, "show", "synthe/solve-resume-demo-1:level.json"), `{ "level": 6 }`);
  assert.equal(git(p.repo, "rev-list", "--count", "main..synthe/solve-resume-demo-1"), "5", "one commit per kept round, none twice");
  // The person's checkout did not move, and no scratch checkout is left.
  assert.equal(git(p.repo, "rev-parse", "HEAD"), headBefore);
  assert.equal(git(p.repo, "status", "--porcelain"), "");
  assert.equal(git(p.repo, "worktree", "list").split("\n").length, 1);
  assert.equal(readState(join(p.repo, ".git"), "resume-demo")?.status, "done");

  // After a run that ended normally, --resume starts a new run and says so.
  const finished = p.calls().length;
  const again = await solve(p.repo, p.out, "--resume").done;
  assert.equal(again.code, 0, again.text);
  assert.match(again.text, /ended normally .*Starting a new run/);
  assert.equal(p.calls()[finished].round, 1, "the new run starts at round 1");
  assert.equal(JSON.parse(readFileSync(join(p.out, "result.json"), "utf8")).branch, "synthe/solve-resume-demo-2");
});

test("after Ctrl-C in round 1 with nothing kept, --resume makes the branch again and runs every round", async (t) => {
  const p = project(t);
  const stopped = await killInRound(p, 1, "SIGINT");
  assert.equal(stopped.code, 130, stopped.text);
  assert.equal(git(p.repo, "branch", "--list", "synthe/solve-*"), "", "the clean-up removed the empty branch");
  const resumed = await solve(p.repo, p.out, "--resume").done;
  assert.equal(resumed.code, 0, resumed.text);
  assert.match(resumed.text, /Resuming run 1 of resume-demo after round 0/);
  const result = JSON.parse(readFileSync(join(p.out, "result.json"), "utf8"));
  assert.deepEqual(result.attempts.map((a: { round: number }) => a.round), [1, 2, 3, 4, 5]);
  assert.equal(result.branch, "synthe/solve-resume-demo-1");
  assert.equal(result.final, 6);
});

test("--resume with no earlier run starts a new run and says so", async (t) => {
  const p = project(t);
  const r = await solve(p.repo, p.out, "--resume").done;
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /No earlier run of resume-demo to resume\. Starting a new run\./);
  assert.equal(JSON.parse(readFileSync(join(p.out, "result.json"), "utf8")).final, 6);
});

test("a run state that cannot be read counts as no state", (t) => {
  const p = project(t);
  const gitDir = join(p.repo, ".git");
  assert.equal(readState(gitDir, "resume-demo"), null);
  writeState(gitDir, "resume-demo", { status: "running", run: 2, branch: "b", base: "x", root: "/nowhere", head: "x", rounds: 1, attempts: [{ round: 1, summary: "s", kept: false, reason: "r" }], baseline: 3, calls: 0, idle: 1, keptAny: false });
  assert.equal(readState(gitDir, "resume-demo")?.run, 2);
  writeFileSync(stateFile(gitDir, "resume-demo"), "{ torn");
  assert.equal(readState(gitDir, "resume-demo"), null);
});
