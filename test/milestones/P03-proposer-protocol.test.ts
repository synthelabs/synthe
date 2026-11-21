// P03: Synthe talks to an outside proposer command exactly as GOAL.md says: the stdin object, the stdout object,
// empty proposals stop the run, and bad JSON or a non-matching search becomes a failed attempt with a reason
// instead of a crash.
// How the check decides: scripted proposers log every stdin object to a file outside the repository and decide only
// from that stdin. The check reads the log (round, goal, files, history, candidates, the folder the proposer ran in),
// result.json and the result branch. Measures are deterministic, so a gain is always a gain.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  attempt, knobFixture, knobMeasure, makeRepo, near, randInt, readLog, readResult, runCli, showFile, solve, tag,
} from "./helpers-a.ts";

describe("P03 outside proposer protocol", { concurrency: true }, () => {
  test("stdin holds round, goal, artifact files, history and candidates; a two-file proposal is applied", async () => {
    const t = tag(), sub = `work-${t}`, level = randInt(10, 30), gain = randInt(3, 8);
    const knob = `level=${level}\n`, extra = `mode=${t}\nlevel=1\n`;
    const S1 = { summary: `raise both levels ${t}` };
    const repo = makeRepo({
      [`${sub}/knob.txt`]: knob,
      [`${sub}/extra.cfg`]: extra,
      [`${sub}/notes.md`]: "level=500\n",
      [`${sub}/tools/m.cjs`]: knobMeasure().replace('read("knob.txt"), "level")', 'read("knob.txt") + read("extra.cfg"), "level")'),
      "README.md": "# p03\n",
    }, "p03-stdin");
    const log = join(repo.base, "proposer.log");
    // The proposer edits the paths exactly as Synthe sends them in `files`.
    repo.write(`${sub}/propose.cjs`, `const fs = require("fs");
let raw = ""; process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  const here = fs.existsSync(${JSON.stringify(`${t}.json`)}) ? fs.readFileSync(${JSON.stringify(`${t}.json`)}, "utf8") : null;
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), raw, here }) + "\\n");
  const input = JSON.parse(raw);
  if (input.history.length) { process.stdout.write(JSON.stringify({ proposals: [] })); return; }
  const k = input.files.find((f) => f.path.endsWith("knob.txt")), e = input.files.find((f) => f.path.endsWith("extra.cfg"));
  process.stdout.write(JSON.stringify({ proposals: [{ summary: ${JSON.stringify(S1.summary)}, edits: [
    { path: k.path, search: "level=${level}", replace: "level=${level + gain}" },
    { path: e.path, search: "level=1", replace: "level=2" },
  ] }] }));
});
`);
    const problemFile = `${sub}/${t}.json`;
    const goal = `Raise the level of ${t}.`;
    const problemText = JSON.stringify({
      version: 1, name: `p03-stdin-${t}`, goal, artifact: ["knob.txt", "*.cfg"],
      // The measure finds its files from its own folder, so it works from the problem folder or the checkout root.
      measure: { command: `node -e "require(require('path').resolve(require('fs').existsSync('tools/m.cjs') ? 'tools/m.cjs' : '${sub}/tools/m.cjs'))"`, direction: "higher" },
      proposer: { command: "node propose.cjs" }, budget: { max_rounds: 10 },
    }, null, 2);
    repo.write(problemFile, problemText);
    repo.commit("Add the problem");
    const out = join(repo.base, "out");
    const r = await runCli(["solve", problemFile, "--out", out], { cwd: repo.dir, home: repo.home });
    assert.equal(r.code, 0, r.out);

    const calls = readLog(log);
    assert.equal(calls.length, 2, `the proposer ran twice: once with a proposal, once with nothing more\n${r.out}`);
    const [one, two] = calls.map((c) => c.input);
    assert.equal(one.round, 1);
    assert.equal(one.goal, goal);
    assert.ok(Number.isInteger(one.candidates) && one.candidates >= 1, "candidates is a whole number of at least 1");
    assert.deepEqual(one.history, [], "history is empty on the first call of a new problem");
    assert.equal(one.files.length, 2, `files holds exactly the artifact files\n${JSON.stringify(one.files.map((f: any) => f.path))}`);
    assert.equal(one.files.find((f: any) => f.path.endsWith("knob.txt"))?.text, knob);
    assert.equal(one.files.find((f: any) => f.path.endsWith("extra.cfg"))?.text, extra);
    const here = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).here);
    assert.ok(here.every((h) => h === problemText), "the proposer runs in the folder that holds the problem file");
    assert.equal(calls[0].cwd.split("/").pop(), sub);

    assert.equal(two.round, 2);
    assert.equal(two.files.find((f: any) => f.path.endsWith("knob.txt"))?.text, `level=${level + gain}\n`, "round 2 gets the kept version");
    assert.equal(two.files.find((f: any) => f.path.endsWith("extra.cfg"))?.text, `mode=${t}\nlevel=2\n`);
    assert.equal(two.history.length, 1);
    assert.equal(two.history[0].round, 1);
    assert.ok(String(two.history[0].summary).includes(S1.summary), "history gives the summary");
    assert.equal(two.history[0].kept, true, "history gives the kept flag");
    assert.ok(typeof two.history[0].reason === "string" && two.history[0].reason.trim(), "history gives a reason");

    const result = readResult(out);
    assert.equal(attempt(result, S1.summary).kept, true);
    assert.equal(showFile(repo, result.branch, `${sub}/knob.txt`), `level=${level + gain}\n`);
    assert.equal(showFile(repo, result.branch, `${sub}/extra.cfg`), `mode=${t}\nlevel=2\n`);
  });

  test("an empty proposals list stops the run at once", async () => {
    const f = knobFixture({ label: "p03-empty", level: randInt(3, 30), proposals: [] });
    const r = await solve(f);
    assert.equal(r.code, 0, r.out);
    assert.equal(readLog(f.log).length, 1, "the proposer is not asked again after an empty list");
    const result = readResult(f.out);
    assert.deepEqual(result.attempts, []);
    assert.ok(typeof result.stopped === "string" && result.stopped.trim(), "result.json gives the stop reason");
  });

  test("a reply that is not JSON is a failed attempt with a reason, and the run goes on", async () => {
    const level = randInt(10, 30), gain = randInt(2, 9), t = tag();
    const good = { summary: `raise the level ${t}`, edits: [{ path: "knob.txt", search: `level=${level}`, replace: `level=${level + gain}` }] };
    const f = knobFixture({
      label: "p03-badjson", level,
      // No history: reply with text that is not JSON. Then the good proposal, then nothing.
      proposerSource: (log) => `const fs = require("fs");
let raw = ""; process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), raw }) + "\\n");
  const h = JSON.parse(raw).history;
  if (h.length === 0) process.stdout.write("Sure! Here is my idea: {proposals: [raise it");
  else if (!h.some((a) => a.kept)) process.stdout.write(JSON.stringify({ proposals: [${JSON.stringify(good)}] }));
  else process.stdout.write(JSON.stringify({ proposals: [] }));
});
`,
    });
    const r = await solve(f);
    assert.equal(r.code, 0, r.out);
    const calls = readLog(f.log);
    assert.ok(calls.length >= 2, `the run went on after the bad reply\n${r.out}`);
    const first = calls[1].input.history[0];
    assert.equal(first.kept, false, "the bad reply is in the history as not kept");
    assert.ok(typeof first.reason === "string" && first.reason.trim(), "the bad reply has a reason");
    const result = readResult(f.out);
    assert.equal(attempt(result, good.summary).kept, true, "the good proposal after it is kept");
    near(result.final, level + gain, "final");
  });

  test("a search that does not match, or matches twice, is a failed attempt and changes nothing", async () => {
    const level = randInt(10, 30), gain = randInt(2, 9), t = tag();
    const files = { "knob.txt": `level=${level}\npad=${t}\npad=${t}\n` };
    const MISS = { summary: `edit a line that is not there ${t}`, edits: [{ path: "knob.txt", search: `level=${level + 1000}`, replace: "level=9999" }] };
    // If Synthe applied this to the first match, the score would rise by 50.
    const TWICE = { summary: `edit a line that is there twice ${t}`, edits: [{ path: "knob.txt", search: `pad=${t}`, replace: `pad=${t}\nlevel=50` }] };
    const GOOD = { summary: `raise the level ${t}`, edits: [{ path: "knob.txt", search: `level=${level}\n`, replace: `level=${level + gain}\n` }] };
    const f = knobFixture({ label: "p03-search", level, files, proposals: [MISS, TWICE, GOOD] });
    const r = await solve(f);
    assert.equal(r.code, 0, r.out);
    const result = readResult(f.out);
    for (const p of [MISS, TWICE]) {
      const a = attempt(result, p.summary);
      assert.equal(a.kept, false, `"${p.summary}" is not kept`);
      assert.ok(typeof a.reason === "string" && a.reason.trim(), `"${p.summary}" has a reason`);
    }
    const third = readLog(f.log)[2]?.input;
    assert.ok(third, "the proposer was asked a third time");
    for (const p of [MISS, TWICE]) {
      const h = third.history.find((x: any) => String(x.summary).includes(p.summary));
      assert.ok(h && h.kept === false && typeof h.reason === "string" && h.reason.trim(), `the history holds "${p.summary}" as failed, with a reason`);
    }
    assert.equal(attempt(result, GOOD.summary).kept, true);
    near(result.final, level + gain, "final");
    assert.equal(showFile(f.repo, result.branch, "knob.txt"), `level=${level + gain}\npad=${t}\npad=${t}\n`);
  });
});
