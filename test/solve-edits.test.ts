import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyEdits, checkEdits, commandPaths, type EditRules, pathProblem } from "../src/solve/edits.ts";

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
