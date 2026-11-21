import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProblem, problemSummary, validateProblem } from "../src/solve/problem.ts";
import { loadProblem, problemCommand } from "../src/cli/problem.ts";
import { isJudged } from "../src/solve/types.ts";

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
  const r = validateProblem(valid, join(dir, "p.json"));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(isJudged(r.problem.measure), false);
  assert.deepEqual(r.problem.split, { holdout: true });
  assert.deepEqual(r.problem.proposer, { command: "node propose.js" });
  assert.equal(r.problem.candidates, 1);

  const min = validateProblem({ version: 1, name: "a", goal: "g", artifact: ["x"], measure: { command: "echo 1", direction: "lower" } }, join(dir, "p.json"));
  assert.ok(min.ok, JSON.stringify(min));
  assert.equal(min.problem.measure.runs, 3);
  assert.deepEqual(min.problem.budget, { max_rounds: 6, max_calls: null });
  assert.equal(min.problem.proposer, "model");
  assert.deepEqual(min.problem.protect, []);
});

test("a judged measure and a model section are valid", () => {
  const dir = repo();
  writeFileSync(join(dir, "cases.jsonl"), '{"id":"1","input":"hi"}\n{"id":"2","input":"yo"}\n');
  const r = validateProblem({
    version: 1, name: "j", goal: "g", artifact: ["prompt.md"], proposer: "model",
    measure: { judge: { cases: "cases.jsonl", run: "node run.js", compare: "model" } },
    model: { base_url: "https://api.example.com/v1", model: "m-1" },
  }, join(dir, "p.json"));
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(isJudged(r.problem.measure));
  assert.deepEqual(r.problem.model, { provider: "openai-compatible", base_url: "https://api.example.com/v1", model: "m-1" });
});

test("model.provider defaults by base_url, and anthropic needs no base_url (GOAL-2.md)", () => {
  const dir = repo();
  const base = { version: 1, name: "m", goal: "g", artifact: ["x"], measure: { command: "echo 1", direction: "higher" } };
  const check = (model: unknown) => validateProblem({ ...base, model }, join(dir, "p.json"));
  const a = check({ model: "claude-x" });
  assert.ok(a.ok, JSON.stringify(a));
  assert.deepEqual(a.problem.model, { provider: "anthropic", model: "claude-x" });
  const b = check({ provider: "anthropic", model: "claude-x", prices: { input_per_mtok: 3, output_per_mtok: 15 } });
  assert.ok(b.ok, JSON.stringify(b));
  assert.deepEqual(b.problem.model?.prices, { input_per_mtok: 3, output_per_mtok: 15 });
  const lines = (r: ReturnType<typeof check>) => (r.ok ? [] : r.problems);
  assert.match(lines(check({ provider: "openai-compatible", model: "m" })).join("\n"), /^model\.base_url:/m);
  assert.match(lines(check({ provider: "gemini", model: "m" })).join("\n"), /^model\.provider:/m);
  assert.match(lines(check({ model: "m", prices: { input_per_mtok: -1, output_per_mtok: 1 } })).join("\n"), /^model\.prices:/m);
  assert.match(lines(check({ model: "m", prices: { input: 1 } })).join("\n"), /^model\.prices:/m);
  assert.match(lines(check({ model: "m", api_key: "sk-ant-x" })).join("\n"), /^model\.api_key: never put a key/m);
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
  ["candidates", (p) => { p.candidates = 0; }],
  ["extra", (p) => { p.extra = 1; }],
];

for (const [field, breakIt] of bad) {
  test(`a bad ${field} gives exactly one line that names it`, () => {
    const p = structuredClone(valid) as Record<string, unknown>;
    breakIt(p);
    const r = validateProblem(p, join(repo(), "p.json"));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.problems.length, 1, r.problems.join("\n"));
    assert.ok(r.problems[0].startsWith(`${field}:`), r.problems[0]);
  });
}

test("a key in the model section is never echoed back", () => {
  const r = validateProblem({ ...valid, model: { base_url: "https://x", model: "m", api_key: "sk-secret-123" } }, join(repo(), "p.json"));
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(!r.problems.join("\n").includes("sk-secret-123"));
});

test("several bad fields give one line each", () => {
  const r = validateProblem({ version: 1, name: "ok", goal: "", artifact: "x", measure: { command: "c", direction: "sideways" } }, join(repo(), "p.json"));
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.deepEqual(r.problems.map((e) => e.split(":")[0]), ["goal", "artifact", "measure.direction"]);
});

test("a folder outside git, a missing file and bad JSON are refused with one line", () => {
  const plain = mkdtempSync(join(tmpdir(), "synthe-nogit-"));
  const r = validateProblem(valid, join(plain, "p.json"));
  assert.equal(r.ok, false);
  if (!r.ok) assert.deepEqual(r.problems.map((l) => l.split(":")[0]), ["file"]);

  const missing = loadProblem("nope.json", plain);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.problems.length, 1);
  const broken = checkProblem("{ not json", join(repo(), "p.json"));
  assert.equal(broken.ok, false);
  if (!broken.ok) assert.match(broken.problems[0], /^file: not valid JSON/);
});

test("problem check: exit 0 with a summary, exit 1 with one line per bad field", () => {
  const dir = repo();
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "p.json"), JSON.stringify(valid));
  const out: string[] = [];
  assert.equal(problemCommand(["check", "sub/p.json"], dir, (l) => out.push(l)), 0);
  assert.match(out.join("\n"), /short-name/);
  const r = loadProblem("sub/p.json", dir);
  assert.ok(r.ok);
  if (r.ok) assert.equal(r.problem.dir, join(dir, "sub"));
  if (r.ok) assert.match(problemSummary(r), /^Guards: python3 -m pytest -q$/m);

  writeFileSync(join(dir, "bad.json"), JSON.stringify({ ...valid, version: 3, name: "" }));
  const out2: string[] = [];
  assert.equal(problemCommand(["check", "bad.json"], dir, (l) => out2.push(l)), 1);
  assert.deepEqual(out2.map((l) => l.split(":")[0]), ["version", "name"]);

  assert.equal(problemCommand(["nope"], dir, () => {}), 1);
});
