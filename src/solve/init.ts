// `problem init`: reads a repository and writes a first synthe.problem.json for it. See swarm/GOAL-3.md, D01.
// It writes a complete file only when it finds tests it can count. Otherwise it writes a starter file and names the
// fields to fill, with the same lines that `problem check` prints, so the two commands never disagree.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { pythonSetup } from "../improve/presets.ts";
import { validateProblem } from "./problem.ts";
import { runnerSetupFiles } from "./setup-files.ts";
import { CONFTEST_GLOB, JS_CONFIG_GLOBS, PYTEST_CONFIG_GLOBS, PYTHON_STARTUP_GLOBS, TEST_FILE_GLOBS } from "./runner-paths.ts";
export { PYTEST_CONFIG_GLOBS, PYTHON_STARTUP_GLOBS, TEST_FILE_GLOBS } from "./runner-paths.ts";
import { EMPTY_VITEST_CONFIG, HELPER_SOURCE, JS_HELPER_FILE, jsRunnerOf, ROOT_CONFIGS, type JsRunner } from "./js-ids.ts";

export const PROBLEM_FILE = "synthe.problem.json";

const SOURCE_DIRS = ["src", "lib", "app"];
const TEST_DIRS = ["test", "tests", "__tests__", "spec"];
const MODEL = { provider: "anthropic", model: "claude-haiku-5-5" };
const CLAUDE_ARGS = ["--permission-mode", "acceptEdits"];
const SKIP = new Set(["node_modules", "dist", "build", "venv", ".venv", "env", "__pycache__", ...TEST_DIRS]);

// awk programs that print the number of passing tests from a test run and nothing else. The test command is piped
// into them, so the count prints even when tests fail and the test command exits non-zero. With no summary line the
// program exits 1: a broken run is not a measurement of 0.
// node:test prints "# pass N" (TAP, when output is not a terminal) or "ℹ pass N"; jest and vitest print
// "Tests: ... N passed"; mocha prints "N passing".
const NPM_COUNT = `awk '/^[ \\t]*(#|ℹ) pass [0-9]+[ \\t]*$/ { n = $NF } /^[ \\t]*Tests:/ && match($0, /[0-9]+ passed/) { n = substr($0, RSTART, RLENGTH) + 0 } /^[ \\t]*[0-9]+ passing/ { n = $1 } END { if (n == "") exit 1; print n + 0 }'`;

// Stage 4d (swarm/GOAL-3.md): code under test runs inside the tests, so it can register more tests or run one test
// twice. So init records the test IDs, and the measure counts a recorded ID only when it ran exactly once and passed.
export const IDS_FILE = "synthe.test-ids.txt";
// node:test TAP: "ok 3 - name", "not ok 4 - name", "ok 5 - name # SKIP", indented 4 spaces for each level of
// nesting. The ID is the indent, a tab and the name, so a nested test and a top-level test never share an ID.
const NODE_PARSE = String.raw`/^ *(not )?ok [0-9]+ - / { s = $0; ind = 0; while (substr(s, ind + 1, 1) == " ") ind++; r = substr(s, ind + 1); pass = substr(r, 1, 3) == "ok "; sub(/^(not )?ok [0-9]+ - /, "", r); if (match(r, / # (SKIP|TODO)/)) { r = substr(r, 1, RSTART - 1); pass = 0 } id = ind "\t" r; ran = 1; seen[id]++; if (!pass) bad[id] = 1 }`;
// pytest -v: "path::test PASSED   [ 50%]". The short summary lines ("FAILED path::test - ...") are skipped.
const PYTEST_PARSE = String.raw`/^(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS) / { next } match($0, / (PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)( +\[ *[0-9]+%\])? *$/) { id = substr($0, 1, RSTART - 1); st = substr($0, RSTART + 1); sub(/ .*/, "", st); ran = 1; seen[id]++; if (st != "PASSED") bad[id] = 1 }`;
// The IDs file comes first, then the test run on stdin. With no test line at all the run is broken: exit 1.
const countIds = (parse: string) => String.raw`awk 'NR == FNR { want[$0] = 1; next } ${parse} END { if (!ran) exit 1; n = 0; for (id in want) if (seen[id] == 1 && !bad[id]) n++; print n }' ${IDS_FILE} -`;
// At init: each ID that ran once. An ID that two tests share can never count, so it is not recorded.
const NODE_LIST = `awk '${NODE_PARSE} END { for (id in seen) if (seen[id] == 1) print id }'`;
// pytest --collect-only -q: one node ID on each line, then a blank line and "N tests collected".
const PYTEST_LIST = String.raw`awk '/^[^ ].*::/ { seen[$0]++ } END { for (id in seen) if (seen[id] == 1) print id }'`;
// Node loads a package from the nearest node_modules folder, so a file there shadows a real package (stage 4j).
export const DEPENDENCY_GLOB = "**/node_modules/**";

// The runner configuration that init protects, because it can change which tests run and how.
const RUNNER_CONFIG = ["package.json", "pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini", ".noderc", ".mocharc.js", ".mocharc.cjs", ".mocharc.json", ".mocharc.yml", ".mocharc.yaml"];
const RUNNER_CONFIG_RE = /^(?:jest|vitest|vite)\.config\.[cm]?[jt]s$/;
// Stage 4g: pytest's `pythonpath` puts a source folder ahead of the standard library, so a new src/pdb.py would
// shadow the real pdb. Init asks the Python that runs the tests for every standard and installed top-level module
// name. -I leaves out the current folder, PYTHONPATH and the user site, as the measure does. Each line is
// "s <name>" (standard) or "i <name>" (installed).
const MODULE_NAMES = `import sys, pkgutil
std = set(getattr(sys, "stdlib_module_names", ()))
for n in sorted(std): print("s", n)
for n in sorted({m.name for m in pkgutil.iter_modules()} - std): print("i", n)`;

// Stage 4h: a new __init__.py in the folder of a test file makes that folder a package, and pytest runs it when it
// imports the test module. So for pytest, __init__.py in every folder from each test file up to the root is protected,
// as an exact path: an __init__.py in an unrelated source folder stays allowed.
export function packageInits(testFiles: string[]): string[] {
  const out = new Set<string>();
  for (const f of testFiles) {
    const parts = f.split("/").slice(0, -1);
    for (let i = parts.length; i >= 0; i--) out.add([...parts.slice(0, i), "__init__.py"].join("/"));
  }
  return [...out].sort();
}

// The folders that pytest's `pythonpath` option adds, from the root configuration, relative to the repository.
function configPythonpath(text: string): string[] {
  const m = /^\s*pythonpath\s*=\s*(\[[^\]]*\]|.*)$/m.exec(text);
  return m ? [...m[1].matchAll(/[A-Za-z0-9_.\/-]+/g)].map((t) => t[0].replace(/^\.\/|\/$/g, "")).filter((t) => t && !t.split("/").includes("..")) : [];
}

// protect globs for every module name in each folder on the path. An installed module that the folder already
// holds is the project itself (an editable install), so it stays changeable.
function shadowGlobs(dir: string, interpreter: string, folders: string[]): { globs: string[]; names: number } {
  let out = "";
  try {
    out = execFileSync(interpreter, ["-I", "-c", MODULE_NAMES], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000, maxBuffer: 16 << 20 });
  } catch { return { globs: [], names: 0 }; }
  const rows = out.split("\n").map((l) => /^([si]) ([A-Za-z_][A-Za-z0-9_]*)$/.exec(l.trim())).filter((m): m is RegExpExecArray => m !== null);
  const globs: string[] = [];
  for (const folder of folders) {
    const at = folder === "." || folder === "" ? "" : `${folder}/`;
    for (const [, kind, name] of rows) {
      if (kind === "i" && (existsSync(join(dir, at, `${name}.py`)) || isDir(join(dir, at, name)))) continue;
      globs.push(`${at}${name}.py`, `${at}${name}/**`);
    }
  }
  return { globs, names: rows.length };
}
export const EMPTY_PYTEST_INI = "synthe.pytest.ini";

// The file that pytest itself would read at the root, in pytest's order, or null.
function pytestRootConfig(dir: string): string | null {
  const text = (f: string) => { try { return readFileSync(join(dir, f), "utf8"); } catch { return null; } };
  for (const f of ["pytest.ini", ".pytest.ini"]) if (text(f) !== null) return f;
  if (/^\[tool\.pytest(?:\.ini_options)?\]/m.test(text("pyproject.toml") ?? "")) return "pyproject.toml";
  if (/^\[pytest\]/m.test(text("tox.ini") ?? "")) return "tox.ini";
  if (/^\[tool:pytest\]/m.test(text("setup.cfg") ?? "")) return "setup.cfg";
  return null;
}

// The test runners whose summary NPM_COUNT reads.
const COUNTABLE_NPM = /\bnode\b[^&|;]*--test\b|\bjest\b|\bvitest\b|\bmocha\b/;
// A plain `node ... --test ...` script, with no other command in it. Its flags are kept and its paths are replaced.
const NODE_TEST_SCRIPT = /^\s*node\s+(?:[^&|;<>`$()]*\s)?--test(?:\s[^&|;<>`$()]*)?$/;
// Node flags that take their value as the next word, such as "--import tsx".
const NODE_VALUE_FLAGS = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader", "--conditions", "-C",
  "--test-reporter", "--test-reporter-destination", "--test-name-pattern", "--test-skip-pattern", "--test-concurrency", "--test-timeout"]);

// The files that each runner runs by default. node:test: *.test.js, *-test.js, *_test.js, test-*.js, test.js and
// every file under a test/ folder. jest and vitest: *.test.*, *.spec.* and __tests__/. mocha: test/*.js. pytest:
// test_*.py and *_test.py.
const JS = /\.(?:c|m)?js$/;
const NODE_TEST_NAME = /^(?:.+[.\-_]test|test-.+|test)\.(?:c|m)?js$/;
const JEST_TEST_NAME = /\.(?:test|spec)\.(?:c|m)?[jt]sx?$/;
const PYTEST_NAME = /^(?:test_.+|.+_test)\.py$/;
const NEVER = new Set(["node_modules", ".git", "venv", ".venv", "env", ".env", "__pycache__", ".tox", "site-packages"]);

function isTestFile(path: string, runner: "node" | "npm" | "pytest"): boolean {
  const parts = path.split("/"), name = parts.at(-1)!, dirs = parts.slice(0, -1);
  if (parts.some((p) => NEVER.has(p))) return false;
  if (runner === "pytest") return PYTEST_NAME.test(name);
  if (runner === "node") return JS.test(name) && (NODE_TEST_NAME.test(name) || dirs.includes("test"));
  return JEST_TEST_NAME.test(name) || (dirs.includes("__tests__") && /\.[cm]?[jt]sx?$/.test(name)) || (dirs[0] === "test" && dirs.length === 1 && JS.test(name));
}

// Every file of the repository, relative to it: the files git knows and the new ones it does not ignore.
function repoFiles(dir: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
    return out.split("\0").filter((f) => f && existsSync(join(dir, f)));
  } catch {
    const all: string[] = [];
    const walk = (rel: string) => {
      for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory() && !NEVER.has(e.name)) walk(p);
        else if (e.isFile()) all.push(p);
      }
    };
    walk("");
    return all;
  }
}

// A word for sh: as it is when it is safe, else in single quotes.
const sh = (s: string) => /^[\w./@%+=:,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

// `node <flags of the script> --test <files>`: the flags stay, the paths of the script go, so only these files run.
function nodeTestCommand(script: string, files: string[]): string {
  const words = script.trim().split(/\s+/).slice(1), kept: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.startsWith("-")) continue;
    const value = NODE_VALUE_FLAGS.has(w) && words[i + 1] !== undefined ? words[++i] : null;
    // The measure reads TAP, so the script's own reporter goes.
    if (/^--test-reporter(?:-destination)?(?:=|$)/.test(w)) continue;
    kept.push(w, ...(value !== null ? [value] : []));
  }
  if (!kept.includes("--test")) kept.push("--test");
  // A node --test that runs inside another one (NODE_TEST_CONTEXT is set) reports to its parent, not as TAP.
  return ["env -u NODE_TEST_CONTEXT node", ...kept, "--test-reporter=tap", ...files.map(sh)].join(" ");
}

export interface Found {
  name: string;
  source: string | null; // the source folder, relative to the repository
  tests: string | null; // the test folder, relative to the repository
  runner: "npm" | "pytest" | null;
  testFiles: string[]; // the test files that exist now; the measure runs only these
  // The configuration the pytest measure names with -c. `create` is the text init writes when the repository has none.
  pytestConfig: { file: string; create: string | null } | null;
  // pytest: the interpreter, the folders that pytest's pythonpath adds, and (set by init) the globs that stop a new
  // file from shadowing a module there.
  python: { interpreter: string; pathFolders: string[]; shadow: string[]; names: number } | null;
  config: string[]; // the runner configuration files that exist
  setup?: string[]; // the files that the root jest, vitest or mocha configuration or package.json loads around the tests
  // For node:test, pytest, jest, vitest and mocha: the command that prints the test IDs, and the test run that the
  // measure counts. `count` is a filter for the run's output, or "" when the run prints the count itself.
  record: { list: string; run: string; count: string } | null;
  // jest, vitest or mocha, run through the helper that init writes (stage 4i). `create` is the text of an empty
  // configuration that init writes when the runner needs one to name and the repository has none.
  js: { runner: JsRunner; config: string | null; create: string | null } | null;
  command: string | null; // the measure command; for node:test and pytest, set when the IDs are recorded
}

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

function readPackage(dir: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

// A folder that holds at least one file, at any depth.
function hasFiles(dir: string): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).some((e) => e.isFile() || (e.isDirectory() && hasFiles(join(dir, e.name))));
  } catch { return false; }
}

// The source folder: a usual name first, then a Python package folder at the top (a flat layout).
function sourceFolder(dir: string, python: boolean): string | null {
  const named = SOURCE_DIRS.find((d) => isDir(join(dir, d)) && hasFiles(join(dir, d)));
  if (named) return named;
  if (!python) return null;
  const pkgs = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name) && existsSync(join(dir, e.name, "__init__.py")))
    .map((e) => e.name).sort();
  return pkgs.length === 1 ? pkgs[0] : null;
}

const safeName = (s: string) => s.replace(/^@[^/]*\//, "").replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "my-problem";

/** Reads the repository at `dir` and finds what `problem init` needs. It runs nothing. */
export function inspectRepo(dir: string): Found {
  const pkg = readPackage(dir);
  const scripts = pkg && typeof pkg.scripts === "object" && pkg.scripts !== null ? pkg.scripts as Record<string, unknown> : {};
  const npmTest = typeof scripts.test === "string" && COUNTABLE_NPM.test(scripts.test);
  const py = npmTest ? null : pythonSetup(dir);
  const runner = npmTest ? "npm" : py ? "pytest" : null;
  const nodeScript = npmTest && NODE_TEST_SCRIPT.test(scripts.test as string) ? scripts.test as string : null;
  const kind = runner === "pytest" ? "pytest" : nodeScript ? "node" : "npm";
  const testFiles = runner ? repoFiles(dir).filter((f) => isTestFile(f, kind)).sort() : [];
  // The measure names the test files, so a test file that a proposal adds is never run, whatever its name.
  const named = testFiles.map(sh).join(" ");
  // pytest without -q, so that -v prints one line for each test. No bytecode files: the folder stays clean.
  const rootConfig = py ? pytestRootConfig(dir) : null;
  // A src layout needs src/ on sys.path. PYTHONPATH=src would also run a src/sitecustomize.py when Python starts
  // (stage 4f), so pytest's own `pythonpath` option adds it after pytest starts: from the protected configuration,
  // or with -o when that configuration does not set it.
  const needSrc = py !== null && py.src;
  const rootHasPath = rootConfig !== null && /^\s*pythonpath\s*=/m.test(readFileSync(join(dir, rootConfig), "utf8"));
  const pytestConfig = py ? { file: rootConfig ?? EMPTY_PYTEST_INI, create: rootConfig ? null : `[pytest]\n${needSrc ? "pythonpath = src\n" : ""}` } : null;
  const python = py ? `${py.interpreter} -m pytest` : "";
  const addPath = needSrc && rootConfig !== null && !rootHasPath ? " -o pythonpath=src" : "";
  const pathFolders = [...new Set([...(needSrc ? ["src"] : []), ...(rootHasPath ? configPythonpath(readFileSync(join(dir, rootConfig!), "utf8")) : [])])];
  const pythonInfo = py ? { interpreter: python.split(" -m pytest")[0].trim(), pathFolders, shadow: [] as string[], names: 0 } : null;
  // The environment cannot add options or plugins either. No bytecode files: the folder stays clean.
  // No user site (a .pth file there runs at startup), no PYTHONPATH from outside, and no .pyc file written, so a
  // stale one is never read.
  const pytest = py ? `env -u PYTEST_ADDOPTS -u PYTEST_PLUGINS -u PYTHONPATH PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1 ${python} -c ${sh(pytestConfig!.file)} --rootdir=.${addPath} -p no:cacheprovider` : "";
  // jest, vitest and mocha: the helper records and counts IDs (stage 4i), when the runner is installed here. Else
  // the measure runs the test files that exist now and reads the summary (stage 4c).
  const top = readdirSync(dir);
  const js = jsSetup(dir, top, pkg, nodeScript || !npmTest ? null : scripts.test as string);
  const jsRun = (mode: string) => js ? ["node", JS_HELPER_FILE, mode, js.runner, sh(js.config ?? "-"), ...testFiles.map(sh)].join(" ") : "";
  const jsRecord = js && testFiles.length ? { list: jsRun("list"), run: jsRun("count"), count: "" } : null;
  const record = !testFiles.length ? null
    : nodeScript ? { list: `${nodeTestCommand(nodeScript, testFiles)} 2>&1 | ${NODE_LIST}`, run: nodeTestCommand(nodeScript, testFiles), count: countIds(NODE_PARSE) }
    : runner === "pytest" ? { list: `${pytest} --collect-only -q ${named} 2>&1 | ${PYTEST_LIST}`, run: `${pytest} -v ${named}`, count: countIds(PYTEST_PARSE) }
    : jsRecord;
  const command = testFiles.length && runner === "npm" && !nodeScript && !js ? `npm test -- ${named} 2>&1 | ${NPM_COUNT}` : null;
  const config = top.filter((f) => RUNNER_CONFIG.includes(f) || RUNNER_CONFIG_RE.test(f)).sort();
  return {
    name: safeName(typeof pkg?.name === "string" ? pkg.name : basename(resolve(dir))),
    source: sourceFolder(dir, runner === "pytest" || (!pkg && pythonSetup(dir) !== null)),
    tests: TEST_DIRS.find((d) => isDir(join(dir, d))) ?? null,
    runner,
    testFiles,
    config,
    pytestConfig,
    python: pythonInfo,
    record,
    js,
    command,
    setup: runnerSetupFiles(dir),
  };
}

// The configuration file that each runner reads at the root, in the runner's own order.
const ROOT_ORDER: Record<JsRunner, string[]> = {
  jest: ["js", "ts", "mjs", "cjs", "cts", "mts", "json"].map((e) => `jest.config.${e}`),
  vitest: ["vitest", "vite"].flatMap((n) => ["ts", "mts", "cts", "js", "mjs", "cjs"].map((e) => `${n}.config.${e}`)),
  mocha: [".mocharc.cjs", ".mocharc.js", ".mocharc.yaml", ".mocharc.yml", ".mocharc.jsonc", ".mocharc.json"],
};

// jest, vitest or mocha, when the npm test script starts it and it is installed in the repository's node_modules.
function jsSetup(dir: string, top: string[], pkg: Record<string, unknown> | null, script: string | null): Found["js"] {
  const runner = script ? jsRunnerOf(script) : null;
  if (!runner || !existsSync(join(dir, "node_modules", runner, "package.json"))) return null;
  const file = ROOT_ORDER[runner].find((f) => top.includes(f) && ROOT_CONFIGS[runner].test(f));
  // jest reads a "jest" key in package.json when it has no configuration file; package.json is protected.
  const config = file ?? (runner === "jest" && pkg && typeof pkg.jest === "object" ? "package.json" : null);
  if (config || runner !== "vitest") return { runner, config, create: null };
  return { runner, config: EMPTY_VITEST_CONFIG, create: "// Written by synthe problem init: the measure names this file, so vitest reads no other configuration.\nexport default { test: {} };\n" };
}

// The problem file for what was found. Fields that init cannot fill stay empty, so `problem check` names them.
export function draftProblem(f: Found): Record<string, unknown> {
  // Every test file, also one next to the code: the measure counts passing tests, so a new test would raise it.
  const testGlobs = [...new Set([...(f.tests ? [`${f.tests}/**`] : []), ...f.testFiles, ...TEST_FILE_GLOBS])];
  const where = f.tests ? ` in ${f.tests}/` : "";
  return {
    version: 1,
    name: f.name,
    goal: f.command ? `Make more of the tests${where} pass, without changing the tests.` : "",
    artifact: f.source ? [`${f.source}/**`] : [],
    // conftest.py and the runner configuration change which tests run and how; the IDs file is the list that counts.
    protect: [...new Set([...testGlobs, CONFTEST_GLOB, ...f.config, ...(f.runner === "pytest" ? [...PYTEST_CONFIG_GLOBS, ...PYTHON_STARTUP_GLOBS, ...packageInits(f.testFiles)] : []), ...(f.python?.shadow ?? []),
      ...(f.js ? [...JS_CONFIG_GLOBS, ...(f.js.config ? [f.js.config] : []), JS_HELPER_FILE] : []),
      ...(f.setup ?? []), ...(f.pytestConfig ? [f.pytestConfig.file] : []), ...(f.record ? [IDS_FILE] : []), DEPENDENCY_GLOB, PROBLEM_FILE])],
    measure: { command: f.command ?? "", direction: "higher", ...(f.command ? { unit: "passing tests" } : {}) },
    // `claude -p` cannot edit a file without this: in print mode it can not ask, so it refuses every edit.
    proposer: { agent: "claude", args: [...CLAUDE_ARGS] },
    // So the same file also runs with the model proposer, as in CI, where no coding agent is installed.
    model: { ...MODEL },
  };
}

// A path to show in a command: relative to where the person is when that is shorter and inside, else absolute.
function shown(file: string, cwd: string): string {
  const rel = relative(cwd, file);
  const p = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : file;
  return /\s/.test(p) ? JSON.stringify(p) : p;
}

// Runs the command that prints the test IDs, in the repository, and returns them sorted. A test run that fails still
// prints IDs: a failing test is recorded too, so that a later repair counts.
function recordIds(dir: string, command: string): string[] {
  let out = "";
  try {
    out = execFileSync("sh", ["-c", command], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 600_000, maxBuffer: 64 << 20 });
  } catch (e) { out = String((e as { stdout?: unknown }).stdout ?? ""); }
  return out.split("\n").filter((l) => l.trim() !== "").sort();
}

const USAGE = "Usage: npx synthe problem init [--dir DIR] [--force]";

/** `synthe problem init`: exit 0 with a valid file, 2 with a starter file to fill, 1 when it wrote nothing. */
export function problemInit(args: string[], cwd: string, say: (line: string) => void): number {
  let dirArg = ".", force = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--force") force = true;
    else if (a === "--dir" && args[i + 1] !== undefined) dirArg = args[++i];
    else if (a.startsWith("--dir=")) dirArg = a.slice(6);
    else { say(`problem init: unknown argument "${a}".`); say(USAGE); return 1; }
  }
  const dir = resolve(cwd, dirArg);
  if (!isDir(dir)) { say(`problem init: ${dir} is not a folder. Give the repository folder with --dir.`); return 1; }
  const file = join(dir, PROBLEM_FILE);
  if (existsSync(file) && !force) {
    say(`${file} already exists, so Synthe did not change it.`);
    say(`To replace it, run "npx synthe problem init${dirArg === "." ? "" : ` --dir ${shown(dir, cwd)}`} --force".`);
    return 1;
  }

  const found = inspectRepo(dir);
  let ids: string[] = [];
  if (found.python?.pathFolders.length) {
    const { globs, names } = shadowGlobs(dir, found.python.interpreter, found.python.pathFolders);
    found.python.shadow = globs;
    found.python.names = names;
  }
  if (found.pytestConfig?.create) {
    try { writeFileSync(join(dir, found.pytestConfig.file), found.pytestConfig.create); } catch (e) {
      say(`problem init: Synthe can't write ${join(dir, found.pytestConfig.file)} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}).`);
      return 1;
    }
  }
  // jest, vitest and mocha: the helper that records and counts the IDs, and an empty vitest configuration to name.
  const jsFiles: [string, string][] = found.js && found.record ? [[JS_HELPER_FILE, HELPER_SOURCE], ...(found.js.create ? [[found.js.config!, found.js.create] as [string, string]] : [])] : [];
  for (const [name, text] of jsFiles) {
    try { writeFileSync(join(dir, name), text); } catch (e) {
      say(`problem init: Synthe can't write ${join(dir, name)} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}).`);
      return 1;
    }
  }
  if (found.record) {
    say(`Synthe runs the tests once to record their IDs...`);
    ids = recordIds(dir, found.record.list);
    if (ids.length) {
      try { writeFileSync(join(dir, IDS_FILE), ids.join("\n") + "\n"); } catch (e) {
        say(`problem init: Synthe can't write ${join(dir, IDS_FILE)} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}).`);
        return 1;
      }
      found.command = found.record.count ? `${found.record.run} 2>&1 | ${found.record.count}` : found.record.run;
    }
  }
  const draft = draftProblem(found);
  try { writeFileSync(file, JSON.stringify(draft, null, 2) + "\n"); } catch (e) {
    say(`problem init: Synthe can't write ${file} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}).`);
    return 1;
  }
  const check = validateProblem(draft, file);
  if (!check.ok || !found.command) {
    say(`Wrote a starter file: ${file}`);
    say(found.command
      ? "Synthe found a test command, but the file is not complete yet."
      : found.record ? `Synthe ran the tests in ${found.testFiles.length} test file${found.testFiles.length === 1 ? "" : "s"}, but it could not record a test ID. Run the tests yourself and check that they start.`
      : found.runner ? `Synthe found ${found.runner === "npm" ? "an npm \"test\" script" : "pytest"}, but no test file for it to run.`
      : "Synthe found no test command that it can count (an npm \"test\" script that runs node --test, jest, vitest or mocha, or pytest).");
    say("Fill these fields:");
    for (const p of check.ok ? [] : check.problems) say(`  ${p}`);
    say(`measure.command must print one number as its last output: the score. Then run "npx synthe problem check ${shown(file, cwd)}".`);
    return 2;
  }

  const runner = found.runner === "npm" ? (found.js && found.record ? found.js.runner : found.record ? "node --test" : "npm test") : "pytest";
  const n = found.testFiles.length;
  say(`Wrote ${file}`);
  say(`  name: ${draft.name}`);
  say(`  goal: ${draft.goal}`);
  say(`  artifact: ${(draft.artifact as string[]).join(", ")} (the source folder ${found.source}: the only files Synthe may change)`);
  const shadow = new Set(found.python?.shadow ?? []);
  const globs = (draft.protect as string[]).filter((g) => !found.testFiles.includes(g) && !shadow.has(g));
  if (found.pytestConfig) say(`  pytest reads only ${found.pytestConfig.file}${found.pytestConfig.create ? " (a file that Synthe wrote, because the repository has no pytest configuration)" : ""}, with the root here. A new configuration file, PYTEST_ADDOPTS, PYTEST_PLUGINS, PYTHONPATH and the user site are never read.`);
  if (found.js && found.record) say(`  ${found.js.runner} reads only ${found.js.config ?? "its built-in defaults"}${found.js.create ? " (a file that Synthe wrote, because the repository has none)" : ""}. A new configuration file is never read. The measure reads the runner's JSON report from a temporary file, through ${JS_HELPER_FILE}.`);
  if (ids.length) say(`  test IDs: ${ids.length}, in ${IDS_FILE}. Only these count, and each counts only when it runs once and passes.`);
  say(`  protect: ${globs.join(", ")}, and the ${n} test file${n === 1 ? "" : "s"} (${found.tests ? `the test folder ${found.tests}, ` : ""}every test file and this file never change)`);
  if (found.python?.pathFolders.length) {
    say(found.python.shadow.length
      ? `  protect also: <name>.py and <name>/** in ${found.python.pathFolders.join(", ")} for ${found.python.names} module names (the standard library and the installed modules), so no new file can shadow a module`
      : `  Warning: Synthe could not list the modules of ${found.python.interpreter}, so protect does not stop a new file in ${found.python.pathFolders.join(", ")} from shadowing a module. Run problem init again when that Python runs.`);
  }
  say(`  measure: runs ${runner} on the ${n} test file${n === 1 ? " that exists" : "s that exist"} now and counts passing tests, higher is better. A new test file never counts.`);
  say(`  proposer: the claude agent, run as "claude ${CLAUDE_ARGS.join(" ")} -p <prompt>" so that it can edit files (the "claude" command must be on your PATH)`);
  say(`  model: ${MODEL.model} from ${MODEL.provider}, for the model proposer, as in CI (it reads the key from SYNTHE_ANTHROPIC_KEY)`);
  say(`Limit: the code under test runs in the same process as the tests, so it can tamper with the test framework itself (for example, an assert that never fails), and no passing-test count can stop that.`);
  say(`To catch such a change, use a held-back split (split.holdout), add guards, and review each pull request before you merge it.`);
  // solve measures a checkout of HEAD, so a file that init wrote and nobody committed is not there.
  const written = [PROBLEM_FILE, ...(ids.length ? [IDS_FILE] : []), ...(found.pytestConfig?.create ? [found.pytestConfig.file] : []), ...jsFiles.map(([name]) => name)];
  const inDir = relative(cwd, dir) === "" ? "" : ` -C ${shown(dir, cwd)}`;
  say(`Read the file and change what is wrong. Then commit the files that Synthe wrote, because solve works only on committed files:`);
  say(`  git${inDir} add ${written.join(" ")} && git${inDir} commit -m "Add the Synthe problem file"`);
  say(`Then run:`);
  say(`  npx synthe solve ${shown(file, cwd)}`);
  return 0;
}
