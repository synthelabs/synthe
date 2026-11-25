// P04: `synthe solve` improves projects in other languages that have no package.json. The measure, the guards and
// the proposer are Python and shell. Each test runs the real CLI on a throwaway git repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { currentBranch, fileOn, projectRepo, solveIn, treeStatus } from "./solve-e2e-helpers.ts";

const SOLVER = `def grade(score):
    if score >= 90:
        return "A"
    if score >= 80:
        return "B"
    return "F"
`;

// Counts the grades the solver gets right. Five cases; the start gets A, B and F right: 3.
const SCORE_PY = `import sys
sys.path.insert(0, ".")
from solver import grade
cases = [(95, "A"), (85, "B"), (75, "C"), (65, "D"), (50, "F")]
print("correct:", sum(1 for s, want in cases if grade(s) == want))
`;

const TEST_PY = `import sys, unittest
sys.path.insert(0, ".")
from solver import grade

class GradeTest(unittest.TestCase):
    def test_every_score_has_a_letter(self):
        for s in range(0, 101):
            self.assertIsInstance(grade(s), str)

if __name__ == "__main__":
    unittest.main()
`;

// One proposal for each earlier attempt: a real gain, a loss, then a gain that breaks the guard. Then nothing more.
const PROPOSE_PY = `import json, sys
req = json.load(sys.stdin)
plan = [
    {"summary": "Add the C grade", "edits": [{"path": "solver.py", "search": '    return "F"', "replace": '    if score >= 70:\\n        return "C"\\n    return "F"'}]},
    {"summary": "Raise the A line to 99", "edits": [{"path": "solver.py", "search": "if score >= 90:", "replace": "if score >= 99:"}]},
    {"summary": "Add the D grade, and no grade for 0", "edits": [{"path": "solver.py", "search": '    return "F"', "replace": '    if score >= 60:\\n        return "D"\\n    if score == 0:\\n        return None\\n    return "F"'}]},
]
n = len(req["history"])
print(json.dumps({"proposals": plan[n:n + 1]}))
`;

test("solve improves a Python project with a Python measure, guard and proposer", { timeout: 240_000 }, () => {
  const dir = projectRepo({
    "solver.py": SOLVER,
    "measure/score.py": SCORE_PY,
    "tests/test_solver.py": TEST_PY,
    "propose.py": PROPOSE_PY,
    "grades.json": JSON.stringify({
      version: 1, name: "grades", goal: "Grade more scores correctly.",
      artifact: ["solver.py"], protect: ["measure/**", "tests/**"],
      measure: { command: "python3 measure/score.py", direction: "higher", unit: "cases", runs: 3 },
      guards: ["python3 -m unittest discover -s tests -q"],
      proposer: { command: "python3 propose.py" },
      budget: { max_rounds: 6 },
    }),
  });
  assert.equal(existsSync(join(dir, "package.json")), false);

  const run = solveIn(dir, "grades.json");
  assert.equal(run.code, 0, run.output);
  const r = run.result;
  assert.equal(r.problem, "grades");
  assert.equal(r.baseline, 3, run.output);
  assert.equal(r.final, 4, run.output);
  assert.deepEqual(r.attempts.map((a) => a.kept), [true, false, false], JSON.stringify(r.attempts, null, 2));
  assert.match(r.attempts[2].reason, /unittest|guard/i, "the guard failure names the guard");

  // The kept change is on the new branch; the person's branch and working tree are as they were.
  assert.ok(r.branch && /^synthe\/solve-grades-\d+$/.test(r.branch), String(r.branch));
  assert.match(fileOn(dir, r.branch, "solver.py"), /return "C"/);
  assert.doesNotMatch(fileOn(dir, r.branch, "solver.py"), /None/);
  assert.equal(currentBranch(dir), "main");
  assert.equal(readFileSync(join(dir, "solver.py"), "utf8"), SOLVER);
  assert.equal(treeStatus(dir), "");
  assert.match(run.report, /Add the C grade/);
});

const SLUGIFY = `#!/bin/sh
printf '%s\\n' "$1" | tr 'A-Z' 'a-z'
`;

// Prints how many cases are wrong; lower is better. The start gets only "ABC" right: 3 wrong.
const SCORE_SH = `#!/bin/sh
wrong=0
check() {
  if [ "$(sh slugify.sh "$1")" != "$2" ]; then wrong=$((wrong + 1)); fi
}
check "Hello World" hello-world
check "ABC" abc
check "a b c" a-b-c
check "Mixed Case Words" mixed-case-words
echo "wrong: $wrong"
`;

const CHECK_SH = `#!/bin/sh
out=$(sh slugify.sh "One Two")
[ -n "$out" ] || { echo "slugify printed nothing"; exit 1; }
[ "$(printf '%s\\n' "$out" | wc -l)" -eq 1 ] || { echo "slugify printed more than one line"; exit 1; }
`;

// A shell proposer: it offers the fix until the file has it, then says it has nothing more.
const PROPOSE_SH = `#!/bin/sh
input=$(cat)
if printf '%s' "$input" | grep -q "tr ' ' '-'"; then
  echo '{"proposals":[]}'
else
  cat proposal.json
fi
`;

test("solve improves a shell-script project in a subfolder, with a lower-is-better shell measure", { timeout: 240_000 }, () => {
  const dir = projectRepo({
    "README.txt": "A shell tool.\n",
    "tools/slugify.sh": SLUGIFY,
    "tools/measure/score.sh": SCORE_SH,
    "tools/tests/check.sh": CHECK_SH,
    "tools/propose.sh": PROPOSE_SH,
    "tools/proposal.json": JSON.stringify({ proposals: [{ summary: "Turn spaces into dashes", edits: [{ path: "slugify.sh", search: "tr 'A-Z' 'a-z'", replace: "tr 'A-Z' 'a-z' | tr ' ' '-'" }] }] }),
    "tools/slug.json": JSON.stringify({
      version: 1, name: "slug", goal: "Make slugify right for more inputs.",
      artifact: ["*.sh"], protect: ["measure/**", "tests/**", "propose.sh"],
      measure: { command: "sh measure/score.sh", direction: "lower", unit: "wrong cases" },
      guards: ["sh tests/check.sh"],
      proposer: { command: "sh propose.sh" },
    }),
  });
  assert.equal(existsSync(join(dir, "package.json")), false);

  const run = solveIn(dir, join("tools", "slug.json"));
  assert.equal(run.code, 0, run.output);
  const r = run.result;
  assert.equal(r.baseline, 3, run.output);
  assert.equal(r.final, 0, run.output);
  assert.equal(r.attempts.length, 1, JSON.stringify(r.attempts, null, 2));
  assert.equal(r.attempts[0].kept, true);
  assert.match(r.stopped, /nothing more|no more|empty/i);
  assert.ok(r.branch);
  assert.match(fileOn(dir, r.branch, "tools/slugify.sh"), /tr ' ' '-'/);
  assert.equal(readFileSync(join(dir, "tools/slugify.sh"), "utf8"), SLUGIFY);
  assert.equal(currentBranch(dir), "main");
  assert.equal(treeStatus(dir), "");
});

test("solve measures and keeps an artifact edit inside the guard folder", { timeout: 240_000 }, () => {
  const artifact = "src/components/score.txt";
  const dir = projectRepo({
    [artifact]: "3\n",
    "measure.cjs": 'console.log(Number(require("node:fs").readFileSync("src/components/score.txt", "utf8")));',
    "guard.cjs": 'if (Number(require("node:fs").readFileSync(process.argv[2] + "/score.txt", "utf8")) < 3) process.exit(1);',
    "propose.cjs": 'console.log(JSON.stringify({proposals: [{summary: "Raise the score", edits: [{path: "src/components/score.txt", search: "3", replace: "4"}]}]}));',
    "components.json": JSON.stringify({
      version: 1, name: "components", goal: "Raise the score.",
      artifact: ["src/components/*.txt"], guards: ["node guard.cjs src/components"],
      measure: { command: "node measure.cjs", direction: "higher", runs: 1 },
      proposer: { command: "node propose.cjs" }, budget: { max_rounds: 1 },
    }),
  });

  const run = solveIn(dir, "components.json");
  assert.equal(run.code, 0, run.output);
  assert.deepEqual(run.result.attempts.map(({ kept, before, after }) => ({ kept, before, after })),
    [{ kept: true, before: 3, after: 4 }], JSON.stringify(run.result.attempts));
  assert.ok(run.result.branch);
  assert.equal(fileOn(dir, run.result.branch, artifact), "4");
  assert.equal(readFileSync(join(dir, artifact), "utf8"), "3\n");
});

test("solve refuses a loader file and measures an added helper and an existing SymPy-style module", { timeout: 240_000 }, () => {
  const source = "sympy/liealgebras";
  const module = source + "/cartan_type.py";
  const helper = source + "/helpers.py";
  const candidates = [
    { summary: "Add test setup", edits: [{ path: source + "/conftest.py", search: "", replace: "# Setup\n" }] },
    { summary: "Add a helper", edits: [{ path: helper, search: "", replace: "SCORE = 1\n" }] },
    { summary: "Improve the module", edits: [{ path: module, search: "SCORE = 3", replace: "SCORE = 5" }] },
  ];
  const dir = projectRepo({
    [module]: "SCORE = 3\n",
    "score.cjs": `const fs = require("node:fs");
const base = fs.readFileSync(${JSON.stringify(module)}, "utf8");
const extra = fs.existsSync(${JSON.stringify(helper)}) ? fs.readFileSync(${JSON.stringify(helper)}, "utf8") : "";
console.log([...((base + extra).matchAll(/SCORE = ([0-9]+)/g))].reduce((total, m) => total + Number(m[1]), 0));
`,
    "propose.cjs": `const request = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
console.log(JSON.stringify({ proposals: ${JSON.stringify(candidates)}.slice(request.history.length, request.history.length + 1) }));
`,
    "problem.json": JSON.stringify({
      version: 1, name: "liealgebras", goal: "Improve a module and its helpers.",
      artifact: [source + "/*.py"], guards: ["pytest " + source],
      measure: { command: "node score.cjs", direction: "higher", runs: 1 },
      proposer: { command: "node propose.cjs" }, budget: { max_rounds: 3 },
    }),
  });

  const bin = mkdtempSync(join(tmpdir(), "synthe-fake-pytest-"));
  const pathBefore = process.env.PATH;
  writeFileSync(join(bin, "pytest"), '#!/bin/sh\ntest -f "$1/cartan_type.py"\n', { mode: 0o755 });
  process.env.PATH = [bin, pathBefore].join(delimiter);
  try {
    const { code, output, result } = solveIn(dir, "problem.json");
    assert.equal(code, 0, output);
    assert.deepEqual(result.attempts.map(({ kept, after }) => [kept, after]), [[false, undefined], [true, 4], [true, 6]], JSON.stringify(result.attempts));
    assert.match(result.attempts[0].reason, /sympy\/liealgebras\/conftest\.py is a file the test runner loads by itself/);
    assert.ok(result.branch);
    assert.equal(fileOn(dir, result.branch, module), "SCORE = 5");
    assert.equal(fileOn(dir, result.branch, helper), "SCORE = 1");
  } finally {
    if (pathBefore === undefined) delete process.env.PATH;
    else process.env.PATH = pathBefore;
    rmSync(bin, { recursive: true, force: true });
  }
});
