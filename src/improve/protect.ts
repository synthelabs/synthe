import { SENSITIVE_PATHS } from "../core/safety.ts";
import type { ImproveConfig } from "./config.ts";

// What a measured change may not touch: anything that decides the number (tests, the metric and its inputs,
// dependencies, config) rather than the product code being measured. Checked before any measurement runs.
const DEPENDENCY_FILES = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|pnpm-workspace\.yaml|bun\.lockb?|poetry\.lock|uv\.lock|Pipfile(\.lock)?|pyproject\.toml|requirements[^/]*\.txt|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?|composer\.(json|lock))$/;

const RULES: [RegExp, string][] = [
  [/(^|\/)\.synthe(\/|$)|(^|\/)synthe\.json$/, "is Synthe's own setup; a measured change leaves it alone."],
  [/^\.github\//, "is under .github/; workflows and CI settings are not part of a measured change."],
  [DEPENDENCY_FILES, "lists dependencies or project settings; Synthe measures with them as they are."],
  [/(^|\/)[^/]*\.(test|spec|bench)\.[^/]+$/, "is a test file; Synthe measures with the tests as they are."],
  [/(^|\/)(test|tests|__tests__|spec|e2e|benchmark|benchmarks|metrics|fixtures)(\/|$)/, "is in a test, benchmark, metric or fixture folder; Synthe measures with those as they are."],
  [/(^|\/)[^/]*\.config\.[^/]+$/, "is a config file; Synthe measures with the project's config as it is."],
  [/(^|\/)\.env/, "is an environment file; a measured change leaves it alone."],
  [/(^|\/)Dockerfile[^/]*$|(^|\/)Makefile$/, "is a build file; Synthe measures with the build as it is."],
  [/(^|\/)\.[^/]/, "is a hidden file or folder; a measured change touches product code only."],
];

// Words in the metric and guard commands that name files: `node metrics/score.js` protects metrics/score.js.
function commandPaths(config: ImproveConfig): string[] {
  return [config.metric.command, config.guard.command ?? ""]
    .flatMap((c) => c.split(/\s+/))
    .map((w) => w.replace(/^['"]|['"]$/g, "").replace(/^\.\//, ""))
    .filter((w) => /[/.]/.test(w) && !w.startsWith("-") && !w.startsWith("/") && !w.split("/").includes(".."));
}

const under = (path: string, entry: string) => {
  const e = entry.replace(/^\.\//, "").replace(/\/$/, "");
  return path === e || path.startsWith(`${e}/`);
};

// null when the path may change; otherwise one sentence that starts with the path and gives the rule.
export function protectedPathProblem(path: string, config: ImproveConfig): string | null {
  for (const [rule, why] of RULES) if (rule.test(path)) return `${path} ${why}`;
  const named = commandPaths(config).find((w) => under(path, w));
  if (named) return `${path} is used by the metric or the regression check (${named}); Synthe measures with it as it is.`;
  const extra = config.protect.find((e) => under(path, e));
  if (extra) return `${path} is protected for this run (--protect ${extra}).`;
  if (SENSITIVE_PATHS.some((p) => p.test(path))) return `${path} can run code, ship dependencies, change CI or hold secrets; a measured change leaves it alone.`;
  return null;
}

export function protectedChanges(paths: string[], config: ImproveConfig): string[] {
  return [...paths].sort().flatMap((p) => protectedPathProblem(p, config) ?? []);
}
