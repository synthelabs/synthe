import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// P07: the proposer never sees holdout output or numbers, also when the held-back measure fails. The failure
// output used to go into the attempt's reason, and from there into the proposer's history.
const CLI = join(import.meta.dirname, "..", "src", "cli", "main.ts");
const SECRET = "HOLDOUT-SECRET-7319";

test("output from a failed held-back measure never reaches the proposer, result.json or report.md", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "synthe-holdout-leak-")));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
  mkdirSync(join(dir, "measure"));
  writeFileSync(join(dir, "list.txt"), "alpha\nbeta\n");
  // Train counts lines. Holdout counts lines too, but fails loudly with a secret once "gamma" is in the list.
  writeFileSync(join(dir, "measure/score.sh"), [
    "#!/bin/sh",
    "if [ \"$SYNTHE_SPLIT\" = holdout ] && grep -q gamma list.txt; then echo \"holdout case 3 expected 17 got 4 " + SECRET + "\"; echo \"" + SECRET + " on stderr\" >&2; exit 1; fi",
    "echo \"lines: $(grep -c . list.txt)\"",
    "",
  ].join("\n"));
  const log = join(dir, "..", `${dir.split("/").pop()}-proposer.log`);
  writeFileSync(join(dir, "propose.mjs"), [
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "const input = JSON.parse(readFileSync(0, 'utf8'));",
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify(input) + "\\n");`,
    "const menu = [",
    "  { summary: 'add gamma', edits: [{ path: 'list.txt', search: 'beta\\n', replace: 'beta\\ngamma\\n' }] },",
    "  { summary: 'add delta', edits: [{ path: 'list.txt', search: 'alpha\\n', replace: 'alpha\\ndelta\\n' }] },",
    "];",
    "const next = menu[input.round - 1];",
    "process.stdout.write(JSON.stringify({ proposals: next ? [next] : [] }));",
    "",
  ].join("\n"));
  writeFileSync(join(dir, "p.json"), JSON.stringify({
    version: 1, name: "leak", goal: "Make the list longer.", artifact: ["list.txt"], protect: ["measure/**", "propose.mjs"],
    measure: { command: "sh measure/score.sh", direction: "higher", runs: 1 }, split: { holdout: true },
    proposer: { command: "node propose.mjs" }, budget: { max_rounds: 3 },
  }));
  git("add", "."); git("commit", "-qm", "init");
  const out = join(dir, ".out");
  const res = await new Promise<{ code: number | null; text: string }>((done) => {
    const child = spawn(process.execPath, [CLI, "solve", join(dir, "p.json"), "--out", out], { cwd: dir });
    let text = "";
    child.stdout.on("data", (d) => (text += d)); child.stderr.on("data", (d) => (text += d));
    child.on("close", (code) => done({ code, text }));
  });
  assert.equal(res.code, 0, res.text);

  const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(calls.length >= 2, "the proposer was asked after the failed holdout");
  const later = JSON.stringify(calls.slice(1));
  assert.ok(later.includes("add gamma"), "round 2 has round 1 in its history");
  assert.ok(!later.includes(SECRET), `holdout output reached the proposer: ${later.slice(0, 600)}`);
  assert.ok(!/\b17\b/.test(JSON.stringify(calls.map((c) => c.history))), "no holdout number in the history");

  const result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
  const gamma = result.attempts.find((a: { summary: string }) => a.summary === "add gamma");
  assert.equal(gamma.kept, false);
  assert.match(gamma.reason, /held-back measure failed/);
  assert.ok(res.text.includes(SECRET), "the person still sees the details in Synthe's output");
  assert.ok(!JSON.stringify(result).includes(SECRET));
  assert.ok(!readFileSync(join(out, "report.md"), "utf8").includes(SECRET));
});
