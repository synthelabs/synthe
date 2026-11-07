import assert from "node:assert/strict";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, test } from "node:test";

// The whole improve flow through the bundled CLI, on a small signup app shaped like synthelabs/builder-signup-demo:
// real git, a real local "origin", real node metric and tests, and only `gh` stubbed.
const work = mkdtempSync(join(tmpdir(), "synthe-improve-e2e-"));
const cli = join(work, "bundle/cli.js");

before(() => {
  // The same esbuild command `npm run build` uses for dist/cli.js, written elsewhere: e2e.test.ts rebuilds dist/
  // in a parallel process, and reading a bundle mid-write would make both tests flaky.
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const buildCli = pkg.scripts.build.split(" && ")[0];
  assert.ok(buildCli.includes("--outfile=dist/cli.js"));
  execSync(`npx ${buildCli.replace("--outfile=dist/cli.js", `--outfile=${cli}`)}`, { stdio: "ignore" });
});

const EMAILS = ["ann@example.com", "bob@test.com", "cy@site.com", "Dana@example.com", "eve.smith@example.com", "fay@mail.example.org",
  "gus+tag@example.com", "hal@example.io", "ivy_2@example.com", "jo@example.co.uk", "kim@EXAMPLE.COM", "lee-ann@example.net"];

function signupApp() {
  const dir = join(work, "app");
  const marker = join(work, "metric-ran");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const write = (path: string, text: string) => { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), text); };
  mkdirSync(dir);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  write("package.json", JSON.stringify({ name: "signup", version: "1.0.0", scripts: { test: "node --test test/validate.test.js", metric: "node metrics/score.js" } }));
  write("validate.js", "module.exports = (email) => /^[a-z]+@[a-z]+\\.com$/.test(email);\n");
  write("metrics/valid-signups.json", JSON.stringify(EMAILS));
  write("metrics/score.js", `const fs = require("fs");\nfs.writeFileSync(${JSON.stringify(marker)}, "ran");\nconst valid = require("../validate.js");\nconsole.log(require("./valid-signups.json").filter(valid).length);\n`);
  write("test/validate.test.js", `const test = require("node:test");\nconst assert = require("node:assert");\nconst valid = require("../validate.js");\ntest("rejects what is not an email", () => { assert.equal(valid("not-an-email"), false); assert.equal(valid("a@b"), false); });\ntest("accepts a plain address", () => { assert.equal(valid("ann@example.com"), true); });\n`);
  git("add", ".");
  git("commit", "-qm", "Signup app");
  write("README.md", "# Signup\n");
  git("add", ".");
  git("commit", "-qm", "README");
  execFileSync("git", ["init", "-q", "--bare", join(work, "origin.git")]);
  git("remote", "add", "origin", join(work, "origin.git"));
  git("push", "-q", "-u", "origin", "main");
  return { dir, git, write, marker };
}

function stubGh() {
  const bin = join(work, "bin");
  const log = join(work, "gh.log");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$*" in
  "--version") echo "gh version 2.60.0" ;;
  "auth status") exit 0 ;;
  "repo view"*) echo '{"nameWithOwner":"o/r","defaultBranchRef":{"name":"main"}}' ;;
  "pr create"*) { echo "ARGS: $*"; cat; echo; } >> ${JSON.stringify(log)}; echo "https://github.com/o/r/pull/1" ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`);
  chmodSync(join(bin, "gh"), 0o755);
  return { bin, log };
}

test("improve then submit on a signup app: 3 → 12 opens a pull request; a shortcut that breaks the test does not", () => {
  const app = signupApp();
  const gh = stubGh();
  const synthe = (...args: string[]) => {
    const r = spawnSync("node", [cli, ...args], { cwd: app.dir, encoding: "utf8", env: { ...process.env, PATH: `${gh.bin}:${process.env.PATH}` }, timeout: 120_000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const prCreates = () => (existsSync(gh.log) ? readFileSync(gh.log, "utf8").split("\n").filter((l) => l.startsWith("ARGS: pr create")).length : 0);

  // 1. Baseline.
  const improved = synthe("improve", "--handoff", "--agent", "--goal", "Let normal emails sign up", "--metric", "custom", "--command", "node metrics/score.js",
    "--label", "valid signups", "--unit", "of 12", "--direction", "higher", "--mode", "review", "--guard", "npm test");
  assert.equal(improved.code, 0, improved.out);
  assert.ok(improved.out.includes("Current code: 3 of 12 (3 runs: 3, 3, 3)."), improved.out);
  assert.ok(improved.out.includes("git checkout -b synthe/improve-1"));
  assert.ok(existsSync(join(app.dir, ".git/synthe-improve.json")));
  assert.equal(app.git("status", "--porcelain"), "");
  assert.equal(app.git("worktree", "list").split("\n").length, 1);

  // 2. The real fix wins and opens a pull request with the numbers.
  app.git("checkout", "-q", "-b", "synthe/improve-1");
  app.write("validate.js", "module.exports = (email) => /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);\n");
  app.git("commit", "-qam", "Accept ordinary email addresses");
  const won = synthe("submit", "--agent");
  assert.equal(won.code, 0, won.out);
  assert.ok(won.out.includes("valid signups: 3 of 12 → 12 of 12 (higher is better)."), won.out);
  assert.ok(won.out.includes("Pull request: https://github.com/o/r/pull/1"));
  const log = readFileSync(gh.log, "utf8");
  assert.ok(log.includes("--title Synthe: valid signups 3 of 12 → 12 of 12"));
  assert.ok(log.includes("**valid signups: 3 of 12 → 12 of 12**") && log.includes("## How it was measured") && log.includes("validate.js"));
  assert.equal(app.git("ls-remote", "origin", "synthe/improve-1").split("\t")[0], app.git("rev-parse", "HEAD"));

  // 3. A shortcut that makes the number go up but breaks the test is not published.
  app.git("checkout", "-q", "main");
  app.git("checkout", "-q", "-b", "synthe/improve-2");
  app.write("validate.js", "module.exports = () => true;\n");
  app.git("commit", "-qam", "Accept everything");
  const shortcut = synthe("submit", "--agent");
  assert.equal(shortcut.code, 1, shortcut.out);
  assert.ok(shortcut.out.includes("Not merged: The regression check did not pass."), shortcut.out);
  assert.equal(prCreates(), 1);

  // 4. Editing the metric's own data is refused before anything runs.
  app.git("checkout", "-q", "main");
  app.git("checkout", "-q", "-b", "synthe/improve-3");
  app.write("metrics/valid-signups.json", JSON.stringify(EMAILS.slice(0, 3)));
  app.git("commit", "-qam", "Fewer signups to check");
  rmSync(app.marker, { force: true });
  const gamed = synthe("submit", "--agent");
  assert.equal(gamed.code, 1, gamed.out);
  assert.ok(gamed.out.includes("metrics/valid-signups.json is in a test, benchmark, metric or fixture folder"), gamed.out);
  assert.ok(gamed.out.includes("Nothing was measured."));
  assert.ok(!existsSync(app.marker), "the metric must not run for a refused change");
  assert.equal(prCreates(), 1);
  assert.equal(app.git("worktree", "list").split("\n").length, 1);
});

test("the bundle's help lists improve and submit", () => {
  const help = execFileSync("node", [cli, "--help"], { encoding: "utf8" });
  assert.match(help, /npx synthe improve/);
  assert.match(help, /npx synthe submit/);
});
