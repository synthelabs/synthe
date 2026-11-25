import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { applyEdits, applyProposal, artifactFiles, checkEdits, commandPaths, type EditRules, measurePathsOf, pathProblem, rulesFor } from "../src/solve/edits.ts";
import type { Problem } from "../src/solve/types.ts";

const rules: EditRules = {
  artifact: ["src/**/*.py", "config.json"],
  protect: ["src/vendor/**"],
  measurePaths: commandPaths(["python3 measure/score.py --fast", "python3 -m pytest -q", "./check.sh"]),
};

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "synthe-edits-"));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  return dir;
}

test("commandPaths: words that name files, not flags, modules or absolute paths", () => {
  assert.deepEqual(commandPaths(["python3 measure/score.py --fast", "python3 -m pytest -q", "./check.sh", "cat /etc/x ../up.txt 'data/in.csv'"]),
    ["measure/score.py", "check.sh", "data/in.csv"]);
});

test("pathProblem: artifact files may change; protect, measure, outside and unsafe paths are refused with the path named", () => {
  assert.equal(pathProblem("config.json", rules), null);
  assert.equal(pathProblem("src/app/main.py", rules), null);
  assert.equal(pathProblem("./config.json", rules), null);
  assert.match(pathProblem("src/vendor/lib.py", rules)!, /^src\/vendor\/lib\.py is protected/);
  assert.match(pathProblem("measure/score.py", rules)!, /^measure\/score\.py is used by the measure/);
  assert.match(pathProblem("check.sh", rules)!, /^check\.sh is used by the measure/);
  assert.match(pathProblem("README.md", rules)!, /^README\.md is outside the artifact globs/);
  assert.match(pathProblem("../escape.py", rules)!, /not a path inside the problem folder/);
  assert.match(pathProblem("/etc/passwd", rules)!, /not a path inside the problem folder/);
  assert.match(pathProblem("src/.git/config", { ...rules, artifact: ["**"] })!, /git's own folder/);
});

test("protect wins over artifact, and the measure's files win over artifact", () => {
  const wide: EditRules = { artifact: ["**"], protect: ["data/**"], measurePaths: ["measure/score.py"] };
  assert.match(pathProblem("data/x.csv", wide)!, /protected/);
  assert.match(pathProblem("measure/score.py", wide)!, /used by the measure/);
  assert.equal(pathProblem("other.txt", wide), null);
});

test("checkEdits: one reason per refused path, in path order", () => {
  const reasons = checkEdits([
    { path: "README.md", search: "a", replace: "b" },
    { path: "config.json", search: "a", replace: "b" },
    { path: "measure/score.py", search: "a", replace: "b" },
    { path: "README.md", search: "c", replace: "d" },
  ], rules);
  assert.deepEqual(reasons.map((r) => r.split(" ")[0]), ["README.md", "measure/score.py"]);
});

test("applyEdits: applies edits in order and reports the changed files", () => {
  const dir = folder({ "config.json": '{"a": 1, "b": 2}', "src/m.py": "x = 1\n" });
  const r = applyEdits(dir, [
    { path: "config.json", search: '"a": 1', replace: '"a": 5' },
    { path: "config.json", search: '"a": 5, "b": 2', replace: '"a": 5, "b": 3' },
    { path: "src/m.py", search: "x = 1", replace: "x = 2" },
  ], rules);
  assert.deepEqual(r, { ok: true, changed: ["config.json", "src/m.py"] });
  assert.equal(readFileSync(join(dir, "config.json"), "utf8"), '{"a": 5, "b": 3}');
  assert.equal(readFileSync(join(dir, "src/m.py"), "utf8"), "x = 2\n");
});

test("applyEdits: a refused path changes no file, not even the allowed ones", () => {
  const dir = folder({ "config.json": '{"a": 1}', "measure/score.py": "print(1)\n" });
  const r = applyEdits(dir, [
    { path: "config.json", search: "1", replace: "2" },
    { path: "measure/score.py", search: "print(1)", replace: "print(100)" },
  ], rules);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /measure\/score\.py/);
  assert.equal(readFileSync(join(dir, "config.json"), "utf8"), '{"a": 1}');
  assert.equal(readFileSync(join(dir, "measure/score.py"), "utf8"), "print(1)\n");
});

test("applyEdits: search must occur exactly once; otherwise a plain reason and no change", () => {
  const dir = folder({ "config.json": '{"a": 1, "b": 1}' });
  const missing = applyEdits(dir, [{ path: "config.json", search: '"c"', replace: "x" }], rules);
  assert.match(!missing.ok ? missing.reason : "", /^config\.json: the search text "\\"c\\"" occurs nowhere/);
  const twice = applyEdits(dir, [{ path: "config.json", search: "1", replace: "2" }], rules);
  assert.match(!twice.ok ? twice.reason : "", /occurs more than once/);
  const late = applyEdits(dir, [{ path: "config.json", search: '"a": 1', replace: '"a": 2' }, { path: "config.json", search: "zzz", replace: "" }], rules);
  assert.equal(late.ok, false);
  assert.equal(readFileSync(join(dir, "config.json"), "utf8"), '{"a": 1, "b": 1}');
});

test("applyEdits: an empty search creates a new artifact file, and only a new one", () => {
  const dir = folder({ "config.json": "{}" });
  assert.deepEqual(applyEdits(dir, [{ path: "src/new/mod.py", search: "", replace: "y = 1\n" }], rules), { ok: true, changed: ["src/new/mod.py"] });
  assert.equal(readFileSync(join(dir, "src/new/mod.py"), "utf8"), "y = 1\n");
  const r = applyEdits(dir, [{ path: "config.json", search: "", replace: "x" }], rules);
  assert.match(!r.ok ? r.reason : "", /empty search can only create a new file/);
  const gone = applyEdits(dir, [{ path: "src/none.py", search: "a", replace: "b" }], rules);
  assert.match(!gone.ok ? gone.reason : "", /src\/none\.py does not exist/);
});

test("applyEdits: bad edit shapes and empty edit lists are refused, not thrown", () => {
  const dir = folder({ "config.json": "{}" });
  assert.equal(applyEdits(dir, [], rules).ok, false);
  assert.equal(applyEdits(dir, [{ path: "config.json", search: 1, replace: "x" } as never], rules).ok, false);
  assert.equal(applyEdits(dir, null as never, rules).ok, false);
});

test("applyEdits: a symbolic link, or a folder that is one, is refused and the target does not change", { skip: process.platform === "win32" }, () => {
  const outside = folder({ "secret.py": "keep\n" });
  const dir = folder({ "config.json": "{}" });
  mkdirSync(join(dir, "src"));
  symlinkSync(join(outside, "secret.py"), join(dir, "src", "link.py"));
  symlinkSync(outside, join(dir, "src", "out"));
  const a = applyEdits(dir, [{ path: "src/link.py", search: "keep", replace: "lost" }], rules);
  assert.match(!a.ok ? a.reason : "", /symbolic link/);
  const b = applyEdits(dir, [{ path: "src/out/secret.py", search: "keep", replace: "lost" }], rules);
  assert.match(!b.ok ? b.reason : "", /under src\/out, a symbolic link/);
  const c = applyEdits(dir, [{ path: "src/out/new.py", search: "", replace: "x" }], rules);
  assert.equal(c.ok, false);
  assert.equal(existsSync(join(outside, "new.py")), false);
  assert.equal(readFileSync(join(outside, "secret.py"), "utf8"), "keep\n");
});

function repo(): { root: string; problem: Problem } {
  const root = mkdtempSync(join(tmpdir(), "synthe-edits-repo-"));
  const files: Record<string, string> = {
    "README.md": "top\n",
    "zoo/tune/config.json": '{"rate": 1}\n',
    "zoo/tune/src/a.py": "A = 1\n",
    "zoo/tune/src/vendor/v.py": "V = 1\n",
    "zoo/tune/src/blob.py": "x\0y",
    "zoo/tune/measure/score.py": "print(1)\n",
    "zoo/tune/propose.js": "\n",
    "zoo/tune/problem.json": "{}\n",
  };
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(root, p, ".."), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  writeFileSync(join(root, "zoo/tune/src/untracked.py"), "U = 1\n");
  const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { stdio: "pipe" });
  git("init", "-q");
  git("add", "--", ...Object.keys(files));
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const dir = join(root, "zoo/tune");
  const problem: Problem = {
    version: 1, name: "tune", goal: "g", artifact: ["config.json", "src/**/*.py", "measure/**", "propose.js", "problem.json"], protect: ["src/vendor/**"],
    measure: { command: "python3 measure/score.py", direction: "higher", runs: 3 }, guards: [], split: { holdout: false },
    proposer: { command: "node propose.js" }, budget: { max_rounds: 6, max_calls: null }, candidates: 1, dir, file: join(dir, "problem.json"),
  };
  return { root, problem };
}

test("measurePathsOf: the measure, guard, judge and proposer files and the problem file", () => {
  const { problem } = repo();
  assert.deepEqual(measurePathsOf(problem).sort(), ["measure/score.py", "problem.json", "propose.js"]);
  const judged: Problem = { ...problem, guards: ["sh guard.sh"], proposer: "model", measure: { judge: { cases: "cases.jsonl", run: "node run.js", compare: "model" }, runs: 3 } };
  assert.deepEqual(measurePathsOf(judged).sort(), ["cases.jsonl", "guard.sh", "problem.json", "run.js"]);
});

test("artifactFiles: tracked text files that match artifact and are not protected, relative to the problem folder", () => {
  const { root, problem } = repo();
  assert.deepEqual(artifactFiles(root, problem).map((f) => f.path),
    ["config.json", "measure/score.py", "problem.json", "propose.js", "src/a.py"]);
  assert.equal(artifactFiles(join(root, "zoo/tune"), problem).find((f) => f.path === "src/a.py")?.text, "A = 1\n");
});

test("applyProposal: changes the problem folder in the checkout and returns paths from the checkout root", () => {
  const { root, problem } = repo();
  const checkout = mkdtempSync(join(tmpdir(), "synthe-edits-checkout-"));
  execFileSync("git", ["-C", root, "worktree", "add", "-q", "--detach", join(checkout, "wt")], { stdio: "pipe" });
  const wt = join(checkout, "wt");
  const ok = applyProposal(wt, problem, { summary: "s", edits: [{ path: "config.json", search: "1", replace: "2" }] });
  assert.deepEqual(ok, { paths: ["zoo/tune/config.json"] });
  assert.equal(readFileSync(join(wt, "zoo/tune/config.json"), "utf8"), '{"rate": 2}\n');
  assert.equal(readFileSync(join(root, "zoo/tune/config.json"), "utf8"), '{"rate": 1}\n');
  for (const [path, why] of [["measure/score.py", /measure\/score\.py is used by the measure/], ["propose.js", /propose\.js is used by/], ["problem.json", /problem\.json is used by/], ["src/vendor/v.py", /src\/vendor\/v\.py is protected/], ["README.md", /README\.md is outside/]] as const) {
    const r = applyProposal(wt, problem, { summary: "s", edits: [{ path, search: "1", replace: "2" }] });
    assert.match("refused" in r ? r.refused : "", why, path);
  }
  assert.equal(readFileSync(join(wt, "zoo/tune/measure/score.py"), "utf8"), "print(1)\n");
  assert.match((applyProposal(wt, problem, { summary: "s" } as never) as { refused: string }).refused, /no edits/);
});

test("measurePathsOf: a command's input that artifact names exactly stays editable; its program does not", () => {
  const { problem } = repo();
  // README.md is the input of the measure, and the artifact names it exactly: it is the thing to improve.
  const doc: Problem = { ...problem, artifact: ["README.md", "tools/*.cjs"], measure: { command: "node tools/count.cjs README.md", direction: "higher", runs: 1 } };
  assert.deepEqual(measurePathsOf(doc).sort(), ["problem.json", "propose.js", "tools/count.cjs"]);
  // The program a command runs stays refused even when artifact names it exactly.
  const named: Problem = { ...doc, artifact: ["README.md", "tools/count.cjs"] };
  assert.ok(measurePathsOf(named).includes("tools/count.cjs"));
  // A file that only a glob covers stays refused, even as an input.
  const globbed: Problem = { ...doc, artifact: ["*.md"] };
  assert.ok(measurePathsOf(globbed).includes("README.md"));
});

test("pathProblem: another spelling of a protected or measured path is refused, and so is another case", () => {
  const r: EditRules = { artifact: ["src/**", "**/*.py"], protect: ["src/pkg/__init__.py", "src/pdb/**"], measurePaths: ["measure/score.py"] };
  for (const path of ["src/pkg/./__init__.py", "src//pkg/__init__.py", "measure/./score.py", "././measure/score.py", "src/./pdb/x.py", "src/pkg/", "/src/a.py"]) {
    assert.match(pathProblem(path, r) ?? "", /not a path inside the problem folder/, `${path} must be refused as not plain`);
  }
  assert.match(pathProblem("src/PKG/__init__.py", r) ?? "", /protected/, "protect matches without case");
  assert.match(pathProblem("Measure/Score.py", r) ?? "", /used by the measure/, "a measure file matches without case");
  assert.match(pathProblem("src/.GIT/config", r) ?? "", /git's own folder/);
  assert.equal(pathProblem("./src/a.py", r), null, "one leading ./ stays allowed");
  assert.equal(pathProblem("src/pkg/mod.py", r), null);
});

test("applyEdits: a non-plain spelling of a measure file writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "synthe-edits-spelling-"));
  mkdirSync(join(dir, "measure"));
  writeFileSync(join(dir, "measure/score.py"), "print(1)\n");
  const r: EditRules = { artifact: ["**/*.py"], protect: [], measurePaths: ["measure/score.py"] };
  const res = applyEdits(dir, [{ path: "measure/./score.py", search: "print(1)", replace: "print(9)" }], r);
  assert.equal(res.ok, false);
  assert.equal(readFileSync(join(dir, "measure/score.py"), "utf8"), "print(1)\n");
});

test("a guard folder keeps an exact NetworkX artifact editable", () => {
  const components = "networkx/algorithms/components";
  const artifact = components + "/strongly_connected.py";
  const dir = folder({ [artifact]: "", [components + "/connected.py"]: "" });
  const { problem } = repo();
  const guardRules = rulesFor({
    ...problem, dir, file: join(dir, "problem.json"), artifact: [artifact],
    guards: [".venv/bin/python -m pytest -q -p no:cacheprovider networkx/algorithms/components --deselect some/test.py"],
  });
  assert.equal(pathProblem(artifact, guardRules), null);
  assert.ok(pathProblem(components + "/connected.py", guardRules));
});

test("a guard folder keeps a SymPy artifact glob editable and preserves the individual protections", () => {
  const dir = folder({
    "sympy/liealgebras/cartan_type.py": "",
    "sympy/liealgebras/check.py": "",
    "sympy/liealgebras/exact_input.py": "",
    "sympy/liealgebras/protected.py": "",
    "sympy/liealgebras/cases.jsonl": "",
    "sympy/liealgebras/rubric.md": "",
    "sympy/liealgebras/problem.json": "",
  });
  const { problem } = repo();
  const guardRules = rulesFor({
    ...problem, dir, file: join(dir, "sympy/liealgebras/problem.json"),
    artifact: ["sympy/liealgebras/*.py", "sympy/liealgebras/problem.json", "sympy/liealgebras/cases.jsonl", "sympy/liealgebras/rubric.md"],
    protect: ["sympy/liealgebras/protected.py"],
    measure: { judge: { cases: "sympy/liealgebras/cases.jsonl", run: "node judge.js", compare: "model", rubric: "sympy/liealgebras/rubric.md" }, runs: 1 },
    guards: ["python3 -m pytest -q sympy/liealgebras", "python3 sympy/liealgebras/check.py sympy/liealgebras/exact_input.py"],
  });
  assert.equal(pathProblem("sympy/liealgebras/cartan_type.py", guardRules), null);
  for (const name of ["check.py", "exact_input.py", "protected.py", "cases.jsonl", "rubric.md", "problem.json"]) {
    assert.ok(pathProblem("sympy/liealgebras/" + name, guardRules), name);
  }
});

test("a guard folder requires exact opt-in for paths that test runners load automatically", () => {
  const dir = folder({ "src/test_core.py": "", "src/pkg/__init__.py": "", "src/main.py": "", "elsewhere/test_other.py": "" });
  const { problem } = repo();
  const config = { ...problem, dir, file: join(dir, "problem.json"), protect: [], guards: ["pytest src"] };
  const r = rulesFor({ ...config, artifact: ["src/**/*.py", "src/**/*.pth", "src/**/*.ini", "src/**/*.toml", "src/**/*.cfg", "src/**/*.ts", "src/**/.mocharc*", "elsewhere/*.py"] });
  for (const path of [
    "src/test_core.py", "src/new_test.py", "src/tests/fixtures.py", "src/conftest.py",
    "src/sitecustomize.py", "src/usercustomize.py", "src/startup.pth", "src/pytest.ini",
    "src/setup.cfg", "src/tox.ini", "src/pyproject.toml", "src/jest.config.ts",
    "src/vitest.config.ts", "src/vite.config.ts", "src/vitest.workspace.ts", "src/.mocharc",
    "src/a.test.ts", "src/a.spec.ts", "src/__tests__/fixture.ts", "src/test/fixture.ts", "src/new/__init__.py",
  ]) assert.match(pathProblem(path, r) ?? "", /file the test runner loads by itself/, path);
  for (const path of ["src/main.py", "src/helpers.py", "src/pkg/__init__.py", "elsewhere/test_other.py"]) {
    assert.equal(pathProblem(path, r), null, path);
  }
  const exact = rulesFor({ ...config, artifact: ["src/**/*.py", "src/test_core.py", "src/conftest.py", "src/new/__init__.py"] });
  for (const path of ["src/test_core.py", "src/conftest.py", "src/new/__init__.py"]) {
    assert.equal(pathProblem(path, exact), null, path);
  }
});
