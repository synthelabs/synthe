import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { metricCheck } from "../src/cli/metric-check.ts";
import type { Exec } from "../src/improve/exec.ts";
import { removeQueryFiles } from "../src/metric/command.ts";

// Answers each day's query file with the same base arm: 300 events in 10,000 units.
function fakeExec(answer: string | null = JSON.stringify({ arms: { base: { units: 10000, events: 300 } } })) {
  const queries: { agent: string; from: string; to: string; arms: string[] }[] = [];
  const exec: Exec = async (_cwd, command) => {
    const path = /'([^']*query\.json)'$/.exec(command)?.[1];
    if (!path) throw new Error(`no query file in: ${command}`);
    queries.push(JSON.parse(readFileSync(path, "utf8")));
    if (answer === null) return { ok: false, stdout: "", stderr: "boom", ms: 1, timedOut: false };
    return { ok: true, stdout: `reading\n${answer}\n`, stderr: "", ms: 1, timedOut: false };
  };
  return { exec, queries };
}

const NOW = new Date("2026-11-13T10:00:00Z");
const ARGS = ["check", "--run", "node metric.js"];

test("metric check: 14 day lines, pooled rate, and a 20% lift row", async () => {
  const said: string[] = [];
  const { exec, queries } = fakeExec();
  const ok = await metricCheck({ say: (t) => said.push(t), exec }, "/tmp", ARGS, NOW);
  const out = said.join("\n");
  assert.equal(ok, true);
  assert.equal(queries.length, 14);
  assert.deepEqual(queries[0].arms, ["base"]);
  assert.equal(Date.parse(queries[0].from), Date.parse("2026-10-30T00:00:00Z"));
  assert.equal(Date.parse(queries[13].to), Date.parse("2026-11-13T00:00:00Z"));
  assert.equal(said.filter((l) => /^\d{4}-\d{2}-\d{2}/.test(l)).length, 14);
  assert.ok(out.includes("3.0%"));
  assert.ok(said.some((l) => l.includes("20% lift") && l.includes("7 days")));
});

test("metric check: a failing command prints the problem and returns false", async () => {
  const said: string[] = [];
  const { exec } = fakeExec(null);
  const ok = await metricCheck({ say: (t) => said.push(t), exec }, "/tmp", ARGS, NOW);
  assert.equal(ok, false);
  assert.ok(said.includes("The metric command failed (exit code not 0). Run it by hand to see the error."));
});

test("metric check: zero units on every day says there is no data", async () => {
  const said: string[] = [];
  const { exec } = fakeExec(JSON.stringify({ arms: { base: { units: 0, events: 0 } } }));
  const ok = await metricCheck({ say: (t) => said.push(t), exec }, "/tmp", ARGS, NOW);
  assert.equal(ok, false);
  assert.ok(said.includes("No data for this agent in the last 14 days. Check the command and the agent name."));
});

// Records what the interrupt hook was given, and counts how often the function it returns is called.
function interruptSpy() {
  const seen: { cleanup?: () => void; stops: number } = { stops: 0 };
  const onInterrupt = (cleanup: () => void) => {
    seen.cleanup = cleanup;
    return () => { seen.stops++; };
  };
  return { seen, onInterrupt };
}

test("metric check: the interrupt cleanup is removeQueryFiles, and the stop function runs once on a good run", async () => {
  const spy = interruptSpy();
  const ok = await metricCheck({ say: () => {}, exec: fakeExec().exec, onInterrupt: spy.onInterrupt }, "/tmp", ARGS, NOW);
  assert.equal(ok, true);
  assert.equal(spy.seen.cleanup, removeQueryFiles);
  assert.equal(spy.seen.stops, 1);
});

test("metric check: the stop function runs once on a failing run too", async () => {
  const spy = interruptSpy();
  const ok = await metricCheck({ say: () => {}, exec: fakeExec(null).exec, onInterrupt: spy.onInterrupt }, "/tmp", ARGS, NOW);
  assert.equal(ok, false);
  assert.equal(spy.seen.cleanup, removeQueryFiles);
  assert.equal(spy.seen.stops, 1);
});
