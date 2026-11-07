import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
