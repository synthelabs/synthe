// End-to-end helpers for `synthe solve`: a throwaway git repository of any kind of project, and the real CLI run on it.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A new git repository with these files committed on branch main. Returns its folder. */
export function projectRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "synthe-solve-e2e-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "start");
  return dir;
}

export interface SolveRun {
  code: number | null;
  output: string;
  result: { problem: string; stopped: string; baseline: number; final: number; branch: string | null; attempts: { round: number; summary: string; kept: boolean; reason: string; before?: number; after?: number }[] };
  report: string;
}

/** Runs `node src/cli/main.ts solve <problem>` in the repository, with result.json and report.md in a temp folder. */
export function solveIn(dir: string, problemFile: string): SolveRun {
  const out = mkdtempSync(join(tmpdir(), "synthe-solve-out-"));
  const r = spawnSync(process.execPath, [join(root, "src/cli/main.ts"), "solve", problemFile, "--out", out, "--seed", "1"], { cwd: dir, encoding: "utf8", timeout: 240_000 });
  const output = `${r.stdout}\n${r.stderr}`;
  let result: SolveRun["result"], report = "";
  try { result = JSON.parse(readFileSync(join(out, "result.json"), "utf8")); } catch { throw new Error(`solve wrote no result.json (exit ${r.status}):\n${output}`); }
  try { report = readFileSync(join(out, "report.md"), "utf8"); } catch { /* the test says it is missing */ }
  return { code: r.status, output, result, report };
}

/** The repository's current branch, working-tree status, and a file's text on a branch. */
export const currentBranch = (dir: string) => git(dir, "rev-parse", "--abbrev-ref", "HEAD");
export const treeStatus = (dir: string) => git(dir, "status", "--porcelain");
export const fileOn = (dir: string, branch: string, path: string) => git(dir, "show", `${branch}:${path}`);
