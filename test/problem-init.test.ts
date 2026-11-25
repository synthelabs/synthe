import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { draftProblem, EMPTY_PYTEST_INI, IDS_FILE, inspectRepo, packageInits, PYTEST_CONFIG_GLOBS, PYTHON_STARTUP_GLOBS, problemInit, PROBLEM_FILE, TEST_FILE_GLOBS } from "../src/solve/init.ts";

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "synthe-init-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function initIn(dir: string, args: string[] = []) {
  const lines: string[] = [];
  const code = problemInit(args, dir, (l) => lines.push(l));
  return { code, out: lines.join("\n") };
}

// The count part of a measure command, fed with canned test output instead of a real test run. `ids` is the
// recorded IDs file, for the measures of node:test and pytest.
function count(awk: string, output: string, ids?: string[], sorted = false): string {
  const dir = mkdtempSync(join(tmpdir(), "synthe-count-"));
  if (ids) writeFileSync(join(dir, IDS_FILE), ids.join("\n") + "\n");
  try {
    const out = execFileSync("sh", ["-c", `cat | ${awk}`], { cwd: dir, input: output, encoding: "utf8" }).trim();
    return sorted ? out.split("\n").sort().join("\n") : out;
  } catch { return "exit 1"; }
}
const afterPipe = (command: string) => command.slice(command.indexOf("| ") + 2);
const passingTest = 'require("node:test").test("t", () => {});\n';

const npmPkg = (test: string) => JSON.stringify({ name: "@acme/my_app", scripts: { test } });

test("inspectRepo finds a node --test script, the src folder and the test folder", () => {
  const f = inspectRepo(repo({ "package.json": npmPkg("node --test"), "src/a.js": "", "test/a.test.js": "" }));
  assert.equal(f.runner, "npm");
  assert.equal(f.source, "src");
  assert.equal(f.tests, "test");
  assert.equal(f.name, "my-app");
  assert.deepEqual(f.testFiles, ["test/a.test.js"]);
  assert.equal(f.record?.run, "env -u NODE_TEST_CONTEXT node --test --test-reporter=tap test/a.test.js");
  assert.deepEqual(f.config, ["package.json"]);
});

test("the default npm test script is not a test command that Synthe can count", () => {
  const f = inspectRepo(repo({ "package.json": npmPkg('echo "Error: no test specified" && exit 1'), "src/a.js": "" }));
  assert.equal(f.runner, null);
  assert.equal(f.command, null);
});

test("inspectRepo finds pytest and a flat Python package", () => {
  const f = inspectRepo(repo({ "pyproject.toml": "[project]\nname='x'\n", "mypkg/__init__.py": "", "tests/test_a.py": "" }));
  assert.equal(f.runner, "pytest");
  assert.equal(f.source, "mypkg");
  assert.equal(f.tests, "tests");
  assert.deepEqual(f.testFiles, ["tests/test_a.py"]);
  // No pytest section in pyproject.toml: the measure names an empty configuration file that init writes.
  assert.deepEqual(f.pytestConfig, { file: EMPTY_PYTEST_INI, create: "[pytest]\n" });
  assert.equal(f.record?.run, "env -u PYTEST_ADDOPTS -u PYTEST_PLUGINS -u PYTHONPATH PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1 python3 -m pytest -c synthe.pytest.ini --rootdir=. -p no:cacheprovider -v tests/test_a.py");
  assert.match(f.record?.list ?? "", /--collect-only -q tests\/test_a\.py 2>&1 \| awk/);
  assert.deepEqual(f.config, ["pyproject.toml"]);
});

test("the npm count reads node:test TAP and spec output, jest and mocha, and refuses output with no summary", () => {
  const cmd = afterPipe(inspectRepo(repo({ "package.json": npmPkg("jest"), "src/a.js": "", "src/a.test.js": "" })).command!);
  assert.equal(count(cmd, "> app@1.0.0 test\nok 1 - a\n# tests 5\n# pass 3\n# fail 2\n"), "3");
  assert.equal(count(cmd, "✔ a (1ms)\nℹ tests 4\nℹ pass 4\nℹ fail 0\n"), "4");
  assert.equal(count(cmd, "Tests:       1 failed, 7 passed, 8 total\n"), "7");
  assert.equal(count(cmd, "  9 passing (20ms)\n  1 failing\n"), "9");
  assert.equal(count(cmd, "SyntaxError: Unexpected token\n"), "exit 1");
});

test("the node:test count takes only recorded IDs that ran once and passed", () => {
  const r = inspectRepo(repo({ "package.json": npmPkg("node --test"), "src/a.js": "", "test/a.test.js": "" })).record!;
  assert.equal(count(afterPipe(r.list), "# Subtest: a\nok 1 - a\nnot ok 2 - b\nok 3 - c\nok 4 - c\nok 5 - d # SKIP\n    ok 1 - inner\n", undefined, true), "0\ta\n0\tb\n0\td\n4\tinner");
  const ids = ["0\ta", "0\tb", "0\td", "4\tinner"];
  assert.equal(count(r.count, "ok 1 - a\nnot ok 2 - b\nok 3 - d # SKIP\n    ok 1 - inner\nok 4 - extra\n# ok 9 - b\n", ids), "2");
  // A recorded ID that runs twice counts as failing, even when both runs pass. "inner" at the top level is another ID.
  assert.equal(count(r.count, "ok 1 - a\nok 2 - a\nok 3 - b\nok 4 - inner\n", ids), "1");
  assert.equal(count(r.count, "SyntaxError: Unexpected token\n", ids), "exit 1");
});

test("the pytest count takes only recorded node IDs that ran once and passed", () => {
  const r = inspectRepo(repo({ "pyproject.toml": "", "src/a.py": "", "tests/test_a.py": "" })).record!;
  assert.equal(count(afterPipe(r.list), "tests/test_a.py::test_x\ntests/test_a.py::test_p[a b]\n\n2 tests collected in 0.01s\n", undefined, true), "tests/test_a.py::test_p[a b]\ntests/test_a.py::test_x");
  const ids = ["tests/test_a.py::test_x", "tests/test_a.py::test_y", "tests/test_a.py::test_p[a b]"];
  const run = "tests/test_a.py::test_x PASSED   [ 25%]\ntests/test_a.py::test_y FAILED   [ 50%]\ntests/test_a.py::test_p[a b] PASSED [ 75%]\ntests/test_a.py::test_new PASSED [100%]\nFAILED tests/test_a.py::test_y - assert 0\n";
  assert.equal(count(r.count, run, ids), "2");
  assert.equal(count(r.count, run + "tests/test_a.py::test_x PASSED [100%]\n", ids), "1");
  assert.equal(count(r.count, "ERROR collecting tests/test_a.py\n1 error in 0.10s\n", ids), "exit 1");
});

test("draftProblem holds the source folder in artifact and the tests and the file in protect", () => {
  const d = draftProblem({ name: "x", source: "src", tests: "test", runner: "npm", testFiles: ["test/a.test.js", "src/b.test.js"], config: ["package.json"], pytestConfig: null, python: null, record: { list: "", run: "", count: "" }, js: null, command: "node --test 2>&1 | awk '{}'" });
  assert.deepEqual(d.artifact, ["src/**"]);
  assert.deepEqual(d.protect, ["test/**", "test/a.test.js", "src/b.test.js", ...TEST_FILE_GLOBS, "**/conftest.py", "package.json", IDS_FILE, "**/node_modules/**", PROBLEM_FILE]);
  assert.deepEqual(d.proposer, { agent: "claude", args: ["--permission-mode", "acceptEdits"] });
  assert.deepEqual(d.model, { provider: "anthropic", model: "claude-haiku-5-5" });
  assert.equal((d.measure as { direction: string }).direction, "higher");
});

test("problem init writes a valid file, prints each field and the solve command, and exits 0", () => {
  const dir = repo({ "package.json": npmPkg("node --test"), "src/a.js": "", "test/a.test.js": passingTest });
  const r = initIn(dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(dir, IDS_FILE), "utf8"), "0\tt\n");
  assert.match(r.out, /same process/);
  assert.match(r.out, /held-back split.*guards.*review/);
  assert.match(r.out, /artifact: src\/\*\*/);
  assert.match(r.out, /protect: test\/\*\*, \*\*\/\*\.test\.\*, .*synthe\.problem\.json, and the 1 test file/);
  assert.match(r.out, /claude agent/);
  assert.match(r.out, /npx synthe solve synthe\.problem\.json/);
  assert.equal(JSON.parse(readFileSync(join(dir, PROBLEM_FILE), "utf8")).proposer.agent, "claude");
});

test("with nothing to measure, problem init writes a starter file, names the fields and exits 2", () => {
  const dir = repo({ "README.md": "# notes\n" });
  const r = initIn(dir);
  assert.equal(r.code, 2, r.out);
  for (const field of ["goal", "artifact", "measure.command"]) assert.match(r.out, new RegExp(`\\b${field.replace(".", "\\.")}:`), r.out);
  assert.equal(typeof JSON.parse(readFileSync(join(dir, PROBLEM_FILE), "utf8")), "object");
});

test("problem init keeps an existing file without --force and replaces it with --force", () => {
  const dir = repo({ "package.json": npmPkg("node --test"), "src/a.js": "", "test/a.test.js": passingTest, [PROBLEM_FILE]: "mine\n" });
  const r = initIn(dir);
  assert.equal(r.code, 1);
  assert.match(r.out, /already exists/);
  assert.match(r.out, /--force/);
  assert.equal(readFileSync(join(dir, PROBLEM_FILE), "utf8"), "mine\n");
  assert.equal(initIn(dir, ["--force"]).code, 0);
  assert.notEqual(readFileSync(join(dir, PROBLEM_FILE), "utf8"), "mine\n");
});

test("problem init refuses an unknown argument and a --dir that is not a folder", () => {
  const dir = repo({});
  assert.equal(initIn(dir, ["--bogus"]).code, 1);
  const r = initIn(dir, ["--dir", "missing"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /is not a folder/);
});

test("the measure names only the test files that exist at init, so a new test file never runs", () => {
  const f = inspectRepo(repo({ "package.json": npmPkg("node --test"), "src/a.js": "", "src/b.test.js": "", "test/c.js": "", "test/fixtures/d.json": "", "lib/test-e.js": "", "src/f.js": "" }));
  assert.deepEqual(f.testFiles, ["lib/test-e.js", "src/b.test.js", "test/c.js"]);
  assert.equal(f.record?.run, "env -u NODE_TEST_CONTEXT node --test --test-reporter=tap lib/test-e.js src/b.test.js test/c.js");
});

test("a node --test script keeps its flags and loses its paths", () => {
  const f = inspectRepo(repo({ "package.json": npmPkg("node --import tsx --test --test-reporter spec test/"), "src/a.js": "", "test/it's.test.js": "" }));
  assert.equal(f.record?.run, "env -u NODE_TEST_CONTEXT node --import tsx --test --test-reporter=tap 'test/it'\\''s.test.js'");
});

test("jest and pytest get the test files after the command, and node_modules and venvs never count", () => {
  const j = inspectRepo(repo({ "package.json": npmPkg("jest"), "src/a.js": "", "src/__tests__/a.js": "", "src/b.spec.ts": "", "node_modules/x/y.test.js": "" }));
  assert.equal(j.command?.split(" 2>&1")[0], "npm test -- src/__tests__/a.js src/b.spec.ts");
  const p = inspectRepo(repo({ "pyproject.toml": "", "src/a.py": "", "src/test_a.py": "", "tests/b_test.py": "", ".venv/lib/test_x.py": "", "tests/conftest.py": "" }));
  assert.deepEqual(p.testFiles, ["src/test_a.py", "tests/b_test.py"]);
});

test("with a test script but no test file, problem init writes a starter file and exits 2", () => {
  const r = initIn(repo({ "package.json": npmPkg("node --test"), "src/a.js": "" }));
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /no test file/);
});

// The run below calls the real pytest. As in improve-worktree.test.ts, it is skipped where no python3 has pytest
// (the CI test job). The pytest parsing has its own test above, with canned output.
const hasPytest = (() => {
  if (process.platform === "win32") return false;
  try { execFileSync("python3", ["-m", "pytest", "--version"], { stdio: "ignore" }); return true; } catch { return false; }
})();

test("problem init with pytest records the node IDs and protects conftest.py and pyproject.toml", { skip: hasPytest ? false : "no python3 with pytest available" }, () => {
  const dir = repo({ "pyproject.toml": "[tool.pytest.ini_options]\npythonpath = [\"src\"]\n", "src/m.py": "def f():\n    return 1\n", "src/test_m.py": "import m\n\ndef test_f():\n    assert m.f() == 1\n\ndef test_g():\n    assert m.f() == 2\n" });
  const r = initIn(dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(dir, IDS_FILE), "utf8"), "src/test_m.py::test_f\nsrc/test_m.py::test_g\n");
  const problem = JSON.parse(readFileSync(join(dir, PROBLEM_FILE), "utf8"));
  for (const g of ["**/conftest.py", "pyproject.toml", IDS_FILE, ...PYTEST_CONFIG_GLOBS, ...PYTHON_STARTUP_GLOBS]) assert.ok(problem.protect.includes(g), g);
  assert.match(problem.measure.command, /^env -u PYTEST_ADDOPTS -u PYTEST_PLUGINS .* -c pyproject\.toml --rootdir=\. -p no:cacheprovider -v /);
  assert.equal(execFileSync("sh", ["-c", problem.measure.command], { cwd: dir, encoding: "utf8" }).trim(), "1");
});

test("pytest with no configuration: init writes an empty protected one, and a nested pytest.ini is never read", { skip: hasPytest ? false : "no python3 with pytest available" }, () => {
  const dir = repo({ "pkg/__init__.py": "", "pkg/m.py": "def f():\n    return 1\n", "pkg/test_m.py": "from pkg import m\n\ndef test_f():\n    assert m.f() == 1\n\ndef test_g():\n    assert m.f() == 2\n", "setup.cfg": "[metadata]\nname = x\n" });
  const r = initIn(dir);
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(dir, EMPTY_PYTEST_INI), "utf8"), "[pytest]\n");
  const problem = JSON.parse(readFileSync(join(dir, PROBLEM_FILE), "utf8"));
  assert.ok(problem.protect.includes(EMPTY_PYTEST_INI));
  assert.match(r.out, /pytest reads only synthe\.pytest\.ini/);
  const measure = () => execFileSync("sh", ["-c", problem.measure.command], { cwd: dir, encoding: "utf8", env: { ...process.env, PYTEST_ADDOPTS: "--bogus-option" } }).trim();
  assert.equal(measure(), "1");
  // A nested configuration with an option pytest does not know would break the run if pytest read it.
  writeFileSync(join(dir, "pkg/pytest.ini"), "[pytest]\naddopts = --bogus-option\n");
  assert.equal(measure(), "1");
});

test("a src layout gets src/ on the path from pytest's pythonpath, never from PYTHONPATH at startup", () => {
  const files = { "src/m.py": "", "src/test_m.py": "" };
  // No pytest configuration: the file that init writes adds src.
  const none = inspectRepo(repo({ ...files, "requirements.txt": "pytest\n", "tests/test_x.py": "" }));
  assert.equal(none.pytestConfig?.create, "[pytest]\npythonpath = src\n");
  // A configuration without pythonpath: the command adds it with -o.
  const without = inspectRepo(repo({ ...files, "pytest.ini": "[pytest]\ntestpaths = src\n" }));
  assert.match(without.record?.run ?? "", / -c pytest\.ini --rootdir=\. -o pythonpath=src -p no:cacheprovider /);
  // A configuration with pythonpath: nothing is added.
  const withPath = inspectRepo(repo({ ...files, "pytest.ini": "[pytest]\npythonpath = src\n" }));
  assert.doesNotMatch(withPath.record?.run ?? "", /-o pythonpath/);
  for (const f of [none, without, withPath]) assert.doesNotMatch(f.record?.run ?? "", /PYTHONPATH=/);
});

test("a src/sitecustomize.py never runs in the measure", { skip: hasPytest ? false : "no python3 with pytest available" }, () => {
  const dir = repo({ "src/m.py": "def f():\n    return 1\n", "src/test_m.py": "import m\n\ndef test_f():\n    assert m.f() == 1\n\ndef test_g():\n    assert m.f() == 2\n", "requirements.txt": "pytest\n", "tests/test_x.py": "import m\n\ndef test_x():\n    assert m.f() == 1\n" });
  const r = initIn(dir);
  assert.equal(r.code, 0, r.out);
  const problem = JSON.parse(readFileSync(join(dir, PROBLEM_FILE), "utf8"));
  const measure = () => execFileSync("sh", ["-c", problem.measure.command], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(measure(), "2");
  // If Python ran it at startup, pytest would stop on the unknown option and the measure would print no number.
  writeFileSync(join(dir, "src/sitecustomize.py"), "import os\nos.environ['PYTEST_ADDOPTS'] = '--bogus-option'\n");
  assert.equal(measure(), "2");
});

test("the folders on pytest's pythonpath come from the src layout and the root configuration", () => {
  const files = { "src/m.py": "", "src/test_m.py": "", "lib/x.py": "" };
  assert.deepEqual(inspectRepo(repo({ ...files, "requirements.txt": "pytest\n", "tests/test_x.py": "" })).python?.pathFolders, ["src"]);
  assert.deepEqual(inspectRepo(repo({ ...files, "pyproject.toml": "[tool.pytest.ini_options]\npythonpath = [\n  \"src\",\n  \"./lib/\",\n]\n" })).python?.pathFolders, ["src", "lib"]);
  assert.deepEqual(inspectRepo(repo({ "pkg/__init__.py": "", "pkg/test_m.py": "", "pytest.ini": "[pytest]\n" })).python?.pathFolders, []);
});

test("problem init protects every standard and installed module name in src, and a new module name stays free", { skip: hasPytest ? false : "no python3 with pytest available" }, () => {
  const dir = repo({ "src/m.py": "def f():\n    return 1\n", "src/test_m.py": "import m\n\ndef test_f():\n    assert m.f() == 1\n", "requirements.txt": "pytest\n", "tests/test_x.py": "" });
  const r = initIn(dir);
  assert.equal(r.code, 0, r.out);
  const protect: string[] = JSON.parse(readFileSync(join(dir, PROBLEM_FILE), "utf8")).protect;
  for (const name of ["pdb", "cmd", "code", "codeop", "os", "pytest", "_pytest"]) {
    assert.ok(protect.includes(`src/${name}.py`) && protect.includes(`src/${name}/**`), name);
  }
  for (const free of ["src/m.py", "src/my_new_module_xyz.py", "src/my_new_module_xyz/__init__.py"]) {
    assert.ok(!protect.some((g) => g === free || (g.endsWith("/**") && free.startsWith(g.slice(0, -2)))), free);
  }
  assert.match(r.out, /protect also: <name>\.py and <name>\/\*\* in src for \d+ module names/);
  assert.doesNotMatch(r.out, /src\/pdb\.py/, "the output summarizes the module globs instead of listing them");
});

test("packageInits lists __init__.py in every folder from each test file up to the root", () => {
  assert.deepEqual(packageInits(["src/checks/test_core.py", "tests/test_x.py", "test_top.py"]), ["__init__.py", "src/__init__.py", "src/checks/__init__.py", "tests/__init__.py"]);
});

test("pytest: protect holds __init__.py around each test file, and an __init__.py in an unrelated source folder stays allowed", () => {
  const f = inspectRepo(repo({ "src/app/core.py": "", "src/checks/test_core.py": "", "pytest.ini": "[pytest]\n" }));
  assert.equal(f.runner, "pytest");
  const protect = draftProblem(f).protect as string[];
  for (const p of ["src/checks/__init__.py", "src/__init__.py", "__init__.py"]) assert.ok(protect.includes(p), p);
  assert.ok(!protect.includes("src/app/__init__.py"));
  assert.ok(!protect.some((g) => g.includes("__init__") && g.includes("*")), "only exact paths");
});

test("the commit line that problem init prints commits every file it wrote, so solve's checkout has them", () => {
  const dir = repo({ "package.json": npmPkg("node --test"), "src/a.js": "", "test/a.test.js": passingTest });
  const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", [...id, "commit", "-qm", "the project"], { cwd: dir });
  const r = initIn(dir);
  assert.equal(r.code, 0, r.out);
  const line = r.out.split("\n").map((l) => l.trim()).find((l) => l.startsWith("git ") && l.includes(" commit "));
  assert.ok(line, `problem init prints a git commit line:\n${r.out}`);
  assert.match(line, new RegExp(`${PROBLEM_FILE}.*${IDS_FILE}`));
  execFileSync("sh", ["-c", line], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }), "", "nothing that init wrote is left uncommitted");
});
