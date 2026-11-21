// P01: `problem check <file>` accepts every valid problem file in GOAL.md and refuses each invalid one with exit 1
// and one line that names the bad field.
// How the check decides: it writes valid problem files (the GOAL.md example, a minimal file, judged measures, a file
// in a subfolder) into a temp git repository. Each must exit 0 and print a summary that holds the problem's name.
// Then it writes files with one bad field each. Each must exit 1, and one output line must name that field.
// A file with two bad fields must give two different lines, one for each field.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { join } from "node:path";
import { makeRepo, runCli, tag } from "./helpers-a.ts";

const t = tag();
const repo = makeRepo({
  "src/app.py": "def answer():\n    return 41\n",
  "config.json": JSON.stringify({ rate: 0.5 }, null, 2) + "\n",
  [`measure/score-${t}.js`]: "console.log(7)\n",
  "cases.jsonl": '{"id":"c1","input":"hello"}\n{"id":"c2","input":"bye"}\n',
  "run.js": "process.stdin.pipe(process.stdout)\n",
  "judge.js": "process.stdout.write(JSON.stringify({ winner: 'tie' }))\n",
  "propose.js": "process.stdout.write(JSON.stringify({ proposals: [] }))\n",
  "sub/data.csv": "a,b\n1,2\n",
  "sub/score.js": "console.log(1)\n",
}, "p01");

const check = async (problem: unknown, file = `${tag()}.problem.json`) => {
  repo.write(file, typeof problem === "string" ? problem : JSON.stringify(problem, null, 2));
  return runCli(["problem", "check", file], { cwd: repo.dir, home: repo.home, timeoutMs: 20_000 });
};

const measure = { command: `node measure/score-${t}.js`, direction: "higher" };
const base = () => ({ version: 1, name: `base-${tag()}`, goal: "Make the answer right.", artifact: ["src/**/*.py"], measure: { ...measure } });

const VALID: [string, () => any, string?][] = [
  ["the GOAL.md example", () => ({
    version: 1, name: `full-${tag()}`, goal: "Raise the score.", artifact: ["src/**/*.py", "config.json"], protect: ["measure/**"],
    measure: { command: `node measure/score-${t}.js`, direction: "higher", unit: "points", runs: 3 },
    guards: ['node -e "process.exit(0)"'], split: { holdout: true }, proposer: { command: "node propose.js" },
    budget: { max_rounds: 6, max_calls: 200 },
  })],
  ["only the required fields, direction lower", () => ({
    version: 1, name: `min-${tag()}`, goal: "Lower the cost.", artifact: ["config.json"], measure: { command: `node measure/score-${t}.js`, direction: "lower" },
  })],
  ["a judged measure with an outside compare and a model proposer", () => ({
    version: 1, name: `judged-${tag()}`, goal: "Write better replies.", artifact: ["run.js"],
    measure: { judge: { cases: "cases.jsonl", run: "node run.js", compare: "node judge.js" } }, proposer: "model",
  })],
  ["a judged measure with compare model and a model endpoint", () => ({
    version: 1, name: `jmodel-${tag()}`, goal: "Write better replies.", artifact: ["run.js"],
    measure: { judge: { cases: "cases.jsonl", run: "node run.js", compare: "model" } },
    model: { base_url: "http://127.0.0.1:9/v1", model: "some-model" }, budget: { max_calls: 40 },
  })],
  ["runs, two guards and a budget with only max_rounds", () => ({
    ...base(), measure: { ...measure, runs: 5 }, guards: ['node -e "process.exit(0)"', `node measure/score-${t}.js`], budget: { max_rounds: 2 },
  })],
  ["a file in a subfolder, a name with capitals and digits", () => ({
    version: 1, name: `Csv-Clean-2-${tag()}`, goal: "Clean the data.", artifact: ["data.csv"], protect: ["score.js"],
    measure: { command: "node score.js", direction: "higher" }, split: { holdout: false },
  }), "sub"],
];

// [what is wrong, the problem, a pattern for the line that names the field]
const INVALID: [string, () => any, RegExp][] = [
  ["version 2", () => ({ ...base(), version: 2 }), /version/i],
  ["no version", () => { const p: any = base(); delete p.version; return p; }, /version/i],
  ["no name", () => { const p: any = base(); delete p.name; return p; }, /\bname\b/i],
  ["a name with a space and !", () => ({ ...base(), name: "bad name!" }), /\bname\b/i],
  ["a goal that is a number", () => ({ ...base(), goal: 42 }), /goal/i],
  ["no goal", () => { const p: any = base(); delete p.goal; return p; }, /goal/i],
  ["no artifact", () => { const p: any = base(); delete p.artifact; return p; }, /artifact/i],
  ["an artifact glob that is a number", () => ({ ...base(), artifact: [7] }), /artifact/i],
  ["no measure", () => { const p: any = base(); delete p.measure; return p; }, /measure/i],
  ["a measure with no command and no judge", () => ({ ...base(), measure: { runs: 3 } }), /measure|command|judge/i],
  ["a command with no direction", () => ({ ...base(), measure: { command: measure.command } }), /direction/i],
  ["direction up", () => ({ ...base(), measure: { ...measure, direction: "up" } }), /direction/i],
  ["runs that is a word", () => ({ ...base(), measure: { ...measure, runs: "three" } }), /\bruns\b/i],
  ["a guard that is a number", () => ({ ...base(), guards: [42] }), /guard/i],
  ["a proposer that is a number", () => ({ ...base(), proposer: 42 }), /proposer/i],
  ["a proposer object with no command", () => ({ ...base(), proposer: { cmd: "node propose.js" } }), /proposer/i],
  ["max_rounds that is a word", () => ({ ...base(), budget: { max_rounds: "six" } }), /max_rounds/i],
  ["a negative max_calls", () => ({ ...base(), budget: { max_calls: -5 } }), /max_calls/i],
  ["holdout that is a string", () => ({ ...base(), split: { holdout: "yes" } }), /holdout/i],
  ["a judge with no compare", () => ({ ...base(), measure: { judge: { cases: "cases.jsonl", run: "node run.js" } } }), /compare/i],
  ["a judge with no cases", () => ({ ...base(), measure: { judge: { run: "node run.js", compare: "node judge.js" } } }), /cases/i],
  ["a judge with no run", () => ({ ...base(), measure: { judge: { cases: "cases.jsonl", compare: "node judge.js" } } }), /\brun\b/i],
  ["a model base_url that is a number", () => ({ ...base(), proposer: "model", model: { base_url: 12, model: "m" } }), /base_url/i],
];

describe("P01 problem check", { concurrency: true }, () => {
  for (const [what, make, folder] of VALID) {
    test(`accepts ${what}`, async () => {
      const problem = make();
      const r = await check(problem, folder ? join(folder, `${tag()}.json`) : undefined);
      assert.equal(r.code, 0, `exit 0 for a valid file\n${r.out}`);
      assert.ok(r.out.includes(problem.name), `the summary names the problem "${problem.name}"\n${r.out}`);
    });
  }

  for (const [what, make, field] of INVALID) {
    test(`refuses ${what}`, async () => {
      const r = await check(make());
      assert.equal(r.code, 1, `exit 1 for ${what}\n${r.out}`);
      assert.ok(r.out.split("\n").some((l) => field.test(l)), `a line names the field (${field})\n${r.out}`);
    });
  }

  test("refuses a file with two bad fields, one line for each", async () => {
    const r = await check({ ...base(), version: 3, measure: { ...measure, direction: "sideways" } });
    assert.equal(r.code, 1, r.out);
    const lines = r.out.split("\n");
    const v = lines.findIndex((l) => /version/i.test(l) && !/direction/i.test(l));
    const d = lines.findIndex((l) => /direction/i.test(l) && !/version/i.test(l));
    assert.ok(v >= 0 && d >= 0 && v !== d, `one line names version and a different line names direction\n${r.out}`);
  });

  test("refuses a file that is not JSON", async () => {
    const r = await check("{ version: 1, name: ");
    assert.equal(r.code, 1, r.out);
    assert.ok(r.out.trim().length > 0, "it says what is wrong");
  });

  test("refuses a file that does not exist", async () => {
    const r = await runCli(["problem", "check", `missing-${tag()}.json`], { cwd: repo.dir, home: repo.home, timeoutMs: 20_000 });
    assert.equal(r.code, 1, r.out);
  });
});
