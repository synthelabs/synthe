import { FRESH_ENV, runCommand, type RunResult } from "./run.ts";
import { isJudged, type Measurement, type Problem } from "./types.ts";

export type Split = "train" | "holdout";
export interface MeasureContext { seed?: number; split?: Split }

// A number with comma thousands separators ("12,345.6") is one number: tools such as toLocaleString and du print
// sizes and counts that way. Only exact groups of three digits count as separators, so "3,4" stays two numbers.
const NUMBER = /[-+]?(?:\d{1,3}(?:,\d{3})+(?:\.\d*)?(?![\d,]\d)|\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/** The last number on stdout is the score (GOAL.md). null when there is none. */
export function lastNumber(stdout: string): number | null {
  const all = stdout.match(NUMBER);
  if (!all) return null;
  const n = Number(all[all.length - 1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

export const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// The last lines of output, so a reason says what the command printed without a wall of text.
function tail(text: string, lines = 3): string {
  const t = text.trim().split("\n").slice(-lines).join(" | ").trim();
  return t.length > 300 ? `...${t.slice(-300)}` : t;
}

// The lines that say what failed. A test runner ends with totals, so its last lines rarely name the failing test;
// "not ok" lines (TAP, node --test) do, and lines with "error" or "fail" usually do. npm's own wrapper lines do not.
function failureLines(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !/^npm (error|ERR!)/i.test(l));
  const notOk = lines.filter((l) => /^not ok\b/.test(l));
  const picked = notOk.length ? notOk : lines.filter((l) => /\b(error|fail(ed|ure|s)?|assert)/i.test(l) && !/^# (fail|pass|tests)\b/.test(l));
  const t = picked.slice(0, 3).join(" | ");
  return t.length > 300 ? `${t.slice(0, 300)}...` : t;
}

/** A plain sentence for a command that did not exit 0. */
export function commandFailure(what: string, command: string, r: RunResult): string {
  if (r.timedOut) return `${what} \`${command}\` did not finish in time.`;
  const said = failureLines(`${r.stdout}\n${r.stderr}`) || tail(r.stderr) || tail(r.stdout);
  return `${what} \`${command}\` failed${said ? `: ${said}` : " and printed nothing"}.`;
}

// Runs the problem's measure in the checkout: measure.command `runs` times (the last number on stdout is the
// score), with SYNTHE_SPLIT set when the problem has a held-back split and SYNTHE_SEED set when there is a seed.
// Returns the measurement, or the plain reason no number came out. Any failed run fails the whole measurement:
// a score from a half-broken run is not a score. Judged measures: judge.ts.
export async function measure(checkout: string, problem: Problem, ctx: MeasureContext = {}): Promise<Measurement | { failed: string }> {
  const m = problem.measure;
  if (isJudged(m)) return { failed: "A judged measure has no command to run; judge.ts compares judged versions." };
  const env: Record<string, string> = { ...FRESH_ENV };
  if (ctx.split) env.SYNTHE_SPLIT = ctx.split;
  if (ctx.seed !== undefined) env.SYNTHE_SEED = String(ctx.seed);
  const runs: number[] = [];
  for (let i = 0; i < Math.max(1, m.runs); i++) {
    const r = await runCommand(checkout, m.command, { env });
    if (!r.ok) return { failed: commandFailure("The measure command", m.command, r) };
    const n = lastNumber(r.stdout);
    if (n === null) return { failed: `The measure command \`${m.command}\` printed no number. Its last number on stdout is the score.` };
    runs.push(n);
  }
  return { value: median(runs), runs };
}

/** Every guard in order; stops at the first that fails and says why, naming the guard. */
export async function guardFailure(checkout: string, problem: Problem): Promise<{ guard: string; reason: string } | null> {
  for (const guard of problem.guards) {
    const r = await runCommand(checkout, guard, { env: { ...FRESH_ENV } });
    if (!r.ok) return { guard, reason: commandFailure("The guard", guard, r) };
  }
  return null;
}

// Runs every guard in the checkout. Returns null when all exit 0, or the first guard command that failed.
// guardFailure gives the same answer with the guard's output for a reason.
export async function failedGuard(checkout: string, problem: Problem): Promise<string | null> {
  return (await guardFailure(checkout, problem))?.guard ?? null;
}
