// P10: A change that raises the score but makes a guard command fail is refused, and the reason names the guard.
// A guard that fails on the baseline stops setup with exit 1.
// How the check decides: run 1 has two guards. The proposer first offers a change that raises the score and breaks
// the second guard, then a change that raises the score and keeps both guards green. The first must be refused with
// a reason that names the second guard's script; the second must be kept. Run 2 has a guard that fails on the
// unchanged repository: solve must exit 1 before it asks the proposer for anything, and make no branch.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  assertTreeUnchanged, attempt, knobFixture, near, randInt, readLog, readResult, showFile, snapshot, solve, solveBranches, tag,
} from "./helpers-a.ts";

describe("P10 guards", { concurrency: true }, () => {
  test("a change that breaks a guard is refused and the reason names the guard", async () => {
    const t = tag(), level = randInt(10, 40), cheat = randInt(20, 40), gain = randInt(2, 8);
    const guard = `checks/sane-${t}.cjs`;
    const CHEAT = { summary: `raise the level with a shortcut ${t}`, edits: [{ path: "knob.txt", search: `level=${level}\n# notes`, replace: `level=${level + cheat}\n# notes\nSHORTCUT-${t}` }] };
    const GOOD = { summary: `raise the level honestly ${t}`, edits: [{ path: "knob.txt", search: `level=${level}`, replace: `level=${level + gain}` }] };
    const f = knobFixture({
      label: "p10-guard", level, proposals: [CHEAT, GOOD],
      files: { [guard]: `const fs = require("fs"); process.exit(fs.readFileSync("knob.txt", "utf8").includes("SHORTCUT") ? 3 : 0);\n` },
      problem: { guards: ['node -e "process.exit(0)"', `node ${guard}`] },
    });
    const before = snapshot(f.repo);
    const r = await solve(f);
    assert.equal(r.code, 0, r.out);
    assertTreeUnchanged(f.repo, before);
    const result = readResult(f.out);
    const c = attempt(result, CHEAT.summary);
    assert.equal(c.kept, false, "the change that breaks the guard is refused");
    assert.ok(typeof c.reason === "string" && c.reason.includes(`sane-${t}`), `the reason names the guard: ${JSON.stringify(c.reason)}`);
    assert.equal(attempt(result, GOOD.summary).kept, true, "the change that keeps the guards green is kept");
    near(result.final, level + gain, "final");
    assert.equal(showFile(f.repo, result.branch, "knob.txt"), `level=${level + gain}\n# notes\n`);
  });

  test("a guard that fails on the baseline stops setup with exit 1", async () => {
    const t = tag(), level = randInt(10, 40);
    const guard = `checks/strict-${t}.cjs`;
    const GOOD = { summary: `raise the level ${t}`, edits: [{ path: "knob.txt", search: `level=${level}`, replace: `level=${level + 5}` }] };
    const f = knobFixture({
      label: "p10-base", level, proposals: [GOOD],
      // Fails on the baseline. It would pass after GOOD, so only a check before the first round can catch it.
      files: { [guard]: `const fs = require("fs"); process.exit(fs.readFileSync("knob.txt", "utf8").includes("level=${level}\\n") ? 1 : 0);\n` },
      problem: { guards: [`node ${guard}`] },
    });
    const before = snapshot(f.repo);
    const r = await solve(f);
    assert.equal(r.code, 1, `exit 1 when a guard fails on the baseline\n${r.out}`);
    assert.equal(readLog(f.log).length, 0, "the proposer is never asked");
    assert.deepEqual(solveBranches(f.repo), [], "no branch is made");
    assertTreeUnchanged(f.repo, before);
  });
});
