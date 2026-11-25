import { spawn } from "node:child_process";
import { childEnv } from "../improve/exec.ts";

export interface RunResult { ok: boolean; code: number | null; stdout: string; stderr: string; timedOut: boolean }
export interface RunOptions { stdin?: string; env?: Record<string, string>; timeoutMs?: number }

export const COMMAND_TIMEOUT_MS = 600_000;

// For every measure, guard, `run` and `compare` command. Python reuses a cached .pyc file when the source has the
// same size and the same modification second. A same-size edit made in the same second as the last measurement
// would then be measured with the old code. With no cache written, each measurement runs the code it measures.
// The proposer and the coding agent do not get it: they measure nothing.
export const FRESH_ENV: Readonly<Record<string, string>> = Object.freeze({ PYTHONDONTWRITEBYTECODE: "1" });
const MAX_OUTPUT = 4 * 1024 * 1024;

// Process groups of problem commands still running. Each command runs in its own group (detached), so a Ctrl-C
// in the terminal does not reach it. An interrupted solve stops them with stopRunning().
const live = new Set<number>();

export function stopRunning(): void {
  const win = process.platform === "win32";
  for (const pid of live) {
    try { process.kill(win ? pid : -pid, "SIGKILL"); } catch { /* already gone */ }
  }
  live.clear();
}

// Runs one shell command of the problem (measure, guard, proposer, judge) and never throws. The command gets the
// person's environment without Synthe's own keys and tokens (see childEnv), plus only the SYNTHE_* values named in
// `env`, such as SYNTHE_SPLIT and SYNTHE_SEED. So a measure command can never read SYNTHE_API_KEY.
export function runCommand(cwd: string, command: string, o: RunOptions = {}): Promise<RunResult> {
  const win = process.platform === "win32";
  return start(cwd, win ? "cmd" : "sh", [win ? "/c" : "-c", command], { ...childEnv(), ...o.env }, o);
}

// Runs one program with its arguments as they are: no shell reads them. `env` is the full environment of the
// program. When the program ends, everything left in its process group is stopped too, so nothing that it started
// goes on in the background. Never throws. Used for a coding agent (agent.ts).
export function runProgram(cwd: string, file: string, args: string[], env: NodeJS.ProcessEnv, o: { timeoutMs?: number } = {}): Promise<RunResult> {
  return start(cwd, file, args, env, o, true);
}

function start(cwd: string, file: string, args: string[], env: NodeJS.ProcessEnv, o: RunOptions, sweep = false): Promise<RunResult> {
  return new Promise((resolve) => {
    const win = process.platform === "win32";
    const child = spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: !win });
    if (child.pid) live.add(child.pid);
    let stdout = "", stderr = "", timedOut = false, done = false;
    child.stdout.on("data", (d: Buffer) => { if (stdout.length < MAX_OUTPUT) stdout += d.toString().slice(0, MAX_OUTPUT - stdout.length); });
    child.stderr.on("data", (d: Buffer) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString().slice(0, MAX_OUTPUT - stderr.length); });
    const killGroup = () => {
      try { if (win) child.kill("SIGKILL"); else if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, o.timeoutMs ?? COMMAND_TIMEOUT_MS);
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      if (child.pid) live.delete(child.pid);
      clearTimeout(timer);
      if (sweep) killGroup();
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut });
    };
    child.on("error", (e) => { stderr += e.message; finish(null); });
    child.on("close", finish);
    // A command that does not read its stdin closes the pipe early; that is not an error.
    child.stdin.on("error", () => {});
    child.stdin.end(o.stdin ?? "");
  });
}
