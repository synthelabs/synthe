// P05: `synthe solve` improves artifacts that are not code: a JSON configuration (parameter tuning), a Markdown
// document scored by a script, and a CSV data file cleaned to raise a quality score.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { currentBranch, fileOn, projectRepo, solveIn, treeStatus } from "./solve-e2e-helpers.ts";

// A scripted proposer: one planned proposal for each earlier attempt, then an empty list.
const PROPOSE_PY = `import json, sys
req = json.load(sys.stdin)
plan = json.load(open("plan.json"))
n = len(req["history"])
print(json.dumps({"proposals": plan[n:n + 1]}))
`;

type Plan = { summary: string; edits: { path: string; search: string; replace: string }[] }[];

function problem(name: string, artifact: string[], measure: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1, name, goal: `Raise the ${name} score.`, artifact, protect: ["measure/**", "plan.json", "propose.py"],
    measure, proposer: { command: "python3 propose.py" }, budget: { max_rounds: 6 }, ...extra,
  });
}

function expectKept(dir: string, file: string, kept: boolean[]) {
  const run = solveIn(dir, file);
  assert.equal(run.code, 0, run.output);
  assert.deepEqual(run.result.attempts.map((a) => a.kept), kept, JSON.stringify(run.result, null, 2));
  assert.ok(run.result.branch, "kept changes go to a branch");
  assert.equal(currentBranch(dir), "main");
  assert.equal(treeStatus(dir), "");
  return run;
}

const CONFIG = JSON.stringify({ threshold: 0.2, window: 3, mode: "fast" }, null, 2) + "\n";

// A smooth score with its best at threshold 0.6 and window 5.
const TUNE_PY = `import json
c = json.load(open("config.json"))
print(round(100 - 100 * (c["threshold"] - 0.6) ** 2 - 3 * abs(c["window"] - 5), 4))
`;

test("solve tunes the parameters in a JSON configuration", { timeout: 240_000 }, () => {
  const plan: Plan = [
    { summary: "Raise the threshold to 0.6", edits: [{ path: "config.json", search: '"threshold": 0.2', replace: '"threshold": 0.6' }] },
    { summary: "Widen the window to 9", edits: [{ path: "config.json", search: '"window": 3', replace: '"window": 9' }] },
    { summary: "Widen the window to 5", edits: [{ path: "config.json", search: '"window": 3', replace: '"window": 5' }] },
  ];
  const dir = projectRepo({
    "config.json": CONFIG, "measure/tune.py": TUNE_PY, "plan.json": JSON.stringify(plan), "propose.py": PROPOSE_PY,
    "tune.json": problem("tune", ["config.json"], { command: "python3 measure/tune.py", direction: "higher", unit: "points" }),
  });
  const run = expectKept(dir, "tune.json", [true, false, true]);
  assert.equal(run.result.baseline, 78);
  assert.equal(run.result.final, 100);
  assert.deepEqual(JSON.parse(fileOn(dir, run.result.branch!, "config.json")), { threshold: 0.6, window: 5, mode: "fast" });
  assert.equal(readFileSync(join(dir, "config.json"), "utf8"), CONFIG);
});

const DOC = `# Widget

Widget turns lists into tables.

## Install

Run the installer.
`;

// Points for each section a reader needs, less one for each line longer than 80 characters.
const DOC_SH = `#!/bin/sh
score=0
for h in "## Install" "## Usage" "## Options" "## License"; do
  grep -qx "$h" README.md && score=$((score + 10))
done
long=$(awk 'length > 80' README.md | wc -l)
echo "score: $((score - long))"
`;

test("solve improves a Markdown document scored by a script", { timeout: 240_000 }, () => {
  const plan: Plan = [
    { summary: "Add a Usage section", edits: [{ path: "README.md", search: "Run the installer.\n", replace: "Run the installer.\n\n## Usage\n\nPipe a list into widget.\n" }] },
    { summary: "Reword the opening line", edits: [{ path: "README.md", search: "Widget turns lists into tables.", replace: "Widget makes tables from lists." }] },
    { summary: "Add a License section on one very long line", edits: [{ path: "README.md", search: "# Widget\n", replace: "# Widget\n\n## License\n\n" + "MIT ".repeat(40) + "\n" }] },
  ];
  const dir = projectRepo({
    "README.md": DOC, "measure/doc.sh": DOC_SH, "plan.json": JSON.stringify(plan), "propose.py": PROPOSE_PY,
    "doc.json": problem("doc", ["*.md"], { command: "sh measure/doc.sh", direction: "higher", unit: "points" }),
  });
  // The reword does not move the score, so it is not kept. The License section gains 10 and loses 1: kept.
  const run = expectKept(dir, "doc.json", [true, false, true]);
  assert.equal(run.result.baseline, 10);
  assert.equal(run.result.final, 29);
  const kept = fileOn(dir, run.result.branch!, "README.md");
  assert.match(kept, /^## Usage$/m);
  assert.match(kept, /^Widget turns lists into tables\.$/m);
  assert.equal(readFileSync(join(dir, "README.md"), "utf8"), DOC);
});

const DATA = `name,email,age
ann,ann@example.com,34
bob,bob-at-example,29
cy,cy@example.com,n/a
dee,dee@example.com,41
`;

// The percentage of rows with an email that has an @ and an age that is a whole number.
const QUALITY_PY = `import csv
rows = list(csv.DictReader(open("data/people.csv", newline="")))
good = sum(1 for r in rows if "@" in r["email"] and r["age"].isdigit())
print(f"quality: {100 * good / len(rows):.1f}")
`;

test("solve cleans a CSV data file to raise a quality score", { timeout: 240_000 }, () => {
  const plan: Plan = [
    { summary: "Fix bob's email", edits: [{ path: "data/people.csv", search: "bob-at-example", replace: "bob@example.com" }] },
    { summary: "Drop ann's row", edits: [{ path: "data/people.csv", search: "ann,ann@example.com,34\n", replace: "" }] },
    { summary: "Fill in cy's age", edits: [{ path: "data/people.csv", search: "cy@example.com,n/a", replace: "cy@example.com,27" }] },
  ];
  const dir = projectRepo({
    "data/people.csv": DATA, "measure/quality.py": QUALITY_PY, "plan.json": JSON.stringify(plan), "propose.py": PROPOSE_PY,
    "clean.json": problem("clean", ["data/*.csv"], { command: "python3 measure/quality.py", direction: "higher", unit: "%" }),
  });
  // Dropping a good row lowers the share of good rows (75% to 66.7%): refused.
  const run = expectKept(dir, "clean.json", [true, false, true]);
  assert.equal(run.result.baseline, 50);
  assert.equal(run.result.final, 100);
  const kept = fileOn(dir, run.result.branch!, "data/people.csv");
  assert.match(kept, /^ann,ann@example.com,34$/m);
  assert.match(kept, /^cy,cy@example.com,27$/m);
  assert.equal(readFileSync(join(dir, "data/people.csv"), "utf8"), DATA);
});
