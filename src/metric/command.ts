import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArmData } from "../live/gate.ts";
import type { Exec } from "../improve/exec.ts";
import type { MetricQuery, MetricResult, MetricSource } from "./types.ts";

// Matches quote in src/improve/worktree.ts, which is not exported. Keep the two in step.
const win = process.platform === "win32";
const quote = (s: string) => (win ? `"${s}"` : `'${s.replace(/'/g, "'\\''")}'`);

const DEFAULT_TIMEOUT_MS = 120_000;

// Query folders still in use. A signal skips the finally in read, so removeQueryFiles clears them on interrupt.
const liveDirs = new Set<string>();

export function removeQueryFiles(): void {
  for (const dir of liveDirs) rmSync(dir, { recursive: true, force: true });
  liveDirs.clear();
}

// The team's own command. It gets the query as a JSON file, because shellExec strips SYNTHE_* variables.
export function commandSource(exec: Exec, cwd: string, run: string, timeoutMs = DEFAULT_TIMEOUT_MS): MetricSource {
  return {
    async read(q: MetricQuery): Promise<MetricResult> {
      const dir = mkdtempSync(join(tmpdir(), "synthe-metric-"));
      liveDirs.add(dir);
      try {
        const path = join(dir, "query.json");
        writeFileSync(path, JSON.stringify({ agent: q.agent, from: q.from, to: q.to, arms: q.arms }));
        const res = await exec(cwd, `${run} ${quote(path)}`, timeoutMs);
        if (res.timedOut) return { problem: "The metric command did not finish in time." };
        if (!res.ok) return { problem: "The metric command failed (exit code not 0). Run it by hand to see the error." };
        const answer = lastJsonObject(res.stdout);
        if (!answer) {
          return { problem: 'The metric command printed no JSON result. Print one line like {"arms":{"base":{"units":100,"events":3}}}.' };
        }
        return checkArms(answer, q.arms);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        liveDirs.delete(dir);
      }
    },
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(o, key);
const nonNeg = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

// The last line that parses as a JSON object is the answer. Anything the team's command prints around it is ignored.
function lastJsonObject(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = lines[i].trim();
    if (!text) continue;
    try {
      const value: unknown = JSON.parse(text);
      if (isObject(value)) return value;
    } catch {
      // Not JSON: keep looking up the output.
    }
  }
  return null;
}

function checkArms(answer: Record<string, unknown>, asked: string[]): MetricResult {
  const given = answer.arms;
  const arms: Record<string, ArmData> = {};
  for (const id of asked) {
    if (!isObject(given) || !has(given, id)) return { problem: `The metric result has no arm "${id}".` };
    const field = armProblem(given[id]);
    if (field) return { problem: `The metric result for arm "${id}" is not valid: ${field}.` };
    arms[id] = copyArm(given[id] as Record<string, unknown>);
  }
  return { arms };
}

// The first problem in the order the brief sets; null when the arm is valid.
function armProblem(arm: unknown): string | null {
  if (!isObject(arm)) return "units";
  if (!nonNeg(arm.units)) return "units";
  const hasEvents = has(arm, "events");
  const hasSum = has(arm, "sum");
  if (hasEvents && hasSum) return "events and sum";
  if (!hasEvents && !hasSum) return "events or sum";
  if (hasEvents) {
    if (!nonNeg(arm.events)) return "events";
    if (arm.events > arm.units) return "events";
    return null;
  }
  if (!nonNeg(arm.sum)) return "sum";
  if (!nonNeg(arm.sum_sq)) return "sum_sq";
  // The variance is sum_sq / units - (sum / units)^2, which cannot be below 0. A smaller sum_sq is a broken
  // count, and the gate would read it as a real spread. The tolerance only allows float rounding.
  if (arm.sum * arm.sum > arm.sum_sq * arm.units * (1 + 1e-12)) return "sum_sq";
  return null;
}

// Keeps only the known fields, so nothing extra the command printed reaches the gate.
function copyArm(arm: Record<string, unknown>): ArmData {
  if (has(arm, "events")) return { units: Number(arm.units), events: Number(arm.events) };
  return { units: Number(arm.units), sum: Number(arm.sum), sum_sq: Number(arm.sum_sq) };
}
