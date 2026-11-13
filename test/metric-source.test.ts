import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import type { Exec, ExecResult } from "../src/improve/exec.ts";
import { commandSource } from "../src/metric/command.ts";
import { conformance, FAILED, TIMED_OUT } from "./metric-conformance.ts";

const CWD = "/work/team";
const RUN = "node metric.js";
const QUERY = { agent: "default", from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z", arms: ["base", "test"] };
const GOOD = { arms: { base: { units: 100, events: 3 }, test: { units: 98, events: 5 } } };

interface Seen { cwd?: string; command?: string; timeoutMs?: number; path?: string; dir?: string; query?: unknown }

// A fake Exec: it reads the query file while the command "runs", then answers with the reply.
function fakeExec(reply: unknown, seen: Seen = {}): Exec {
  return async (cwd, command, timeoutMs) => {
    seen.cwd = cwd;
    seen.command = command;
    seen.timeoutMs = timeoutMs;
    const path = /'([^']*)'$/.exec(command)?.[1];
    if (path) {
      seen.path = path;
      seen.dir = dirname(path);
      seen.query = JSON.parse(readFileSync(path, "utf8"));
    }
    return answer(reply);
  };
}

function answer(reply: unknown): ExecResult {
  if (reply === TIMED_OUT) return { ok: false, stdout: "", stderr: "", ms: 1, timedOut: true };
  if (reply === FAILED) return { ok: false, stdout: "", stderr: "boom", ms: 1, timedOut: false };
  const stdout = typeof reply === "string" ? reply : `${JSON.stringify(reply)}\n`;
  return { ok: true, stdout, stderr: "", ms: 1, timedOut: false };
}

conformance("command", (reply) => commandSource(fakeExec(reply), CWD, RUN));

test("command: text printed before the JSON line is ignored", async () => {
  const stdout = `Loading 100 rows...\nDone.\n${JSON.stringify(GOOD)}\n`;
  assert.deepEqual(await commandSource(fakeExec(stdout), CWD, RUN).read(QUERY), GOOD);
});

test("command: text printed after the JSON line is ignored", async () => {
  const stdout = `${JSON.stringify(GOOD)}\nthanks for waiting\n`;
  assert.deepEqual(await commandSource(fakeExec(stdout), CWD, RUN).read(QUERY), GOOD);
});

test("command: when several lines are JSON objects, the last one is the answer", async () => {
  const earlier = { arms: { base: { units: 1, events: 0 }, test: { units: 1, events: 0 } } };
  const stdout = `${JSON.stringify(earlier)}\n${JSON.stringify(GOOD)}\n`;
  assert.deepEqual(await commandSource(fakeExec(stdout), CWD, RUN).read(QUERY), GOOD);
});

test("command: a JSON null on its own line is not a result", async () => {
  const got = await commandSource(fakeExec("null\n[1]\n"), CWD, RUN).read(QUERY);
  assert.deepEqual(got, { problem: 'The metric command printed no JSON result. Print one line like {"arms":{"base":{"units":100,"events":3}}}.' });
});

test("command: the command ends with the quoted path of the query file, and the file holds the four query fields", async () => {
  const seen: Seen = {};
  await commandSource(fakeExec(GOOD, seen), CWD, RUN).read(QUERY);
  assert.ok(seen.command?.startsWith(`${RUN} '`), `command was ${seen.command}`);
  assert.match(seen.command!, /query\.json'$/);
  assert.equal(seen.cwd, CWD);
  assert.deepEqual(seen.query, QUERY);
});

test("command: the default time limit is 120000 ms, and a given one is passed through", async () => {
  const dflt: Seen = {};
  await commandSource(fakeExec(GOOD, dflt), CWD, RUN).read(QUERY);
  assert.equal(dflt.timeoutMs, 120000);
  const given: Seen = {};
  await commandSource(fakeExec(GOOD, given), CWD, RUN, 5000).read(QUERY);
  assert.equal(given.timeoutMs, 5000);
});

const cases: Array<[string, unknown]> = [
  ["good", GOOD],
  ["timed out", TIMED_OUT],
  ["failed", FAILED],
  ["no JSON", "nothing here\n"],
  ["missing arm", { arms: { base: { units: 100, events: 3 } } }],
];

for (const [label, reply] of cases) {
  test(`command: the temp folder and file are gone after a ${label} reply`, async () => {
    const seen: Seen = {};
    await commandSource(fakeExec(reply, seen), CWD, RUN).read(QUERY);
    assert.ok(seen.path && seen.dir, "the fake exec should have seen the query path");
    assert.equal(existsSync(seen.path), false);
    assert.equal(existsSync(seen.dir), false);
  });
}
