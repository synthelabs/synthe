// Stage 4i (swarm/GOAL-3.md): test IDs for jest, vitest and mocha. `problem init` writes HELPER_SOURCE to a protected
// file next to the problem file. The measure runs it. It runs the runner with a machine-readable report that goes to
// a new temporary file, so text that the code under test prints can never pass as a report. It names the protected
// root configuration itself (or none), and only the test files that existed at init.
// The helper is one plain ESM file with no imports outside Node, so it runs in any repository. Its parse functions
// are exported, so the unit tests import the same text that init writes.

export type JsRunner = "jest" | "vitest" | "mocha";
export const JS_RUNNERS: JsRunner[] = ["jest", "vitest", "mocha"];
export const JS_HELPER_FILE = "synthe.js-tests.mjs";
// vitest has no flag for "no configuration", so when the repository has none, init writes this empty one to name.
export const EMPTY_VITEST_CONFIG = "synthe.vitest.config.mjs";
export { JS_CONFIG_GLOBS } from "./runner-paths.ts";

// The root configuration each runner reads, in the runner's own order.
export const ROOT_CONFIGS: Record<JsRunner, RegExp> = {
  jest: /^jest\.config\.(?:[cm]?js|[cm]?ts|json)$/,
  vitest: /^(?:vitest|vite)\.config\.(?:[cm]?js|[cm]?ts)$/,
  mocha: /^\.mocharc\.(?:c?js|json|jsonc|ya?ml)$/,
};

/** The runner that an npm test script starts, when it starts one of the three directly. */
export function jsRunnerOf(script: string): JsRunner | null {
  const m = /^\s*(?:npx\s+)?(jest|vitest|mocha)(?:\s|$)/.exec(script);
  return m ? m[1] as JsRunner : null;
}

export const HELPER_SOURCE = String.raw`// Written by "synthe problem init" (stage 4i). The measure runs this file; protect keeps it unchanged.
// Usage: node ${JS_HELPER_FILE} count|list <jest|vitest|mocha> <root configuration, or - for none> <test files...>
// count: prints the number of recorded test IDs (synthe.test-ids.txt) that ran exactly once and passed.
// list: prints each test ID that ran exactly once, passed or not.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const IDS_FILE = "synthe.test-ids.txt";

// A report path, relative to the repository, with forward slashes.
export function relFile(name, roots) {
  if (typeof name !== "string") return "";
  if (name.startsWith("file:")) { try { name = fileURLToPath(name); } catch {} }
  if (!isAbsolute(name)) return name.split(sep).join("/");
  const names = [name];
  try { names.push(realpathSync(name)); } catch {}
  for (const n of names) for (const r of roots) {
    const rel = relative(r, n);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.split(sep).join("/");
  }
  return name.split(sep).join("/");
}

// One ID: the test file, the describe blocks and the test title, as one JSON line.
export const idOf = (file, ancestors, title) => JSON.stringify([file, ...ancestors, title]);

// The rows of a report: one { id, pass } for each test that ran. null when the report does not parse.
export function reportRows(runner, text, roots) {
  let r;
  try { r = JSON.parse(text); } catch { return null; }
  if (typeof r !== "object" || r === null) return null;
  const str = (v) => typeof v === "string" ? v : "";
  if (runner === "mocha") {
    if (!Array.isArray(r.tests)) return null;
    // mocha's JSON gives no describe path, only the full title (the describe titles and the title, with spaces).
    const key = (t) => typeof t === "object" && t !== null ? idOf(relFile(t.file, roots), [], str(t.fullTitle)) : "";
    const set = (a) => new Set(Array.isArray(a) ? a.map(key) : []);
    const passes = set(r.passes), bad = new Set([...set(r.failures), ...set(r.pending)]);
    return r.tests.map(key).filter(Boolean).map((id) => ({ id, pass: passes.has(id) && !bad.has(id) }));
  }
  if (!Array.isArray(r.testResults)) return null;
  const rows = [];
  for (const file of r.testResults) {
    if (typeof file !== "object" || file === null || !Array.isArray(file.assertionResults)) continue;
    const f = relFile(file.name, roots);
    for (const a of file.assertionResults) {
      if (typeof a !== "object" || a === null) continue;
      const anc = Array.isArray(a.ancestorTitles) ? a.ancestorTitles.map(str) : [];
      rows.push({ id: idOf(f, anc, str(a.title)), pass: a.status === "passed" });
    }
  }
  return rows;
}

// Each ID with the number of times it ran, and whether every run passed.
function tally(rows) {
  const seen = new Map(), bad = new Set();
  for (const { id, pass } of rows) { seen.set(id, (seen.get(id) ?? 0) + 1); if (!pass) bad.add(id); }
  return { seen, bad };
}

// A recorded ID counts when it ran exactly once and passed. Other IDs count nothing.
export function countRecorded(recorded, rows) {
  const { seen, bad } = tally(rows ?? []);
  let n = 0;
  for (const id of new Set(recorded)) if (seen.get(id) === 1 && !bad.has(id)) n++;
  return n;
}

// The IDs to record: each one that ran once. An ID that two tests share could never count.
export function listOnce(rows) {
  const { seen } = tally(rows ?? []);
  return [...seen].filter(([, n]) => n === 1).map(([id]) => id).sort();
}

// The runner's own command. Its configuration is named, so a configuration file that a proposal adds is never read.
export function runnerArgs(runner, config, files, out) {
  const cfg = config && config !== "-" ? config : null;
  if (runner === "jest") return ["--ci", "--no-watchman", "--forceExit", "--json", "--outputFile=" + out, "--config", cfg ?? "{}", "--runTestsByPath", "--", ...files];
  if (runner === "vitest") return ["run", "--config", cfg ?? "${EMPTY_VITEST_CONFIG}", "--reporter=json", "--outputFile=" + out, "--watch=false", "--", ...files];
  return [...(cfg ? ["--config", cfg] : ["--no-config"]), "--reporter", "json", "--reporter-option", "output=" + out, "--exit", "--", ...files];
}

// The runner's command-line script in this repository's node_modules.
function runnerBin(runner) {
  const dir = join(process.cwd(), "node_modules", runner);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[runner];
  return join(dir, bin);
}

function main(argv) {
  const [mode, runner, config, ...files] = argv;
  if (!["count", "list"].includes(mode) || !["jest", "vitest", "mocha"].includes(runner)) {
    process.stderr.write("usage: node ${JS_HELPER_FILE} count|list <jest|vitest|mocha> <config or -> <test files...>\n");
    return 2;
  }
  const tmp = mkdtempSync(join(tmpdir(), "synthe-report-"));
  const out = join(tmp, "report.json");
  let text = "";
  try {
    // The runner's own output goes nowhere: only the report file counts.
    spawnSync(process.execPath, [runnerBin(runner), ...runnerArgs(runner, config, files, out)], { stdio: "ignore", timeout: 1_800_000, env: { ...process.env, CI: "1" } });
    if (existsSync(out)) text = readFileSync(out, "utf8");
  } catch {} finally { try { rmSync(tmp, { recursive: true, force: true }); } catch {} }
  const roots = [process.cwd()];
  try { roots.push(realpathSync(process.cwd())); } catch {}
  // A report that does not parse, or no report because the test process died, counts 0.
  const rows = reportRows(runner, text, roots) ?? [];
  if (mode === "list") { for (const id of listOnce(rows)) process.stdout.write(id + "\n"); return 0; }
  let recorded = [];
  try { recorded = readFileSync(IDS_FILE, "utf8").split("\n").filter((l) => l.trim() !== ""); } catch {}
  process.stdout.write(countRecorded(recorded, rows) + "\n");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
`;
