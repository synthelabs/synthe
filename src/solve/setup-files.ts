import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Stage 4j (swarm/GOAL-3.md): the files that the root runner configuration or package.json names to load before or
// around the tests. jest, vitest and mocha run them in the test process, so a change to one can make every test
// pass. problem init protects each of them. Paths are relative to the repository root, with "/" separators.

// The keys that name a file to load, for the three runners. Each value can be one path, a list of paths, or (jest
// transform, reporters) an object or nested lists that hold paths.
const LOAD_KEYS = [
  // jest
  "setupFiles", "setupFilesAfterEnv", "globalSetup", "globalTeardown", "testEnvironment", "testRunner", "testSequencer",
  "snapshotResolver", "resolver", "transform", "reporters", "watchPlugins", "runner", "prettierPath", "dependencyExtractor",
  // vitest (setupFiles and globalSetup are above)
  "environment", "workspace", "projects",
  // mocha
  "require", "file", "ui", "reporter",
];

// The root files that the three runners read for their configuration.
const ROOT_FILES = [
  ...["js", "ts", "mjs", "cjs", "cts", "mts", "json"].map((e) => `jest.config.${e}`),
  ...["vitest", "vite"].flatMap((n) => ["ts", "mts", "cts", "js", "mjs", "cjs"].map((e) => `${n}.config.${e}`)),
  ...["cjs", "js", "jsonc", "json"].map((e) => `.mocharc.${e}`),
];
const YAML_FILES = [".mocharc.yaml", ".mocharc.yml"];
const CODE_EXT = [".js", ".cjs", ".mjs", ".ts", ".cts", ".mts", ".jsx", ".tsx", ".json"];

// The text from `at` to the end of one value: up to the first "," or closing bracket at depth 0, or the line end.
// Strings are skipped, so a bracket inside a string does not count.
function valueAt(text: string, at: number): string {
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (c === "[" || c === "{" || c === "(") depth++;
    else if (c === "]" || c === "}" || c === ")") { if (depth === 0) return text.slice(at, i); depth--; if (depth === 0) return text.slice(at, i + 1); }
    else if ((c === "," || c === "\n" || c === ";") && depth === 0) return text.slice(at, i);
  }
  return text.slice(at);
}

const strings = (text: string) => [...text.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map((m) => m[2]);

// The string values of the load keys in a JavaScript, TypeScript or JSON configuration.
export function namedInCode(text: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?:^|[\\s{,(])["'\`]?(${LOAD_KEYS.join("|")})["'\`]?\\s*:`, "g");
  for (const m of text.matchAll(re)) out.push(...strings(valueAt(text, m.index! + m[0].length)));
  return out;
}

// The values of the load keys in a mocha YAML configuration: "require: ./a.js" or a list of "- ./a.js" lines.
export function namedInYaml(text: string): string[] {
  const out: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(["']?)([\w-]+)\2\s*:\s*(.*)$/.exec(lines[i]);
    if (!m || !LOAD_KEYS.includes(m[3])) continue;
    const rest = m[4].replace(/\s+#.*$/, "").trim();
    if (rest.startsWith("[")) out.push(...rest.slice(1, rest.lastIndexOf("]") === -1 ? undefined : rest.lastIndexOf("]")).split(",").map((s) => s.trim()));
    else if (rest) out.push(rest);
    else for (let j = i + 1; j < lines.length && /^\s*-\s/.test(lines[j]); j++) out.push(lines[j].replace(/^\s*-\s*/, "").replace(/\s+#.*$/, "").trim());
  }
  return out.map((s) => s.replace(/^(["'])(.*)\1$/, "$2")).filter(Boolean);
}

const isFile = (path: string) => { try { return statSync(path).isFile(); } catch { return false; } };

// The repository paths that one named value can load. A value that names no path in the repository (a package
// such as "jsdom" or "ts-node/register") gives nothing, unless it is written as a path.
function pathsOf(dir: string, value: string): string[] {
  let v = value.trim().replace(/\\/g, "/").replace(/^<rootDir>\//, "").replace(/^\.\//, "");
  if (!v || v.startsWith("/") || /^[a-z]+:/i.test(v) || /[*?{}[\]]/.test(v) || v.split("/").includes("..")) return [];
  v = v.replace(/\/+$/, "");
  const asPath = value.trim().startsWith(".") || value.trim().startsWith("<rootDir>") || /\.[a-z]+$/i.test(v);
  const found = [v, ...CODE_EXT.map((e) => v + e), ...CODE_EXT.map((e) => `${v}/index${e}`)].filter((p) => isFile(join(dir, p)));
  // A path that does not exist yet stays protected too, so a proposal can not create the file the runner loads.
  return [...new Set([...found, ...(asPath && !found.length && !existsSync(join(dir, v)) ? [v] : [])])];
}

/** The files that the root jest, vitest or mocha configuration, or package.json, names to load around the tests. */
export function runnerSetupFiles(dir: string): string[] {
  const named: string[] = [];
  for (const f of ROOT_FILES) {
    if (!isFile(join(dir, f))) continue;
    try { named.push(...namedInCode(readFileSync(join(dir, f), "utf8"))); } catch { /* unreadable: nothing named */ }
  }
  for (const f of YAML_FILES) {
    if (!isFile(join(dir, f))) continue;
    try { named.push(...namedInYaml(readFileSync(join(dir, f), "utf8"))); } catch { /* unreadable */ }
  }
  // package.json: only the "jest" and "mocha" keys configure a runner; "main" and the rest name the code itself.
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    for (const key of ["jest", "mocha"]) if (pkg && typeof pkg[key] === "object" && pkg[key] !== null) named.push(...namedInCode(JSON.stringify(pkg[key])));
  } catch { /* no package.json, or not JSON */ }
  return [...new Set(named.flatMap((v) => pathsOf(dir, v)))].sort();
}
