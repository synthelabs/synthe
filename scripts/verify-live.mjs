// The closed verification loop for one task of the Tier A plan (section B). One script decides whether a
// task is done; no model does. Gates run in order and stop at the first failure, so a worker sees one problem.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MAX_BUFFER = 256 * 1024 * 1024; // npm test prints a lot; the default 1 MB would cut it off.

// Each task's Files list from the plan. Only task 7 owns dist/, so only it may leave dist changed.
export const TASK_FILES = {
  "0": ["scripts/verify-live.mjs", "scripts/verify-live.d.mts", "package.json", "test/live-verify.test.ts"],
  "1": ["src/live/rule.ts", "test/live-rule.test.ts"],
  "2": ["src/live/stats.ts", "test/live-stats.test.ts"],
  "3": ["src/live/gate.ts", "scripts/mutation-check.mjs", "test/live-gate.test.ts"],
  "4": ["scripts/simulate-live-gate.ts", "package.json", "test/live-simulate.test.ts"],
  "5": ["src/metric/types.ts", "src/metric/command.ts", "test/metric-conformance.ts", "test/metric-source.test.ts"],
  "6": ["src/live/assign.ts", "docs/assign-vectors.json", "test/live-assign.test.ts"],
  "7": ["src/cli/metric-check.ts", "src/live/plan.ts", "src/cli/main.ts", "dist/cli.js", "test/live-plan.test.ts", "test/metric-check.test.ts"],
};
const ALL_FILES = [...new Set(Object.values(TASK_FILES).flat())];

// Tests cancelled on origin/main in this container (Node 22 here; CI runs Node 24). They were already
// failing before this plan, so G4 lets them through and nothing else. Matched by substring of the not-ok name.
const KNOWN_CANCELLED = [
  "a dead, hanging or refusing proxy never slows or fails the run, and sends stop after two failures",
  "a timed-out send is not retried; a failed connection is retried exactly once",
  "wrapped io, exec and model record what the person saw, answered and ran, with tokens, cost and stop reason",
  "candidate diffs come from the files as the model saw them, as a unified diff, cut at 20 KB and never beyond",
  "recorded() marks a crash and still sends the final batch, within the close wait, through a real socket",
];

// Changed paths outside the allowed list, or null. Pure so the test can call it without git.
export function scopeProblem(changed, allowed) {
  const outside = changed.filter((file) => !allowed.includes(file));
  return outside.length ? `Changed outside this task: ${outside.join(", ")}` : null;
}

const ok = () => ({ ok: true });
const fail = (problem, tail = "") => ({ ok: false, problem, tail });
const skip = (why) => ({ skipped: true, why });

function tail(text) {
  return text.trimEnd().split("\n").slice(-40).join("\n");
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: MAX_BUFFER });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { status: r.status, signal: r.signal, output, tail: tail(output) };
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: MAX_BUFFER })
    .split("\n")
    .filter(Boolean);
}

function g1(allowed) {
  // Uncommitted work is checked against this task's own list. Committed work is checked against the union,
  // because earlier tasks are already committed on the branch.
  const uncommitted = [...git(["diff", "--name-only", "HEAD"]), ...git(["ls-files", "--others", "--exclude-standard"])];
  const own = scopeProblem(uncommitted, allowed);
  if (own) return fail(own);
  const committed = scopeProblem(git(["diff", "--name-only", "origin/main...HEAD"]), ALL_FILES);
  return committed ? fail(committed) : ok();
}

function g2() {
  const r = run("npm", ["run", "-s", "typecheck"]);
  return r.status === 0 ? ok() : fail(`Typecheck failed: npm run -s typecheck exited ${r.status}. Fix the errors in the tail.`, r.tail);
}

function g3(testFiles) {
  if (!testFiles.length) return fail("This task lists no test file in test/.");
  const r = run("node", ["--test", ...testFiles]);
  if (r.status !== 0) return fail(`Task tests failed: node --test ${testFiles.join(" ")} exited ${r.status}. See the failing assertion in the tail.`, r.tail);
  const summary = /^# tests (\d+)$/m.exec(r.output);
  if (!summary || Number(summary[1]) === 0) return fail("No task test ran: the '# tests' summary is missing or zero.", r.tail);
  return ok();
}

function g4(id) {
  const r = run("npm", ["test"]);
  // npm test rebuilds dist/ (test/e2e.test.ts), so restore it unless this task owns it.
  if (id !== "7" && id !== "all") run("git", ["checkout", "--", "dist"]);
  if (r.status === 0) return ok();
  const failCount = /^# fail (\d+)$/m.exec(r.output);
  const notOk = [...r.output.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((m) => m[1]);
  const unexpected = notOk.filter((name) => !KNOWN_CANCELLED.some((known) => name.includes(known)));
  if (failCount && Number(failCount[1]) === 0 && notOk.length > 0 && unexpected.length === 0) return ok();
  const why = unexpected.length ? `Failing tests that are not known: ${unexpected.join("; ")}` : `npm test exited ${r.status}`;
  return fail(`npm test failed. ${why}.`, r.tail);
}

function g5() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  if (!pkg.scripts?.["simulate:live"]) return skip("no simulate:live script yet (added in task 4)");
  const r = run("npm", ["run", "-s", "simulate:live"]);
  return r.status === 0 ? ok() : fail(`simulate:live exited ${r.status}: a rate is outside its limit.`, r.tail);
}

// Each entry of scripts/mutation-check.mjs is one line: [name, file, find, replace]. Older lines use constants
// or single quotes, which JSON cannot read; they are skipped here, not treated as errors.
function parseEntries(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    let body = line.trim();
    if (body.endsWith(",")) body = body.slice(0, -1);
    let value;
    try {
      value = JSON.parse(body);
    } catch {
      continue;
    }
    if (Array.isArray(value) && value.length === 4 && value.every((item) => typeof item === "string")) {
      entries.push({ name: value[0], file: value[1], find: value[2], replace: value[3] });
    }
  }
  return entries;
}

function readTree(dir) {
  const files = new Map();
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(relative(ROOT, full), readFileSync(full, "utf8"));
    }
  };
  walk(join(ROOT, dir));
  return files;
}

// Runs each mutation through the task's test files. Returns the src/ snapshot taken before any mutation,
// so G7 can prove every file was restored.
function g6(allowed, testFiles, state) {
  const entries = parseEntries(readFileSync(join(ROOT, "scripts/mutation-check.mjs"), "utf8")).filter((e) => allowed.includes(e.file));
  if (!entries.length) return skip("no mutation entries for this task's files");
  state.snapshot = readTree("src");
  let mutated = null;
  const survivors = [];
  try {
    for (const entry of entries) {
      const path = join(ROOT, entry.file);
      if (!existsSync(path)) return fail(`Stale mutation "${entry.name}": ${entry.file} does not exist.`);
      const original = readFileSync(path, "utf8");
      if (!original.includes(entry.find)) return fail(`Stale mutation "${entry.name}": its find text is not in ${entry.file}.`);
      mutated = { path, original };
      writeFileSync(path, original.replace(entry.find, () => entry.replace));
      // A mutation that makes a test loop forever must not hang the gate. A timeout ends with no exit status,
      // and counts as not caught, the same as scripts/mutation-check.mjs.
      const r = spawnSync("node", ["--test", ...testFiles], { cwd: ROOT, encoding: "utf8", maxBuffer: MAX_BUFFER, timeout: 120000 });
      // The parent cannot run its own SIGINT handler while spawnSync blocks, so check the child's signal here.
      if (r.signal === "SIGINT") throw new Error("interrupted during the mutation run");
      writeFileSync(path, original);
      mutated = null;
      if (r.status === 0) survivors.push(entry.name);
      else if (r.status === null) survivors.push(`${entry.name} (timed out)`);
    }
  } finally {
    if (mutated) writeFileSync(mutated.path, mutated.original);
  }
  return survivors.length ? fail(`Mutations survived, so the tests miss them: ${survivors.join("; ")}.`) : ok();
}

function g7(allowed, state) {
  const paths = git(["status", "--porcelain", "--untracked-files=all"]).map((line) => line.slice(3).split(" -> ").pop());
  const outside = paths.filter((file) => !allowed.includes(file));
  if (outside.length) return fail(`Leftover change outside this task: ${outside.join(", ")}. Revert it or commit it under its own task.`);
  if (state.snapshot) {
    const now = readTree("src");
    const differs = [...new Set([...state.snapshot.keys(), ...now.keys()])].filter((file) => now.get(file) !== state.snapshot.get(file));
    if (differs.length) return fail(`Mutation text is left in src/: ${differs.join(", ")}. Restore the file.`);
  }
  return ok();
}

function main(id) {
  const allowed = id === "all" ? ALL_FILES : TASK_FILES[id];
  const testFiles = allowed.filter((file) => /^test\/[^/]+\.test\.ts$/.test(file));
  const state = { snapshot: null };
  const gates = [
    ["G1", () => g1(allowed)],
    ["G2", () => g2()],
    ["G3", () => g3(testFiles)],
    ["G4", () => g4(id)],
    ["G5", () => g5()],
    ["G6", () => g6(allowed, testFiles, state)],
    ["G7", () => g7(allowed, state)],
  ];
  for (const [gate, check] of gates) {
    let result;
    try {
      result = check();
    } catch (error) {
      result = fail(`${gate} could not run: ${error.message}`);
    }
    if (result.skipped) console.log(JSON.stringify({ gate, skipped: true, why: result.why }));
    else if (result.ok) console.log(JSON.stringify({ gate, ok: true }));
    else {
      console.log(JSON.stringify({ gate, ok: false, problem: result.problem, tail: result.tail }));
      process.exit(1);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const id = process.argv[2];
  if (!id || !(id === "all" || Object.hasOwn(TASK_FILES, id))) {
    console.error("Usage: node scripts/verify-live.mjs <task-id>\n  task-id: 0 to 7, or all");
    process.exit(2);
  }
  main(id);
}
