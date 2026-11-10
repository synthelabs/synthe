import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { shellExec } from "../src/improve/exec.ts";
import { presetsForRepo } from "../src/improve/presets.ts";
import { measureAt, withWorktree } from "../src/improve/worktree.ts";
import { config, custom } from "./improve-helpers.ts";

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

function repo(score = "console.log(3)", testJs = "process.exit(0)") {
  const dir = mkdtempSync(join(tmpdir(), "synthe-wt-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { metric: "node score.js", test: "node test.js" } }));
  writeFileSync(join(dir, "score.js"), score);
  writeFileSync(join(dir, "test.js"), testJs);
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return { dir, head: git(dir, "rev-parse", "HEAD") };
}

const worktrees = (dir: string) => git(dir, "worktree", "list").split("\n").length;

test("measureAt measures the committed code in a throwaway worktree and leaves the repo untouched", async () => {
  const { dir, head } = repo();
  writeFileSync(join(dir, "score.js"), "console.log(99)");   // an uncommitted edit must NOT be measured
  const said: string[] = [];
  const out = await measureAt(shellExec, dir, head, config({ metric: { ...custom("node score.js").metric, runs: 3 }, guard: { command: "node test.js" } }), (l) => said.push(l));
  assert.deepEqual(out.measurement?.runs, [3, 3, 3]);
  assert.equal(out.measurement?.median, 3);
  assert.equal(out.measurement?.commit, head);
  assert.equal(out.guardPassed, true);
  assert.equal(worktrees(dir), 1);
  assert.deepEqual(said, [
    `Measuring valid signups at ${head.slice(0, 7)}, run 1 of 3...`,
    `Measuring valid signups at ${head.slice(0, 7)}, run 2 of 3...`,
    `Measuring valid signups at ${head.slice(0, 7)}, run 3 of 3...`,
    "Running the regression check (node test.js)...",
  ]);
  assert.equal(git(dir, "status", "--porcelain"), "M score.js");
});

test("measureAt reports a failing guard and a metric that prints nothing", async () => {
  const failing = repo("console.log(3)", "process.exit(1)");
  const guarded = await measureAt(shellExec, failing.dir, failing.head, config({ metric: custom("node score.js").metric, guard: { command: "node test.js" } }));
  assert.equal(guarded.guardPassed, false);
  assert.equal(guarded.measurement?.median, 3);
  const silent = repo("console.log('n/a')");
  const said: string[] = [];
  const none = await measureAt(shellExec, silent.dir, silent.head, config({ metric: custom("node score.js").metric, guard: { command: "node test.js" } }), (l) => said.push(l));
  assert.equal(none.measurement, null);
  assert.equal(none.reason, "The metric command printed no number.");
  assert.equal(said.length, 1);   // stops at the first run that gives no number, and skips the guard
  assert.equal(worktrees(silent.dir), 1);
});

test("withWorktree links node_modules from the main checkout and removes the worktree even when the work throws", async () => {
  const { dir, head } = repo();
  mkdirSync(join(dir, "node_modules/x"), { recursive: true });
  let seen = "";
  await withWorktree(shellExec, dir, head, async (wt) => { seen = wt; assert.ok(existsSync(join(wt, "node_modules/x"))); });
  assert.ok(!existsSync(seen));
  assert.ok(existsSync(join(dir, "node_modules/x")));   // the real folder survives the cleanup
  await assert.rejects(withWorktree(shellExec, dir, head, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(worktrees(dir), 1);
  await assert.rejects(withWorktree(shellExec, dir, "0000000000000000000000000000000000000000", async () => 1), /^Error: Could not check out 0000000/);
});

test("withWorktree links .venv and venv for the run and never deletes the real ones", async () => {
  const { dir, head } = repo();
  for (const v of [".venv", "venv"]) { mkdirSync(join(dir, v, "bin"), { recursive: true }); writeFileSync(join(dir, v, "bin", "python"), "real"); }
  let inside = "";
  for (const fail of [false, true]) {
    try {
      await withWorktree(shellExec, dir, head, async (wt) => {
        for (const v of [".venv", "venv"]) {
          assert.equal(lstatSync(join(wt, v)).isSymbolicLink(), true);
          assert.equal(readFileSync(join(wt, v, "bin", "python"), "utf8"), "real");
        }
        inside = wt;
        if (fail) throw new Error("boom");
      });
    } catch (e) { assert.equal(fail, true); assert.equal((e as Error).message, "boom"); }
    assert.equal(existsSync(inside), false);
    for (const v of [".venv", "venv"]) {
      assert.equal(lstatSync(join(dir, v)).isSymbolicLink(), false);
      assert.equal(readFileSync(join(dir, v, "bin", "python"), "utf8"), "real");
    }
  }
  assert.equal(worktrees(dir), 1);
});

// A python that has pytest: the system one, or a venv made once and kept (a download from PyPI on first use).
function pytestPython(): string | null {
  const works = (py: string) => spawnSync(py, ["-m", "pytest", "--version"], { stdio: "ignore" }).status === 0;
  if (works("python3")) return "python3";
  const venv = join(tmpdir(), "synthe-test-pytest-venv");
  const py = join(venv, "bin", "python");
  if (works(py)) return py;
  // Some system Pythons can't make a venv (broken ensurepip), so try a few.
  for (const base of ["python3", "python3.13", "python3.12", "python3.11", "python3.10"]) {
    rmSync(venv, { recursive: true, force: true });
    const made = spawnSync(base, ["-m", "venv", venv], { stdio: "ignore" }).status === 0
      && spawnSync(py, ["-m", "pip", "install", "-q", "pytest"], { stdio: "ignore" }).status === 0;
    if (made && works(py)) return py;
  }
  return null;
}
const pytest = process.platform === "win32" ? null : pytestPython();

test("a src-layout Python repo with an editable-style install measures the candidate's code, not the original's", { skip: pytest ? false : "no Python with pytest available" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "synthe-src-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  const write = (path: string, text: string) => { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), text); };
  write("pyproject.toml", "[project]\nname = 'pkg'\nversion = '0'\n");
  write("src/pkg/__init__.py", "def add(a, b):\n    return a - b\n");
  write("tests/test_add.py", "from pkg import add\n\ndef test_one():\n    assert add(2, 1) == 3\n\ndef test_two():\n    assert add(0, 0) == 0\n\ndef test_three():\n    assert add(5, 5) == 10\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "broken add");
  const before = git(dir, "rev-parse", "HEAD");
  write("src/pkg/__init__.py", "def add(a, b):\n    return a + b\n");
  git(dir, "commit", "-qam", "fix add");
  const after = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", before);   // the checkout the install points at has the OLD code; the candidate has the fix
  // An editable install: the venv's site-packages points at the ORIGINAL repo's src/ (plus pytest from the shared one).
  // Ask Python where pytest and its packages live: Homebrew keeps them in /opt/homebrew/lib/..., outside sys.prefix.
  const shared: string[] = JSON.parse(spawnSync(pytest!, ["-c", "import json, os, site, pytest; print(json.dumps(site.getsitepackages() + [os.path.dirname(os.path.dirname(pytest.__file__))]))"], { encoding: "utf8" }).stdout);
  spawnSync(pytest!, ["-m", "venv", join(dir, ".venv")], { stdio: "ignore" });
  const site = (v: string) => readdirSync(join(v, "lib")).filter((n) => n.startsWith("python")).map((n) => join(v, "lib", n, "site-packages"))[0];
  writeFileSync(join(site(join(dir, ".venv")), "editable.pth"), [join(dir, "src"), ...new Set(shared)].join("\n") + "\n");

  const preset = presetsForRepo(dir).find((p) => p.label.includes("pytest"))!;
  assert.equal(preset.command, "PYTHONPATH=src .venv/bin/python -m pytest -q");
  const cfg = config({ metric: { preset: "test-pass", label: preset.label, unit: "tests", command: preset.command, direction: "higher", runs: 1 }, guard: { command: null } });
  const measure = async (commit: string) => (await measureAt(shellExec, dir, commit, cfg)).measurement?.median;
  assert.equal(await measure(before), 1);   // add(0, 0) is the only test the broken code passes
  assert.equal(await measure(after), 3);    // the candidate's fix is seen even though the install points at the original
  // Without src/ on the path the install wins and the fix would be invisible: that is the trap PYTHONPATH avoids.
  const naive = config({ metric: { ...cfg.metric, command: ".venv/bin/python -m pytest -q" } });
  assert.equal((await measureAt(shellExec, dir, after, naive)).measurement?.median, 1);
  assert.equal(worktrees(dir), 1);
});
