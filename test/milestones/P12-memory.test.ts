// P12: a second `solve` run of the same problem sends the proposer the history of the first run, with each attempt's
// summary, kept flag and reason.
// How it decides: run 1 tries three changes in a temp git repo: one that raises an exact score (kept), one that lowers
// it (refused) and one whose search text does not match (failed). Between the runs the check adds one item to the
// proposer's menu. Run 2 uses the same problem file. The check passes when the first stdin of run 2 holds all three
// attempts of run 1 with the same kept flags as run 1's result.json and a reason for each. A different problem in the
// same repository must not get that history.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeRepo, problemFile, readProposerLog, rng, solve, word, workDir, write, writeMenuProposer, type Proposal } from "./helpers-b.ts";

test("a second solve run of the same problem gets the first run's history", async () => {
  const r = rng(`P12-${process.pid}-${Date.now()}`);
  const token = `${word(r)}${Math.floor(r() * 1000)}`;
  const work = workDir("p12");
  const repo = makeRepo(join(work, "repo"), {
    "list.txt": "alpha\nbeta\n",
    "other.txt": "one\n",
    "measure/count.sh": "#!/bin/sh\necho \"lines: $(grep -c . list.txt)\"\n",
    "measure/other.sh": "#!/bin/sh\necho \"lines: $(grep -c . other.txt)\"\n",
  });
  const menu: Proposal[] = [
    { summary: `add gamma (${token})`, edits: [{ path: "list.txt", search: "beta\n", replace: "beta\ngamma\n" }] },
    { summary: `remove alpha (${token})`, edits: [{ path: "list.txt", search: "alpha\n", replace: "" }] },
    { summary: `rename zeta (${token})`, edits: [{ path: "list.txt", search: "zeta\n", replace: "eta\n" }] },
  ];
  const menuPath = join(work, "menu.json");
  const logPath = join(work, "proposer.log");
  writeFileSync(menuPath, JSON.stringify(menu));
  const proposer = writeMenuProposer(join(work, "propose.mjs"), menuPath, logPath, false);
  const problem = (name: string, artifact: string, measure: string, command: string) => ({
    name, goal: "Make the list longer.", artifact: [artifact], protect: ["measure/**"],
    measure: { command: measure, direction: "higher", unit: "lines", runs: 1 },
    proposer: { command },
    budget: { max_rounds: 6 },
  });
  const name = `list-${word(r)}`;
  const file = problemFile(repo.dir, "list.problem.json", problem(name, "list.txt", "sh measure/count.sh", `node ${JSON.stringify(proposer)}`));
  repo.git("add", ".");
  repo.git("commit", "-qm", "Problem file");

  // Run 1.
  const first = (await solve(file, null)).result;
  for (const m of menu) assert.ok(first.attempts.some((a) => a.summary === m.summary), `run 1 has the attempt "${m.summary}"`);
  const run1Calls = readProposerLog(logPath).length;

  // Run 2 of the same problem, with one more item on the menu.
  const extra: Proposal = { summary: `add delta (${token})`, edits: [{ path: "list.txt", search: "alpha\n", replace: "alpha\ndelta\n" }] };
  writeFileSync(menuPath, JSON.stringify([...menu, extra]));
  await solve(file, null);
  const run2 = readProposerLog(logPath).slice(run1Calls);
  assert.ok(run2.length >= 1, "run 2 called the proposer");
  const history = run2[0].input.history;
  assert.ok(Array.isArray(history), "the proposer's stdin has a history list");
  for (const m of menu) {
    const was = first.attempts.find((a) => a.summary === m.summary)!;
    const h = history.find((x) => x.summary === m.summary);
    assert.ok(h, `run 2's first history holds run 1's attempt "${m.summary}". History: ${JSON.stringify(history).slice(0, 800)}`);
    assert.equal(h.kept, was.kept, `the kept flag of "${m.summary}" matches run 1`);
    assert.ok(typeof h.reason === "string" && h.reason.trim().length > 0, `the attempt "${m.summary}" has a reason in the history`);
  }
  assert.equal(history.find((x) => x.summary === menu[0].summary)?.kept, true, "the change that raised the score was kept in run 1");
  assert.equal(history.find((x) => x.summary === menu[1].summary)?.kept, false, "the change that lowered the score was refused in run 1");
  assert.equal(history.find((x) => x.summary === menu[2].summary)?.kept, false, "the change that did not apply failed in run 1");

  // A different problem in the same repository starts with no history from the first problem.
  const otherLog = join(work, "other.log");
  writeFileSync(join(work, "other-menu.json"), JSON.stringify([{ summary: "add two", edits: [{ path: "other.txt", search: "one\n", replace: "one\ntwo\n" }] }]));
  const otherProposer = writeMenuProposer(join(work, "other.mjs"), join(work, "other-menu.json"), otherLog, false);
  write(repo.dir, "other.problem.json", `${JSON.stringify({ version: 1, ...problem(`other-${word(r)}x`, "other.txt", "sh measure/other.sh", `node ${JSON.stringify(otherProposer)}`) }, null, 2)}\n`);
  repo.git("add", "other.problem.json");
  repo.git("commit", "-qm", "Second problem");
  await solve(join(repo.dir, "other.problem.json"), null);
  const other = readProposerLog(otherLog);
  assert.ok(other.length >= 1, "the other problem called the proposer");
  const leaked = other[0].input.history.filter((h) => h.summary.includes(token));
  assert.deepEqual(leaked, [], "a different problem does not get this problem's history");
});
