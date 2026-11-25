import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bootId, processAlive, startTime } from "../src/solve/boot.ts";
import { release, take } from "../src/solve/excl.ts";
import { listJobs, queueAdd, queueStatus, readStatus, takeLock, tick, type Runner } from "../src/solve/queue.ts";
import { stillRunning, type RunRecord } from "../src/solve/resume.ts";

const temp = () => mkdtempSync(join(tmpdir(), "synthe-queue-"));
const lines = () => { const out: string[] = []; return { out, say: (l: string) => out.push(l) }; };
const env = (boot: string) => ({ ...process.env, SYNTHE_BOOT_ID: boot });

function problemFile(dir: string): string {
  const file = join(dir, "p.json");
  execFileSync("git", ["init", "-q", dir]);
  writeFileSync(join(dir, "x"), "1\n");
  writeFileSync(file, JSON.stringify({ version: 1, name: "q", goal: "g", artifact: ["x"], measure: { command: "echo 1", direction: "higher" } }));
  return file;
}

function addJobFile(dir: string, id: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, problem: join(dir, "none.json"), options: [], cwd: dir, added: "" }));
}

// A runner that records each solve call and answers with the next exit code for that problem.
function fakeRunner(codes: Record<string, number[]>): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    solve: async (args) => {
      calls.push(args);
      const code = codes[args[0]]?.shift() ?? 0;
      return { code, tail: code ? "p.json: the measure is missing." : "Done." };
    },
  };
}

test("the boot id comes from SYNTHE_BOOT_ID, else the machine", () => {
  assert.equal(bootId({ SYNTHE_BOOT_ID: "abc" }), "abc");
  assert.ok(bootId({}).length > 0);
  assert.equal(bootId({}), bootId({}));
});

test("solve --resume: a run from another boot is never still running, even when its process id is alive", () => {
  const prev = process.env.SYNTHE_BOOT_ID;
  try {
    process.env.SYNTHE_BOOT_ID = "now";
    const parent = process.ppid; // alive, and not this process
    assert.ok(processAlive(parent));
    const record = { pid: parent, boot: "now" } as RunRecord;
    assert.equal(stillRunning(record), true, "same boot, live process");
    assert.equal(stillRunning({ ...record, boot: "before" }), false, "another boot");
    assert.equal(stillRunning({ ...record, boot: "" }), true, "a record from before boot ids falls back to the process id");
  } finally {
    if (prev === undefined) delete process.env.SYNTHE_BOOT_ID; else process.env.SYNTHE_BOOT_ID = prev;
  }
});

test("queue add writes one job file and prints its id; a bad problem file is refused", () => {
  const dir = temp(), q = join(dir, "queue"), problem = problemFile(dir);
  const a = lines();
  assert.equal(queueAdd([q, "p.json", "--out", "out"], dir, a.say), 0);
  const jobs = listJobs(q);
  assert.equal(jobs.length, 1);
  assert.ok(a.out[0].includes(jobs[0].id));
  assert.equal(jobs[0].problem, problem);
  assert.deepEqual(jobs[0].options, ["--out", "out"]);
  assert.equal(readStatus(q, jobs[0].id).state, "queued", "no status file means queued");

  const b = lines();
  assert.equal(queueAdd([q, "missing.json"], dir, b.say), 1);
  assert.equal(queueAdd([q, "p.json", "--resume"], dir, b.say), 1);
  assert.equal(listJobs(q).length, 1);
  const s = lines();
  assert.equal(queueStatus([q], dir, s.say), 0);
  assert.equal(s.out.length, 1);
  assert.match(s.out[0], new RegExp(`^${jobs[0].id}\\s+queued\\b`));
});

test("the lock: a live lock on this boot holds; a dead process or another boot is taken over", () => {
  const q = temp();
  writeFileSync(join(q, "tick.lock.1"), JSON.stringify({ pid: process.ppid, boot: "b1", time: "" }));
  assert.equal(takeLock(q, "b1").ok, false);
  assert.deepEqual(takeLock(q, "b2"), { ok: true, n: 2, stale: true });
  assert.equal(JSON.parse(readFileSync(join(q, "tick.lock.2"), "utf8")).pid, process.pid);

  const dead = spawn(process.execPath, ["-e", ""]);
  return new Promise<void>((done) => dead.on("close", () => {
    writeFileSync(join(q, "tick.lock.3"), JSON.stringify({ pid: dead.pid, boot: "b1", time: "" }));
    assert.deepEqual(takeLock(q, "b1"), { ok: true, n: 4, stale: true });
    done();
  }));
});

test("the lock takeover is atomic: a tick that waits after judging a lock stale loses to a newer lock", async () => {
  const q = temp();
  writeFileSync(join(q, "tick.lock.1"), JSON.stringify({ pid: 999_999_999, boot: "old", time: "" }));
  // The child judges lock 1 stale, waits 3 s (the test seam), then tries to take it over.
  const src = `import { takeLock } from ${JSON.stringify(join(import.meta.dirname, "..", "src", "solve", "queue.ts"))};
console.log(JSON.stringify(takeLock(process.argv[1], "now")));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", src, q], { env: { ...process.env, SYNTHE_TEST_LOCK_PAUSE_MS: "3000" } });
  let out = "";
  child.stdout.on("data", (b) => (out += b));
  const ended = new Promise<number>((done) => child.on("close", (code) => done(code ?? 1)));
  // While the child waits, this process takes the stale lock over and holds it.
  const started = Date.now();
  await new Promise((r) => setTimeout(r, 1000));
  const mine = takeLock(q, "now");
  assert.deepEqual(mine, { ok: true, n: 2, stale: true });
  assert.equal(await ended, 0);
  assert.ok(Date.now() - started >= 2500, "the child judged lock 1 stale and waited: the race happened");
  const theirs = JSON.parse(out);
  assert.equal(theirs.ok, false, `the waiting tick must not also hold the lock: ${out}`);
  assert.equal(theirs.held.pid, process.pid);
});

test("tick exits at once when a live tick holds the lock", async () => {
  const q = temp();
  addJobFile(q, "job-1");
  writeFileSync(join(q, "tick.lock.1"), JSON.stringify({ pid: process.ppid, boot: "b", time: "" }));
  const r = fakeRunner({}), o = lines();
  assert.equal(await tick([q], q, o.say, r, env("b")), 0);
  assert.match(o.out.join("\n"), /Another tick holds the lock/);
  assert.equal(r.calls.length, 0);
});

test("tick runs jobs oldest first, continues a cut-off job with --resume, and fails a job after 3 setup tries", async () => {
  const q = temp();
  for (const id of ["job-3", "job-1", "job-2"]) addJobFile(q, id);
  // job-1 was cut off by a dead tick on another boot.
  writeFileSync(join(q, "job-1.status.json"), JSON.stringify({ state: "running", attempts: 1, failures: 0, time: "" }));
  writeFileSync(join(q, "tick.lock.1"), JSON.stringify({ pid: process.ppid, boot: "old", time: "" }));
  const bad = join(q, "none.json");
  // job-2 and job-3 share the problem path: give job-2 its own.
  const two = JSON.parse(readFileSync(join(q, "job-2.json"), "utf8"));
  writeFileSync(join(q, "job-2.json"), JSON.stringify({ ...two, problem: join(q, "bad.json") }));
  const r = fakeRunner({ [join(q, "bad.json")]: [1, 1, 1, 1] });

  const o = lines();
  assert.equal(await tick([q], q, o.say, r, env("new")), 0);
  assert.deepEqual(r.calls.map((c) => [c[0], c.includes("--resume")]), [[bad, true], [join(q, "bad.json"), false], [bad, false]],
    "the cut-off job first with --resume, then the oldest queued job; a setup failure is not tried again in the same tick");
  assert.equal(readStatus(q, "job-1").state, "done");
  assert.equal(readStatus(q, "job-3").state, "done");
  assert.deepEqual([readStatus(q, "job-2").state, readStatus(q, "job-2").failures], ["queued", 1]);
  assert.match(o.out.join("\n"), /No more jobs to run now/);
  assert.equal(JSON.parse(readFileSync(join(q, "tick.lock.2"), "utf8")).released, true, "tick releases its lock");

  await tick([q], q, () => {}, r, env("new"));
  await tick([q], q, () => {}, r, env("new"));
  const failed = readStatus(q, "job-2");
  assert.deepEqual([failed.state, failed.attempts, failed.failures], ["failed", 3, 3]);
  assert.match(failed.reason!, /Setup failed 3 times.*measure/);
  assert.ok(r.calls.slice(3).every((c) => c.includes("--resume")), "a retry resumes, or starts a run when there is none");

  const last = lines();
  await tick([q], q, last.say, r, env("new"));
  assert.equal(r.calls.length, 5, "a failed job is not tried again");
  assert.match(last.out.join("\n"), /No job is left/);
});

test("a job whose solve still runs on this boot is left alone and is not a setup try", async () => {
  const q = temp();
  addJobFile(q, "job-1");
  addJobFile(q, "job-2");
  writeFileSync(join(q, "job-1.status.json"), JSON.stringify({ state: "running", attempts: 1, failures: 0, time: "" }));
  const r = { ...fakeRunner({}), stillGoing: () => 4242 }, o = lines();
  assert.equal(await tick([q], q, o.say, r, env("b")), 0);
  assert.equal(r.calls.length, 0, "no solve ran: not the running job, and no other job beside it");
  assert.match(o.out.join("\n"), /still running \(solve process 4242\)/);
  assert.deepEqual([readStatus(q, "job-1").state, readStatus(q, "job-1").attempts, readStatus(q, "job-1").failures], ["running", 1, 0]);
  assert.equal(readStatus(q, "job-2").state, "queued");
});

test("a job whose solve ended by itself after its tick died is done, and is not run again", async () => {
  const q = temp();
  addJobFile(q, "job-1");
  writeFileSync(join(q, "job-1.status.json"), JSON.stringify({ state: "running", attempts: 1, failures: 0, time: new Date().toISOString() }));
  const r = { ...fakeRunner({}), stillGoing: () => null, endedSince: () => "/repo/result.json" };
  assert.equal(await tick([q], q, () => {}, r, env("b")), 0);
  assert.equal(r.calls.length, 0, "no solve ran again");
  const s = readStatus(q, "job-1");
  assert.deepEqual([s.state, s.result, s.attempts], ["done", "/repo/result.json", 1]);
});

test("tick records the solve process at once, and a job whose recorded solve lives on this boot is still going", async () => {
  const q = temp();
  addJobFile(q, "job-1");
  let seen: unknown;
  const r: Runner = {
    solve: async (_args, _cwd, _log, started) => {
      started?.(4242, null);
      seen = readStatus(q, "job-1").solve; // before solve writes any run record
      return { code: 0, tail: "" };
    },
  };
  assert.equal(await tick([q], q, () => {}, r, env("b")), 0);
  assert.deepEqual(seen, { pid: 4242, boot: "b", start: null });

  // A tick died before solve wrote its run record: only the status names the live solve.
  addJobFile(q, "job-2");
  addJobFile(q, "job-3");
  const live = { state: "running", attempts: 1, failures: 0, time: "", solve: { pid: process.ppid, boot: "b" } };
  writeFileSync(join(q, "job-2.status.json"), JSON.stringify(live));
  const f = { ...fakeRunner({}), stillGoing: () => null }, o = lines();
  assert.equal(await tick([q], q, o.say, f, env("b")), 0);
  assert.equal(f.calls.length, 0, "no second solve of the job, and no other job beside it");
  assert.match(o.out.join("\n"), new RegExp(`still running \\(solve process ${process.ppid}\\)`));
  assert.deepEqual([readStatus(q, "job-2").state, readStatus(q, "job-2").failures], ["running", 0]);

  // The same record from another boot is not a live solve: the job continues with --resume.
  writeFileSync(join(q, "job-2.status.json"), JSON.stringify({ ...live, solve: { pid: process.ppid, boot: "old" } }));
  assert.equal(await tick([q], q, () => {}, f, env("b")), 0);
  assert.ok(f.calls[0].includes("--resume"));
});

test("a process id with another start time is not the recorded process", () => {
  const start = startTime(process.pid);
  assert.ok(start && /^\d+$/.test(start));
  assert.equal(processAlive(process.pid, start), true);
  assert.equal(processAlive(process.pid, `${Number(start) + 1}`), false, "the id now names another program");
  assert.equal(processAlive(process.pid, null), true, "a record without a start time: the id alone counts");
});

test("excl: one holder; a released or removed holder is taken again, and numbers go on", () => {
  const dir = temp();
  const a = take(dir, "claim", "b");
  assert.deepEqual(a, { ok: true, n: 1, stale: false });
  const held = JSON.parse(readFileSync(join(dir, "claim.1"), "utf8"));
  assert.deepEqual([held.pid, held.boot, held.start], [process.pid, "b", startTime(process.pid)]);
  // A live holder from another process blocks; with a wrong start time it is stale.
  writeFileSync(join(dir, "claim.2"), JSON.stringify({ pid: process.ppid, boot: "b", start: startTime(process.ppid) }));
  assert.equal(take(dir, "claim", "b").ok, false);
  writeFileSync(join(dir, "claim.2"), JSON.stringify({ pid: process.ppid, boot: "b", start: "1" }));
  assert.deepEqual(take(dir, "claim", "b"), { ok: true, n: 3, stale: true });
  release(dir, "claim", 3, true);
  assert.ok(!existsSync(join(dir, "claim.3")) && existsSync(join(dir, "claim.2")), "the holder file goes, the one below stays");
  assert.equal(take(dir, "claim", "b").ok, true);
});

test("solve exits 3 and changes nothing while another solve holds the claim on its problem", () => {
  const dir = temp();
  const file = problemFile(dir);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), proposer: { command: "node -e 0" } }));
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  const claims = join(dir, ".git", "synthe", "solve", "q");
  mkdirSync(claims, { recursive: true });
  writeFileSync(join(claims, "claim.1"), JSON.stringify({ pid: process.ppid, boot: bootId(), start: startTime(process.ppid) }));
  const before = execFileSync("git", ["-C", dir, "status", "--porcelain", "--ignored"], { encoding: "utf8" });
  let code = 0, out = "";
  try {
    execFileSync(process.execPath, [join(import.meta.dirname, "..", "src", "cli", "main.ts"), "solve", "p.json"], { cwd: dir, encoding: "utf8", env: { ...process.env, SYNTHE_BOOT_ID: "" } });
  } catch (e) { code = (e as { status: number }).status; out = String((e as { stdout: string }).stdout); }
  assert.equal(code, 3, out);
  assert.match(out, /already running \(solve process \d+\)/);
  assert.equal(execFileSync("git", ["-C", dir, "status", "--porcelain", "--ignored"], { encoding: "utf8" }), before, "no file changed");
  assert.deepEqual(execFileSync("git", ["-C", dir, "branch", "--format=%(refname:short)"], { encoding: "utf8" }).trim().split("\n").length, 1, "no solve branch");
});

test("tick treats solve exit 3 as still going, not a setup try", async () => {
  const q = temp();
  addJobFile(q, "job-1");
  addJobFile(q, "job-2");
  writeFileSync(join(q, "job-1.status.json"), JSON.stringify({ state: "running", attempts: 1, failures: 0, time: "" }));
  const r = { ...fakeRunner({ [join(q, "none.json")]: [3] }), stillGoing: () => null }, o = lines();
  assert.equal(await tick([q], q, o.say, r, env("b")), 0);
  assert.equal(r.calls.length, 1, "no other job beside it");
  assert.match(o.out.join("\n"), /still running/);
  const s = readStatus(q, "job-1");
  assert.deepEqual([s.state, s.attempts, s.failures], ["running", 1, 0]);
});
