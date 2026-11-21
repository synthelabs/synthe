#!/usr/bin/env node
// The Synthe score: how well `synthe solve` does, with a real model, on problems it was not tuned to.
//
//   node scripts/score/score.mjs                      # the hidden set; needs HIDDEN_SET_KEY and SYNTHE_ANTHROPIC_KEY
//   node scripts/score/score.mjs --problems <dir>     # a plain folder of problems in the same layout
//   node scripts/score/score.mjs --self-test          # the demo set against a loopback fake model: free
//   ... --detail <file>                               # also write per-problem detail to a file
//
// Environment: SCORE_MODEL (the model id), SCORE_INPUT_PER_MTOK and SCORE_OUTPUT_PER_MTOK (USD per million tokens),
// SCORE_MAX_USD (the cap for the whole run), SCORE_RUNS (runs per version of a noisy measure, default 12).
// SCORE_API_URL points the run at a loopback fake of the API for a dry run; any other address is refused.
//
// For each problem: b is the baseline's score on the holdout split, f is the score of the branch that `solve` made,
// and r is the score of a reference solution. The gain share is (f - b) / (r - b), clamped to [-1, 1]. A false keep
// is a kept change that the scorer measures again, with more runs, and finds to be no real gain.
//
//   Synthe score = mean gain share - 2 * (false keeps / kept changes)
//
// This file prints only totals. The swarm can read workflow logs, so a problem's name, files, cases and numbers
// must never reach stdout or stderr. Per-problem detail goes only to the --detail file.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeApi } from "./fake-api.mjs";
import { startMeter, usageOf } from "./meter.mjs";
import { gainShare, isFalseKeep, mean, studentTCdf, syntheScore, welchP } from "./stats.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
// The code under test. SCORE_SYNTHE_DIR lets the workflow take the scorer from one checkout and Synthe from another.
const CLI = join(process.env.SCORE_SYNTHE_DIR ? resolve(process.env.SCORE_SYNTHE_DIR) : ROOT, "src", "cli", "main.ts");
const HIDDEN_SET = join(ROOT, "swarm", "hidden", "set.tar.gz.enc");
const DEMO = join(HERE, "demo");
const API = "https://api.anthropic.com";
// `solve` gets this in place of the key. The gate (meter.mjs) puts the real key on the outgoing request.
const PLACEHOLDER_KEY = "sk-ant-score-gate-placeholder";
const NOISY_RUNS = 12;
const COMMAND_TIMEOUT_MS = 5 * 60_000;
const SOLVE_TIMEOUT_MS = 45 * 60_000;

// A stop with a message that is safe to print: it never holds problem content.
class Stop extends Error {
  constructor(message, code = 2) { super(message); this.code = code; }
}

// Every temporary folder of this run. The decrypted set is in one of them, so a stopped run removes them too.
const TEMP = new Set();
function tempDir(prefix, parent = tmpdir()) {
  const dir = mkdtempSync(join(parent, prefix));
  if (parent === tmpdir()) TEMP.add(dir);
  return dir;
}
function removeTemp(dir) { rmSync(dir, { recursive: true, force: true }); TEMP.delete(dir); }
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => { for (const dir of TEMP) rmSync(dir, { recursive: true, force: true }); process.exit(130); });
}

// ---------------------------------------------------------------------------------------------------------------
// Processes

// Commands of a problem run model-written code. They get a small environment: no key, no token, no SCORE_* value.
function cleanEnv(extra = {}) {
  const env = {};
  for (const k of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SystemRoot", "ComSpec", "PATHEXT"]) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}

// Runs a command and never throws. With `shell`, `file` is a shell command line.
function run(file, args, { cwd, env, timeoutMs = COMMAND_TIMEOUT_MS, shell = false, input } = {}) {
  return new Promise((done) => {
    const win = process.platform === "win32";
    const child = shell
      ? spawn(win ? "cmd" : "sh", [win ? "/c" : "-c", file], { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: !win })
      : spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: !win });
    let stdout = "", stderr = "", timedOut = false, ended = false;
    const cap = 4 * 1024 * 1024;
    child.stdout.on("data", (d) => { if (stdout.length < cap) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < cap) stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (win) child.kill("SIGKILL"); else process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    const finish = (code) => { if (ended) return; ended = true; clearTimeout(timer); done({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut }); };
    child.on("error", () => finish(null));
    child.on("close", finish);
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

const GIT_ID = ["-c", "user.name=Synthe score", "-c", "user.email=score@users.noreply.github.com", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"];
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...GIT_ID, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();

// ---------------------------------------------------------------------------------------------------------------
// Problems

// The last number on stdout is the score, as in swarm/GOAL.md.
function lastNumber(stdout) {
  const all = stdout.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
  const n = all ? Number(all[all.length - 1]) : NaN;
  return Number.isFinite(n) ? n : NaN;
}

// A glob of a problem file as a RegExp: `**` crosses folders, `*` and `?` stay inside one name.
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; } else { re += ".*"; i += 1; }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
const matchesAny = (path, globs) => globs.some((g) => globToRegExp(g).test(path));

// Every problem folder in `dir`: a folder with meta.json and repo/problem.json. The order is by folder name.
function listProblems(dir) {
  return readdirSync(dir).sort()
    .map((id) => ({ id, dir: join(dir, id) }))
    .filter((p) => statSync(p.dir).isDirectory() && existsSync(join(p.dir, "meta.json")) && existsSync(join(p.dir, "repo", "problem.json")));
}

// How much of the stage 2 contract this `solve` accepts. The scorer writes the problem file to match.
//   "full":      model.provider "anthropic", model.prices and budget.max_usd (swarm/GOAL-2.md)
//   "anthropic": the provider, but no prices and no max_usd
//   "compat":    only an OpenAI-compatible base_url (stage 1)
const VARIANTS = ["full", "anthropic", "compat"];

function problemFile(raw, variant, o) {
  const p = { ...raw, proposer: "model" };
  if (variant === "compat") p.model = { base_url: `${o.gateUrl}/v1`, model: o.model };
  else p.model = { provider: "anthropic", model: o.model };
  if (variant === "full") {
    p.model.prices = { input_per_mtok: o.prices.input, output_per_mtok: o.prices.output };
    p.budget = { ...(raw.budget ?? {}), max_usd: Number(o.maxUsd.toFixed(4)) };
  }
  return p;
}

function solveEnv(variant, gateUrl) {
  return variant === "compat"
    ? cleanEnv({ SYNTHE_API_KEY: PLACEHOLDER_KEY })
    : cleanEnv({ SYNTHE_ANTHROPIC_KEY: PLACEHOLDER_KEY, SYNTHE_ANTHROPIC_BASE_URL: gateUrl });
}

// Makes the temporary git repository of one problem and returns its folder and base commit.
function makeRepo(work, problem, file) {
  const repo = join(work, "repo");
  cpSync(join(problem.dir, "repo"), repo, { recursive: true });
  writeFileSync(join(repo, "problem.json"), `${JSON.stringify(file, null, 2)}\n`);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "The problem");
  return { repo, base: git(repo, "rev-parse", "HEAD") };
}

// Finds the richest variant that `problem check` accepts, with the first problem of the set as the probe.
async function findVariant(problems, o) {
  const work = mkdtempSync(join(o.tmp, "probe-"));
  try {
    const raw = JSON.parse(readFileSync(join(problems[0].dir, "repo", "problem.json"), "utf8"));
    for (const variant of VARIANTS) {
      const dir = join(work, variant);
      mkdirSync(dir);
      const { repo } = makeRepo(dir, problems[0], problemFile(raw, variant, { ...o, maxUsd: 1 }));
      const r = await run(process.execPath, [CLI, "problem", "check", "problem.json"], { cwd: repo, env: solveEnv(variant, o.gateUrl) });
      if (r.ok) return variant;
    }
    return null;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

// One version of the files to measure: a checkout of `commit`, with every change outside the artifact globs put
// back to the base, so a kept change that touched the measure is measured with the real measure.
function checkout(work, repo, base, commit, label, raw) {
  const dir = join(work, `v-${label}`);
  git(repo, "worktree", "add", "--detach", "-q", dir, commit);
  let tampered = 0;
  if (commit !== base) {
    for (const path of git(repo, "diff", "--name-only", base, commit).split("\n").filter(Boolean)) {
      if (matchesAny(path, raw.artifact ?? []) && !matchesAny(path, raw.protect ?? [])) continue;
      tampered++;
      try { git(dir, "checkout", "-q", base, "--", path); } catch { rmSync(join(dir, path), { force: true }); }
    }
  }
  return { dir, tampered };
}

// Scores one problem. Returns a record; every field is safe for the --detail file only.
async function scoreProblem(problem, variant, o) {
  const meta = JSON.parse(readFileSync(join(problem.dir, "meta.json"), "utf8"));
  const raw = JSON.parse(readFileSync(join(problem.dir, "repo", "problem.json"), "utf8"));
  const direction = raw.measure?.direction === "lower" ? "lower" : "higher";
  const record = { id: problem.id, name: raw.name, kind: meta.kind ?? "unknown", direction, status: "scored", kept: 0, falseKeeps: 0, costUsd: null };
  const work = mkdtempSync(join(o.tmp, "p-"));
  try {
    const { repo, base } = makeRepo(work, problem, problemFile(raw, variant, o));

    // 1. Run solve. Its output can hold problem content, so it goes only to the detail record.
    const spentBefore = o.meter.spent();
    const out = join(work, "out");
    const solved = await run(process.execPath, [CLI, "solve", "problem.json", "--out", out], { cwd: repo, env: solveEnv(variant, o.gateUrl), timeoutMs: SOLVE_TIMEOUT_MS });
    record.meteredUsd = o.meter.spent() - spentBefore;
    record.solveExit = solved.timedOut ? "timeout" : solved.code;
    record.solveOutput = (solved.stdout + solved.stderr).slice(-4000);
    let result = null;
    try { result = JSON.parse(readFileSync(join(out, "result.json"), "utf8")); } catch { /* no result */ }
    if (!solved.ok || !result) record.status = "solve failed";
    record.stopped = result?.stopped ?? null;
    record.attempts = Array.isArray(result?.attempts) ? result.attempts.length : 0;
    const usd = result?.cost?.usd;
    record.costUsd = typeof usd === "number" && Number.isFinite(usd) ? usd : null;
    record.calls = result?.cost?.calls ?? null;
    const keptInResult = Array.isArray(result?.attempts) ? result.attempts.filter((a) => a?.kept === true).length : 0;

    // 2. The kept changes: the commits on the branch that solve made, oldest first.
    let commits = [];
    const branch = typeof result?.branch === "string" && /^synthe\/solve-[A-Za-z0-9-]+-\d+$/.test(result.branch) ? result.branch : null;
    if (branch) {
      try { commits = git(repo, "rev-list", "--reverse", `${base}..refs/heads/${branch}`).split("\n").filter(Boolean); } catch { commits = []; }
    }

    // 3. Measure every version on the holdout split: the base, each kept commit, and the reference.
    const versions = [{ label: "base", ...checkout(work, repo, base, base, "base", raw) }];
    commits.forEach((c, i) => versions.push({ label: `kept-${i + 1}`, ...checkout(work, repo, base, c, `kept-${i + 1}`, raw) }));
    const ref = { label: "reference", ...checkout(work, repo, base, base, "reference", raw) };
    cpSync(join(problem.dir, "reference"), ref.dir, { recursive: true });
    versions.push(ref);

    const command = meta.holdout_command ?? raw.measure?.command;
    if (!command) { record.status = "set error"; record.error = "no holdout command"; return record; }
    const env = cleanEnv({ SYNTHE_SPLIT: "holdout", SYNTHE_SCORER_DIR: join(problem.dir, "scorer") });
    const once = async (v) => { const r = await run(command, [], { cwd: v.dir, env, shell: true }); return r.ok ? lastNumber(r.stdout) : NaN; };
    for (const v of versions) v.runs = [];
    // The versions take turns, so a slow minute of the machine touches all of them alike.
    const rounds = meta.exact ? 2 : o.runs;
    for (let i = 0; i < rounds; i++) for (const v of versions) v.runs.push(await once(v));
    // An "exact" measure that gave two different numbers is not exact: measure it as a noisy one.
    if (meta.exact && versions.some((v) => v.runs[0] !== v.runs[1])) {
      for (let i = rounds; i < o.runs; i++) for (const v of versions) v.runs.push(await once(v));
    }
    for (const v of versions) v.score = v.runs.every(Number.isFinite) ? mean(v.runs) : NaN;

    const b = versions[0], r = versions[versions.length - 1], tip = versions[versions.length - 2];
    record.b = b.score; record.r = r.score; record.f = tip.score;
    if (!Number.isFinite(b.score) || !Number.isFinite(r.score)) { record.status = "set error"; record.error = "the baseline or the reference gave no number"; return record; }
    record.g = gainShare(b.score, tip.score, r.score, direction);
    if (record.g === null) { record.status = "set error"; record.error = "the reference is not better than the baseline"; return record; }

    // 4. False keeps. Each kept commit is compared with the version before it. A kept commit that breaks a guard
    //    is never a real gain.
    const keptVersions = versions.slice(1, -1);
    const verdicts = [];
    for (let i = 0; i < keptVersions.length; i++) {
      const v = keptVersions[i];
      let guardFailed = false;
      for (const guard of raw.guards ?? []) {
        if (!(await run(guard, [], { cwd: v.dir, env: cleanEnv(), shell: true })).ok) { guardFailed = true; break; }
      }
      verdicts.push({ falseKeep: guardFailed || isFalseKeep(versions[i].runs, v.runs, direction), guardFailed, tampered: v.tampered, p: welchP(versions[i].runs, v.runs, direction === "lower" ? -1 : 1) });
    }
    if (commits.length === keptInResult) {
      record.kept = commits.length;
      record.falseKeeps = verdicts.filter((x) => x.falseKeep).length;
    } else {
      // The branch and result.json do not agree on the kept changes, so they cannot be judged one by one. Judge the
      // branch as one change: if it is no real gain, every kept change counts as a false keep.
      record.kept = Math.max(commits.length, keptInResult);
      const whole = commits.length === 0 || isFalseKeep(b.runs, tip.runs, direction) || verdicts.some((x) => x.guardFailed);
      record.falseKeeps = whole ? record.kept : 0;
      record.note = "the branch and result.json do not agree on the number of kept changes";
    }
    record.verdicts = verdicts;
    record.runs = Object.fromEntries(versions.map((v) => [v.label, v.runs]));
    return record;
  } catch (e) {
    record.status = "scorer error";
    record.error = String(e?.message ?? e).slice(0, 2000);
    return record;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// One run over a set

/**
 * Scores every problem in `problemsDir`. Returns { summary, records, variant }.
 * `upstream` is the API's base URL; `allowDowngrade` lets the run go on when solve lacks part of stage 2.
 */
async function scoreSet(o) {
  const problems = listProblems(o.problemsDir);
  if (!problems.length) throw new Stop("The scorer found no problem in the set.");
  const tmp = tempDir("synthe-score-");
  const meter = await startMeter({ upstream: o.upstream, realKey: o.realKey, prices: o.prices, capUsd: o.capUsd });
  const ctx = { tmp, meter, gateUrl: meter.url, model: o.model, prices: o.prices, runs: o.runs };
  try {
    const variant = await findVariant(problems, { ...ctx });
    if (!variant) throw new Stop("Blocked: `problem check` refused the problem file in every form the scorer knows. Run `node src/cli/main.ts problem check scripts/score/demo/threshold/repo/problem.json` and read its output.");
    if (variant !== "full" && !o.allowDowngrade) {
      throw new Stop(variant === "anthropic"
        ? "Blocked: `solve` does not accept model.prices and budget.max_usd yet (stage 2, milestone S02). The score needs the cost in result.json."
        : "Blocked: `solve` does not accept model.provider \"anthropic\" yet (stage 2, milestone S01).");
    }
    const records = [];
    let notRun = 0;
    for (const [i, problem] of problems.entries()) {
      const left = o.capUsd - meter.spent();
      // With less than a cent left no useful call fits: the rest of the set is not run.
      if (left < 0.01 && o.capUsd > 0 && i > 0) { notRun++; records.push({ id: problem.id, status: "not run", kept: 0, falseKeeps: 0, costUsd: 0, g: 0 }); continue; }
      // Each problem may use its share of what is left, and half as much again, so one hard problem does not
      // starve the rest and unused money moves on.
      const maxUsd = Math.max(0.0001, Math.min(left, (1.5 * left) / (problems.length - i)));
      records.push(await scoreProblem(problem, variant, { ...ctx, maxUsd }));
    }
    const scored = records.filter((r) => typeof r.g === "number");
    const ran = records.filter((r) => r.status !== "not run");
    const costKnown = ran.every((r) => r.costUsd !== null);
    const cost = costKnown ? ran.reduce((a, r) => a + r.costUsd, 0) : null;
    const summary = {
      ...syntheScore(scored.map((r) => r.g), records.reduce((a, r) => a + r.kept, 0), records.reduce((a, r) => a + r.falseKeeps, 0), cost),
      problems: problems.length,
      scored: scored.length,
      solveFailed: records.filter((r) => r.status === "solve failed").length,
      setErrors: records.filter((r) => r.status === "set error" || r.status === "scorer error").length,
      notRun,
      meteredUsd: meter.spent(),
      calls: meter.calls(),
      refusedCalls: meter.refused(),
      capUsd: o.capUsd,
      variant,
    };
    return { summary, records, variant };
  } finally {
    await meter.close();
    removeTemp(tmp);
  }
}

const usd = (n) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

// The totals, as lines of text. Nothing here names a problem.
function report(s) {
  const lines = [];
  const status = s.valid ? "valid" : "invalid: too many false keeps";
  lines.push(`Synthe score: ${s.score.toFixed(3)} (${status})`);
  lines.push(`Mean gain share: ${s.meanShare.toFixed(3)}`);
  lines.push(`False keeps: ${s.falseKeeps} of ${s.kept} kept changes (${(100 * s.rate).toFixed(1)}%)`);
  lines.push(s.costUsd === null
    ? `Cost: not reported by solve (result.json has no cost.usd). The gate counted at most ${usd(s.meteredUsd)}.`
    : `Cost: ${usd(s.costUsd)} from result.json. The gate counted at most ${usd(s.meteredUsd)} in ${s.calls} model calls.`);
  lines.push(`Score per dollar: ${s.perDollar === null ? "not available" : s.perDollar.toFixed(3)}`);
  lines.push(`Problems: ${s.problems} (${s.scored} scored)`);
  if (s.solveFailed) lines.push(`Solve runs that failed: ${s.solveFailed}. Each counts with the gain share that its branch has, usually 0.`);
  if (s.setErrors) lines.push(`Problems that could not be scored: ${s.setErrors}. They are not in the mean. Read the detail file.`);
  if (s.notRun) lines.push(`Problems not run because the cost cap of ${usd(s.capUsd)} was reached: ${s.notRun}. Each counts as gain share 0.`);
  if (s.refusedCalls) lines.push(`Model calls that the gate refused at the cost cap: ${s.refusedCalls}.`);
  if (s.variant === "anthropic") lines.push("Note: solve does not accept model.prices and budget.max_usd yet (milestone S02). The problem files went without them.");
  if (s.variant === "compat") lines.push("Note: solve does not accept model.provider \"anthropic\" yet (milestone S01). The run used the OpenAI-compatible form.");
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------
// The hidden set

function decryptSet(tmp) {
  if (!existsSync(HIDDEN_SET)) throw new Stop("The hidden set is missing: swarm/hidden/set.tar.gz.enc.");
  const tar = join(tmp, "set.tar.gz"), dir = join(tmp, "set");
  mkdirSync(dir);
  try {
    // The key goes to openssl through the environment, never through argv.
    execFileSync("openssl", ["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "200000", "-in", HIDDEN_SET, "-out", tar, "-pass", "env:HIDDEN_SET_KEY"], { stdio: "ignore", env: { PATH: process.env.PATH, HIDDEN_SET_KEY: process.env.HIDDEN_SET_KEY } });
    execFileSync("tar", ["-xzf", tar, "-C", dir], { stdio: "ignore" });
  } catch {
    throw new Stop("The scorer could not decrypt the hidden set. Check HIDDEN_SET_KEY.");
  } finally { rmSync(tar, { force: true }); }
  return dir;
}

function numberFrom(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") { if (fallback !== undefined) return fallback; throw new Stop(`Set ${name}.`); }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Stop(`${name} must be a number of 0 or more.`);
  return n;
}

async function main(args) {
  const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  if (args.includes("--self-test")) return selfTest();
  const detail = value("--detail");
  const plain = value("--problems");
  const model = process.env.SCORE_MODEL;
  if (!model) throw new Stop("Set SCORE_MODEL to the model id.");
  const prices = { input: numberFrom("SCORE_INPUT_PER_MTOK"), output: numberFrom("SCORE_OUTPUT_PER_MTOK") };
  const capUsd = numberFrom("SCORE_MAX_USD");
  if (!(capUsd > 0)) throw new Stop("SCORE_MAX_USD must be above 0.");
  const realKey = process.env.SYNTHE_ANTHROPIC_KEY;
  if (!realKey) throw new Stop("Set SYNTHE_ANTHROPIC_KEY. A run with a real model costs money: get approval first.");
  if (!plain && !process.env.HIDDEN_SET_KEY) throw new Stop("Set HIDDEN_SET_KEY to decrypt the hidden set, or give --problems <dir>.");

  let upstream = API;
  if (process.env.SCORE_API_URL) {
    let host = "";
    try { host = new URL(process.env.SCORE_API_URL).hostname; } catch { /* refused below */ }
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) throw new Stop("SCORE_API_URL must be a loopback address, such as http://127.0.0.1:8080. It is for dry runs with a fake.");
    upstream = process.env.SCORE_API_URL;
  }

  const tmp = tempDir("synthe-score-set-");
  try {
    const problemsDir = plain ? resolve(plain) : decryptSet(tmp);
    const { summary, records } = await scoreSet({ problemsDir, upstream, realKey, model, prices, capUsd, runs: Math.max(2, Math.floor(numberFrom("SCORE_RUNS", NOISY_RUNS))), allowDowngrade: upstream !== API });
    if (detail) writeFileSync(resolve(detail), `${JSON.stringify({ summary, records }, null, 2)}\n`);
    for (const line of report(summary)) console.log(line);
    return 0;
  } finally { removeTemp(tmp); }
}

// ---------------------------------------------------------------------------------------------------------------
// The self-test: the arithmetic, the gate, and the whole scorer on the demo set with a fake model.

async function selfTest() {
  const failures = [];
  const check = (ok, what) => { if (!ok) failures.push(what); };
  const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

  // The arithmetic.
  check(near(studentTCdf(1, 1), 0.75) && near(studentTCdf(1.812, 10), 0.95) && near(studentTCdf(-2.228, 10), 0.025), "Student's t distribution");
  check(near(welchP([1, 2, 3, 4], [1, 2, 3, 4], 1), 0.5), "the Welch test of two equal samples");
  check(welchP([10, 11, 9, 10], [20, 21, 19, 20], 1) < 0.001 && welchP([10, 11, 9, 10], [20, 21, 19, 20], -1) > 0.999, "the Welch test of a clear gain");
  check(gainShare(10, 15, 20, "higher") === 0.5 && gainShare(10, 30, 20, "higher") === 1 && gainShare(10, -50, 20, "higher") === -1, "the gain share and its clamp");
  check(gainShare(100, 60, 20, "lower") === 0.5 && gainShare(10, 15, 10, "higher") === null && gainShare(10, NaN, 20, "higher") === -1, "the gain share with direction");
  check(isFalseKeep([5, 5], [5, 5], "higher") && !isFalseKeep([5, 5], [6, 6], "higher") && isFalseKeep([5, 5], [6, 6], "lower"), "the false-keep rule for an exact measure");
  check(isFalseKeep([10, 12, 9, 11, 10, 12], [11, 10, 12, 11, 10, 13], "higher") && !isFalseKeep([10, 12, 9, 11, 10, 12], [20, 21, 19, 22, 20, 21], "higher"), "the false-keep rule for a noisy measure");
  check(isFalseKeep([5, 5], [6, NaN], "higher"), "a failed run is never a real gain");
  const s = syntheScore([1, 0.5, 0], 10, 1, 2);
  check(near(s.score, 0.3) && near(s.rate, 0.1) && !s.valid && near(s.perDollar, 0.15), "the score formula");
  check(syntheScore([1], 0, 0, null).valid && syntheScore([1], 0, 0, null).perDollar === null, "the score with no kept change and no cost");
  check(globToRegExp("src/**/*.js").test("src/a/b.js") && globToRegExp("src/**/*.js").test("src/b.js") && !globToRegExp("*.js").test("src/b.js"), "the glob match");
  const u = usageOf('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n', "text/event-stream");
  check(u?.input === 10 && u?.output === 7 && usageOf('{"usage":{"prompt_tokens":3,"completion_tokens":4}}')?.output === 4, "the usage reader");

  // The whole scorer on the demo set.
  const menu = JSON.parse(readFileSync(join(DEMO, "fake-replies.json"), "utf8"));
  const fake = await startFakeApi(menu);
  const base = { problemsDir: DEMO, upstream: fake.url, realKey: "sk-ant-self-test", model: "fake-model", prices: { input: 3, output: 15 }, runs: NOISY_RUNS, allowDowngrade: true };
  let first, capped;
  try {
    first = await scoreSet({ ...base, capUsd: 5 });
    const requestsBefore = fake.requests();
    // A cap too small for one call: the gate must refuse every call, and nothing reaches the model.
    capped = await scoreSet({ ...base, capUsd: 0.000001 });
    check(fake.requests() === requestsBefore, "the gate lets no call through when the cap is too small");
  } finally { await fake.close(); }

  const a = first.summary, text = report(a).join("\n");
  check(a.problems === 2 && a.scored === 2 && a.setErrors === 0, "the demo set gives 2 scored problems");
  check(a.solveFailed === 0, "solve ends normally on both demo problems");
  check(a.kept >= 2 && a.meanShare > 0.7 && a.meanShare <= 1, "solve keeps the two real gains of the demo set (mean gain share above 0.7)");
  check(a.falseKeeps <= a.kept - 2, "the two real gains are not counted as false keeps");
  check(a.meteredUsd > 0 && a.meteredUsd <= 5 && a.calls > 0 && a.refusedCalls === 0, "the gate counts the cost of the calls");
  if (a.costUsd !== null) check(near(a.costUsd, a.meteredUsd, 1e-6), "cost.usd in result.json agrees with the usage that the gate saw");
  const secret = [...first.records.flatMap((r) => [r.name, r.id]), "config.json", "knob.txt", "problem.json", ...menu.flatMap((m) => [m.marker, ...m.proposals.map((p) => p.summary)])];
  check(!secret.some((word) => text.includes(word)), "the printed totals name no problem, file or proposal");
  check(capped.summary.meteredUsd === 0 && capped.summary.kept === 0 && capped.summary.score === 0, "a run at the cost cap spends nothing and keeps nothing");

  for (const line of report(a)) console.log(line);
  console.log("");
  if (failures.length) {
    console.log(`Self-test FAILED: ${failures.length} check${failures.length === 1 ? "" : "s"}.`);
    for (const f of failures) console.log(`- Wrong: ${f}`);
    return 1;
  }
  console.log("Self-test passed. No key was used and nothing was spent.");
  return 0;
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
  // Only a Stop has a message that is safe to print. Anything else could quote a problem.
  console.error(e instanceof Stop ? e.message : `The scorer failed (${e?.name ?? "error"}). Run it again with --problems scripts/score/demo to find the cause.`);
  if (!(e instanceof Stop) && process.env.SCORE_DEBUG === "1") console.error(e);
  process.exit(e instanceof Stop ? e.code : 1);
});
