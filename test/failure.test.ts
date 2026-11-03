import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { renderWorkflow } from "../src/cli/init.ts";
import { runDecide } from "../src/loop/decide.ts";
import { failureOf, type Failure } from "../src/loop/failure.ts";
import { MemoryRepo, goal } from "./helpers.ts";

const BUSY: Failure = { step: "score", kind: "busy", message: "Anthropic's API is busy right now. Wait a few minutes and try again." };
const KEY: Failure = { step: "write", kind: "key", message: "Your Synthe key has no credit left. Ask the Synthe table for a new key." };
const failedRound = (error: Failure | null) => ({ candidates: null, scores: null, costUsd: null, error });

test("a model failure is sorted into busy (try next hour), key (needs a person) or other", () => {
  assert.equal(failureOf("score", { status: 529, message: "529 Overloaded" }).kind, "busy");
  assert.equal(failureOf("score", { status: 429, message: "429 rate_limit_error" }).kind, "busy");
  assert.equal(failureOf("write", { status: 500, message: "500 Internal server error" }).kind, "busy");
  assert.equal(failureOf("write", new Anthropic.APIConnectionError({ message: "fetch failed" })).kind, "busy");
  assert.equal(failureOf("write", { status: 401, message: "401 invalid x-api-key" }).kind, "key");
  assert.equal(failureOf("write", { status: 400, message: "400 Your credit balance is too low to access the Anthropic API." }).kind, "key");
  assert.equal(failureOf("write", { status: 400, message: "400 You have reached your specified workspace API usage limits." }).kind, "key");
  assert.equal(failureOf("write", { status: 403, message: "403 forbidden" }).kind, "key");
  assert.deepEqual(failureOf("score", new Error("candidates are missing\n    at main")), { step: "score", kind: "other", message: "candidates are missing" });
});

test("a failed write step saves why it failed for the decide step, and still exits 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "synthe-failure-"));
  const env = { ...process.env, INPUT_STEP: "write", GITHUB_REPOSITORY: "team/agent", GITHUB_API_URL: "http://127.0.0.1:9" };
  // No synthe.json here, so the step fails before any model or GitHub call.
  const run = spawnSync(process.execPath, [join(import.meta.dirname, "../src/action.ts")], { cwd: dir, env, encoding: "utf8" });
  assert.equal(run.status, 1);
  const saved = JSON.parse(readFileSync(join(dir, ".synthe-out/error.json"), "utf8")) as Failure;
  assert.equal(saved.step, "write");
  assert.equal(saved.kind, "other");
  assert.match(saved.message, /synthe\.json/);
});

test("a failed decide step writes no error file: only write and score failures are explained", () => {
  const dir = mkdtempSync(join(tmpdir(), "synthe-failure-"));
  const env = { ...process.env, INPUT_STEP: "decide", GITHUB_REPOSITORY: "team/agent", GITHUB_API_URL: "http://127.0.0.1:9" };
  const run = spawnSync(process.execPath, [join(import.meta.dirname, "../src/action.ts")], { cwd: dir, env, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.equal(existsSync(join(dir, ".synthe-out/error.json")), false);
});

test("a round Anthropic was too busy for is recorded as failed but doesn't count as a stall", async () => {
  const repo = new MemoryRepo("Old prompt.");
  const record = await runDecide(goal(), repo, failedRound(BUSY));
  assert.equal(record!.outcome, "failed");
  assert.equal(record!.failure, "busy");
  assert.equal(repo.state.stalls, 0);
  assert.match(record!.plain!, /Anthropic's API was busy/);
  assert.match(record!.plain!, /try again next hour/);
  assert.doesNotMatch(record!.plain!, /credit/);
});

test("three busy rounds in a row don't stop the run, and the report says it will try again", async () => {
  const repo = new MemoryRepo("Old prompt.");
  for (let i = 0; i < 3; i++) await runDecide(goal(), repo, failedRound(BUSY));
  assert.equal(repo.state.stopped, null);
  assert.equal(repo.state.round, 3);
  assert.equal(repo.state.stalls, 0);
  assert.match(repo.issue, /## Synthe is working on your prompt/);
  assert.match(repo.issue, /Anthropic's API was busy; Synthe tries again next hour/);
  assert.match(repo.issue, /- Nothing to do\. Anthropic's API was busy during the last round/);
  assert.doesNotMatch(repo.issue, /credit|Stopped/);
  // A busy hour between stalls doesn't reset them either: only a merge does.
  await runDecide(goal(), repo, failedRound(null));
  await runDecide(goal(), repo, failedRound(BUSY));
  assert.equal(repo.state.stalls, 1);
});

test("a key failure says what to do: get a new key and update the repo secret", async () => {
  const repo = new MemoryRepo("Old prompt.");
  const record = await runDecide(goal(), repo, failedRound(KEY));
  assert.equal(record!.failure, "key");
  assert.equal(repo.state.stalls, 1);
  assert.match(record!.plain!, /Your Synthe key has no credit left\. Get a new key from the Synthe table, then run `gh secret set SYNTHE_ANTHROPIC_KEY` in your repo/);
  assert.doesNotMatch(record!.plain!, /Ask the Synthe table/);
  assert.match(repo.issue, /## Synthe needs you to fix something/);
  assert.match(repo.issue, /Synthe tries again at the next hourly run/);
  assert.doesNotMatch(repo.issue, /Nothing to do/);
});

test("when the last rounds all failed, the headline names the cause instead of always blaming credit", async () => {
  const key = new MemoryRepo("Old prompt.");
  for (let i = 0; i < 3; i++) await runDecide(goal(), key, failedRound(KEY));
  assert.ok(key.state.stopped);
  assert.match(key.issue, /## Stopped: your Synthe key stopped working/);
  assert.match(key.issue, /gh secret set SYNTHE_ANTHROPIC_KEY.*Do this before you start Synthe again/);

  // Busy rounds don't stall, so a busy run only stops at its round limit, and nothing needs fixing.
  const busy = new MemoryRepo("Old prompt.");
  const short = goal();
  short.merge_rule = { ...short.merge_rule, max_rounds: 2 };
  for (let i = 0; i < 2; i++) await runDecide(short, busy, failedRound(BUSY));
  assert.equal(busy.state.stopped, "reached 2 rounds");
  assert.match(busy.issue, /## Stopped: the last rounds didn't finish because Anthropic's API was busy/);
  assert.match(busy.issue, /Nothing is wrong on your side\. Synthe stopped because it ran all 2 rounds/);
  assert.doesNotMatch(busy.issue, /credit|key stopped/);

  const unknown = new MemoryRepo("Old prompt.");
  for (let i = 0; i < 3; i++) await runDecide(goal(), unknown, failedRound({ step: "score", kind: "other", message: "boom" }));
  assert.match(unknown.issue, /## Stopped: the last rounds didn't finish\n\nLook at the latest run in the Actions tab for the error/);
});

test("each new workflow runs at a random minute of the hour, so teams don't all call Anthropic at once", () => {
  const template = readFileSync("templates/synthe.yml", "utf8");
  assert.match(template, /cron: "__MINUTE__ \* \* \* \*"/);
  assert.match(renderWorkflow(template, () => 0), /cron: "0 \* \* \* \*"/);
  assert.match(renderWorkflow(template, () => 0.5), /cron: "30 \* \* \* \*"/);
  assert.match(renderWorkflow(template, () => 0.9999999), /cron: "59 \* \* \* \*"/);
  assert.doesNotMatch(renderWorkflow(template), /__MINUTE__|__ACTION__/);
});

test("every job has a time limit, and write and score failures reach decide without clashing names", () => {
  const template = readFileSync("templates/synthe.yml", "utf8");
  const jobs = Object.fromEntries(template.split("\njobs:\n")[1].split(/\n(?=  \w+:\n)/).map((block) => [block.match(/^  (\w+):/)![1], block]));
  assert.deepEqual(Object.keys(jobs), ["write", "score", "decide"]);
  assert.match(jobs.write, /\n    timeout-minutes: 15\n/);
  assert.match(jobs.score, /\n    timeout-minutes: 15\n/);
  assert.match(jobs.decide, /\n    timeout-minutes: 10\n/);
  for (const [job, name] of [["write", "write-error"], ["score", "score-error"]]) {
    assert.match(jobs[job], new RegExp(`if: failure\\(\\)\\n        with: \\{ name: ${name}, path: \\.synthe-out/error\\.json`));
  }
  const names = [...template.matchAll(/name: ([\w-]+), path: \.synthe-out\//g)].map((m) => m[1]);
  assert.equal(new Set(names).size, names.length);
  // Decide downloads every artifact into .synthe-out, where action.ts loads error.json.
  assert.match(jobs.decide, /with: \{ path: \.synthe-out, merge-multiple: true \}/);
});
