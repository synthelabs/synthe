import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// One scratch checkout for a whole solve run. It is a git worktree on a new branch, synthe/solve-<name>-<n>,
// made from the person's HEAD. Synthe edits, measures and commits only here, so the person's working tree and
// current branch never change. Only committed files are in the checkout: an uncommitted edit can not leak
// into a number.

export interface Scratch {
  // The checkout's root, and the problem's folder inside it (the same relative path as in the repo).
  root: string;
  dir: string;
  branch: string;
  // The person's HEAD when the run started.
  base: string;
  // Commits exactly these paths (relative to root) on the branch and returns the commit.
  commit(paths: string[], message: string): Promise<string>;
  // Puts every file back to the last commit and removes new files: used after a refused or lost proposal.
  reset(): Promise<void>;
  // Removes the checkout. Keeps the branch only when `keepBranch` is true (the run kept at least one change).
  close(keepBranch: boolean): Promise<void>;
}

interface State { top: string; root: string; dir: string; branch: string; base: string; links: string[] }

// Dependencies are linked, not installed: the measure uses the dependencies the person already has.
const LINKED = ["node_modules", ".venv", "venv"];
const IDENTITY = ["-c", "user.name=Synthe", "-c", "user.email=synthe@users.noreply.github.com"];

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function tryGit(cwd: string, args: string[]): string | null {
  try { return git(cwd, args); } catch { return null; }
}

function firstLine(e: unknown): string {
  const err = e as { stderr?: string | Buffer; message?: string };
  const text = String(err.stderr ?? "").trim() || String(err.message ?? e);
  return text.split("\n")[0];
}

// The next free branch number: one more than the highest synthe/solve-<name>-<n> that exists.
export function nextBranch(top: string, name: string): string {
  const prefix = `synthe/solve-${name}-`;
  const listed = tryGit(top, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${prefix}*`]) ?? "";
  let max = 0;
  for (const ref of listed.split("\n")) {
    const n = Number(ref.trim().slice(prefix.length));
    if (ref.trim().startsWith(prefix) && Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${max + 1}`;
}

// Throws an Error with a plain message when the folder is not in a git repository, the repository has no commit,
// or the problem folder is not committed. `repoRoot` may be empty: the root is then found from `problemDir`.
// The scratch checkouts that are open now, so an interrupted run can remove them (closeOpenScratches).
const open = new Set<State>();

export async function openScratch(repoRoot: string, problemDir: string, name: string): Promise<Scratch> {
  const s = openState(repoRoot, problemDir, name);
  open.add(s);
  let closed = false;
  return {
    root: s.root,
    dir: s.dir,
    branch: s.branch,
    base: s.base,
    commit: async (paths, message) => commitKept(s, paths, message),
    reset: async () => resetScratch(s),
    close: async (keepBranch) => {
      if (closed || !open.has(s)) return;
      closed = true;
      open.delete(s);
      closeScratch(s, keepBranch);
    },
  };
}

function openState(repoRoot: string, problemDir: string, name: string): State {
  const real = realpathSync(problemDir);
  const topOut = tryGit(repoRoot || real, ["rev-parse", "--show-toplevel"]);
  if (!topOut) throw new Error(`${problemDir} is not inside a git repository. Run git init and commit the files first.`);
  const top = realpathSync(topOut.trim());
  const base = tryGit(top, ["rev-parse", "--verify", "HEAD^{commit}"])?.trim();
  if (!base) throw new Error(`The repository at ${top} has no commit yet. Commit the files first.`);
  const rel = relative(top, real);
  if (rel && !tryGit(top, ["ls-tree", "-d", "--name-only", base, rel])?.trim()) {
    throw new Error(`The folder ${rel} is not committed in ${top}. Commit it first: Synthe works only on committed files.`);
  }

  const branch = nextBranch(top, name);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "synthe-solve-")));
  try {
    git(top, ["worktree", "add", "--quiet", "-b", branch, dir, base]);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`Could not make a scratch checkout on ${branch}: ${firstLine(e)}`);
  }
  const scratch: State = { top, root: dir, dir: join(dir, rel), branch, base, links: [] };
  // Link from the repository root and from the problem folder, where a Python or Node project usually keeps them.
  for (const from of new Set([top, real])) {
    const to = join(scratch.root, relative(top, from));
    for (const name of LINKED) {
      const source = join(from, name);
      const link = join(to, name);
      if (existsSync(source) && existsSync(to) && !existsSync(link)) {
        try {
          symlinkSync(source, link, process.platform === "win32" ? "junction" : "dir");
          scratch.links.push(link);
        } catch { /* the measure runs without it and says so */ }
      }
    }
  }
  return scratch;
}

// The scratch HEAD: the last kept change, or the base.
function headOf(s: State): string {
  return git(s.root, ["rev-parse", "HEAD"]).trim();
}

// Commits the given paths (relative to the scratch root) and returns the new commit. Hooks are skipped and
// signing is off: this is a machine commit in a throwaway checkout, and a signing prompt would hang the run.
function commitKept(s: State, paths: string[], message: string): string {
  if (paths.length) git(s.root, ["add", "-A", "--", ...paths]);
  const hasName = tryGit(s.root, ["config", "user.name"])?.trim();
  const hasEmail = tryGit(s.root, ["config", "user.email"])?.trim();
  const identity = hasName && hasEmail ? [] : IDENTITY;
  git(s.root, [...identity, "-c", "commit.gpgsign=false", "commit", "--no-verify", "--quiet", "--allow-empty", "-F", "-"], message);
  return headOf(s);
}

// Puts the scratch checkout back to its last commit: drops edits, and files the measure or guards made.
// Ignored files stay (build caches), and the dependency links stay.
function resetScratch(s: State): void {
  git(s.root, ["reset", "--hard", "--quiet", "HEAD"]);
  git(s.root, ["clean", "-fdq", ...LINKED.flatMap((n) => ["-e", n])]);
}

// For Ctrl-C or a kill: removes every open scratch checkout, synchronously. A branch stays only when it holds a
// kept change (a commit after the base); an empty branch is deleted. Returns the branches that stay.
export function closeOpenScratches(): string[] {
  const kept: string[] = [];
  for (const s of [...open]) {
    open.delete(s);
    let keep = false;
    try { keep = headOf(s) !== s.base; } catch { /* the checkout is broken: nothing to keep */ }
    closeScratch(s, keep);
    if (keep) kept.push(s.branch);
  }
  return kept;
}

// Removes the scratch checkout. The branch stays only when the run kept a change, so a run that keeps nothing
// leaves no trace in the person's repository.
function closeScratch(s: State, keepBranch: boolean): void {
  // Unlink first so removing the worktree can never reach through a link into the person's dependencies.
  for (const link of s.links) try { if (lstatSync(link).isSymbolicLink()) unlinkSync(link); } catch { /* gone */ }
  tryGit(s.top, ["worktree", "remove", "--force", s.root]);
  rmSync(s.root, { recursive: true, force: true });
  tryGit(s.top, ["worktree", "prune"]);
  if (!keepBranch) tryGit(s.top, ["branch", "-D", "--quiet", s.branch]);
}
