import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { loadProblem } from "../cli/problem.ts";
import { bootId, processAlive, startTime } from "./boot.ts";
import { release, take, type Taken } from "./excl.ts";
import { readRun, stillRunning } from "./resume.ts";

// A queue of solve jobs that survives a machine replacement (swarm/GOAL-4.md). Every call is a new process, so all
// state is in files in the queue folder: one job file `<id>.json`, one status file `<id>.status.json` for each job,
// and the lock `tick.lock` of the tick that runs now. A missing status file means `queued`.

export type JobState = "queued" | "running" | "done" | "failed";

export interface JobFile {
  id: string;
  problem: string; // absolute path
  options: string[]; // solve options, as given to `queue add`
  cwd: string; // the folder of `queue add`: relative solve options are relative to it
  added: string;
}

export interface JobStatus {
  state: JobState;
  attempts: number; // every start of solve for this job, resumes included
  failures: number; // setup failures: at SETUP_TRIES the job is failed
  time: string;
  result?: string; // the path of result.json
  reason?: string;
  // The solve process that tick started for this job, written right after the start, before solve does any git
  // work. Until solve writes its run record, this is the only sign that it runs (swarm/GOAL-4.md, stage 5c).
  solve?: { pid: number; boot: string; start?: string | null };
}

export const SETUP_TRIES = 3;
// The exit code of `solve` when another solve of the same problem runs (src/cli/solve.ts).
export const SOLVE_ALREADY_RUNNING = 3;
const jobPath = (dir: string, id: string) => join(dir, `${id}.json`);
const statusPath = (dir: string, id: string) => join(dir, `${id}.status.json`);

function writeAtomic(file: string, text: string) {
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

// The ids sort by the time they were added, so the oldest job is first.
function newId(): string {
  const t = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "-").replace("Z", "");
  return `job-${t}-${Math.random().toString(36).slice(2, 6)}`;
}

export function listJobs(dir: string): JobFile[] {
  if (!existsSync(dir)) return [];
  const jobs: JobFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json") || name.endsWith(".status.json")) continue;
    try {
      const j = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (j && typeof j.id === "string" && `${j.id}.json` === name && typeof j.problem === "string" && Array.isArray(j.options)) jobs.push(j);
    } catch { /* not a job file */ }
  }
  return jobs;
}

export function readStatus(dir: string, id: string): JobStatus {
  try {
    const s = JSON.parse(readFileSync(statusPath(dir, id), "utf8"));
    if (s && ["queued", "running", "done", "failed"].includes(s.state)) return { attempts: 0, failures: 0, time: "", ...s };
  } catch { /* no status yet */ }
  return { state: "queued", attempts: 0, failures: 0, time: "" };
}

function writeStatus(dir: string, id: string, s: Omit<JobStatus, "time">) {
  writeAtomic(statusPath(dir, id), JSON.stringify({ ...s, time: new Date().toISOString() }, null, 2) + "\n");
}

// `queue add <queue-dir> <problem-file> [solve options]`.
export function queueAdd(args: string[], cwd: string, say: (l: string) => void): number {
  const [dirArg, fileArg, ...options] = args;
  if (!dirArg || !fileArg) { say("Usage: npx synthe queue add <queue-dir> <problem-file> [solve options]"); return 1; }
  if (options.includes("--resume")) { say("Leave out --resume: tick adds it when a job was cut off."); return 1; }
  const problem = resolve(cwd, fileArg);
  const check = loadProblem(problem, cwd);
  if (!check.ok) { for (const p of check.problems) say(p); say("The job was not added. Fix the problem file, then add it again."); return 1; }
  const dir = resolve(cwd, dirArg);
  mkdirSync(dir, { recursive: true });
  const id = newId();
  const job: JobFile = { id, problem, options, cwd, added: new Date().toISOString() };
  writeAtomic(jobPath(dir, id), JSON.stringify(job, null, 2) + "\n");
  say(`Added job ${id}`);
  say(`Run \`npx synthe tick ${dirArg}\` to run it, and \`npx synthe queue status ${dirArg}\` to see it.`);
  return 0;
}

// `queue status <queue-dir>`: one line for each job, oldest first.
export function queueStatus(args: string[], cwd: string, say: (l: string) => void): number {
  if (!args[0]) { say("Usage: npx synthe queue status <queue-dir>"); return 1; }
  const dir = resolve(cwd, args[0]);
  const jobs = listJobs(dir);
  if (!jobs.length) { say(`No jobs in ${dir}. Add one with \`npx synthe queue add\`.`); return 0; }
  for (const job of jobs) {
    const s = readStatus(dir, job.id);
    say(`${job.id}  ${s.state.padEnd(7)}  tries ${s.attempts}${s.time ? `  since ${s.time}` : ""}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// The lock: the files `tick.lock.<n>` of excl.ts. A tick marks its lock released when it ends.

const LOCK = "tick.lock";

export function takeLock(dir: string, boot: string, env: NodeJS.ProcessEnv = process.env): Taken {
  return take(dir, LOCK, boot, Number(env.SYNTHE_TEST_LOCK_PAUSE_MS ?? 0) || 0);
}

// ---------------------------------------------------------------------------------------------------------------
// tick

// Where solve writes result.json for this job: the same rule as solve() uses.
function resultPath(job: JobFile): string | undefined {
  const check = loadProblem(job.problem, job.cwd);
  if (!check.ok) return undefined;
  const i = job.options.indexOf("--out");
  let outDir: string;
  if (i >= 0 && job.options[i + 1]) outDir = isAbsolute(job.options[i + 1]) ? job.options[i + 1] : resolve(job.cwd, job.options[i + 1]);
  else {
    try {
      const top = execFileSync("git", ["-C", check.problem.dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
      outDir = join(top, ".synthe", "solve", check.problem.name);
    } catch { return undefined; }
  }
  const file = join(outDir, "result.json");
  return existsSync(file) ? file : undefined;
}

export interface Runner {
  // Runs `solve` with these arguments in `cwd`, prints its output, and gives its exit code and its last lines.
  // `started` gets the process id of solve as soon as it starts.
  solve(args: string[], cwd: string, log: string, started?: (pid: number, start: string | null) => void): Promise<{ code: number; tail: string }>;
  // The process id of the solve run of this job when it still runs on this boot, else null.
  stillGoing?(job: JobFile): number | null;
  // The result.json of a solve run of this job that ended by itself after `since` (ms), else undefined.
  endedSince?(job: JobFile, since: number): string | undefined;
}

// The solve run record of the job's problem (resume.ts), or null.
function runOf(job: JobFile) {
  const check = loadProblem(job.problem, job.cwd);
  if (!check.ok) return null;
  try {
    const gitDir = resolve(check.problem.dir, execFileSync("git", ["-C", check.problem.dir, "rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim());
    return readRun(gitDir, check.problem.name);
  } catch { return null; }
}

// The process id of the job's solve run when it still runs on this boot. That happens when a tick dies and the
// solve process it started does not.
export function solveStillGoing(job: JobFile): number | null {
  const run = runOf(job);
  return run && run.status === "running" && stillRunning(run) ? run.pid : null;
}

// The result.json of a solve run that ended by its own stop rule after `since` (ms), when its tick died first.
export function solveEndedSince(job: JobFile, since: number): string | undefined {
  if (runOf(job)?.status !== "ended") return undefined;
  const result = resultPath(job);
  try { return result && statSync(result).mtimeMs >= since ? result : undefined; } catch { return undefined; }
}

// Runs `solve` as a child process of this CLI, so a crash in one job cannot take the tick with it. Its output goes
// to a log file, not a pipe: when the tick dies, its solve goes on and a later tick sees it still going. The tick
// copies the new lines of the log to its own output while the solve runs.
export const childRunner = (): Runner => ({
  stillGoing: solveStillGoing,
  endedSince: solveEndedSince,
  solve: (args, cwd, log, started) => new Promise((done) => {
    const fd = openSync(log, "a");
    let at = fstatSync(fd).size;
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "solve", ...args], { cwd, env: process.env, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    if (child.pid) {
      // The test seam: a wait between the start of solve and the status write that names it.
      const ms = Number(process.env.SYNTHE_TEST_SPAWN_PAUSE_MS ?? 0) || 0;
      if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      started?.(child.pid, startTime(child.pid));
    }
    const copy = () => {
      try {
        const text = readFileSync(log);
        if (text.length > at) { process.stdout.write(text.subarray(at)); at = text.length; }
      } catch { /* the log is gone: nothing to copy */ }
    };
    const timer = setInterval(copy, 500);
    const end = (code: number, why?: string) => {
      clearInterval(timer);
      copy();
      let tail = why ?? "";
      try { tail ||= readFileSync(log, "utf8").slice(-4000); } catch { /* no log */ }
      done({ code, tail });
    };
    child.on("error", (e) => end(1, e.message));
    child.on("close", (code) => end(code ?? 1));
  }),
});

const lastLines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" ").slice(0, 600);

// `tick <queue-dir>`: safe to call at any time. It takes the lock, continues a cut-off job with `solve --resume`
// or starts the oldest queued job, one job at a time, until no job is left that it may run now.
export async function tick(args: string[], cwd: string, say: (l: string) => void, runner: Runner = childRunner(), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!args[0]) { say("Usage: npx synthe tick <queue-dir>"); return 1; }
  const dir = resolve(cwd, args[0]);
  if (!existsSync(dir)) { say(`No jobs: ${dir} does not exist. Add one with \`npx synthe queue add\`.`); return 0; }
  const boot = bootId(env);
  const lock = takeLock(dir, boot, env);
  if (!lock.ok) {
    say(`Another tick holds the lock in ${dir}${lock.held.pid ? ` (process ${lock.held.pid})` : ""}. It runs the jobs; this tick exits.`);
    return 0;
  }
  if (lock.stale) say("Took over the lock of a tick that stopped (its process ended, or the machine was replaced).");
  try {
    // A job that fails in setup is tried again by a later tick, not by this one: the cause can take time to clear.
    const triedNow = new Set<string>();
    for (;;) {
      const jobs = listJobs(dir).map((job) => ({ job, status: readStatus(dir, job.id) }));
      const next = jobs.find((j) => j.status.state === "running") ?? jobs.find((j) => j.status.state === "queued" && !triedNow.has(j.job.id));
      if (!next) {
        const waiting = jobs.filter((j) => j.status.state === "queued").length;
        say(waiting ? `No more jobs to run now. ${waiting} queued job${waiting === 1 ? "" : "s"} failed setup this time; a later tick tries again.` : "No job is left: the queue is done.");
        return 0;
      }
      const { job, status } = next;
      triedNow.add(job.id);
      // A job whose solve still runs is not cut off: leave it alone, and run no other job beside it.
      // Its solve runs when the solve process that a tick started, or the one in its run record, lives on this boot.
      const child = status.solve && status.solve.boot === boot && processAlive(status.solve.pid, status.solve.start) ? status.solve.pid : null;
      const going = status.attempts > 0 ? child ?? runner.stillGoing?.(job) ?? null : null;
      if (going) {
        say(`Job ${job.id} is still running (solve process ${going}), so this tick leaves it alone and runs no other job. Call tick again when it ends.`);
        return 0;
      }
      // A tick died while its solve went on, and that solve has ended by its own stop rule since: the job is done.
      const ended = status.state === "running" ? runner.endedSince?.(job, Date.parse(status.time) || 0) : undefined;
      if (ended) {
        writeStatus(dir, job.id, { state: "done", attempts: status.attempts, failures: status.failures, result: ended });
        say(`Job ${job.id} is done: its solve ended after its tick stopped. Result: ${ended}`);
        continue;
      }
      // A job that started before was cut off or failed: --resume goes on with its run, or starts one when
      // there is none to continue.
      const resume = status.attempts > 0;
      const attempts = status.attempts + 1;
      writeStatus(dir, job.id, { state: "running", attempts, failures: status.failures });
      say(status.state === "running" ? `Continuing job ${job.id}, which was cut off, with solve --resume.` : `Starting job ${job.id}: ${job.problem}`);
      const r = await runner.solve([job.problem, ...job.options, ...(resume ? ["--resume"] : [])], job.cwd, join(dir, `${job.id}.log`),
        (pid, start) => writeStatus(dir, job.id, { state: "running", attempts, failures: status.failures, solve: { pid, boot, start } }));
      // Exit 3: another solve holds the claim on this problem (stage 5d). The job is still going: not a setup try.
      if (r.code === SOLVE_ALREADY_RUNNING) {
        writeStatus(dir, job.id, { state: "running", attempts: status.attempts, failures: status.failures, ...(status.solve ? { solve: status.solve } : {}) });
        say(`Job ${job.id} is still running: another solve of its problem holds the claim, so this tick leaves it alone. Call tick again when it ends.`);
        return 0;
      }
      if (r.code === 0) {
        const result = resultPath(job);
        writeStatus(dir, job.id, { state: "done", attempts, failures: status.failures, ...(result ? { result } : {}) });
        say(`Job ${job.id} is done.${result ? ` Result: ${result}` : ""}`);
        continue;
      }
      // A solve that refused to start because the run still goes is not a setup failure.
      const late = runner.stillGoing?.(job) ?? null;
      if (late) {
        writeStatus(dir, job.id, { state: "running", attempts: status.attempts, failures: status.failures });
        say(`Job ${job.id} is still running (solve process ${late}), so this tick leaves it alone. Call tick again when it ends.`);
        return 0;
      }
      const failures = status.failures + 1;
      const why = lastLines(r.tail) || `solve exited ${r.code}`;
      if (failures >= SETUP_TRIES) {
        writeStatus(dir, job.id, { state: "failed", attempts, failures, reason: `Setup failed ${failures} times. Last output: ${why}` });
        say(`Job ${job.id} failed ${failures} times in setup, so it is failed. Fix the cause and add it again with \`npx synthe queue add\`.`);
      } else {
        writeStatus(dir, job.id, { state: "queued", attempts, failures, reason: `Setup failed (try ${failures} of ${SETUP_TRIES}): ${why}` });
        say(`Job ${job.id} failed in setup (try ${failures} of ${SETUP_TRIES}). A later tick tries again.`);
      }
    }
  } finally {
    release(dir, LOCK, lock.n);
  }
}

export async function queueCommand(args: string[], cwd: string, say: (l: string) => void): Promise<number> {
  if (args[0] === "add") return queueAdd(args.slice(1), cwd, say);
  if (args[0] === "status") return queueStatus(args.slice(1), cwd, say);
  say("Usage: npx synthe queue add <queue-dir> <problem-file> [solve options]\n       npx synthe queue status <queue-dir>");
  return 1;
}
