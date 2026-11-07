import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { createEvaluator, EvaluationInterrupted } from "./evaluator.ts";

export interface BuilderInput {
  repo: string;
  goal: string;
  metricCommand: string;
  direction: "higher" | "lower";
  target?: number;
  guardCommand: string;
  mode: "review" | "auto";
  protectedPaths?: string[];
  refine: (goal: string) => Promise<string>;
  runAgent: (cwd: string, prompt: string) => Promise<void>;
  onProgress?: (message: string) => void;
}

interface Trial {
  value: number | null;
  guardsPassed: boolean;
  eligible: boolean;
  reason?: string;
}

export interface BuilderResult {
  commit: string;
  baseline: { value: number; guardsPassed: boolean };
  original: Trial;
  refined: Trial;
  refinedPrompt: string;
  winner: "original" | "refined" | null;
  patchPath: string | null;
  applied: boolean;
  applyReason?: string;
}

const MAX_GIT_OUTPUT = 2 * 1024 * 1024;
const MAX_ARCHIVE = 32 * 1024 * 1024;
const splitPaths = (value: string) => value.split("\0").filter(Boolean);
const clean = (cwd: string) => git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]).length === 0;

// Only Git operations run here. Metric and regression commands run in Docker.
function localEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", "WINDIR", "PATHEXT"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.PATH = process.env.PATH?.split(delimiter).filter(isAbsolute).join(delimiter) || "/usr/bin:/bin";
  return env;
}

function gitOptions(cwd: string, input?: Buffer): Omit<ExecFileSyncOptions, "encoding"> {
  return {
    cwd, input, maxBuffer: MAX_GIT_OUTPUT, timeout: 30_000,
    stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    env: { ...localEnv(), GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
  };
}

const gitFlags = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.autocrlf=false"];

function git(cwd: string, args: string[], input?: Buffer): string {
  return execFileSync("git", [...gitFlags, ...args], { ...gitOptions(cwd, input), encoding: "utf8" });
}

function archive(cwd: string, tree: string): Buffer {
  try {
    return execFileSync("git", [...gitFlags, "archive", "--format=tar", tree], {
      ...gitOptions(cwd), maxBuffer: MAX_ARCHIVE,
    });
  } catch {
    throw new Error("Builder could not package the tracked files. The evaluator snapshot is limited to 32 MiB.");
  }
}

function checkout(repo: string, root: string, name: string, commit: string): string {
  const cwd = join(root, name);
  // Independent object stores, without hooks or access to the caller's worktree.
  git(root, ["init", "--quiet", cwd]);
  git(cwd, ["-c", "protocol.file.allow=always", "fetch", "--quiet", "--no-tags", "--depth=1", "--", repo, commit]);
  git(cwd, ["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
  if (git(cwd, ["rev-parse", "HEAD"]).trim() !== commit || !clean(cwd)) throw new Error("Could not reproduce the starting commit.");
  return cwd;
}

type Evaluate = Awaited<ReturnType<typeof createEvaluator>>;

async function measure(evaluate: Evaluate, snapshot: Buffer, command: string): Promise<number> {
  const result = await evaluate(snapshot, command);
  if (!result.ok) throw new Error("The metric command failed in the offline Docker evaluator.");
  const number = result.stdout.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(number) || !Number.isFinite(Number(number))) {
    throw new Error("The metric command must print exactly one finite number.");
  }
  return Number(number);
}

function validateProtectedPaths(paths: string[]): string[] {
  return paths.map((raw) => {
    const path = raw.trim().replace(/\/$/, "");
    if (!path || isAbsolute(path) || /[\0\r\n\\]/.test(path) || path.split("/").some((p) => !p || p === "." || p === "..")) {
      throw new Error("Protected files must be repository-relative paths.");
    }
    return path;
  });
}

function protectedPath(path: string, input: BuilderInput, extra: string[]): boolean {
  return extra.some((p) => path === p || path.startsWith(`${p}/`))
    || input.metricCommand.includes(path) || input.guardCommand.includes(path)
    || /(?:^|\/)\./.test(path)
    || /(?:^|\/)(?:test|tests|__tests__|e2e|benchmark|benchmarks|metrics|fixtures)(?:\/|$)/i.test(path)
    || /(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|makefile|justfile|cargo\.toml|go\.(?:mod|sum)|pyproject\.toml|requirements.*\.txt|.*(?:test|spec|bench|metric)\.[^/]+|.*\.config\.[^/]+|.*\.(?:pem|key|pfx|p12))$/i.test(path);
}

function makePatch(cwd: string, verify: string, commit: string, input: BuilderInput, protectedPaths: string[]) {
  // Use an independent Git directory so the agent cannot configure host-side
  // filters, helpers, or hooks that run when we inspect or stage the patch.
  const capture = (args: string[]) => git(cwd, ["--git-dir", join(verify, ".git"), "--work-tree", cwd, ...args]);
  const untracked = splitPaths(capture(["ls-files", "--others", "--exclude-standard", "-z"]));
  if (untracked.length > 200 || untracked.join("").length > 20_000) throw new Error("Too many new files in the trial.");
  capture(["--literal-pathspecs", "add", "-u", "--", "."]);
  if (untracked.length) capture(["--literal-pathspecs", "add", "--", ...untracked]);
  const entries = splitPaths(capture(["diff", "--cached", "--raw", "--no-renames", "-z", commit, "--"]));
  if (!entries.length) return null;
  if (entries.length > 400) throw new Error("Too many changed files in the trial.");
  for (let i = 0; i < entries.length; i += 2) {
    const [before, after] = entries[i].slice(1).split(" ");
    const path = entries[i + 1];
    if (!path || /[\0\r\n]/.test(path) || protectedPath(path, input, protectedPaths)) {
      throw new Error("The trial changed a protected file. Review the metric, test, and configuration paths before retrying.");
    }
    if (![before, after].every((mode) => /^(?:000000|100644|100755)$/.test(mode))) {
      throw new Error("The trial changed a link or submodule, which cannot be applied.");
    }
  }
  // Git binary patches encode binary content as text.
  const patch = Buffer.from(capture(["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames", commit, "--"]));
  return { patch, tree: git(verify, ["write-tree"]).trim() };
}

export async function runBuilder(input: BuilderInput): Promise<BuilderResult> {
  if (!input.goal.trim() || !input.metricCommand.trim() || !input.guardCommand.trim()) throw new Error("Provide a goal, metric command, and regression command.");
  if (input.target !== undefined && !Number.isFinite(input.target)) throw new Error("The target must be a finite number.");
  if (input.direction !== "higher" && input.direction !== "lower") throw new Error("Choose higher or lower for the metric.");
  if (input.mode !== "review" && input.mode !== "auto") throw new Error("Choose review or auto.");
  const repo = realpathSync(git(resolve(input.repo), ["rev-parse", "--show-toplevel"]).trim());
  const commit = git(repo, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  if (!clean(repo)) throw new Error("Commit or stash your changes before starting the comparison.");
  const protectedPaths = validateProtectedPaths(input.protectedPaths ?? []);
  const root = mkdtempSync(join(tmpdir(), "synthe-builder-"));
  const progress = input.onProgress ?? (() => {});
  try {
    const evaluate = await createEvaluator(root);
    const baselineDir = checkout(repo, root, "baseline", commit);
    const originalDir = checkout(repo, root, "original", commit);
    const refinedDir = checkout(repo, root, "refined", commit);
    progress("Measuring the unchanged repo and running its regression check.");
    const baselineSnapshot = archive(baselineDir, `${commit}^{tree}`);
    const baseline = {
      value: await measure(evaluate, baselineSnapshot, input.metricCommand),
      guardsPassed: (await evaluate(baselineSnapshot, input.guardCommand)).ok,
    };
    if (!baseline.guardsPassed) throw new Error("The unchanged repo did not pass the regression check.");
    const refinedPrompt = await input.refine(input.goal);
    if (typeof refinedPrompt !== "string" || !refinedPrompt.trim()) throw new Error("Could not refine the product request.");
    const higher = input.direction === "higher";

    const trial = async (cwd: string, prompt: string, label: "original" | "refined"): Promise<{ result: Trial; patch: Buffer | null }> => {
      const fail = (reason: string, value: number | null = null, guardsPassed = false) => ({ result: { value, guardsPassed, eligible: false, reason }, patch: null });
      progress(`Trying the ${label} request in a separate copy.`);
      try { await input.runAgent(cwd, prompt); }
      catch { return fail("The coding agent did not finish this trial."); }
      let verified;
      const verify = checkout(repo, root, `${label}-check`, commit);
      try { verified = makePatch(cwd, verify, commit, input, protectedPaths); }
      catch (error) {
        return fail(error instanceof Error && !error.message.startsWith("Command failed")
          ? error.message : "The trial's changes could not be reviewed safely.");
      }
      if (!verified) return fail("The coding agent did not change tracked product code.");
      try {
        // Both checks start from the staged tree in independent containers.
        const snapshot = archive(verify, verified.tree);
        const value = await measure(evaluate, snapshot, input.metricCommand);
        const guardsPassed = (await evaluate(snapshot, input.guardCommand)).ok;
        if (!guardsPassed) return fail("The regression check did not pass.", value);
        const improves = higher ? value > baseline.value : value < baseline.value;
        if (!improves) return fail("The metric did not beat the unchanged repo.", value, true);
        const reachesTarget = input.target === undefined || (higher ? value >= input.target : value <= input.target);
        if (!reachesTarget) return fail("The metric improved but did not reach the target.", value, true);
        return { result: { value, guardsPassed, eligible: true }, patch: verified.patch };
      } catch (error) {
        if (error instanceof EvaluationInterrupted) throw error;
        return fail(error instanceof Error && error.message.startsWith("The metric command")
          ? error.message : "The trial could not be measured using the approved commands.");
      }
    };

    const original = await trial(originalDir, input.goal, "original");
    const refined = await trial(refinedDir, refinedPrompt, "refined");
    const prefersRefined = original.result.value !== null && refined.result.value !== null
      && (higher ? refined.result.value > original.result.value : refined.result.value < original.result.value);
    const winner = refined.result.eligible && (!original.result.eligible || prefersRefined) ? "refined"
      : original.result.eligible ? "original" : null;
    const result: BuilderResult = { commit, baseline, original: original.result, refined: refined.result, refinedPrompt, winner, patchPath: null, applied: false };
    if (!winner) return result;
    const patch = (winner === "original" ? original.patch : refined.patch)!;
    const review = mkdtempSync(join(tmpdir(), "synthe-builder-review-"));
    result.patchPath = join(review, "winner.patch");
    writeFileSync(result.patchPath, patch, { mode: 0o600 });
    if (input.mode === "auto") {
      try {
        if (git(repo, ["rev-parse", "HEAD"]).trim() !== commit || !clean(repo)) {
          result.applyReason = "The original checkout changed. Review and apply the patch yourself.";
        } else {
          git(repo, ["apply", "--binary", "--check", "--", "-"], patch);
          git(repo, ["apply", "--binary", "--", "-"], patch);
          result.applied = true;
        }
      } catch { result.applyReason = "The patch could not be applied cleanly. Review it yourself."; }
    }
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
