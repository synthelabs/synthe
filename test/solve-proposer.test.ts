import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTHING_MORE, askProposer, parseProposerReply, type ProposerInput } from "../src/solve/proposer.ts";

const input: ProposerInput = {
  round: 2,
  goal: "Make the score higher.",
  files: [{ path: "config.json", text: "{\"a\": 1}\n" }],
  history: [{ round: 1, summary: "try a=2", kept: false, reason: "no gain" }],
  candidates: 1,
};

function script(body: string): { dir: string; command: string } {
  const dir = mkdtempSync(join(tmpdir(), "synthe-proposer-"));
  writeFileSync(join(dir, "propose.js"), body);
  return { dir, command: "node propose.js" };
}

test("the proposer gets the stdin object, runs in the problem folder, and its proposals come back", async () => {
  const { dir, command } = script(`
    const fs = require("node:fs");
    const stdin = fs.readFileSync(0, "utf8");
    fs.writeFileSync("seen.json", stdin);
    console.log(JSON.stringify({ proposals: [{ summary: "set a to 3", edits: [{ path: "config.json", search: "1", replace: "3" }] }] }));
  `);
  const reply = await askProposer(command, dir, input);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "seen.json"), "utf8")), input);
  assert.equal(reply.kind, "proposals");
  assert.ok(reply.kind === "proposals");
  assert.deepEqual(reply.items, [{ ok: true, proposal: { summary: "set a to 3", edits: [{ path: "config.json", search: "1", replace: "3" }] } }]);
});

test("history reaches the proposer with only round, summary, kept and reason: no scores", async () => {
  const { dir, command } = script(`require("node:fs").writeFileSync("seen.json", require("node:fs").readFileSync(0, "utf8")); console.log('{"proposals":[]}');`);
  const rich = { ...input, history: [{ round: 1, summary: "s", kept: true, reason: "r", before: 1, after: 2, holdout: 9 }] };
  await askProposer(command, dir, rich);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "seen.json"), "utf8")).history, [{ round: 1, summary: "s", kept: true, reason: "r" }]);
});

test("an empty proposals list means nothing more to try", async () => {
  const { dir, command } = script(`console.log(JSON.stringify({ proposals: [] }));`);
  assert.deepEqual(await askProposer(command, dir, input), { kind: "empty", reason: NOTHING_MORE });
});

test("bad JSON is a failed proposal with a reason, not a crash", async () => {
  const { dir, command } = script(`console.log("this is not json {");`);
  const reply = await askProposer(command, dir, input);
  assert.equal(reply.kind, "failed");
  assert.match(reply.kind === "failed" ? reply.reason : "", /not valid JSON/);
});

test("a non-zero exit, a timeout and a missing command each fail with a plain reason", async () => {
  const exit = script(`console.error("boom"); process.exit(3);`);
  const r1 = await askProposer(exit.command, exit.dir, input);
  assert.ok(r1.kind === "failed" && /code 3: boom/.test(r1.reason), JSON.stringify(r1));

  const slow = script(`setTimeout(() => {}, 60000);`);
  const r2 = await askProposer(slow.command, slow.dir, input, { timeoutMs: 300 });
  assert.ok(r2.kind === "failed" && /did not finish/.test(r2.reason), JSON.stringify(r2));

  const r3 = await askProposer("definitely-not-a-command-xyz", exit.dir, input);
  assert.ok(r3.kind === "failed" && /exited with code/.test(r3.reason), JSON.stringify(r3));
});

test("a proposer that ignores stdin and exits still gives a reply", async () => {
  const { dir, command } = script(`process.stdout.write('{"proposals":[]}');`);
  assert.equal((await askProposer(command, dir, { ...input, files: [{ path: "big", text: "x".repeat(2_000_000) }] })).kind, "empty");
});

test("log lines before the JSON answer are allowed", () => {
  const reply = parseProposerReply("thinking...\n{\"proposals\":[]}\n");
  assert.equal(reply.kind, "empty");
});

test("each malformed proposal fails alone with a reason; good ones in the same reply still count", () => {
  const reply = parseProposerReply(JSON.stringify({ proposals: [
    { summary: "good", edits: [{ path: "a", search: "x", replace: "y" }] },
    { summary: "no edits" },
    { summary: "bad edit", edits: [{ path: "a", search: "x" }] },
    { summary: "empty search", edits: [{ path: "a", search: "", replace: "y" }] },
    "just text",
  ] }));
  assert.ok(reply.kind === "proposals");
  assert.deepEqual(reply.items.map((i) => i.ok), [true, false, false, false, false]);
  const reasons = reply.items.flatMap((i) => (i.ok ? [] : [i.reason]));
  assert.match(reasons[0], /"edits"/);
  assert.match(reasons[1], /"replace"/);
  assert.match(reasons[2], /empty "search"/);
  assert.match(reasons[3], /not a JSON object/);
});

test("a reply that is JSON but not the right shape fails with a reason", () => {
  for (const out of ["[]", "42", "{\"proposal\": []}", ""]) {
    const reply = parseProposerReply(out);
    assert.equal(reply.kind, "failed", out);
  }
});
