import { shellExec, type Exec } from "../improve/exec.ts";

export type Split = "train" | "holdout";

export interface MeasureOptions {
  /** The scratch checkout. */
  cwd: string;
  command: string;
  /** Runs per measurement. GOAL.md's default is 3. */
  runs?: number;
  /** Sets SYNTHE_SPLIT for the command. Leave it out when the problem has no holdout split. */
  split?: Split;
  exec?: Exec;
  timeoutMs?: number;
}

export type Measured = { ok: true; runs: number[] } | { ok: false; reason: string };

export type GuardResult = { ok: true } | { ok: false; guard: string; reason: string };

export const DEFAULT_RUNS = 3;
// A measure or guard that hangs must not hang the whole run. Ten minutes is far above any zoo problem.
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/** The last number on stdout is the score (GOAL.md). null when there is none. */
export function lastNumber(stdout: string): number | null {
  const all = stdout.match(NUMBER);
  if (!all) return null;
  const n = Number(all[all.length - 1]);
  return Number.isFinite(n) ? n : null;
}

// The last lines of output, so a reason says what the command printed without a wall of text.
function tail(text: string, lines = 3): string {
  const t = text.trim().split("\n").slice(-lines).join(" | ").trim();
  return t.length > 300 ? `...${t.slice(-300)}` : t;
}

function failure(what: string, command: string, r: { timedOut: boolean; stdout: string; stderr: string }, timeoutMs: number): string {
  if (r.timedOut) return `${what} \`${command}\` did not finish in ${Math.round(timeoutMs / 1000)} seconds.`;
  const said = tail(r.stderr) || tail(r.stdout);
  return `${what} \`${command}\` failed${said ? `: ${said}` : " and printed nothing."}`;
}

/** Runs the measure command `runs` times and returns every score. Any failed run fails the measurement. */
export async function measure(o: MeasureOptions): Promise<Measured> {
  const exec = o.exec ?? shellExec;
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = o.split ? { SYNTHE_SPLIT: o.split } : undefined;
  const runs: number[] = [];
  for (let i = 0; i < Math.max(1, o.runs ?? DEFAULT_RUNS); i++) {
    const r = await exec(o.cwd, o.command, timeoutMs, env);
    if (!r.ok) return { ok: false, reason: failure("The measure command", o.command, r, timeoutMs) };
    const n = lastNumber(r.stdout);
    if (n === null) return { ok: false, reason: `The measure command \`${o.command}\` printed no number. Its last number on stdout is the score.` };
    runs.push(n);
  }
  return { ok: true, runs };
}

/** Runs each guard in order and stops at the first that fails. The reason names that guard. */
export async function runGuards(cwd: string, guards: string[], exec: Exec = shellExec, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<GuardResult> {
  for (const guard of guards) {
    const r = await exec(cwd, guard, timeoutMs);
    if (!r.ok) return { ok: false, guard, reason: failure("The guard", guard, r, timeoutMs) };
  }
  return { ok: true };
}
