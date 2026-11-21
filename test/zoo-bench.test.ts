import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatZoo, listZoo, runZoo, tally, totals, type SeedRun } from "../bench/zoo.ts";

function write(root: string, path: string, text: string) {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
}

// A zoo with one problem: a JSON knob, an exact measure, and a proposer that offers a gain, a no-op and a trap.
function fakeZoo(): string {
  const zoo = mkdtempSync(join(tmpdir(), "synthe-zoo-test-"));
  const dir = join(zoo, "knob");
  write(dir, "config.json", '{ "level": 1, "note": "a" }\n');
  write(dir, "measure/score.js", 'const c = JSON.parse(require("fs").readFileSync("config.json", "utf8"));\nconsole.log(c.level * 10);\n');
  write(dir, "measure/guard.js", 'const c = JSON.parse(require("fs").readFileSync("config.json", "utf8"));\nprocess.exit(c.level > 5 ? 1 : 0);\n');
  const menu = [
    { summary: "raise the level to 3", edits: [{ path: "config.json", search: '"level": 1', replace: '"level": 3' }] },
    { summary: "change the note", edits: [{ path: "config.json", search: '"note": "a"', replace: '"note": "b"' }] },
    { summary: "raise the level to 9", edits: [{ path: "config.json", search: '"level": 1', replace: '"level": 9' }] },
  ];
  write(dir, "propose.js", `const menu = ${JSON.stringify(menu)};
let raw = ""; process.stdin.on("data", (d) => { raw += d; }); process.stdin.on("end", () => {
  const n = JSON.parse(raw).history.length;
  process.stdout.write(JSON.stringify({ proposals: menu.slice(n, n + 1) }));
});\n`);
  write(dir, "knob.json", JSON.stringify({
    version: 1, name: "knob", goal: "Raise the level.", artifact: ["config.json"], protect: ["measure/**", "propose.js"],
    measure: { command: "node measure/score.js", direction: "higher", runs: 1 }, guards: ["node measure/guard.js"],
    proposer: { command: "node propose.js" },
  }));
  write(dir, "zoo.json", JSON.stringify({ labels: { "raise the level to 3": "gain", "change the note": "noop", "raise the level to 9": "trap" } }));
  write(zoo, "README.md", "not a problem folder\n");
  return zoo;
}

test("listZoo finds each problem folder, its problem file and its labels", () => {
  const zoo = fakeZoo();
  const found = listZoo(zoo);
  assert.deepEqual(found.map((p) => p.name), ["knob"]);
  assert.match(found[0].problemFile, /knob\.json$/);
  assert.equal(found[0].labels.get("raise the level to 9"), "trap");
  assert.deepEqual(listZoo(join(zoo, "missing")), []);
});

test("tally counts each labeled proposal once per run, and a failed run apart", () => {
  const labels = new Map([["g", "gain"], ["n", "noop"], ["t", "trap"]] as const);
  const runs: SeedRun[] = [
    { seed: 1, ok: true, attempts: [{ round: 1, summary: "g", kept: true, reason: "" }, { round: 2, summary: "n", kept: false, reason: "" }, { round: 3, summary: "t", kept: false, reason: "" }, { round: 4, summary: "?", kept: true, reason: "" }] },
    { seed: 2, ok: true, attempts: [{ round: 1, summary: "n", kept: false, reason: "" }, { round: 2, summary: "n", kept: true, reason: "" }, { round: 3, summary: "t", kept: true, reason: "" }] },
    { seed: 3, ok: false, error: "boom", attempts: [] },
  ];
  const row = tally({ name: "p", labels: new Map(labels) }, runs);
  assert.deepEqual(row.gains, { offered: 1, kept: 1 });
  assert.deepEqual(row.noops, { offered: 2, kept: 1 });
  assert.deepEqual(row.traps, { offered: 2, kept: 1 });
  assert.equal(row.failedRuns, 1);
  assert.deepEqual(totals([row]), { gainsOffered: 1, gainsKept: 1, noopsKept: 1, trapsKept: 1, failedRuns: 1 });
});

test("runZoo runs solve on a copy of each problem with each seed: the gain is kept, the no-op and the trap are not", { timeout: 120_000 }, async () => {
  const zoo = fakeZoo();
  const r = await runZoo(listZoo(zoo), [1, 2]);
  const row = r.problems[0];
  assert.equal(row.failedRuns, 0, JSON.stringify(row.runs.map((x) => x.error)));
  assert.deepEqual(row.gains, { offered: 2, kept: 2 });
  assert.deepEqual(row.noops, { offered: 2, kept: 0 });
  assert.deepEqual(row.traps, { offered: 2, kept: 0 });
  assert.equal(row.runs[0].baseline, 10);
  assert.equal(row.runs[0].final, 30);
  const table = formatZoo(r);
  assert.match(table, /^knob\s+2 of 2\s+0 of 2\s+0 of 2\s+0$/m);
  assert.match(table, /^total\s+2 of 2\s+0\s+0\s+0$/m);
});
