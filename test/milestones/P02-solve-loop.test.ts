// P02: `solve <file>` measures the baseline, runs rounds with the proposer, keeps a change only when the measure
// improves, commits kept changes to synthe/solve-<name>-<n>, leaves the working tree and current branch unchanged,
// and writes result.json and report.md as GOAL.md says.
// How the check decides: each fixture is a temp git repository with a deterministic measure (no noise) and a scripted
// proposer that offers a gain, a loss and a no-op, then nothing. The check reads result.json, report.md and the
// branch, and compares the working tree before and after. A second fixture uses direction "lower" and runs from a
// folder outside the repository. A third uses the default output folder and a branch name that is already taken.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  assertTreeUnchanged, attempt, knobFixture, memo, near, randInt, readReport, readResult, runCli, showFile, snapshot, solve, tag,
} from "./helpers-a.ts";

describe("P02 solve runs the loop", { concurrency: true }, () => {
  test("keeps only the gain, commits it to a new branch and reports every attempt", async () => {
    const level = randInt(10, 40), gain = randInt(3, 9), penalty = randInt(2, 6), t = tag();
    const G = { summary: `raise the level ${t}`, edits: [{ path: "knob.txt", search: `level=${level}`, replace: `level=${level + gain}` }] };
    const R = { summary: `add a penalty ${t}`, edits: [{ path: "other.txt", search: "penalty=0", replace: `penalty=${penalty}` }] };
    const N = { summary: `explain the knob ${t}`, edits: [{ path: "knob.txt", search: "# notes", replace: "# notes: the level sets the score" }] };
    const f = knobFixture({ label: "p02-loop", level, proposals: [G, R, N] });
    const before = snapshot(f.repo);
    const r = await solve(f);
    assert.equal(r.code, 0, `solve exits 0\n${r.out}`);
    assertTreeUnchanged(f.repo, before);

    const result = readResult(f.out);
    assert.equal(result.problem, f.name);
    assert.equal(typeof result.stopped, "string");
    assert.ok(result.stopped.trim().length > 0, "result.json gives a stop reason");
    near(result.baseline, level, "baseline");
    near(result.final, level + gain, "final");
    assert.equal(result.attempts.length, 3, `three attempts\n${JSON.stringify(result.attempts, null, 2)}`);
    assert.deepEqual(result.attempts.map((a: any) => a.round), [1, 2, 3], "attempts give their rounds in order");

    const g = attempt(result, G.summary), rr = attempt(result, R.summary), n = attempt(result, N.summary);
    assert.equal(g.kept, true, "the gain is kept");
    assert.equal(rr.kept, false, "the loss is not kept");
    assert.equal(n.kept, false, "the no-op is not kept");
    near(g.before, level, "the gain's before");
    near(g.after, level + gain, "the gain's after");
    near(rr.before, level + gain, "the loss's before (the kept version)");
    near(rr.after, level + gain - penalty, "the loss's after");
    near(n.after, level + gain, "the no-op's after");
    for (const a of result.attempts) assert.ok(typeof a.reason === "string" && a.reason.trim().length > 0, "each attempt has a reason");

    assert.match(result.branch, new RegExp(`^synthe/solve-${f.name}-\\d+$`), "the branch is synthe/solve-<name>-<n>");
    f.repo.git("merge-base", "--is-ancestor", before.head, result.branch);
    assert.equal(showFile(f.repo, result.branch, "knob.txt"), `level=${level + gain}\n# notes\n`, "the branch holds the gain and not the no-op");
    assert.equal(showFile(f.repo, result.branch, "other.txt"), "penalty=0\n", "the branch does not hold the loss");

    const report = readReport(f.out);
    for (const s of [G.summary, R.summary, N.summary]) assert.ok(report.includes(s), `report.md names the attempt "${s}"`);
    assert.match(report, /kept/i, "report.md says what was kept");
    assert.match(report, /not kept|refused|rejected|discarded|dropped/i, "report.md says what was not kept");
  });

  test("direction lower: keeps a decrease, refuses an increase, from any folder", async () => {
    const level = randInt(30, 60), step = randInt(4, 12), t = tag();
    const DOWN = { summary: `lower the cost ${t}`, edits: [{ path: "knob.txt", search: `level=${level}`, replace: `level=${level - step}` }] };
    const UP = { summary: `raise the cost ${t}`, edits: [{ path: "knob.txt", search: `level=${level - step}`, replace: `level=${level + step}` }] };
    const f = knobFixture({ label: "p02-lower", level, proposals: [DOWN, UP], direction: "lower" });
    const before = snapshot(f.repo);
    // The person runs solve from a folder outside the repository, with an absolute path to the problem file.
    const r = await runCli(["solve", join(f.repo.dir, f.problemFile), "--out", f.out], { cwd: f.repo.base, home: f.repo.home });
    assert.equal(r.code, 0, r.out);
    assertTreeUnchanged(f.repo, before);
    const result = readResult(f.out);
    near(result.baseline, level, "baseline");
    near(result.final, level - step, "final");
    assert.equal(attempt(result, DOWN.summary).kept, true, "the decrease is kept");
    assert.equal(attempt(result, UP.summary).kept, false, "the increase is not kept");
    assert.equal(showFile(f.repo, result.branch, "knob.txt"), `level=${level - step}\n# notes\n`);
  });

  const defaultOut = memo(async () => {
    const level = randInt(5, 25), gain = randInt(2, 7), t = tag();
    const G = { summary: `raise the level ${t}`, edits: [{ path: "knob.txt", search: `level=${level}`, replace: `level=${level + gain}` }] };
    const f = knobFixture({ label: "p02-default", level, proposals: [G] });
    // A branch from an earlier run already has the name with n = 1. Solve must make a new branch and leave it.
    f.repo.git("branch", `synthe/solve-${f.name}-1`);
    const taken = f.repo.git("rev-parse", `synthe/solve-${f.name}-1`);
    const before = snapshot(f.repo);
    const r = await runCli(["solve", f.problemFile], { cwd: f.repo.dir, home: f.repo.home });
    return { f, level, gain, taken, before, r };
  });

  test("writes result.json and report.md to .synthe/solve/<name>/ by default", async () => {
    const { f, level, gain, before, r } = await defaultOut();
    assert.equal(r.code, 0, r.out);
    assertTreeUnchanged(f.repo, before);
    const out = join(f.repo.dir, ".synthe/solve", f.name);
    assert.ok(existsSync(join(out, "report.md")), "report.md is in the default folder");
    const result = readResult(out);
    near(result.final, level + gain, "final");
  });

  test("makes a new branch when synthe/solve-<name>-1 already exists", async () => {
    const { f, level, gain, taken, r } = await defaultOut();
    assert.equal(r.code, 0, r.out);
    const result = readResult(join(f.repo.dir, ".synthe/solve", f.name));
    assert.match(result.branch, new RegExp(`^synthe/solve-${f.name}-\\d+$`));
    assert.notEqual(result.branch, `synthe/solve-${f.name}-1`, "the kept change goes to a new branch");
    assert.equal(f.repo.git("rev-parse", `synthe/solve-${f.name}-1`), taken, "the earlier branch did not move");
    assert.equal(showFile(f.repo, result.branch, "knob.txt"), `level=${level + gain}\n# notes\n`);
  });
});
