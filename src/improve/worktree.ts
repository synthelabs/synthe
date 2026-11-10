import { existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMAND_TIMEOUT_MS, type ImproveConfig, type Measurement } from "./config.ts";
import type { Exec } from "./exec.ts";
import { countsTests, measureOnce } from "./presets.ts";
import { median } from "./verdict.ts";

const win = process.platform === "win32";
const quote = (s: string) => (win ? `"${s}"` : `'${s.replace(/'/g, "'\\''")}'`);
const GIT_TIMEOUT_MS = 120_000;

// A detached checkout of exactly one commit, so uncommitted files and the person's build output can't leak
// into the number. node_modules and a Python venv (.venv, venv) are linked, not installed: the measurement uses
// the same dependencies the person already has, and setup stays seconds long.
const LINKED = ["node_modules", ".venv", "venv"];

export async function withWorktree<T>(exec: Exec, root: string, commit: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "synthe-improve-"));
  const added = await exec(root, `git worktree add --detach ${quote(dir)} ${commit}`, GIT_TIMEOUT_MS);
  if (!added.ok) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`Could not check out ${commit.slice(0, 7)} to measure it: ${(added.stderr || added.stdout).trim().split("\n")[0]}`);
  }
  const linked: string[] = [];
  try {
    for (const name of LINKED) {
      const link = join(dir, name);
      if (existsSync(join(root, name)) && !existsSync(link)) {
        symlinkSync(join(root, name), link, win ? "junction" : "dir");
        linked.push(link);
      }
    }
    return await fn(dir);
  } finally {
    // Unlink first so removing the worktree can never reach through a link into the real node_modules or venv.
    for (const link of linked) try { if (lstatSync(link).isSymbolicLink()) unlinkSync(link); } catch { /* already gone */ }
    await exec(root, `git worktree remove --force ${quote(dir)}`, GIT_TIMEOUT_MS);
    await exec(root, "git worktree prune", GIT_TIMEOUT_MS);
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface MeasureResult { measurement: Measurement | null; guardPassed: boolean | null; reason?: string; metricMs: number }

// The metric `runs` times (stopping at the first run that gives no number), then the regression check once.
export async function measureAt(exec: Exec, root: string, commit: string, config: ImproveConfig, say: (line: string) => void = () => {}): Promise<MeasureResult> {
  return withWorktree(exec, root, commit, async (dir) => {
    const runs: number[] = [];
    // Every test that failed in any run, so a flaky test that failed once counts as failing here (see verdict.ts).
    let failing: Set<string> | null = new Set();
    let metricMs = 0;
    const n = config.metric.runs;
    for (let i = 1; i <= n; i++) {
      say(`Measuring ${config.metric.label} at ${commit.slice(0, 7)}, run ${i} of ${n}...`);
      const once = await measureOnce(exec, dir, config);
      metricMs += once.ms;
      if (once.value === null) return { measurement: null, guardPassed: null, reason: once.reason, metricMs };
      runs.push(once.value);
      if (!once.failing) failing = null;
      else for (const t of once.failing) failing?.add(t);
    }
    let guardPassed: boolean | null = null;
    if (config.guard.command) {
      say(`Running the regression check (${config.guard.command})...`);
      guardPassed = (await exec(dir, config.guard.command, COMMAND_TIMEOUT_MS)).ok;
    }
    const tests = countsTests(config) ? { failing: failing ? [...failing].sort() : null } : {};
    return { measurement: { commit, median: median(runs), runs, at: new Date().toISOString(), ...tests }, guardPassed, metricMs };
  });
}
