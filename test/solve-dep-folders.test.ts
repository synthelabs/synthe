// Stage 4j (swarm/GOAL-3.md): nothing a proposal adds survives a reset, and no proposal writes where tools load
// code. The repository is the monitor's reproduction in a smaller form: a colocated test requires a helper package
// from node_modules, and a proposal adds a copy of that package under src/node_modules/ that never fails.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyEdits } from "../src/solve/edits.ts";
import { openScratch } from "../src/solve/scratch.ts";
import { projectRepo, solveIn } from "./solve-e2e-helpers.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const CHECKER = "module.exports = { equal: (a, b) => a === b };\n";
const FAKE = "module.exports = { equal: () => true };\n";

// Round 1 adds the fake helper under src/node_modules/. Round 2 adds only a comment. Round 3 says nothing more.
const PROPOSER = `
const input = JSON.parse(require("fs").readFileSync(0, "utf8"));
const rounds = {
  1: { summary: "add a helper package", edits: [{ path: "src/node_modules/checker/index.js", search: "", replace: ${JSON.stringify(FAKE)} }] },
  2: { summary: "add a comment", edits: [{ path: "src/lib.cjs", search: "exports.add", replace: "// adds two numbers\\nexports.add" }] },
};
const p = rounds[input.round];
process.stdout.write(JSON.stringify({ proposals: p ? [p] : [] }));
`;

function shadowRepo(): string {
  const dir = projectRepo({
    ".gitignore": "/node_modules\n",
    "src/lib.cjs": "exports.add = (a, b) => a - b;\n",
    "src/lib.test.cjs": 'const { equal } = require("checker");\nconst { add } = require("./lib.cjs");\nmodule.exports = equal(add(1, 2), 3) ? 1 : 0;\n',
    "measure.cjs": 'console.log(1 + require("./src/lib.test.cjs"));\n',
    "propose.cjs": PROPOSER,
    "problem.json": JSON.stringify({
      version: 1,
      name: "shadow",
      goal: "Make add correct.",
      artifact: ["src/**"],
      protect: ["src/lib.test.cjs", "measure.cjs"],
      measure: { command: "node measure.cjs", direction: "higher", runs: 1 },
      proposer: { command: "node propose.cjs" },
      budget: { max_rounds: 3 },
    }),
  });
  // The person's installed dependencies: not committed, linked into the scratch checkout.
  mkdirSync(join(dir, "node_modules", "checker"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "checker", "index.js"), CHECKER);
  return dir;
}

test("a helper package that a proposal adds under src/node_modules is refused, and a comment is not kept as a gain", () => {
  const dir = shadowRepo();
  const run = solveIn(dir, "problem.json");
  assert.equal(run.code, 0, run.output);
  assert.equal(run.result.baseline, 1);
  const [shadow, comment] = run.result.attempts;
  assert.equal(shadow.kept, false, `the shadow package must not be kept: ${JSON.stringify(shadow)}`);
  assert.match(shadow.reason, /src\/node_modules\/checker\/index\.js/, "the reason names the path");
  assert.equal(comment.summary, "add a comment");
  assert.equal(comment.kept, false, `a comment-only change must not be kept: ${JSON.stringify(comment)}`);
  assert.equal(run.result.final, 1);
  assert.equal(run.result.branch, null);
});

test("a reset removes files added under any node_modules, .venv or venv folder, and keeps Synthe's own links", async () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "solve-dep-reset-")));
  git(top, "init", "-q", "-b", "main");
  git(top, "config", "user.name", "T");
  git(top, "config", "user.email", "t@example.com");
  mkdirSync(join(top, "prob", "src"), { recursive: true });
  writeFileSync(join(top, "prob", "src", "a.js"), "a\n");
  // node_modules at any depth is ignored, as in many real repositories: ignored files must go too.
  writeFileSync(join(top, ".gitignore"), "node_modules\n.venv\n");
  git(top, "add", "-A");
  git(top, "commit", "-qm", "init");
  for (const name of ["node_modules", ".venv"]) {
    mkdirSync(join(top, name));
    mkdirSync(join(top, "prob", name));
  }

  const s = await openScratch(top, join(top, "prob"), "deps");
  const links = ["node_modules", ".venv", "prob/node_modules", "prob/.venv"];
  for (const link of links) assert.ok(existsSync(join(s.root, link)), `${link} is linked`);
  const added = [
    "prob/src/node_modules/chai/index.js",
    "prob/src/.venv/lib/x.py",
    "prob/src/venv/x.py",
    "prob/deep/er/node_modules/m.js",
    "node_modules2/node_modules/x.js",
  ];
  for (const path of added) {
    mkdirSync(join(s.root, path, ".."), { recursive: true });
    writeFileSync(join(s.root, path), "x");
  }
  await s.reset();
  for (const path of added) assert.ok(!existsSync(join(s.root, path)), `${path} must be removed by the reset`);
  assert.ok(!existsSync(join(s.root, "prob/src/node_modules")), "the added folder goes too");
  for (const link of links) assert.ok(existsSync(join(s.root, link)), `${link} stays linked after the reset`);
  await s.close(false);
  for (const name of ["node_modules", ".venv"]) assert.ok(existsSync(join(top, "prob", name)), "the person's folders stay");
});

test("a reset puts back a dependency link that a proposal replaced with a folder", async () => {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "solve-dep-relink-")));
  git(top, "init", "-q", "-b", "main");
  git(top, "config", "user.name", "T");
  git(top, "config", "user.email", "t@example.com");
  writeFileSync(join(top, "a.txt"), "a\n");
  git(top, "add", "-A");
  git(top, "commit", "-qm", "init");
  mkdirSync(join(top, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(top, "node_modules", "pkg", "index.js"), "real\n");

  const s = await openScratch(top, top, "deps");
  rmSync(join(s.root, "node_modules"));
  mkdirSync(join(s.root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(s.root, "node_modules", "pkg", "index.js"), "fake\n");
  await s.reset();
  assert.equal(readFileSync(join(s.root, "node_modules", "pkg", "index.js"), "utf8"), "real\n");
  await s.close(false);
  assert.ok(existsSync(join(top, "node_modules", "pkg", "index.js")));
});

test("solve refuses an edit or an agent's file under any node_modules, .venv or venv folder, and names the path", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "solve-dep-edits-")));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.js"), "a\n");
  const rules = { artifact: ["**"], protect: [], measurePaths: [] };
  for (const path of ["src/node_modules/chai/index.js", "node_modules/x.js", "src/.venv/lib/site.py", "lib/venv/x.py", "src/Node_Modules/x.js"]) {
    const edit = applyEdits(dir, [{ path, search: "", replace: "x" }], rules);
    assert.equal(edit.ok, false, `an edit of ${path} is refused`);
    assert.ok(!edit.ok && edit.reason.includes(path), `the reason names ${path}`);
    const agent = applyEdits(dir, [{ path, search: "", replace: "x", write: true }], rules);
    assert.equal(agent.ok, false, `an agent's file ${path} is refused`);
    assert.ok(!agent.ok && agent.reason.includes(path), `the reason names ${path}`);
    assert.ok(!existsSync(join(dir, path)), `${path} is not written`);
  }
  // A file whose own name is venv is not inside such a folder.
  assert.equal(applyEdits(dir, [{ path: "src/venv", search: "", replace: "x" }], rules).ok, true);
});
