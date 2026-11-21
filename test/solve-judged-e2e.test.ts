import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const main = resolve("src/cli/main.ts");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

// A reply style file, a run command that answers each case in that style, and a judge that truly prefers answers
// that give a reason ("because") but, when both or neither do, picks the longer one: a judge with a length bias.
function repo(proposals: { summary: string; replace: string }[]): string {
  const top = realpathSync(mkdtempSync(join(tmpdir(), "solve-judged-")));
  git(top, "init", "-q", "-b", "main");
  git(top, "config", "user.name", "T");
  git(top, "config", "user.email", "t@example.com");
  writeFileSync(join(top, "style.txt"), "Answer.");
  writeFileSync(join(top, "cases.jsonl"), Array.from({ length: 8 }, (_, i) => JSON.stringify({ id: `q${i}`, input: `question ${i}` })).join("\n") + "\n");
  writeFileSync(join(top, "run.mjs"), `import {readFileSync} from "node:fs"; const c = JSON.parse(readFileSync(0, "utf8")); console.log(c.input + ": " + readFileSync("style.txt", "utf8"));`);
  writeFileSync(join(top, "judge.mjs"), `import {readFileSync} from "node:fs"; const q = JSON.parse(readFileSync(0, "utf8"));
const g = (s) => s.includes("because"); let w;
if (g(q.a) !== g(q.b)) w = g(q.a) ? "a" : "b"; else w = q.a.length === q.b.length ? "tie" : q.a.length > q.b.length ? "a" : "b";
console.log(JSON.stringify({ winner: w }));`);
  writeFileSync(join(top, "propose.mjs"), `import {readFileSync} from "node:fs"; const req = JSON.parse(readFileSync(0, "utf8"));
const list = ${JSON.stringify(proposals)}; const p = list[req.round - 1];
const text = req.files.find((f) => f.path === "style.txt").text;
console.log(JSON.stringify({ proposals: p ? [{ summary: p.summary, edits: [{ path: "style.txt", search: text, replace: p.replace }] }] : [] }));`);
  writeFileSync(join(top, "problem.json"), JSON.stringify({
    version: 1, name: "replies", goal: "Better replies.", artifact: ["style.txt"],
    measure: { judge: { cases: "cases.jsonl", run: "node run.mjs", compare: "node judge.mjs" } },
    proposer: { command: "node propose.mjs" }, budget: { max_rounds: 4 },
  }));
  git(top, "add", "-A");
  git(top, "commit", "-qm", "init");
  return top;
}

test("solve with a judged measure keeps a real gain and refuses a longer-only change", () => {
  const top = repo([
    { summary: "Pad the answer", replace: "Answer, with many more words that add nothing new at all." },
    { summary: "Give the reason", replace: "Answer, because of the rule." },
  ]);
  const out = join(top, "out");
  const r = spawnSync("node", [main, "solve", join(top, "problem.json"), "--out", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
  assert.equal(result.attempts.length, 2);
  const [pad, reason] = result.attempts;
  assert.equal(pad.kept, false);
  assert.match(pad.reason, /same length/);
  assert.equal(reason.kept, true, reason.reason);
  assert.equal(result.baseline, 0.5);
  assert.equal(result.final, 1);
  assert.equal(result.branch, "synthe/solve-replies-1");
  assert.equal(git(top, "show", "synthe/solve-replies-1:style.txt"), "Answer, because of the rule.");
  assert.equal(readFileSync(join(top, "style.txt"), "utf8"), "Answer.");
  assert.match(readFileSync(join(out, "report.md"), "utf8"), /Give the reason/);
});
