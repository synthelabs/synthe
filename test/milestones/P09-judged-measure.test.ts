// P09 checks this statement from swarm/milestones.json: "With measure.judge, Synthe asks every comparison twice with
// a and b swapped, keeps a change the judge truly prefers, and refuses a change that wins only through the judge's
// position or length bias."
//
// How it decides: a problem with 32 cases and a scripted compare command with known biases, as bench/prompt/oracle.ts
// has. With chance 0.5 the judge picks reply a without reading. Else, when the lengths differ, with chance 0.35 it
// picks the longer reply. Else it picks the reply with the higher true quality, wrong with chance 0.02. The judge
// logs every question to a file outside the repository. The proposer offers three changes: a length trap (much
// longer, truly worse), a real gain (truly better), and a position trap (the same length, truly worse). The check
// requires that the real gain is kept, that both traps are refused, and that every question (case, x, y) in the log
// has its swapped twin (case, y, x) as often. A simulation of 20000 runs: with both orders and a one-sided sign test
// over cases at alpha 0.05, the real gain is kept in 99.99% and the length trap in 0.03%. A rule that asks once,
// with the change as reply a, keeps the length trap in about 55% of runs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes, randomInt } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ZOO, attemptsOf, gitRepo, isolatedEnv, readJson, synthe, tail, tempDir } from "./helpers-c.ts";

const NAMES = ["Ana", "Ben", "Cleo", "Dev", "Eli", "Fay", "Gia", "Hugo", "Ines", "Jon", "Kai", "Lena", "Milo", "Nora", "Omar", "Pia", "Quin", "Rae", "Sam", "Tess", "Uma", "Vic", "Wren", "Yara",
  "Abe", "Bea", "Cal", "Dot", "Ezra", "Flo", "Gus", "Hal"];

const RUN = `// Writes the reply to one case from template.txt. Reads the case on stdin.
const fs = require("fs");
const path = require("path");
const c = JSON.parse(fs.readFileSync(0, "utf8"));
const input = String(c.input);
const name = (input.match(/name=([^;]+)/) || [])[1] || "";
const ref = (input.match(/ref=([^;]+)/) || [])[1] || "";
const lines = fs.readFileSync(path.join(__dirname, "template.txt"), "utf8").split("\\n").map((l) => l.trim()).filter(Boolean);
console.log(lines.join(" ").split("{name}").join(name).split("{ref}").join(ref));
`;

// The judge. LOG and COUNTER are absolute paths outside the repository, set when the fixture is built.
const COMPARE = `// The scripted judge: position bias, then length bias, then true quality with a small error.
const fs = require("fs");
const crypto = require("crypto");
const LOG = __LOG__, COUNTER = __COUNTER__, SEED = __SEED__;
const POSITION = 0.5, LENGTH = 0.35, ERROR = 0.02, LONG = 90;
const q = JSON.parse(fs.readFileSync(0, "utf8"));
const input = String(q.case.input);
const name = (input.match(/name=([^;]+)/) || [])[1] || "";
const ref = (input.match(/ref=([^;]+)/) || [])[1] || "";
const a = String(q.a).trim(), b = String(q.b).trim();
const hash = (t) => crypto.createHash("sha256").update(t).digest("hex").slice(0, 16);
fs.appendFileSync(LOG, JSON.stringify({ id: q.case.id, a: hash(a), b: hash(b) }) + "\\n");
function quality(t) {
  let s = 0;
  if (name && t.includes(name)) s += 1;
  if (ref && t.includes(ref)) s += 1;
  if (/howdy/i.test(t)) s -= 1;
  if (t.length > LONG) s -= 1;
  return s;
}
let n = 0;
try { n = Number(fs.readFileSync(COUNTER, "utf8")) || 0; } catch {}
fs.writeFileSync(COUNTER, String(n + 1));
const draw = (label) => crypto.createHash("sha256").update(SEED + ":" + n + ":" + label).digest().readUInt32BE(0) / 4294967296;
let winner;
if (a === b) winner = "tie";
else if (draw("position") < POSITION) winner = "a";
else if (a.length !== b.length && draw("length") < LENGTH) winner = a.length > b.length ? "a" : "b";
else if (quality(a) === quality(b)) winner = "tie";
else {
  const right = quality(a) > quality(b) ? "a" : "b";
  winner = draw("error") < ERROR ? (right === "a" ? "b" : "a") : right;
}
console.log(JSON.stringify({ winner }));
`;

test("P09: a judged measure asks each question both ways, keeps a true gain and refuses bias-only wins", { timeout: 120_000 }, async () => {
  const work = tempDir("p09");
  const repo = join(work, "repo");
  const log = join(work, "judge-log.jsonl");
  const counter = join(work, "judge-counter");
  writeFileSync(log, "");
  const tag = randomBytes(2).toString("hex");
  const cases = NAMES.map((name, i) => ({ id: `q${tag}-${i + 1}`, input: `name=${name};ref=R-${randomInt(1000, 9999)}${i}` }));
  const filler = "We value you as a customer and we are always here to help with anything at all, on any day of the year.";
  const menu = [
    { summary: "add a warm closing sentence to every reply", edits: [{ path: "template.txt", search: "thanks for writing to us today.", replace: `thanks for writing to us today.\n${filler}` }] },
    { summary: "tell the customer their reference number", edits: [{ path: "template.txt", search: "thanks for writing to us today.", replace: "we have logged your reference {ref} for you today." }] },
    { summary: "use a friendlier greeting", edits: [{ path: "template.txt", search: "Hello {name},", replace: "Howdy {name}," }] },
  ];
  const problem = {
    version: 1, name: `judged-${tag}`,
    goal: "Make the replies to customers more useful.",
    artifact: ["template.txt"], protect: ["judge.cjs", "run.cjs", "cases.jsonl"],
    measure: { judge: { cases: "cases.jsonl", run: "node run.cjs", compare: "node judge.cjs" } },
    proposer: { command: "node propose.cjs" },
    budget: { max_rounds: 5, max_calls: 100 },
  };
  gitRepo(repo, {
    "problem.json": JSON.stringify(problem, null, 2) + "\n",
    "template.txt": "Hello {name},\nthanks for writing to us today.\n",
    "run.cjs": RUN,
    "judge.cjs": COMPARE.replace("__LOG__", JSON.stringify(log)).replace("__COUNTER__", JSON.stringify(counter)).replace("__SEED__", JSON.stringify(tag)),
    "cases.jsonl": cases.map((c) => JSON.stringify(c)).join("\n") + "\n",
    "menu.json": JSON.stringify(menu, null, 2) + "\n",
    "propose.cjs": readFileSync(join(ZOO, "reply-judge", "propose.cjs"), "utf8"),
  });

  const out = join(work, "out");
  const r = await synthe(["solve", join(repo, "problem.json"), "--seed", "1", "--out", out], { cwd: repo, env: isolatedEnv(join(work, "home")), timeoutMs: 110_000 });
  assert.equal(r.code, 0, `solve exited ${r.code}:\n${tail(r.stdout + r.stderr)}`);
  const attempts = attemptsOf(readJson(join(out, "result.json")));
  assert.ok(Array.isArray(attempts), `no attempts: ${attempts}`);
  const find = (s: string) => attempts.find((a) => a.summary === s);
  const [lengthTrap, real, positionTrap] = menu.map((m) => find(m.summary));
  assert.ok(real && lengthTrap && positionTrap, `solve did not try all three changes: ${JSON.stringify(attempts)}`);
  assert.equal(real.kept, true, `the change the judge truly prefers was not kept: ${JSON.stringify(real)}`);
  assert.notEqual(lengthTrap.kept, true, `a longer, worse reply was kept: it wins only through the judge's length bias: ${JSON.stringify(lengthTrap)}`);
  assert.notEqual(positionTrap.kept, true, `a worse reply was kept: it wins only through the judge's position bias: ${JSON.stringify(positionTrap)}`);

  const asked = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; a: string; b: string });
  assert.ok(asked.length > 0, "Synthe never ran the compare command");
  const count = new Map<string, number>();
  for (const q of asked) count.set(`${q.id}|${q.a}|${q.b}`, (count.get(`${q.id}|${q.a}|${q.b}`) ?? 0) + 1);
  for (const [k, n] of count) {
    const [id, a, b] = k.split("|");
    if (a === b) continue;
    assert.equal(count.get(`${id}|${b}|${a}`) ?? 0, n, `case ${id} was asked with one order of the two replies ${n} time(s), but not as often with a and b swapped`);
  }
  const ids = new Set(asked.map((q) => q.id));
  for (const c of cases) assert.ok(ids.has(c.id), `case ${c.id} was never compared`);
});
