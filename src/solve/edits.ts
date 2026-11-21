import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { matchesAny } from "./glob.ts";

export interface Edit { path: string; search: string; replace: string }

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
