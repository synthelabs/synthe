// Stage 4j (swarm/GOAL-3.md): the improve preset follows stage 4g. Improve mode refuses a change that adds a module
// with the name of a standard or installed module in a folder on pytest's path.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { improve, improveOptions, type ImproveIo } from "../src/cli/improve.ts";
import { improveFile, parseImproveConfig } from "../src/improve/config.ts";
import type { Exec } from "../src/improve/exec.ts";
import { protectedPathProblem } from "../src/improve/protect.ts";

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
// pytest is an installed module only where it is installed; the CI Python may not have it.
const hasPytest = (() => { try { execFileSync("python3", ["-I", "-c", "import pytest"], { stdio: "ignore" }); return true; } catch { return false; } })();
const hasPython = (() => { try { execFileSync("python3", ["-c", "import sys; sys.stdlib_module_names"], { stdio: "ignore" }); return true; } catch { return false; } })();

function pyRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "synthe-improve-shadow-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

// The improve setup with a fake measurement: no test runs, no network.
async function setUp(dir: string) {
  const exec: Exec = async (_cwd, command) => ({ ok: true, stdout: command.includes("pytest") ? "1 failed, 1 passed in 0.01s\n" : "", stderr: "", ms: 1, timedOut: false });
  const io: ImproveIo = {
    say: () => {},
    ask: async () => "",
    exec,
    async run(cmd, args) {
      const line = args.join(" ");
      if (cmd === "git") return git(dir, ...args);
      if (line === "--version") return "gh version 2.60.0\n";
      if (line.startsWith("repo view")) return JSON.stringify({ nameWithOwner: "o/r", defaultBranchRef: { name: "main" } });
      return "";
    },
  };
  assert.equal(await improve(io, dir, improveOptions(["--handoff", "--agent", "--goal", "g", "--metric", "pytest", "--mode", "review"])), true);
  return parseImproveConfig(readFileSync(improveFile(join(dir, ".git")), "utf8"));
}

test("improve refuses a new src/pdb.py, src/pdb/ package or root pdb.py in a src layout", { skip: hasPython ? false : "no python3 with sys.stdlib_module_names" }, async () => {
  const dir = pyRepo({
    "pyproject.toml": "[project]\nname = \"app\"\n",
    "src/app/__init__.py": "def add(a, b):\n    return a - b\n",
    "src/code.py": "# the project's own module named like a standard one\n",
    "tests/test_app.py": "from app import add\n\ndef test_add():\n    assert add(1, 2) == 3\n",
  });
  const config = await setUp(dir);
  for (const path of ["src/pdb.py", "src/pdb/__init__.py", "pdb.py", "src/cmd.py", "src/json/__init__.py", "src/pdb.cpython-312-x86_64-linux-gnu.so", ...(hasPytest ? ["src/pytest.py", "src/_pytest/runner.py"] : [])]) {
    assert.match(protectedPathProblem(path, config) ?? "", /module named/, `${path} is refused`);
  }
  for (const path of ["src/app/__init__.py", "src/app/util.py", "src/brand_new_module.py", "src/code.py", "README.md"]) {
    assert.equal(protectedPathProblem(path, config), null, `${path} stays changeable`);
  }
});

test("the folders that the root pytest configuration adds with pythonpath are covered too", { skip: hasPython ? false : "no python3 with sys.stdlib_module_names" }, async () => {
  const dir = pyRepo({
    "pytest.ini": "[pytest]\npythonpath = lib\n",
    "lib/calc.py": "def add(a, b):\n    return a - b\n",
    "tests/test_calc.py": "from calc import add\n\ndef test_add():\n    assert add(1, 2) == 3\n",
  });
  const config = await setUp(dir);
  assert.match(protectedPathProblem("lib/pdb.py", config) ?? "", /module named pdb/);
  assert.equal(protectedPathProblem("lib/calc.py", config), null);
  assert.equal(protectedPathProblem("lib/helpers.py", config), null);
});

test("a config with a bad shadow list is refused, and one with none still loads", () => {
  const base = { version: 1, goal: "g", metric: { preset: "pytest", label: "l", unit: "tests", command: "python3 -m pytest -q", direction: "higher", runs: 3 }, guard: { command: null }, protect: [], mode: "review", baseline: { commit: "abc", median: 1, runs: [1], at: "t" } };
  assert.doesNotThrow(() => parseImproveConfig(JSON.stringify(base)));
  assert.throws(() => parseImproveConfig(JSON.stringify({ ...base, shadow: [{ folder: "../x", names: ["pdb"] }] })), /shadow/);
  assert.throws(() => parseImproveConfig(JSON.stringify({ ...base, shadow: [{ folder: "src", names: "pdb" }] })), /shadow/);
});
