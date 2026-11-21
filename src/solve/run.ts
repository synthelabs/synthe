import { spawn } from "node:child_process";
import { childEnv } from "../improve/exec.ts";

export interface RunResult { ok: boolean; code: number | null; stdout: string; stderr: string; timedOut: boolean }
export interface RunOptions { stdin?: string; env?: Record<string, string>; timeoutMs?: number }

export const COMMAND_TIMEOUT_MS = 600_000;
const MAX_OUTPUT = 4 * 1024 * 1024;

// Runs one shell command of the problem (measure, guard, proposer, judge) and never throws. The command gets the
// person's environment without Synthe's own keys and tokens (see childEnv), plus only the SYNTHE_* values named in
// `env`, such as SYNTHE_SPLIT and SYNTHE_SEED. So a measure command can never read SYNTHE_API_KEY.
export function runCommand(cwd: string, command: string, o: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const win = process.platform === "win32";
    const child = spawn(win ? "cmd" : "sh", [win ? "/c" : "-c", command], { cwd, env: { ...childEnv(), ...o.env }, stdio: ["pipe", "pipe", "pipe"], detached: !win });
    let stdout = "", stderr = "", timedOut = false, done = false;
    child.stdout.on("data", (d: Buffer) => { if (stdout.length < MAX_OUTPUT) stdout += d.toString().slice(0, MAX_OUTPUT - stdout.length); });
    child.stderr.on("data", (d: Buffer) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString().slice(0, MAX_OUTPUT - stderr.length); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (win) child.kill("SIGKILL"); else process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
    }, o.timeoutMs ?? COMMAND_TIMEOUT_MS);
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut });
    };
    child.on("error", (e) => { stderr += e.message; finish(null); });
    child.on("close", finish);
    // A command that does not read its stdin closes the pipe early; that is not an error.
    child.stdin.on("error", () => {});
    child.stdin.end(o.stdin ?? "");
  });
}
