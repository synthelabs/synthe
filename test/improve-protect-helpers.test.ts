import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parseImproveConfig } from "../src/improve/config.ts";
import { importsOf, metricOnlyFiles, protectedPathProblem } from "../src/improve/protect.ts";
import { config, custom } from "./improve-helpers.ts";

// A scoring helper only the metric imports decides the number as much as the metric script does, so it is protected.
// Product code the metric imports is also imported by the app or its tests, and stays editable.

test("importsOf finds relative JS/TS imports and Python imports that resolve to tracked files", () => {
  const tracked = new Set(["eval.js", "scoring.js", "lib/target.ts", "lib/index.js", "a.mjs", "pkg/eval.py", "pkg/helpers.py", "pkg/mod.py", "pkg/sub/__init__.py", "scoring_helpers.py", "target.py", "util.py", "src/core.py"]);
  const js = `const s = require("./scoring");\nimport t from "./lib/target";\nimport("./a.mjs");\nconst x = require("lodash");\nimport y from "../outside.js";\nconst i = require("./lib");\n`;
  assert.deepEqual(importsOf("eval.js", js, tracked).sort(), ["a.mjs", "lib/index.js", "lib/target.ts", "scoring.js"]);
  const py = "from scoring_helpers import score\nimport target, util as u\nimport os\nfrom core import thing\n";
  assert.deepEqual(importsOf("eval.py", py, tracked).sort(), ["scoring_helpers.py", "src/core.py", "target.py", "util.py"]);
  const rel = "from .helpers import h\nfrom . import mod\nfrom pkg.sub import y\n";
  assert.deepEqual(importsOf("pkg/eval.py", rel, tracked).sort(), ["pkg/helpers.py", "pkg/mod.py", "pkg/sub/__init__.py"]);
  // Two dots climb one package: pkg/sub/eval.py's "..helpers" is pkg/helpers.py, never a top-level helpers.py.
  assert.deepEqual(importsOf("pkg/sub/eval.py", "from ..helpers import h\n", new Set(["helpers.py", "pkg/helpers.py", "pkg/sub/eval.py"])), ["pkg/helpers.py"]);
  assert.deepEqual(importsOf("README.md", "import x from './scoring.js'", tracked), [], "only code files are read");
});

function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "synthe-helpers-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  for (const [path, text] of Object.entries(files)) { mkdirSync(join(dir, dirname(path)), { recursive: true }); writeFileSync(join(dir, path), text); }
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "app");
  return dir;
}

test("metricOnlyFiles protects a helper only the metric imports, not the product code it measures (JS)", () => {
  const dir = repo({
    "eval.js": `const score = require("./scoring");\nconst target = require("./target");\nconsole.log(score(target));\n`,
    "scoring.js": "module.exports = (t) => t.length;\n",
    "target.js": "module.exports = 'abc';\n",
    "app.js": "const target = require('./target');\n",
  });
  assert.deepEqual(metricOnlyFiles(dir, custom("node eval.js")), ["scoring.js"]);
});

test("metricOnlyFiles works for Python, counting tests as other importers", () => {
  const dir = repo({
    "eval.py": "from scoring_helpers import score\nimport target\nprint(score(target.run()))\n",
    "scoring_helpers.py": "def score(x):\n    return x\n",
    "target.py": "def run():\n    return 3\n",
    "tests/test_target.py": "import target\n",
  });
  assert.deepEqual(metricOnlyFiles(dir, custom("python eval.py")), ["scoring_helpers.py"]);
  // A guard script's own helpers count too.
  const withGuard = { ...config({ metric: { ...custom("python eval.py").metric } }), guard: { command: "python eval.py --check" } };
  assert.deepEqual(metricOnlyFiles(dir, withGuard), ["scoring_helpers.py"]);
  // Nothing to read: a command that names no code file, or a repo that is not a git checkout.
  assert.deepEqual(metricOnlyFiles(dir, custom("npm test")), []);
  assert.deepEqual(metricOnlyFiles(mkdtempSync(join(tmpdir(), "synthe-not-git-")), custom("python eval.py")), []);
});

test("a metric-only helper is refused like the metric script, and the saved list is validated", () => {
  const cfg = { ...custom("node eval.js"), metricOnly: ["scoring.js"] };
  assert.equal(protectedPathProblem("scoring.js", cfg), "scoring.js is imported by the metric or the regression check and by no other file, so it is part of how the number is measured; Synthe measures with it as it is.");
  assert.equal(protectedPathProblem("target.js", cfg), null);
  assert.deepEqual(parseImproveConfig(JSON.stringify(cfg)).metricOnly, ["scoring.js"]);
  assert.throws(() => parseImproveConfig(JSON.stringify({ ...cfg, metricOnly: ["../x.js"] })), /metricOnly paths must stay inside the repo/);
  assert.throws(() => parseImproveConfig(JSON.stringify({ ...cfg, metricOnly: [3] })), /metricOnly must be a list of paths/);
});
