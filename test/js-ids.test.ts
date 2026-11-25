// Unit tests for the stage 4i helper that `problem init` writes for jest, vitest and mocha (src/solve/js-ids.ts).
// They import the same text that init writes, so the tested parse code is the code that runs in a team's repository.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HELPER_SOURCE, JS_HELPER_FILE, jsRunnerOf } from "../src/solve/js-ids.ts";
import { IDS_FILE } from "../src/solve/init.ts";

interface Row { id: string; pass: boolean }
interface Helper {
  IDS_FILE: string;
  idOf(file: string, ancestors: string[], title: string): string;
  relFile(name: unknown, roots: string[]): string;
  reportRows(runner: string, text: string, roots: string[]): Row[] | null;
  countRecorded(recorded: string[], rows: Row[] | null): number;
  listOnce(rows: Row[] | null): string[];
  runnerArgs(runner: string, config: string, files: string[], out: string): string[];
}
const h = await import(`data:text/javascript,${encodeURIComponent(HELPER_SOURCE)}`) as Helper;
const ROOT = "/repo";
const jestReport = (results: { name: string; tests: { anc: string[]; title: string; status: string }[] }[]) => JSON.stringify({
  numPassedTests: 999, success: true,
  testResults: results.map((r) => ({ name: r.name, assertionResults: r.tests.map((t) => ({ ancestorTitles: t.anc, title: t.title, fullName: [...t.anc, t.title].join(" "), status: t.status })) })),
});

test("the helper reads the same IDs file that init writes", () => {
  assert.equal(h.IDS_FILE, IDS_FILE);
  assert.match(HELPER_SOURCE, new RegExp(JS_HELPER_FILE.replace(".", "\\.")));
});

test("jest and vitest reports: the ID holds the file, the describe blocks and the title", () => {
  const rows = h.reportRows("jest", jestReport([
    { name: "/repo/test/a.test.js", tests: [{ anc: ["g"], title: "t1", status: "passed" }, { anc: ["g"], title: "t2", status: "failed" }] },
    { name: "/repo/test/b.test.js", tests: [{ anc: ["g"], title: "t1", status: "passed" }, { anc: [], title: "t1", status: "skipped" }] },
  ]), [ROOT]);
  assert.deepEqual(rows, [
    { id: h.idOf("test/a.test.js", ["g"], "t1"), pass: true },
    { id: h.idOf("test/a.test.js", ["g"], "t2"), pass: false },
    { id: h.idOf("test/b.test.js", ["g"], "t1"), pass: true },
    { id: h.idOf("test/b.test.js", [], "t1"), pass: false },
  ]);
  assert.deepEqual(h.reportRows("vitest", jestReport([{ name: "/repo/x.test.js", tests: [{ anc: [], title: "t", status: "passed" }] }]), [ROOT]), [{ id: '["x.test.js","t"]', pass: true }]);
});

test("mocha reports: a test passes only when it is in passes and not in failures or pending", () => {
  const t = (title: string, file = "/repo/test/a.js") => ({ title, fullTitle: `g ${title}`, file, err: {} });
  const report = JSON.stringify({ stats: { passes: 999 }, tests: [t("a"), t("b"), t("c"), t("d")], passes: [t("a"), t("d")], failures: [t("b"), t("d")], pending: [t("c")] });
  assert.deepEqual(h.reportRows("mocha", report, [ROOT]), [
    { id: '["test/a.js","g a"]', pass: true },
    { id: '["test/a.js","g b"]', pass: false },
    { id: '["test/a.js","g c"]', pass: false },
    { id: '["test/a.js","g d"]', pass: false },
  ]);
});

test("a report that does not parse, or has the wrong shape, gives no rows", () => {
  for (const runner of ["jest", "vitest", "mocha"]) {
    assert.equal(h.reportRows(runner, "", [ROOT]), null);
    assert.equal(h.reportRows(runner, "Tests: 999 passed\n", [ROOT]), null);
    assert.equal(h.reportRows(runner, "null", [ROOT]), null);
  }
  assert.equal(h.reportRows("mocha", jestReport([]), [ROOT]), null);
  assert.equal(h.reportRows("jest", JSON.stringify({ tests: [] }), [ROOT]), null);
  assert.equal(h.countRecorded(["x"], null), 0);
});

test("a recorded ID counts only when it ran exactly once and passed", () => {
  const [a, b, c] = ["a", "b", "c"].map((x) => h.idOf("t.js", ["g"], x));
  const recorded = [a, b, c];
  assert.equal(h.countRecorded(recorded, [{ id: a, pass: true }, { id: b, pass: false }, { id: c, pass: true }]), 2);
  // New IDs count nothing.
  assert.equal(h.countRecorded(recorded, [{ id: a, pass: true }, ...Array.from({ length: 40 }, (_, i) => ({ id: h.idOf("t.js", ["g"], `new ${i}`), pass: true }))]), 1);
  // A second passing copy of a passing ID lowers the count by one; a passing copy of a failing ID adds nothing.
  assert.equal(h.countRecorded(recorded, [{ id: a, pass: true }, { id: a, pass: true }, { id: c, pass: true }]), 1);
  assert.equal(h.countRecorded(recorded, [{ id: b, pass: false }, { id: b, pass: true }, { id: c, pass: true }]), 1);
  // A recorded ID listed twice in the file still counts once.
  assert.equal(h.countRecorded([a, a], [{ id: a, pass: true }]), 1);
});

test("init records each ID that ran once, passed or not, and leaves out shared IDs", () => {
  const rows = [{ id: "x", pass: false }, { id: "y", pass: true }, { id: "y", pass: true }, { id: "w", pass: true }];
  assert.deepEqual(h.listOnce(rows), ["w", "x"]);
});

test("report paths become relative to the repository; a path outside stays as it is", () => {
  assert.equal(h.relFile("/repo/test/a.js", ["/repo"]), "test/a.js");
  assert.equal(h.relFile("file:///repo/test/a.js", ["/repo"]), "test/a.js");
  assert.equal(h.relFile("/other/a.js", ["/repo"]), "/other/a.js");
  assert.equal(h.relFile(undefined, ["/repo"]), "");
});

test("the runner always gets a named configuration (or none) and writes its report to the given file", () => {
  const files = ["test/a.test.js"];
  assert.deepEqual(h.runnerArgs("jest", "jest.config.js", files, "/tmp/r.json").slice(-6), ["--outputFile=/tmp/r.json", "--config", "jest.config.js", "--runTestsByPath", "--", "test/a.test.js"]);
  assert.ok(h.runnerArgs("jest", "-", files, "/o").includes("{}"));
  const v = h.runnerArgs("vitest", "-", files, "/o");
  assert.equal(v[v.indexOf("--config") + 1], "synthe.vitest.config.mjs");
  assert.ok(v.includes("--reporter=json") && v.includes("--outputFile=/o"));
  assert.deepEqual(h.runnerArgs("mocha", ".mocharc.json", files, "/o").slice(0, 2), ["--config", ".mocharc.json"]);
  assert.equal(h.runnerArgs("mocha", "-", files, "/o")[0], "--no-config");
  assert.ok(h.runnerArgs("mocha", "-", files, "/o").includes("output=/o"));
});

test("jsRunnerOf finds a runner only when the npm script starts it", () => {
  assert.equal(jsRunnerOf("jest"), "jest");
  assert.equal(jsRunnerOf("vitest run --coverage"), "vitest");
  assert.equal(jsRunnerOf("npx mocha"), "mocha");
  assert.equal(jsRunnerOf("node --test"), null);
  assert.equal(jsRunnerOf("jestx"), null);
  assert.equal(jsRunnerOf("tsc && jest"), null);
});
