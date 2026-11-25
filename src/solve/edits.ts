import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { coversArtifactGlob, literalParent, matchesAny, normalizePath } from "./glob.ts";
import { RUNNER_LOADED_GLOBS } from "./runner-paths.ts";
import { type Edit, isAgent, isJudged, type Problem, type Proposal, type ProposerFile } from "./types.ts";

// What a proposal may touch. Paths are relative to the problem folder, with "/" separators.
export interface EditRules {
  artifact: string[];
  protect: string[];
  // Files the measure, the judge and the guards read. A change to one of them changes the number, not the work.
  measurePaths: string[];
  commandFolders?: string[];
  dir?: string;
}

export type EditResult = { ok: true; changed: string[] } | { ok: false; reason: string };

const commandWord = (word: string) => word.replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
const localPath = (word: string) => word && !word.startsWith("-") && !word.startsWith("/") && !/^[a-z]+:/i.test(word) && !word.split("/").includes("..");

// The words in shell commands that name files: `python3 measure/score.py --fast` gives measure/score.py.
// A word counts when it has a "/" or a "."; flags, absolute paths and paths that leave the folder do not.
export function commandPaths(commands: string[]): string[] {
  const words = commands.flatMap((c) => c.split(/\s+/).map(commandWord))
    .map((w) => w.replace(/^\.\//, ""))
    .filter((w) => /[/.]/.test(w) && localPath(w));
  return [...new Set(words.map((w) => w.replace(/\/$/, "")).filter(Boolean))];
}

const LOADED = new Set(["node_modules", ".venv", "venv"]);
const exactArtifact = (pattern: string) => !/[*?[\]{}]/.test(pattern);
const normal = (path: string) => path.replace(/\\/g, "/").replace(/^\.\//, "");
const under = (path: string, entry: string) => path === entry || path.startsWith(`${entry}/`);
const inCommandFolder = (path: string, folder: string) => folder === "." || path.toLowerCase().startsWith(`${folder.toLowerCase()}/`);

// null when the path may change; otherwise one plain sentence that starts with the path and gives the rule.
export function pathProblem(path: string, rules: EditRules): string | null {
  const p = normal(path);
  // Only one spelling of a path is allowed. Another spelling of a protected file, such as "a/./b" or "a//b", would
  // pass the exact checks below and still write that file.
  const parts = p.split("/");
  if (!p || /^[a-z]:/i.test(p) || parts.some((part) => part === "" || part === "." || part === "..")) {
    return `${path} is not a path inside the problem folder in its plain form. Write it with no "." or ".." part and no "//".`;
  }
  if (parts.some((part) => part.toLowerCase() === ".git")) return `${p} is inside git's own folder; a proposal may not change it.`;
  // Node and Python load code from these folders in place of the real modules, so a file there can change what a
  // test or the measure runs. A case-blind match, as for protect below.
  const loaded = parts.slice(0, -1).find((part) => LOADED.has(part.toLowerCase()));
  if (loaded) return `${p} is inside a ${loaded} folder, where tools load code; a proposal may not change or add files there.`;
  // On a file system that ignores case (macOS, Windows), "Measure/x" writes the file "measure/x". So protect and the
  // measure's files match without case. artifact keeps its case: that can only refuse more.
  if (matchesAny(p, rules.protect, true)) return `${p} is protected by the problem file (protect); a proposal may not change it.`;
  const artifact = matchesAny(p, rules.artifact);
  const measured = rules.measurePaths.map(normal).find((m) => under(p.toLowerCase(), m.toLowerCase()))
    ?? (artifact ? undefined : rules.commandFolders?.find((folder) => inCommandFolder(p, folder)));
  if (measured) return `${p} is used by the measure or a guard (${measured}); Synthe measures with it as it is.`;
  if (!artifact) return `${p} is outside the artifact globs; a proposal may change only files that match artifact.`;
  if (rules.commandFolders?.some((folder) => inCommandFolder(p, folder))
    && !rules.artifact.some((a) => exactArtifact(a) && normalizePath(a) === p)) {
    const newInit = parts.at(-1)?.toLowerCase() === "__init__.py" && (!rules.dir || fileKind(rules.dir, p) !== "file");
    if (newInit || matchesAny(p, RUNNER_LOADED_GLOBS, true)) {
      return `${p} is a file the test runner loads by itself, inside a folder that a command runs; a proposal may not add or change it.`;
    }
  }
  return null;
}

// Every refused path in a set of edits, one reason each, in path order.
export function checkEdits(edits: Edit[], rules: EditRules): string[] {
  const paths = [...new Set(edits.map((e) => e.path))].sort();
  return paths.flatMap((p) => pathProblem(p, rules) ?? []);
}

function count(text: string, search: string): number {
  let n = 0;
  for (let i = text.indexOf(search); i !== -1 && n < 2; i = text.indexOf(search, i + 1)) n++;
  return n;
}

// A folder on the way to the file that is a link could point out of the scratch checkout.
function linkedParent(dir: string, path: string): string | null {
  const parts = path.split("/").slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join("/");
    try { if (lstatSync(join(dir, sub)).isSymbolicLink()) return sub; } catch { return null; }
  }
  return null;
}

// The edit code can create missing paths, but cannot replace a directory or cross a link.
function fileKind(dir: string, path: string): "file" | "folder" | "missing" | "blocked" {
  if (linkedParent(dir, path)) return "blocked";
  try {
    const stat = lstatSync(join(dir, path), { throwIfNoEntry: false });
    if (!stat) return "missing";
    if (stat.isFile()) return "file";
    return stat.isDirectory() ? "folder" : "blocked";
  } catch {
    return "blocked";
  }
}

const preview =(s: string) => JSON.stringify(s.length > 60 ? `${s.slice(0, 57)}...` : s);

// Applies the edits in dir, in order. All edits are checked and computed in memory first: if one is refused,
// no file changes. An empty search creates a file that does not exist yet.
export function applyEdits(dir: string, edits: Edit[], rules: EditRules): EditResult {
  if (!Array.isArray(edits) || edits.length === 0) return { ok: false, reason: "The proposal has no edits." };
  for (const e of edits) {
    if (!e || typeof e.path !== "string" || typeof e.search !== "string" || typeof e.replace !== "string") {
      return { ok: false, reason: "An edit needs a path, a search and a replace, each a string." };
    }
  }
  const refused = checkEdits(edits, { ...rules, dir });
  if (refused.length) return { ok: false, reason: refused.join(" ") };

  // The new text of each path; null removes the file.
  const texts = new Map<string, string | null>();
  for (const e of edits) {
    const p = normal(e.path);
    const file = join(dir, p);
    if (e.write || e.remove) {
      // A whole-file change (the agent proposer). It never follows a link, and it removes only a plain file.
      const link = linkedParent(dir, p);
      if (link) return { ok: false, reason: `${p} is under ${link}, a symbolic link; a proposal may change only plain files in the folder.` };
      let stat;
      try { stat = lstatSync(file); } catch { stat = null; }
      if (stat?.isSymbolicLink()) return { ok: false, reason: `${p} is a symbolic link; a proposal may change only plain files.` };
      if (stat && !stat.isFile()) return { ok: false, reason: `${p} is not a file.` };
      if (e.remove && !stat && !texts.has(p)) return { ok: false, reason: `${p} does not exist, so the proposal cannot remove it.` };
      texts.set(p, e.remove ? null : e.replace);
      continue;
    }
    if (texts.get(p) === null) return { ok: false, reason: `${p}: the proposal removes this file and also edits it.` };
    if (!texts.has(p)) {
      const link = linkedParent(dir, p);
      if (link) return { ok: false, reason: `${p} is under ${link}, a symbolic link; a proposal may change only plain files in the folder.` };
      if (existsSync(file)) {
        const stat = lstatSync(file);
        if (stat.isSymbolicLink()) return { ok: false, reason: `${p} is a symbolic link; a proposal may change only plain files.` };
        if (!stat.isFile()) return { ok: false, reason: `${p} is not a file.` };
        texts.set(p, readFileSync(file, "utf8"));
      } else if (e.search === "") {
        texts.set(p, "");
      } else {
        return { ok: false, reason: `${p} does not exist, so the search text ${preview(e.search)} cannot match.` };
      }
    }
    const text = texts.get(p) as string;
    if (e.search === "") {
      if (text !== "") return { ok: false, reason: `${p}: the search text is empty; an empty search can only create a new file.` };
      texts.set(p, e.replace);
      continue;
    }
    const n = count(text, e.search);
    if (n !== 1) {
      return { ok: false, reason: `${p}: the search text ${preview(e.search)} occurs ${n === 0 ? "nowhere" : "more than once"} in the file; it must occur exactly once.` };
    }
    const at = text.indexOf(e.search);
    texts.set(p, text.slice(0, at) + e.replace + text.slice(at + e.search.length));
  }

  for (const [p, text] of texts) {
    const file = join(dir, p);
    if (text === null) { rmSync(file, { force: true }); continue; }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return { ok: true, changed: [...texts.keys()].sort() };
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

// The problem folder's path inside its repository ("" at the root, else "sub/dir/"), so the same folder can be
// found inside a scratch checkout of that repository.
function problemPrefix(problem: Problem): string {
  return git(problem.dir, "rev-parse", "--show-prefix").trim();
}

// The problem folder inside the checkout. `checkout` may be the checkout's root or any folder in it.
function folderIn(checkout: string, problem: Problem): { top: string; prefix: string; dir: string } {
  const top = git(checkout, "rev-parse", "--show-toplevel").trim();
  const prefix = problemPrefix(problem);
  return { top, prefix, dir: join(top, prefix) };
}

// Every command of the problem: guards, the measure (or the judge's run and compare), and the proposer.
function commandsOf(problem: Problem): string[] {
  const commands = [...problem.guards];
  if (isJudged(problem.measure)) {
    commands.push(problem.measure.judge.run);
    if (problem.measure.judge.compare !== "model") commands.push(problem.measure.judge.compare);
  } else {
    commands.push(problem.measure.command);
  }
  // An agent's program is a program too: a proposal may not change it.
  if (problem.proposer !== "model") commands.push(isAgent(problem.proposer) ? problem.proposer.bin : problem.proposer.command);
  return commands;
}

// A folder argument can hold both the artifact and other inputs. A link or a missing path keeps its
// existing protection because we cannot establish that it is a folder in the checkout.
function commandFoldersOf(commands: string[], dir: string): string[] {
  const programs = new Set(commands.map((command) => command.trim().split(/\s+/)[0]).map(commandWord).map(posix.normalize));
  const args = commands.flatMap((command) => command.trim().split(/\s+/).slice(1).map(commandWord));
  return [...new Set(args.filter(localPath).map((word) => posix.normalize(word).replace(/\/$/, "")))].filter((path) => {
    if (programs.has(path) || linkedParent(dir, path)) return false;
    try { return lstatSync(join(dir, path)).isDirectory(); } catch { return false; }
  });
}

// `node count.cjs README.md` runs count.cjs and reads README.md as its input. When artifact names README.md
// exactly (no glob), it is the thing to improve, so it stays editable. A program a command runs is always refused,
// and so is a file that only a glob covers. `problem check` warns about each file this returns.
export function editableCommandInputs(problem: Problem, commands = commandsOf(problem), folders = commandFoldersOf(commands, problem.dir)): string[] {
  const named = new Set(problem.artifact.filter(exactArtifact).map(normal));
  const programs = new Set(commands.flatMap((c) => commandPaths([c]).slice(0, 1)).map(normal));
  return commandPaths(commands).map(normal).filter((p) => named.has(p) && !programs.has(p) && !folders.includes(posix.normalize(p)));
}

export function measurePathsOf(problem: Problem, commands = commandsOf(problem), folders = commandFoldersOf(commands, problem.dir)): string[] {
  const extra: string[] = [];
  if (isJudged(problem.measure)) {
    const j = problem.measure.judge;
    extra.push(j.cases);
    if (j.rubric) extra.push(j.rubric);
  }
  const file = relative(problem.dir, problem.file).replace(/\\/g, "/");
  if (file && !file.startsWith("..")) extra.push(file);
  // A command's input that artifact names exactly stays editable. The problem file and judge data stay refused.
  const editable = new Set(editableCommandInputs(problem, commands, folders));
  const fromCommands = commandPaths(commands).filter((p) => !editable.has(normal(p)) && !folders.includes(posix.normalize(p)));
  return [...new Set([...fromCommands, ...extra.map(normal)])];
}

export function rulesFor(problem: Problem, dir = problem.dir): EditRules {
  const commands = commandsOf(problem);
  const commandFolders = commandFoldersOf(commands, dir);
  return { artifact: problem.artifact, protect: problem.protect, measurePaths: measurePathsOf(problem, commands, commandFolders), commandFolders, dir };
}

// A concrete path can be checked outright. A glob can still name a future file unless its fixed parent is
// unavailable or a path rule covers the whole glob. Seeing only protected files today is not enough to refuse.
function artifactCanBeCreated(pattern: string, dir: string, rules: EditRules): boolean {
  const path = normalizePath(pattern);
  if (exactArtifact(path)) {
    return pathProblem(path, rules) === null && fileKind(dir, path) === "missing";
  }
  const parent = literalParent(path);
  if (parent) {
    const kind = fileKind(dir, parent);
    if (kind !== "folder" && kind !== "missing") return false;
    const parts = parent.toLowerCase().split("/");
    if (parts.some((part) => LOADED.has(part) || part === ".git")) return false;
    if (rules.measurePaths.some((entry) => under(parent.toLowerCase(), normal(entry).toLowerCase()))) return false;
  }
  const inGuard = rules.commandFolders?.some((folder) => folder === "." || inCommandFolder(parent + "/", folder));
  const protect = inGuard ? [...rules.protect, ...RUNNER_LOADED_GLOBS, "**/__init__.py"] : rules.protect;
  return !protect.some((cover) => coversArtifactGlob(path, cover));
}

export function checkArtifactPaths(problem: Problem): { folders: string[]; blocked: boolean } {
  const rules = rulesFor(problem);
  const commandFolders = rules.commandFolders ?? [];
  const files = git(problem.dir, "ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z", "--", ".")
    .split("\0").filter((p) => p && matchesAny(p, rules.artifact) && fileKind(problem.dir, p) === "file");
  return {
    folders: commandFolders.filter((folder) => files.some((file) => inCommandFolder(file, folder))),
    blocked: files.every((file) => pathProblem(file, rules) !== null)
      && rules.artifact.every((glob) => !artifactCanBeCreated(glob, problem.dir, rules)),
  };
}

const MAX_FILE_BYTES = 1024 * 1024;

// The files the proposer sees: every tracked file in the problem folder of the checkout that matches artifact and
// is not protected, at its current version. Paths are relative to the problem folder. Links, large files and
// binary files are left out: the proposer edits text.
export function artifactFiles(checkout: string, problem: Problem): ProposerFile[] {
  const { dir } = folderIn(checkout, problem);
  const tracked = git(dir, "ls-files", "-z", "--", ".").split("\0").filter(Boolean);
  const files: ProposerFile[] = [];
  for (const path of tracked.sort()) {
    if (!matchesAny(path, problem.artifact) || matchesAny(path, problem.protect, true)) continue;
    const file = join(dir, path);
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES || linkedParent(dir, path)) continue;
      const bytes = readFileSync(file);
      if (bytes.includes(0)) continue;
      files.push({ path, text: bytes.toString("utf8") });
    } catch { /* deleted in the checkout */ }
  }
  return files;
}

// Applies one proposal to the scratch checkout: all edits or none. Paths in the proposal are relative to the
// problem folder; the changed paths come back relative to the checkout root, ready for Scratch.commit.
export function applyProposal(checkout: string, problem: Problem, proposal: Proposal): { paths: string[] } | { refused: string } {
  let where: { top: string; prefix: string; dir: string };
  try { where = folderIn(checkout, problem); } catch (e) { return { refused: `Could not find the problem folder in the scratch checkout: ${(e as Error).message.split("\n")[0]}` }; }
  if (typeof proposal?.failed === "string") return { refused: proposal.failed };
  const r = applyEdits(where.dir, proposal?.edits, rulesFor(problem, where.dir));
  if (!r.ok) return { refused: r.reason };
  return { paths: r.changed.map((p) => posix.join(where.prefix, p)) };
}
