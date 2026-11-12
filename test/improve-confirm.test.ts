import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseImproveConfig, type ImproveConfig } from "../src/improve/config.ts";
import { shellExec } from "../src/improve/exec.ts";
import { runLoop } from "../src/improve/loop.ts";
import { measureAt } from "../src/improve/worktree.ts";
import type { Model } from "../src/model/client.ts";

// Picking the change that measured best also picks its lucky runs. A change is kept only if it still wins when measured
// again, and the fresh runs become the best. Here the metric is the number in value.js plus a scripted "luck" per
// measurement, counted in a file outside the repo (each measurement runs in a fresh checkout).
function app(luck: number[]) {
  const dir = mkdtempSync(join(tmpdir(), "synthe-confirm-"));
  const counter = join(mkdtempSync(join(tmpdir(), "synthe-luck-")), "n");
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env: gitEnv }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "value.js"), "module.exports = 10;\n");
  writeFileSync(join(dir, "metric.js"), `const fs = require("fs");\nconst f = ${JSON.stringify(counter)};\nconst n = fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0;\nfs.writeFileSync(f, String(n + 1));\nconst luck = ${JSON.stringify(luck)};\nconsole.log(require("./value.js") + (luck[n] ?? 0));\n`);
  git("add", ".");
  git("commit", "-qm", "app");
  return { dir, git, gitEnv };
}

function scripted(proposals: unknown[]): Model {
  let round = -1;
  return {
    async ask(a) {
      const picking = Boolean((a.schema as any)?.properties?.paths);
      if (picking) round++;
      return { text: JSON.stringify(picking ? { paths: ["value.js"], why: "the number" } : proposals[round] ?? { summary: "nothing more", edits: [] }), costUsd: 0.001 };
    },
  };
}

async function run(luck: number[], proposals: unknown[], rounds: number) {
  const { dir, git, gitEnv } = app(luck);
  const draft: ImproveConfig = {
    version: 1, goal: "Raise the number", guard: { command: null }, protect: [], mode: "review",
    metric: { preset: "custom", label: "score", unit: "points", command: "node metric.js", direction: "higher", runs: 1 },
    baseline: { commit: "x", median: 0, runs: [0], at: "" },
  };
  const measured = await measureAt(shellExec, dir, git("rev-parse", "HEAD"), draft);
  const config = parseImproveConfig(JSON.stringify({ ...draft, baseline: measured.measurement }));
  const said: string[] = [];
  const io = { say: (t: string) => said.push(t), exec: shellExec, run: async (cmd: string, args: string[], stdin?: string) => execFileSync(cmd, args, { cwd: dir, encoding: "utf8", input: stdin, env: gitEnv, stdio: ["pipe", "pipe", "pipe"] }) };
  const result = await runLoop(io, { top: dir, gitDir: join(dir, ".git"), config, model: scripted(proposals), rounds, budgetUsd: 1 });
  return { result, said, baseline: config.baseline.median };
}

const TIDY = { summary: "tidy the value file", edits: [{ path: "value.js", search: "module.exports = 10;", replace: "module.exports = 10; // the score" }] };
const RAISE = { summary: "raise the value to 12", edits: [{ path: "value.js", search: "module.exports = 10;", replace: "module.exports = 12;" }] };

test("a change that won only by luck is not kept when measured again", async () => {
  // Measurements in order: baseline, round 1 (lucky +5), round 1 again, round 2, round 2 again.
  const { result, said, baseline } = await run([0, 5, 0, 0, 0], [TIDY, RAISE], 2);
  assert.equal(baseline, 10);
  assert.equal(result.rounds[0].kept, false);
  assert.match(result.rounds[0].why, /^did not hold when measured again: not better/);
  assert.equal(result.rounds[0].value, 10, "the round shows the fresh measurement, not the lucky one");
  assert.ok(said.includes("Measuring round 1's change again to confirm it..."), said.join("\n"));
  // A real gain is confirmed and kept, and the best is the fresh measurement.
  assert.equal(result.rounds[1].kept, true);
  assert.equal(result.best.median, 12);
});

test("the confirmed measurement, not the lucky first one, becomes the best, so it can't block the next real gain", async () => {
  // Round 1 raises to 12 and measures 17 by luck, then 12 when measured again: kept at 12, not 17.
  // Round 2 raises to 13; against a stored lucky 17 it would lose; against the confirmed 12 it wins.
  const BUMP = { summary: "raise the value to 13", edits: [{ path: "value.js", search: "module.exports = 12;", replace: "module.exports = 13;" }] };
  const { result } = await run([0, 5, 0, 0, 0], [RAISE, BUMP], 2);
  assert.equal(result.rounds[0].kept, true);
  assert.equal(result.rounds[0].value, 12);
  assert.equal(result.rounds[1].kept, true, result.rounds[1].why);
  assert.equal(result.best.median, 13);
});

test("a confirmation that gives no number does not keep the change", async () => {
  // The second measurement prints "12x", which is not a number.
  const { result } = await run([0, 0, "x"] as unknown as number[], [RAISE], 1);
  assert.equal(result.rounds[0].kept, false);
  assert.match(result.rounds[0].why, /^did not hold when measured again: the metric gave no number \(The metric command printed no number\)$/);
  assert.equal(result.best.median, 10);
});
