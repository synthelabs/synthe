import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProblem, problemSummary, validateProblem } from "../src/solve/problem.ts";
import { problemCommand } from "../src/cli/problem.ts";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "synthe-problem-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

const valid = {
  version: 1,
  name: "short-name",
  goal: "One plain sentence: what should get better.",
  artifact: ["src/**/*.py", "config.json"],
  protect: ["measure/**"],
  measure: { command: "python3 measure/score.py", direction: "higher", unit: "points", runs: 3 },
  guards: ["python3 -m pytest -q"],
  split: { holdout: true },
  proposer: { command: "node propose.js" },
  budget: { max_rounds: 6, max_calls: 200 },
};

test("the full example in GOAL.md is valid, and defaults fill the optional fields", () => {
  const dir = repo();
  const r = validateProblem(valid, dir);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.problem.measure.kind, "command");
  assert.equal(r.problem.holdout, true);
  assert.deepEqual(r.problem.proposer, { kind: "command", command: "node propose.js" });

  const min = validateProblem({ version: 1, name: "a", goal: "g", artifact: ["x"], measure: { command: "echo 1", direction: "lower" } }, dir);
  assert.ok(min.ok, JSON.stringify(min));
  assert.equal(min.problem.measure.runs, 3);
  assert.equal(min.problem.budget.maxRounds, 6);
  assert.equal(min.problem.budget.maxCalls, null);
  assert.deepEqual(min.problem.proposer, { kind: "model" });
  assert.deepEqual(min.problem.protect, []);
});

test("a judged measure and a model section are valid", () => {
  const dir = repo();
  writeFileSync(join(dir, "cases.jsonl"), '{"id":"1","input":"hi"}\n{"id":"2","input":"yo"}\n');
  const r = validateProblem({
    version: 1, name: "j", goal: "g", artifact: ["prompt.md"], proposer: "model",
    measure: { judge: { cases: "cases.jsonl", run: "node run.js", compare: "model" } },
    model: { base_url: "https://api.example.com/v1", model: "m-1" },
  }, dir);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.problem.measure.kind, "judge");
  assert.deepEqual(r.problem.model, { baseUrl: "https://api.example.com/v1", model: "m-1" });
});

const bad: [string, (p: Record<string, unknown>) => void][] = [
  ["version", (p) => { p.version = 2; }],
  ["name", (p) => { p.name = "bad name!"; }],
  ["goal", (p) => { delete p.goal; }],
  ["artifact", (p) => { p.artifact = []; }],
  ["artifact[0]", (p) => { p.artifact = ["../outside/**"]; }],
  ["protect[0]", (p) => { p.protect = ["/etc/passwd"]; }],
  ["measure", (p) => { delete p.measure; }],
  ["measure", (p) => { p.measure = { command: "x", direction: "higher", judge: { cases: "c", run: "r", compare: "c" } }; }],
  ["measure.direction", (p) => { p.measure = { command: "x", direction: "up" }; }],
  ["measure.runs", (p) => { p.measure = { command: "x", direction: "higher", runs: 0 }; }],
  ["measure.judge.cases", (p) => { p.measure = { judge: { cases: "missing.jsonl", run: "r", compare: "c" } }; }],
  ["guards", (p) => { p.guards = "pytest"; }],
  ["split.holdout", (p) => { p.split = { holdout: "yes" }; }],
  ["proposer", (p) => { p.proposer = "human"; }],
  ["proposer.command", (p) => { p.proposer = { command: "" }; }],
  ["budget.max_rounds", (p) => { p.budget = { max_rounds: 1.5 }; }],
  ["budget.max_calls", (p) => { p.budget = { max_calls: -1 }; }],
  ["model.base_url", (p) => { p.model = { base_url: "ftp://x", model: "m" }; }],
  ["model.api_key", (p) => { p.model = { base_url: "https://x", model: "m", api_key: "sk-123" }; }],
  ["extra", (p) => { p.extra = 1; }],
];

for (const [field, breakIt] of bad) {
  test(`a bad ${field} gives exactly one line that names it`, () => {
    const p = structuredClone(valid) as Record<string, unknown>;
    breakIt(p);
    const r = validateProblem(p, repo());
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.errors.length, 1, r.errors.join("\n"));
    assert.ok(r.errors[0].startsWith(`${field}:`), r.errors[0]);
  });
}

test("a key in the model section is never echoed back", () => {
  const r = validateProblem({ ...valid, model: { base_url: "https://x", model: "m", api_key: "sk-secret-123" } }, repo());
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(!r.errors.join("\n").includes("sk-secret-123"));
});

test("several bad fields give one line each", () => {
  const r = validateProblem({ version: 1, name: "ok", goal: "", artifact: "x", measure: { command: "c", direction: "sideways" } }, repo());
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.deepEqual(r.errors.map((e) => e.split(":")[0]), ["goal", "artifact", "measure.direction"]);
});

test("a folder outside git, a missing file and bad JSON are refused with one line", () => {
  const plain = mkdtempSync(join(tmpdir(), "synthe-nogit-"));
  const r = validateProblem(valid, plain);
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.errors.length, 1);

  const missing = loadProblem(join(plain, "nope.json"));
  assert.equal(missing.ok, false);
  const dir = repo();
  writeFileSync(join(dir, "p.json"), "{ not json");
  const broken = loadProblem(join(dir, "p.json"));
  assert.equal(broken.ok, false);
  if (!broken.ok) assert.match(broken.errors[0], /^file: not valid JSON/);
});

test("problem check: exit 0 with a summary, exit 1 with one line per bad field", () => {
  const dir = repo();
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "p.json"), JSON.stringify(valid));
  const out: string[] = [], err: string[] = [];
  assert.equal(problemCommand(["check", join(dir, "sub", "p.json")], (l) => out.push(l), (l) => err.push(l)), 0);
  assert.match(out[0], /short-name/);
  const r = loadProblem(join(dir, "sub", "p.json"));
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.problem.dir, join(dir, "sub"));
  if (r.ok) assert.ok(problemSummary(r.problem).some((l) => l.startsWith("Guards:")));

  writeFileSync(join(dir, "bad.json"), JSON.stringify({ ...valid, version: 3, name: "" }));
  const out2: string[] = [];
  assert.equal(problemCommand(["check", join(dir, "bad.json")], (l) => out2.push(l), () => {}), 1);
  assert.deepEqual(out2.map((l) => l.split(":")[0]), ["version", "name"]);

  assert.equal(problemCommand(["nope"], () => {}, () => {}), 1);
});
