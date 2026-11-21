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

test("solve with compare \"model\" asks the model judge and counts its calls against max_calls", async () => {
  const { createServer } = await import("node:http");
  let asked = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      asked++;
      const body = JSON.parse(raw);
      const user = body.messages.find((m: { role: string }) => m.role === "user").content;
      const q = JSON.parse(typeof user === "string" ? user : user.map((p: { text: string }) => p.text).join(""));
      const g = (s: string) => s.includes("because");
      const winner = g(q.a) === g(q.b) ? "tie" : g(q.a) ? "a" : "b";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ winner }) }, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as { port: number }).port;
    const top = repo([{ summary: "Give the reason", replace: "Answer, because of the rule." }]);
    const p = JSON.parse(readFileSync(join(top, "problem.json"), "utf8"));
    p.measure.judge.compare = "model";
    p.model = { base_url: `http://127.0.0.1:${port}/v1`, model: "fake-judge" };
    writeFileSync(join(top, "problem.json"), JSON.stringify(p));
    git(top, "commit", "-qam", "model judge");
    const out = join(top, "out");
    const env: NodeJS.ProcessEnv = { ...process.env, SYNTHE_API_KEY: "sk-test-judge" };
    const { spawn } = await import("node:child_process");
    const code = await new Promise<number | null>((done) => {
      const child = spawn("node", [main, "solve", join(top, "problem.json"), "--out", out], { env, stdio: "ignore" });
      child.on("close", done);
    });
    assert.equal(code, 0);
    const result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
    assert.equal(result.attempts[0].kept, true, result.attempts[0].reason);
    assert.ok(asked >= 16, `the model judge was asked ${asked} times`);

    // A budget smaller than one round of questions stops the run on max_calls.
    p.budget = { max_rounds: 4, max_calls: 5 };
    const top2 = repo([{ summary: "Give the reason", replace: "Answer, because of the rule." }, { summary: "Again", replace: "Answer, because." }]);
    writeFileSync(join(top2, "problem.json"), JSON.stringify(p));
    git(top2, "commit", "-qam", "model judge");
    const out2 = join(top2, "out");
    const before = asked;
    await new Promise<number | null>((done) => {
      const child = spawn("node", [main, "solve", join(top2, "problem.json"), "--out", out2], { env, stdio: "ignore" });
      child.on("close", done);
    });
    const r2 = JSON.parse(readFileSync(join(out2, "result.json"), "utf8"));
    assert.match(r2.stopped, /call limit/);
    assert.equal(r2.attempts.length, 1);
    assert.ok(asked - before <= 5, `the model judge was asked ${asked - before} times with max_calls 5`);
    assert.match(r2.attempts[0].reason, /call limit/);
  } finally {
    server.close();
  }
});
