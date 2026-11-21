// P08: A proposal that edits a protect path, the measure command's files, or a file outside artifact is refused with
// a reason that names the path, and the file does not change.
// How the check decides: one solve run on a temp repository. The scripted proposer offers, in this order: an edit to a
// protect path inside artifact, an edit to the measure script (inside artifact too), a real gain, an edit to a file
// outside artifact, a proposal that mixes a real gain with a protected edit, a second real gain, and an edit to a
// file outside the repository through "../". Every bad edit would raise the score if Synthe applied it. The check
// reads result.json, the result branch, the working tree and the file outside the repository.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertTreeUnchanged, attempt, listProposer, makeRepo, near, randInt, readResult, runCli, showFile, snapshot, solveBranches, tag,
} from "./helpers-a.ts";

test("P08 refuses edits to protected, measure and outside paths, and names the path", async () => {
  const t = tag(), level = randInt(10, 40), g1 = randInt(2, 6), g2 = randInt(2, 6);
  const scorer = `scoring/score-${t}.js`;
  const locked = `cfg/locked-${t}.json`;
  const extra = `notes/extra-${t}.txt`;
  const repo = makeRepo({
    "cfg/main.json": `{"level": ${level}}\n`,
    [locked]: `{"bonus": 0}\n`,
    [extra]: "extra=0\n",
    [scorer]: `const fs = require("fs");
const main = JSON.parse(fs.readFileSync("cfg/main.json", "utf8"));
const locked = JSON.parse(fs.readFileSync(${JSON.stringify(locked)}, "utf8"));
const extra = Number(fs.readFileSync(${JSON.stringify(extra)}, "utf8").split("=")[1]);
const total = main.level + locked.bonus + extra;
console.log(total);
`,
  }, "p08");
  const outsideDir = join(repo.base, "outside");
  mkdirSync(outsideDir);
  const outsideFile = join(outsideDir, `secret-${t}.txt`);
  writeFileSync(outsideFile, "extra=0\n");

  const P = {
    protect: { summary: `raise the locked bonus ${t}`, edits: [{ path: locked, search: `"bonus": 0`, replace: `"bonus": 50` }] },
    measure: { summary: `count more in the scorer ${t}`, edits: [{ path: scorer, search: "console.log(total);", replace: "console.log(total + 100);" }] },
    gain1: { summary: `raise the level a little ${t}`, edits: [{ path: "cfg/main.json", search: `"level": ${level}`, replace: `"level": ${level + g1}` }] },
    outside: { summary: `add extra points ${t}`, edits: [{ path: extra, search: "extra=0", replace: "extra=40" }] },
    mixed: { summary: `raise the level and the bonus ${t}`, edits: [
      { path: "cfg/main.json", search: `"level": ${level + g1}`, replace: `"level": ${level + g1 + 30}` },
      { path: locked, search: `"bonus": 0`, replace: `"bonus": 9` },
    ] },
    gain2: { summary: `raise the level again ${t}`, edits: [{ path: "cfg/main.json", search: `"level": ${level + g1}`, replace: `"level": ${level + g1 + g2}` }] },
    escape: { summary: `edit a file next to the repository ${t}`, edits: [{ path: `../outside/secret-${t}.txt`, search: "extra=0", replace: "extra=77" }] },
  };
  const log = join(repo.base, "proposer.log");
  repo.write("propose.cjs", listProposer(log, Object.values(P)));
  const problemFile = `p08-${t}.json`;
  repo.write(problemFile, JSON.stringify({
    version: 1, name: `p08-${t}`, goal: "Raise the total.",
    artifact: ["cfg/*.json", "scoring/*.js"], protect: [locked],
    measure: { command: `node ${scorer}`, direction: "higher" },
    proposer: { command: "node propose.cjs" }, budget: { max_rounds: 20 },
  }, null, 2));
  repo.commit("Add the problem");
  const before = snapshot(repo);
  const out = join(repo.base, "out");
  const r = await runCli(["solve", problemFile, "--out", out], { cwd: repo.dir, home: repo.home });
  assert.equal(r.code, 0, r.out);
  assertTreeUnchanged(repo, before);
  assert.equal(readFileSync(outsideFile, "utf8"), "extra=0\n", "the file outside the repository did not change");

  const result = readResult(out);
  const refused: [keyof typeof P, string][] = [
    ["protect", locked], ["measure", scorer], ["outside", extra], ["mixed", locked], ["escape", `secret-${t}.txt`],
  ];
  for (const [k, path] of refused) {
    const a = attempt(result, P[k].summary);
    assert.equal(a.kept, false, `"${P[k].summary}" is refused`);
    assert.ok(typeof a.reason === "string" && a.reason.includes(path), `the reason names ${path}: ${JSON.stringify(a.reason)}`);
  }
  assert.equal(attempt(result, P.gain1.summary).kept, true, "a real gain is kept");
  assert.equal(attempt(result, P.gain2.summary).kept, true, "a real gain after a refused mix is kept");
  near(result.final, level + g1 + g2, "final");

  // No branch Synthe made holds a change to a refused file, or the gain half of the refused mix.
  const branches = solveBranches(repo);
  assert.ok(branches.includes(result.branch), "the result branch exists");
  for (const b of branches) {
    assert.equal(showFile(repo, b, locked), `{"bonus": 0}\n`, `${locked} did not change on ${b}`);
    assert.equal(showFile(repo, b, scorer), before.files.get(scorer), `${scorer} did not change on ${b}`);
    assert.equal(showFile(repo, b, extra), "extra=0\n", `${extra} did not change on ${b}`);
  }
  assert.equal(showFile(repo, result.branch, "cfg/main.json"), `{"level": ${level + g1 + g2}}\n`);
});
