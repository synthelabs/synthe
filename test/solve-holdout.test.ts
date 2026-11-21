// P07: with split.holdout true, a change that wins on train only is refused, a change that wins on both splits is
// kept, and the proposer never receives a holdout number. End to end through the CLI on a temp git repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "src/cli/main.ts");

// Train cases are x = 1..5 and holdout cases are x = 11..15; the right answer is x + 3. A `memo:x=y` line answers
// one case by heart; otherwise the answer is x + offset. The holdout score is scaled to numbers that appear nowhere
// else, so a leak to the proposer is easy to see.
const MEASURE = `const fs = require("fs"), path = require("path");
const text = fs.readFileSync(path.join(__dirname, "..", "rule.txt"), "utf8");
const offset = Number((text.match(/^offset=(-?\\d+)/m) || [0, 0])[1]);
const memo = new Map([...text.matchAll(/^memo:(\\d+)=(\\d+)/gm)].map((m) => [Number(m[1]), Number(m[2])]));
const split = process.env.SYNTHE_SPLIT;
const xs = split === "holdout" ? [11, 12, 13, 14, 15] : [1, 2, 3, 4, 5];
const right = xs.filter((x) => (memo.has(x) ? memo.get(x) : x + offset) === x + 3).length;
console.log(split === "holdout" ? 4242 + 137 * right : right);
`;

const MEMORIZE = { summary: "answer the five known cases by heart", edits: [{ path: "rule.txt", search: "offset=0\n", replace: "offset=0\nmemo:1=4\nmemo:2=5\nmemo:3=6\nmemo:4=7\nmemo:5=8\n" }] };
const GENERAL = { summary: "add three to every input", edits: [{ path: "rule.txt", search: "offset=0", replace: "offset=3" }] };

function proposer(log: string): string {
  return `const fs = require("fs");
const PROPOSALS = ${JSON.stringify([MEMORIZE, GENERAL])};
let raw = ""; process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ raw, env: Object.keys(process.env).filter((k) => k.startsWith("SYNTHE_")) }) + "\\n");
  const seen = JSON.parse(raw).history.map((h) => h.summary);
  const next = PROPOSALS.find((p) => !seen.includes(p.summary));
  process.stdout.write(JSON.stringify({ proposals: next ? [next] : [] }));
});
`;
}

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "synthe-holdout-")));
  const dir = join(base, "repo"), home = join(base, "home"), log = join(base, "proposer.log"), out = join(base, "out");
  mkdirSync(join(dir, "measure"), { recursive: true });
  mkdirSync(home);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "team@example.com");
  git("config", "user.name", "Team");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "rule.txt"), "offset=0\n");
  writeFileSync(join(dir, "measure", "score.cjs"), MEASURE);
  writeFileSync(join(dir, "propose.cjs"), proposer(log));
  writeFileSync(join(dir, "problem.json"), JSON.stringify({
    version: 1, name: "holdout-check", goal: "Answer more cases right.", artifact: ["rule.txt"], protect: ["measure/**"],
    measure: { command: "node measure/score.cjs", direction: "higher", runs: 2 },
    split: { holdout: true }, proposer: { command: "node propose.cjs" }, budget: { max_rounds: 5 },
  }));
  git("add", "-A");
  git("commit", "-qm", "Start");
  return { dir, home, log, out, git };
}

test("holdout: a train-only change is refused, a change that wins on both is kept, no holdout number leaks", () => {
  const f = setup();
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SYNTHE_|ANTHROPIC_|OPENAI_)/.test(k)));
  const r = spawnSync(process.execPath, [CLI, "solve", "problem.json", "--out", f.out], { cwd: f.dir, env: { ...env, HOME: f.home }, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);

  const result = JSON.parse(readFileSync(join(f.out, "result.json"), "utf8"));
  const byName = (s: string) => result.attempts.find((a: { summary: string }) => a.summary === s);
  assert.equal(byName(MEMORIZE.summary)?.kept, false, "the memorizing change is refused");
  assert.match(byName(MEMORIZE.summary).reason, /held-back|holdout/i, "the reason says it failed on the held-back split");
  assert.equal(byName(GENERAL.summary)?.kept, true, "the general change is kept");
  assert.equal(result.baseline, 0);
  assert.equal(result.final, 5, "result.json reports train numbers");
  assert.equal(f.git("show", `${result.branch}:rule.txt`), "offset=3");

  const calls = readFileSync(f.log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(calls.length >= 3, "the proposer was asked after both attempts");
  // Holdout scores are 4242 + 137 * right: 4242 ... 4927.
  const holdoutNumbers = [0, 1, 2, 3, 4, 5].map((n) => String(4242 + 137 * n));
  for (const c of calls) {
    for (const n of holdoutNumbers) assert.ok(!c.raw.includes(n), `the proposer got the holdout number ${n}: ${c.raw}`);
    assert.deepEqual(c.env, [], "the proposer sees no SYNTHE_ variable, so no split name either");
  }
  // Nothing the proposer can read in the repository holds a holdout number either.
  const report = existsSync(join(f.out, "report.md")) ? readFileSync(join(f.out, "report.md"), "utf8") : "";
  for (const n of holdoutNumbers) assert.ok(!JSON.stringify(result).includes(n) && !report.includes(n), `result.json or report.md holds ${n}`);
});
