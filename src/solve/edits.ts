import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { matchesAny } from "./glob.ts";
import { type Edit, isJudged, type Problem, type Proposal, type ProposerFile } from "./types.ts";

// What a proposal may touch. Paths are relative to the problem folder, with "/" separators.
export interface EditRules {
  artifact: string[];
  protect: string[];
  // Files the measure, the judge and the guards read. A change to one of them changes the number, not the work.
  measurePaths: string[];
}

export type EditResult = { ok: true; changed: string[] } | { ok: false; reason: string };

// The words in shell commands that name files: `python3 measure/score.py --fast` gives measure/score.py.
// A word counts when it has a "/" or a "."; flags, absolute paths and paths that leave the folder do not.
export function commandPaths(commands: string[]): string[] {
  const words = commands.flatMap((c) => c.split(/\s+/))
    .map((w) => w.replace(/^['"]|['"]$/g, "").replace(/\\/g, "/").replace(/^\.\//, ""))
    .filter((w) => /[/.]/.test(w) && !w.startsWith("-") && !w.startsWith("/") && !/^[a-z]+:/i.test(w) && !w.split("/").includes(".."));
  return [...new Set(words.map((w) => w.replace(/\/$/, "")).filter(Boolean))];
}

const normal = (path: string) => path.replace(/\\/g, "/").replace(/^\.\//, "");
const under = (path: string, entry: string) => path === entry || path.startsWith(`${entry}/`);

// null when the path may change; otherwise one plain sentence that starts with the path and gives the rule.
export function pathProblem(path: string, rules: EditRules): string | null {
  const p = normal(path);
  if (!p || p.startsWith("/") || /^[a-z]:/i.test(p) || p.split("/").includes("..")) return `${path} is not a path inside the problem folder.`;
  if (p.split("/").includes(".git")) return `${p} is inside git's own folder; a proposal may not change it.`;
  if (matchesAny(p, rules.protect)) return `${p} is protected by the problem file (protect); a proposal may not change it.`;
  const measured = rules.measurePaths.map(normal).find((m) => under(p, m));
  if (measured) return `${p} is used by the measure or a guard (${measured}); Synthe measures with it as it is.`;
  if (!matchesAny(p, rules.artifact)) return `${p} is outside the artifact globs; a proposal may change only files that match artifact.`;
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
  const refused = checkEdits(edits, rules);
  if (refused.length) return { ok: false, reason: refused.join(" ") };

  const texts = new Map<string, string>();
  for (const e of edits) {
    const p = normal(e.path);
    const file = join(dir, p);
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
    const text = texts.get(p)!;
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

// The files that decide the number or run the proposer: every file named in the measure, judge, guard and
// proposer commands, the judge's cases, and the problem file itself. Relative to the problem folder.
export function measurePathsOf(problem: Problem): string[] {
  const commands = [...problem.guards];
  const extra: string[] = [];
  if (isJudged(problem.measure)) {
    const j = problem.measure.judge;
    commands.push(j.run);
    if (j.compare !== "model") commands.push(j.compare);
    extra.push(j.cases);
    if (j.rubric) extra.push(j.rubric);
  } else {
    commands.push(problem.measure.command);
  }
  if (problem.proposer !== "model") commands.push(problem.proposer.command);
  const file = relative(problem.dir, problem.file).replace(/\\/g, "/");
  if (file && !file.startsWith("..")) extra.push(file);
  // `node count.cjs README.md` runs count.cjs and reads README.md as its input. When artifact names README.md
  // exactly (no glob), it is the thing to improve, so it stays editable. A program a command runs is always refused,
  // and so is a file that only a glob covers, the problem file and the judge's cases.
  const named = new Set(problem.artifact.filter((a) => !/[*?[\]{}]/.test(a)).map(normal));
  const programs = new Set(commands.flatMap((c) => commandPaths([c]).slice(0, 1)).map(normal));
  const fromCommands = commandPaths(commands).filter((p) => programs.has(normal(p)) || !named.has(normal(p)));
  return [...new Set([...fromCommands, ...extra.map(normal)])];
}

export function rulesFor(problem: Problem): EditRules {
  return { artifact: problem.artifact, protect: problem.protect, measurePaths: measurePathsOf(problem) };
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
    if (!matchesAny(path, problem.artifact) || matchesAny(path, problem.protect)) continue;
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
  const r = applyEdits(where.dir, proposal?.edits, rulesFor(problem));
  if (!r.ok) return { refused: r.reason };
  return { paths: r.changed.map((p) => posix.join(where.prefix, p)) };
}
