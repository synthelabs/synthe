import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandProposer, parseReply } from "../src/solve/proposer.ts";
import type { Problem, ProposerRequest } from "../src/solve/types.ts";

const request: ProposerRequest = {
  round: 2,
  goal: "Make the score higher.",
  files: [{ path: "config.json", text: "{\"a\": 1}\n" }],
  history: [{ round: 1, summary: "try a=2", kept: false, reason: "no gain" }],
  candidates: 1,
};

function problemWith(body: string): Problem {
  const dir = mkdtempSync(join(tmpdir(), "synthe-proposer-"));
  writeFileSync(join(dir, "propose.js"), body);
  return {
    version: 1, name: "p", goal: request.goal, artifact: ["config.json"], protect: [],
    measure: { command: "echo 1", direction: "higher", runs: 3 }, guards: [], split: { holdout: false },
    proposer: { command: "node propose.js" }, budget: { max_rounds: 6, max_calls: null }, candidates: 1,
    dir, file: join(dir, "problem.json"),
  };
}

const failed = (r: unknown) => (r && typeof r === "object" && "failed" in r ? String((r as { failed: string }).failed) : "");

test("the proposer gets the stdin object, runs in the problem folder, and its proposals come back", async () => {
  const p = problemWith(`
    const fs = require("node:fs");
    fs.writeFileSync("seen.json", fs.readFileSync(0, "utf8"));
    console.log(JSON.stringify({ proposals: [{ summary: "set a to 3", edits: [{ path: "config.json", search: "1", replace: "3" }] }] }));
  `);
  const { reply, calls } = await commandProposer(p).propose(request);
  assert.deepEqual(JSON.parse(readFileSync(join(p.dir, "seen.json"), "utf8")), request);
  assert.equal(calls, 0);
  assert.deepEqual(reply, { proposals: [{ summary: "set a to 3", edits: [{ path: "config.json", search: "1", replace: "3" }] }] });
});

test("history reaches the proposer with only round, summary, kept and reason: no scores", async () => {
  const p = problemWith(`require("node:fs").writeFileSync("seen.json", require("node:fs").readFileSync(0, "utf8")); console.log('{"proposals":[]}');`);
  const rich = { ...request, history: [{ round: 1, summary: "s", kept: true, reason: "r", before: 1, after: 2, holdout: 9 }] };
  await commandProposer(p).propose(rich);
  assert.deepEqual(JSON.parse(readFileSync(join(p.dir, "seen.json"), "utf8")).history, [{ round: 1, summary: "s", kept: true, reason: "r" }]);
});

test("an empty proposals list comes back as an empty list, so the loop can stop", async () => {
  const p = problemWith(`console.log(JSON.stringify({ proposals: [] }));`);
  assert.deepEqual((await commandProposer(p).propose(request)).reply, { proposals: [] });
});

test("bad JSON is a failed reply with a reason, not a crash", async () => {
  const p = problemWith(`console.log("this is not json {");`);
  assert.match(failed((await commandProposer(p).propose(request)).reply), /not valid JSON/);
});

test("a non-zero exit, a timeout and a missing command each fail with a plain reason", async () => {
  const exit = problemWith(`console.error("boom"); process.exit(3);`);
  assert.match(failed((await commandProposer(exit).propose(request)).reply), /exited with code 3: boom/);

  const slow = problemWith(`setTimeout(() => {}, 60000);`);
  assert.match(failed((await commandProposer(slow, { timeoutMs: 300 }).propose(request)).reply), /did not finish/);

  const missing = { ...exit, proposer: { command: "definitely-not-a-command-xyz" } };
  assert.match(failed((await commandProposer(missing).propose(request)).reply), /exited with code|could not start/);
});

test("a run function that throws still gives a failed reply", async () => {
  const p = problemWith("");
  const reply = (await commandProposer(p, { run: async () => { throw new Error("spawn EACCES"); } }).propose(request)).reply;
  assert.match(failed(reply), /could not start: spawn EACCES/);
});

test("a proposer that ignores a large stdin and exits still gives a reply", async () => {
  const p = problemWith(`process.stdout.write('{"proposals":[]}');`);
  const big = { ...request, files: [{ path: "big", text: "x".repeat(2_000_000) }] };
  assert.deepEqual((await commandProposer(p).propose(big)).reply, { proposals: [] });
});

test("log lines before the JSON answer are allowed", () => {
  assert.deepEqual(parseReply("thinking...\n{\"proposals\":[]}\n"), { proposals: [] });
});

test("a proposal with the wrong shape fails the reply with a reason that names it", () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ summary: "no edits" }, /proposal 2 has no "edits"/],
    [{ summary: "bad edit", edits: [{ path: "a", search: "x" }] }, /Edit 1 of the proposer's proposal 2 has no "replace"/],
    [{ summary: "empty search", edits: [{ path: "a", search: "", replace: "y" }] }, /empty "search"/],
    [{ summary: "no change", edits: [] }, /empty "edits"/],
    [{ edits: [{ path: "a", search: "x", replace: "y" }] }, /no "summary"/],
    ["just text", /proposal 2 is not a JSON object/],
  ];
  for (const [bad, reason] of cases) {
    const reply = parseReply(JSON.stringify({ proposals: [{ summary: "good", edits: [{ path: "a", search: "x", replace: "y" }] }, bad] }));
    assert.match(failed(reply), reason);
  }
});

test("a reply that is JSON but not the right shape fails with a reason", () => {
  for (const out of ["[]", "42", "{\"proposal\": []}", "", "null"]) assert.ok(failed(parseReply(out)), out);
});
