import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { GOAL_FILE } from "../core/goal.ts";
import { SENSITIVE_PATHS } from "../core/safety.ts";
import type { ImproveConfig } from "./config.ts";

// What a measured change may not touch: anything that decides the number (tests, the metric and its inputs,
// dependencies, config) rather than the product code being measured. Checked before any measurement runs.
const DEPENDENCY_FILES = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lockb?|poetry\.lock|uv\.lock|Pipfile(\.lock)?|pyproject\.toml|pytest\.ini|tox\.ini|setup\.cfg|requirements[^/]*\.txt|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?|composer\.(json|lock))$/i;

const RULES: [RegExp, string][] = [
  [/(^|\/)\.synthe(\/|$)|(^|\/)synthe\.json$/i, "is Synthe's own setup; a measured change leaves it alone."],
  [/^\.github\//i, "is under .github/; workflows and CI settings are not part of a measured change."],
  [DEPENDENCY_FILES, "lists dependencies or project settings; Synthe measures with them as they are."],
  [/(^|\/)[^/]*\.(test|spec|bench)\.[^/]+$/i, "is a test file; Synthe measures with the tests as they are."],
  [/(^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$/i, "is a Python test file; Synthe measures with the tests as they are."],
  [/(^|\/)(test|tests|__tests__|spec|e2e|benchmark|benchmarks|metrics|fixtures)(\/|$)/i, "is in a test, benchmark, metric or fixture folder; Synthe measures with those as they are."],
  [/(^|\/)[^/]*\.config\.[^/]+$/i, "is a config file; Synthe measures with the project's config as it is."],
  [/(^|\/)\.env/i, "is an environment file; a measured change leaves it alone."],
  [/(^|\/)Dockerfile[^/]*$|(^|\/)(gnu)?makefile$/i, "is a build file; Synthe measures with the build as it is."],
  [/(^|\/)\.[^/]/i, "is a hidden file or folder; a measured change touches product code only."],
];

// Words in the metric and guard commands that name files: `node metrics/score.js` protects metrics/score.js.
function commandPaths(config: ImproveConfig): string[] {
  return [config.metric.command, config.guard.command ?? ""]
    .flatMap((c) => c.split(/\s+/))
    .map((w) => w.replace(/^['"]|['"]$/g, "").replace(/^\.\//, ""))
    .filter((w) => /[/.]/.test(w) && !w.startsWith("-") && !w.startsWith("/") && !w.split("/").includes(".."));
}

// Case-insensitive: macOS and Windows treat \`Metrics/\` and \`metrics/\` as one folder, and git records the existing case.
const under = (path: string, entry: string) => {
  const e = entry.replace(/^\.\//, "").replace(/\/$/, "").toLowerCase();
  const p = path.toLowerCase();
  return p === e || p.startsWith(`${e}/`);
};

// null when the path may change; otherwise one sentence that starts with the path and gives the rule.
export function protectedPathProblem(path: string, config: ImproveConfig): string | null {
  for (const [rule, why] of RULES) if (rule.test(path)) return `${path} ${why}`;
  const named = commandPaths(config).find((w) => under(path, w));
  if (named) return `${path} is used by the metric or the regression check (${named}); Synthe measures with it as it is.`;
  const helper = config.metricOnly?.find((e) => under(path, e));
  if (helper) return `${path} is imported by the metric or the regression check and by no other file, so it is part of how the number is measured; Synthe measures with it as it is.`;
  const extra = config.protect.find((e) => under(path, e));
  if (extra) return `${path} is protected for this run (--protect ${extra}).`;
  const prompt = config.promptFiles?.find((e) => under(path, e));
  if (prompt) return `${path} is the prompt file Synthe's prompt mode tunes (named in ${GOAL_FILE}); improve mode leaves it alone.`;
  if (SENSITIVE_PATHS.some((p) => new RegExp(p.source, "i").test(path))) return `${path} can run code, ship dependencies, change CI or hold secrets; a measured change leaves it alone.`;
  return null;
}

export function protectedChanges(paths: string[], config: ImproveConfig): string[] {
  return [...paths].sort().flatMap((p) => protectedPathProblem(p, config) ?? []);
}

// Files prompt mode (synthe.json) edits: its prompt file and its test cases. Improve mode must never change them,
// or the two modes would fight over one file. A missing, unreadable or invalid synthe.json protects nothing.
export function promptModeProtect(top: string): string[] {
  try {
    const file = join(top, GOAL_FILE);
    if (!existsSync(file)) return [];
    const goal = JSON.parse(readFileSync(file, "utf8"));
    const clean = (p: unknown) => {
      if (typeof p !== "string") return [];
      const path = p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
      return path && !path.startsWith("/") && !path.split("/").includes("..") ? [path] : [];
    };
    return [...new Set([...clean(goal?.prompt?.path), ...clean(goal?.scenarios)])];
  } catch { return []; }
}

// Helper files only the metric decides with. A metric script often imports a scoring helper (scoring.py next to eval.py);
// editing that helper changes the number without changing the product, so it is protected like the script. A file the
// script imports that any other tracked file also imports is product code (the app or its tests use it), and stays
// editable: that is what the metric measures. Direct imports only, relative JS/TS imports and Python imports.
const JS_FILE = /\.(?:m?js|cjs|ts|mts|cts|jsx|tsx)$/;
const PY_FILE = /\.py$/;
const JS_IMPORTS = [/\brequire\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g, /\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g, /\bimport\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g];
const JS_TRIES = ["", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx", "/index.js", "/index.ts"];
const MAX_SCANNED = 5000;
const MAX_BYTES = 512 * 1024;

export function importsOf(file: string, text: string, tracked: Set<string>): string[] {
  const dir = posix.dirname(file);
  const found = new Set<string>();
  const inRepo = (p: string) => (p.startsWith("../") || p === ".." ? null : p);
  if (JS_FILE.test(file)) {
    for (const re of JS_IMPORTS) for (const m of text.matchAll(re)) {
      const base = inRepo(posix.normalize(posix.join(dir, m[1])));
      const hit = base === null ? undefined : JS_TRIES.map((t) => base + t).find((p) => tracked.has(p));
      if (hit) found.add(hit);
    }
  } else if (PY_FILE.test(file)) {
    const roots = [...new Set([dir, ".", "src"])];
    const module = (from: string, name: string) => {
      const rel = name.replace(/\./g, "/");
      for (const root of from ? [from] : roots) {
        const base = inRepo(posix.normalize(posix.join(root, rel)));
        const hit = base === null ? undefined : [`${base}.py`, `${base}/__init__.py`].find((p) => tracked.has(p));
        if (hit) { found.add(hit); return; }
      }
    };
    for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+\(?([\w ,\t]+)/gm)) {
      const dots = m[1].length;
      const from = dots ? posix.normalize(posix.join(dir, ...Array(dots - 1).fill(".."))) : "";
      if (m[2]) module(from, m[2]);
      else for (const n of m[3].split(",")) module(from, n.trim().split(/\s+/)[0]);
    }
    for (const m of text.matchAll(/^[ \t]*import[ \t]+([\w.]+(?:[ \t]*,[ \t]*[\w.]+)*)/gm)) for (const n of m[1].split(",")) module("", n.trim());
  }
  found.delete(file);
  return [...found];
}

export function metricOnlyFiles(top: string, config: ImproveConfig): string[] {
  let tracked: string[];
  try { tracked = execFileSync("git", ["-C", top, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean); } catch { return []; }
  const known = new Set(tracked);
  const read = (f: string) => { try { return statSync(join(top, f)).size > MAX_BYTES ? null : readFileSync(join(top, f), "utf8"); } catch { return null; } };
  const scripts = commandPaths(config).filter((p) => known.has(p) && (JS_FILE.test(p) || PY_FILE.test(p)));
  const used = new Set(scripts.flatMap((s) => { const t = read(s); return t === null ? [] : importsOf(s, t, known); }));
  for (const s of scripts) used.delete(s);
  if (!used.size) return [];
  for (const f of tracked.filter((f) => (JS_FILE.test(f) || PY_FILE.test(f)) && !scripts.includes(f)).slice(0, MAX_SCANNED)) {
    const t = read(f);
    if (t !== null) for (const i of importsOf(f, t, known)) used.delete(i);
    if (!used.size) break;
  }
  return [...used].sort();
}
