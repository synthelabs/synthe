import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { gzipSync } from "node:zlib";
import { COMMAND_TIMEOUT_MS, type Direction, type ImproveConfig, type PresetId } from "./config.ts";
import type { Exec } from "./exec.ts";

export interface Preset { id: PresetId; label: string; unit: string; direction: Direction; runs: number; command: string; guard: string | null;
  requiresGuard?: boolean; // the number can be gamed by deleting features, so a run needs a regression check
  note?: string; // one plain sentence shown under the preset in the menu
}

const NPM_PLACEHOLDER = 'echo "Error: no test specified" && exit 1';

// How to run pytest in a worktree of this repo; only built when the repo shows a Python tests setup.
export interface PythonSetup { command: string }

const win = process.platform === "win32";
const VENV_NAMES = [".venv", "venv"];

// Only what this repo can run. The first preset is the recommended one.
export function detectPresets(files: { path: string; text: string }[], python: PythonSetup | null = null): Preset[] {
  let scripts: Record<string, unknown> = {};
  const pkg = files.find((f) => f.path === "package.json");
  if (pkg) {
    try { scripts = JSON.parse(pkg.text)?.scripts ?? {}; } catch { /* an unreadable package.json offers only custom */ }
  }
  const hasTest = typeof scripts.test === "string" && scripts.test.trim() !== "" && scripts.test.trim() !== NPM_PLACEHOLDER;
  const hasBuild = typeof scripts.build === "string" && scripts.build.trim() !== "";
  // A regression check must pass on today's code. When the metric is "tests passing" there is no separate check:
  // a repo with failing tests is exactly where that number has room to grow, and a check that demanded every
  // test pass would refuse to start. Other metrics are guarded by the project's test run (npm first, else pytest).
  const guard = hasTest ? "npm test" : python ? python.command : null;
  const both = hasTest && python !== null;
  // Three runs for tests too: a flaky test then shows up as run-to-run spread, and one lucky run can't win.
  const tests: Preset[] = [];
  if (hasTest) tests.push({ id: "test-pass", label: both ? "tests passing (npm test)" : "tests passing", unit: "tests", direction: "higher", runs: 3, command: "npm test", guard: null });
  if (python) tests.push({ id: "pytest", label: "tests passing (pytest)", unit: "tests", direction: "higher", runs: 3, command: python.command, guard: null });
  // Shrinking a bundle or a build is easy by deleting features, so these never run without a check that notices.
  const note = guard ? undefined : "No test script to check nothing broke, so this needs --guard <a command that fails if the app is broken>.";
  const build: Preset[] = hasBuild ? [
    { id: "bundle-size", label: "built JS and CSS, gzipped", unit: "bytes", direction: "lower", runs: 1, command: "npm run build", guard, requiresGuard: true, ...(note && { note }) },
    { id: "build-time", label: "build time", unit: "ms", direction: "lower", runs: 3, command: "npm run build", guard, requiresGuard: true, ...(note && { note }) },
  ] : [];
  const custom: Preset = { id: "custom", label: "your own command", unit: "units", direction: "higher", runs: 3, command: "", guard };
  // The first preset is the recommended one: the tests when the repo has them, otherwise the person's own command.
  return tests.length ? [...tests, ...build, custom] : [custom, ...build];
}

const PYTHON_TEST_FILE = /^(test_.*|.*_test)\.py$/;

function hasPythonTests(dir: string, depth = 3): boolean {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  return entries.some((e) => (e.isFile() && PYTHON_TEST_FILE.test(e.name))
    || (depth > 0 && e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules" && hasPythonTests(join(dir, e.name), depth - 1)));
}

const onPath = (name: string) => (process.env.PATH ?? "").split(delimiter).some((d) => d && existsSync(join(d, win ? `${name}.exe` : name)));

// `src/` holds the package when it has a Python package folder or module in it (the "src layout").
function srcLayout(top: string): boolean {
  try {
    return readdirSync(join(top, "src"), { withFileTypes: true }).some((e) =>
      (e.isFile() && e.name.endsWith(".py")) || (e.isDirectory() && existsSync(join(top, "src", e.name, "__init__.py"))));
  } catch { return false; }
}

// The pytest command for this repo, or null when it shows no Python tests.
export function pythonSetup(top: string): PythonSetup | null {
  const signals = ["pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini"].some((f) => existsSync(join(top, f)))
    || hasPythonTests(join(top, "tests"))
    || readdirSync(top, { withFileTypes: true }).some((e) => e.isFile() && PYTHON_TEST_FILE.test(e.name));
  if (!signals) return null;
  // The measurement runs in a worktree where a repo-root venv is linked in (see worktree.ts), so a relative
  // path finds it there. Without one, the system Python.
  const venv = VENV_NAMES.find((v) => existsSync(join(top, v, win ? "Scripts" : "bin", win ? "python.exe" : "python")));
  const python = venv ? (win ? `${venv}\\Scripts\\python` : `${venv}/bin/python`) : win || !onPath("python3") ? "python" : "python3";
  // `python -m` puts the worktree first on sys.path, which covers a flat layout. A src layout is usually
  // installed editable, which would import the ORIGINAL repo's package and measure the wrong code, so src/ goes
  // first on the path explicitly.
  const src = srcLayout(top);
  const run = `${python} -m pytest -q${src && win ? " -o pythonpath=src" : ""}`;
  return { command: src && !win ? `PYTHONPATH=src ${run}` : run };
}

// What this repo can measure: package.json scripts and Python tests, read from the repo on disk.
export function presetsForRepo(top: string): Preset[] {
  const pkg = join(top, "package.json");
  return detectPresets(existsSync(pkg) ? [{ path: "package.json", text: readFileSync(pkg, "utf8") }] : [], pythonSetup(top));
}

const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

// The last line that is only a number, so `npm run`'s "> app@1.0.0 metric" banner lines don't count.
export function lastNumber(stdout: string): number | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => NUMBER.test(l));
  if (!lines.length) return null;
  const n = Number(lines.at(-1));
  return Number.isFinite(n) ? n : null;
}

const lastMatch = (text: string, re: RegExp) => {
  const all = [...text.matchAll(re)];
  return all.length ? Number(all.at(-1)![1]) : null;
};

// Passing tests from the summary line of node:test, jest/vitest, mocha or pytest.
export function countPassed(output: string): number | null {
  return lastMatch(output, /^\s*[ℹ#] pass (\d+)\s*$/gm)
    ?? lastMatch(output, /^\s*Tests:?\s.*?(\d+) passed/gm)
    ?? lastMatch(output, /^\s*(\d+) passing\b/gm)
    ?? lastMatch(output, /^=+ .*?\b(\d+) passed\b.*=+\s*$/gm)
    ?? lastMatch(output, PYTEST_PASSED)
    ?? pytestAllFailed(output);
}

// `pytest -q` prints no "=====" rule: "12 passed, 1 failed in 0.3s", "1 failed, 5 passed, 2 warnings in 1.20s".
const PYTEST_PASSED = /^(?:\d+ \w+(?:, | and ))*(\d+) passed\b(?:(?:, | and )\d+ \w+)* in \d[\d.]*s\b/gm;
const PYTEST_SUMMARY = /^(?:\d+ \w+(?:, | and )?)+ in \d[\d.]*s\b.*$/gm;

// A run where every test failed prints "3 failed in 0.1s": zero passing, a real number. Collection errors alone
// ("1 error in 0.1s") stay uncounted: that is a broken run, not a measurement.
function pytestAllFailed(output: string): number | null {
  const last = [...output.matchAll(PYTEST_SUMMARY)].at(-1)?.[0];
  return last && /\b\d+ failed\b/.test(last) ? 0 : null;
}

const countIn = (line: string, re: RegExp) => Number(re.exec(line)?.[1] ?? 0);

// Failed tests from the same summary lines countPassed reads, in the same runner order. pytest errors count as
// failures: a test that errors in setup did not pass. null when no runner summary is found.
export function countFailed(output: string): number | null {
  const node = lastMatch(output, /^\s*[ℹ#] fail (\d+)\s*$/gm);
  if (node !== null) return node;
  const jest = [...output.matchAll(/^\s*Tests:?\s.*\b(?:passed|failed)\b.*$/gm)].at(-1)?.[0];
  if (jest) return countIn(jest, /(\d+) failed/);
  if (/^\s*\d+ passing\b/m.test(output) || /^\s*\d+ failing\b/m.test(output)) return lastMatch(output, /^\s*(\d+) failing\b/gm) ?? 0;
  const pytest = [...output.matchAll(/^=+ (.*\b(?:passed|failed|errors?)\b.*?) =+\s*$/gm)].at(-1)?.[1] ?? [...output.matchAll(PYTEST_SUMMARY)].at(-1)?.[0];
  if (pytest && /\b\d+ (?:passed|failed|errors?)\b/.test(pytest)) return countIn(pytest, /(\d+) failed/) + countIn(pytest, /(\d+) errors?\b/);
  return null;
}

// One failing test per line, for node:test (TAP and spec), jest, vitest, mocha and pytest. A name only has to read the
// same from run to run: names are compared as text, never parsed further. Durations are cut so they can't differ.
const FAILING_LINES: RegExp[] = [
  /^\s*not ok \d+ - (.+)$/, // TAP (node --test when output is not a terminal)
  /^\s*✖ (.+)$/, // node:test spec reporter
  /^\s*● (.+)$/, // jest failure headers ("● Suite › name", "● Test suite failed to run")
  /^\s*[✕×] (.+)$/, // jest verbose, vitest
  /^\s*FAIL\s+(.+)$/, // jest and vitest file lines, so a test file that stops loading counts too
  /^\s*\d+\) (.+?):?\s*$/, // mocha ("1) suite name")
  /^(?:FAILED|ERROR) (\S+)/, // pytest short summary
  /^(\S+::\S+) (?:FAILED|ERROR)\b/, // pytest -v
];
const DURATION = /\s+\(?\d+(?:\.\d+)?\s*(?:ms|s)\)?$/;

// The failing tests in one run. null when the runner says tests failed but fewer were named than it counted, so a
// newly broken test could be missing from the list. Extra names (a parent suite, a file line) are harmless: the same
// lines appear in every run of the same code, and a change is judged only on names that were not failing before.
export function failingTests(output: string): string[] | null {
  const failed = countFailed(output);
  if (failed === 0) return [];
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    for (const re of FAILING_LINES) {
      const m = re.exec(line);
      if (!m) continue;
      const name = m[1].replace(/\s+#\s*time=.*$/, "").replace(DURATION, "").trim();
      // Not tests: TAP todo/skip lines, node's "✖ failing tests:" header, jest's "● Console" block for logged output.
      if (name && !/#\s*(?:TODO|SKIP)\b/i.test(name) && !/^(?:failing tests:?|Console)$/i.test(name)) names.add(name);
      break;
    }
  }
  return failed !== null && names.size >= failed ? [...names].sort() : null;
}

const OUTPUT_DIRS = ["dist", "build", "out", ".next/static", "public/build"];

function builtFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : builtFiles(path);
    return e.isFile() && /\.(m?js|css)$/.test(e.name) ? [path] : [];
  });
}

// Gzipped bytes of the built JS and CSS: roughly what a visitor downloads.
export function bundleBytes(root: string): number | null {
  const dir = OUTPUT_DIRS.map((d) => join(root, d)).find((d) => existsSync(d) && statSync(d).isDirectory());
  if (!dir) return null;
  const files = builtFiles(dir);
  if (!files.length) return null;
  return files.reduce((sum, f) => sum + gzipSync(readFileSync(f)).length, 0);
}

export const REASONS = {
  noNumber: "The metric command printed no number.",
  failed: "The metric command failed (exit code not 0).",
  timedOut: "The metric command took longer than 10 minutes.",
  noTests: "No tests were counted in the output.",
  noBuild: "No built JS or CSS was found under dist, build, out, .next/static or public/build.",
};

// The metrics where the number is a count of passing tests, so the tests are also the regression check (see verdict.ts).
export const countsTests = (config: ImproveConfig) => config.metric.preset === "test-pass" || config.metric.preset === "pytest";

export async function measureOnce(exec: Exec, cwd: string, config: ImproveConfig): Promise<{ value: number | null; ms: number; reason?: string; failing?: string[] | null }> {
  const r = await exec(cwd, config.metric.command, COMMAND_TIMEOUT_MS);
  const none = (reason: string) => ({ value: null, ms: r.ms, reason });
  if (r.timedOut) return none(REASONS.timedOut);
  switch (config.metric.preset) {
    case "test-pass":
    case "pytest": {
      // Failing tests exit non-zero but still count: fewer passing is a lower number, not a broken measurement.
      const out = `${r.stdout}\n${r.stderr}`;
      const n = countPassed(out);
      return n === null ? none(REASONS.noTests) : { value: n, ms: r.ms, failing: failingTests(out) };
    }
    case "bundle-size": {
      if (!r.ok) return none(REASONS.failed);
      const n = bundleBytes(cwd);
      return n === null ? none(REASONS.noBuild) : { value: n, ms: r.ms };
    }
    case "build-time":
      return r.ok ? { value: r.ms, ms: r.ms } : none(REASONS.failed);
    default: {
      if (!r.ok) return none(REASONS.failed);
      const n = lastNumber(r.stdout);
      return n === null ? none(REASONS.noNumber) : { value: n, ms: r.ms };
    }
  }
}
