import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

export interface ExecResult { ok: boolean; stdout: string; stderr: string; ms: number; timedOut: boolean }
export type Exec = (cwd: string, command: string, timeoutMs: number) => Promise<ExecResult>;

const MAX_OUTPUT = 4 * 1024 * 1024;
const HIDDEN = ["ANTHROPIC_API_KEY", "GH_TOKEN", "GITHUB_TOKEN"];

// The metric and the guard are the team's own code. They have no reason to see Synthe's codes or a GitHub token.
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("SYNTHE_") && !HIDDEN.includes(k)));
}

export const shellExec: Exec = (cwd, command, timeoutMs) => new Promise((resolve) => {
  const win = process.platform === "win32";
  const started = performance.now();
  // Its own process group off Windows, so a timeout kills `npm run` and everything it started, not just the shell.
  const child = spawn(win ? "cmd" : "sh", [win ? "/c" : "-c", command], { cwd, env: childEnv(), stdio: ["ignore", "pipe", "pipe"], detached: !win });
  let stdout = "", stderr = "", timedOut = false, done = false;
  const take = (into: "out" | "err") => (d: Buffer) => {
    if (into === "out" && stdout.length < MAX_OUTPUT) stdout += d.toString().slice(0, MAX_OUTPUT - stdout.length);
    if (into === "err" && stderr.length < MAX_OUTPUT) stderr += d.toString().slice(0, MAX_OUTPUT - stderr.length);
  };
  child.stdout.on("data", take("out"));
  child.stderr.on("data", take("err"));
  const timer = setTimeout(() => {
    timedOut = true;
    try { if (win) child.kill("SIGKILL"); else process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
  }, timeoutMs);
  const finish = (code: number | null) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    resolve({ ok: code === 0 && !timedOut, stdout, stderr, ms: Math.round(performance.now() - started), timedOut });
  };
  child.on("error", (e) => { stderr += e.message; finish(null); });
  child.on("close", finish);
});
