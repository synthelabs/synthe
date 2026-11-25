// What a resumed run must carry over from the run it continues: the money already spent (budget.max_usd holds for
// the whole run) and, for a judged measure, the starting version's outputs (the final number compares with them).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const CLI = join(import.meta.dirname, "..", "src", "cli", "main.ts");
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

// Round 1 raises the level by 5. Round 2 hangs once, until the test kills solve; after that it has nothing more.
const PROPOSE = (side: string) => `const fs = require("fs");
const req = JSON.parse(fs.readFileSync(0, "utf8"));
const hang = ${JSON.stringify(join(side, "hung"))};
if (req.round === 2 && !fs.existsSync(hang)) { fs.writeFileSync(hang, String(process.pid)); setTimeout(() => {}, 120000); }
else if (req.round >= 2) process.stdout.write(JSON.stringify({ proposals: [] }));
else {
  const level = JSON.parse(req.files.find((f) => f.path === "config.json").text).level;
  process.stdout.write(JSON.stringify({ proposals: [{ summary: "raise", edits: [{ path: "config.json", search: '"level": ' + level, replace: '"level": ' + (level + 5) }] }] }));
}
`;

function setup(problem: Record<string, unknown>, extra: Record<string, string> = {}) {
  const base = mkdtempSync(join(tmpdir(), "synthe-carry-"));
  const repo = join(base, "repo"), side = join(base, "side");
  mkdirSync(join(repo, "p"), { recursive: true });
  mkdirSync(side);
  mkdirSync(join(base, "tmp"));
  const files: Record<string, string> = {
    "p/config.json": '{"level": 10}\n',
    "p/measure.js": 'console.log(JSON.parse(require("fs").readFileSync("config.json", "utf8")).level);\n',
    "p/propose.js": PROPOSE(side),
    "p/problem.json": JSON.stringify({ version: 1, name: "carry", goal: "Raise the level.", artifact: ["config.json"], proposer: { command: "node propose.js" }, ...problem }),
    ...extra,
  };
  for (const [p, text] of Object.entries(files)) writeFileSync(join(repo, p), text);
  git(repo, "init", "-q", "-b", "work");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return { base, repo, side, out: join(base, "out"), runFile: join(repo, ".git", "synthe", "solve", "carry", "run.json") };
}
type Setup = ReturnType<typeof setup>;

function solve(s: Setup, extra: string[] = []) {
  const child = spawn(process.execPath, [CLI, "solve", "p/problem.json", "--out", s.out, ...extra], { cwd: s.repo, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: join(s.base, "tmp") } });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  return { child, done: new Promise<{ code: number | null; out: string }>((r) => child.on("close", (code) => r({ code, out }))) };
}

async function killInRound2(s: Setup) {
  const run = solve(s);
  const hung = join(s.side, "hung");
  const end = Date.now() + 60_000;
  while (!existsSync(hung) || !readFileSync(hung, "utf8")) {
    if (Date.now() > end) throw new Error("the proposer never hung");
    await new Promise((r) => setTimeout(r, 50));
  }
  run.child.kill("SIGKILL");
  await run.done;
  try { process.kill(-Number(readFileSync(hung, "utf8")), "SIGKILL"); } catch { /* gone */ }
}

test("--resume keeps the money the earlier rounds spent: a run already over budget.max_usd stops at once", { skip: process.platform === "win32" }, async (t) => {
  const s = setup({
    measure: { command: "node measure.js", direction: "higher", runs: 1 },
    model: { provider: "anthropic", model: "m", prices: { input_per_mtok: 1, output_per_mtok: 1 } }, budget: { max_rounds: 6, max_usd: 2 },
  });
  t.after(() => rmSync(s.base, { recursive: true, force: true }));
  await killInRound2(s);
  // The killed process had spent $2.50 by its last finished round.
  const record = JSON.parse(readFileSync(s.runFile, "utf8"));
  record.cost = { calls: 7, input_tokens: 1000, output_tokens: 500, usd: 2.5 };
  writeFileSync(s.runFile, JSON.stringify(record));

  const r = await solve(s, ["--resume"]).done;
  assert.equal(r.code, 0, r.out);
  const res = JSON.parse(readFileSync(join(s.out, "result.json"), "utf8"));
  assert.match(res.stopped, /cost limit/, "the resumed run counts the $2.50 against max_usd 2");
  assert.equal(res.cost.usd, 2.5, "result.json counts the whole run");
  assert.equal(res.cost.calls, 7);
});

test("--resume of a judged run compares the final version with the starting outputs, not with the resume point", { skip: process.platform === "win32" }, async (t) => {
  const s = setup({
    measure: { judge: { cases: "cases.jsonl", run: "node run.js", compare: "node compare.js" } }, budget: { max_rounds: 6 },
  }, {
    "p/cases.jsonl": '{"id": "a", "input": 1}\n{"id": "b", "input": 2}\n{"id": "c", "input": 3}\n{"id": "d", "input": 4}\n{"id": "e", "input": 5}\n{"id": "f", "input": 6}\n',
    "p/run.js": 'const c = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(c.input * JSON.parse(require("fs").readFileSync("config.json", "utf8")).level);\n',
    "p/compare.js": 'const q = JSON.parse(require("fs").readFileSync(0, "utf8")); const a = Number(q.a), b = Number(q.b); console.log(JSON.stringify({ winner: a > b ? "a" : b > a ? "b" : "tie" }));\n',
  });
  t.after(() => rmSync(s.base, { recursive: true, force: true }));
  await killInRound2(s);
  const r = await solve(s, ["--resume"]).done;
  assert.equal(r.code, 0, r.out);
  const res = JSON.parse(readFileSync(join(s.out, "result.json"), "utf8"));
  assert.equal(res.branch, "synthe/solve-carry-1", "round 1's kept change is on the branch");
  assert.equal(res.final, 1, "the kept version wins every case against the start; 0.5 would mean it was judged against itself");
});
