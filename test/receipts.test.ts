import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { CRIMSON_ACTION, renderWorkflow } from "../src/cli/init.ts";
import { renderCrimsonDiagnostics } from "../src/cli/workflows.ts";
import { deliverReceipt, finishReceipt } from "../src/core/receipts.ts";

const oidc = {
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://github.test/oidc?existing=1",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-token",
};
const beforeCutoff = () => Date.parse("2026-11-08T23:58:00Z");
const afterCutoff = () => Date.parse("2026-11-08T23:59:00Z");

function transport(replies: (() => Response)[]) {
  const bodies: unknown[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (url.host === "github.test") {
      assert.equal(url.searchParams.get("audience"), "synthe-receipts");
      assert.equal(url.searchParams.get("existing"), "1");
      assert.equal(headers.get("authorization"), "bearer runner-token");
      return Response.json({ value: "signed-oidc-token" });
    }
    assert.equal(url.href, "https://synthe-crimson.vercel.app/api/collect/receipt");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(headers.get("authorization"), "Bearer signed-oidc-token");
    assert.equal(headers.get("x-synthe-event"), "fixture-event");
    assert.equal(headers.get("x-synthe-team"), "fixture-team");
    bodies.push(JSON.parse(String(init?.body)));
    return replies[bodies.length - 1]();
  };
  return { bodies, fetcher };
}

test("preflight waits for an affirmative receipt, retries temporary errors, and sends no content", async () => {
  const { bodies, fetcher } = transport([
    () => new Response(null, { status: 409 }),
    () => Response.json({ ok: false }),
    () => Response.json({ ok: true }),
  ]);
  const waits: number[] = [];
  assert.equal(await deliverReceipt("receipt-start", "fixture-event", "fixture-team", {
    env: oidc, now: beforeCutoff, fetcher, sleep: async (ms) => { waits.push(ms); },
  }), true);
  assert.deepEqual(waits, [1000, 2000]);
  assert.deepEqual(bodies, [{ kind: "start" }, { kind: "start" }, { kind: "start" }]);
});

test("preflight fails closed for missing secrets, denials, and exhausted retries", async () => {
  const { bodies, fetcher } = transport([() => new Response("fixture-team", { status: 403 })]);
  const options = { env: oidc, now: beforeCutoff, fetcher, sleep: async () => {} };
  await assert.rejects(deliverReceipt("receipt-start", "fixture-event", "", options), /both repository secrets/);
  assert.equal(bodies.length, 0);
  await assert.rejects(deliverReceipt("receipt-start", "fixture-event", "fixture-team", options),
    (error: Error) => /refused this team/.test(error.message) && !error.message.includes("fixture-team"));
  assert.equal(bodies.length, 1);
  const failure = transport(Array.from({ length: 3 }, () => () => { throw new Error("credential-bearing transport error"); }));
  await assert.rejects(deliverReceipt("receipt-start", "fixture-event", "fixture-team", { ...options, fetcher: failure.fetcher }),
    (error: Error) => /three attempts/.test(error.message) && !error.message.includes("credential-bearing"));
  assert.equal(failure.bodies.length, 3);
  assert.equal(await deliverReceipt("receipt-start", "", "", { ...options, now: afterCutoff }), false);
  assert.equal(bodies.length, 1);
});

test("collector reports the exact same-repo source attempt even after the start cutoff", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "synthe-receipt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "event.json");
  const run = {
    id: 42141347867, run_attempt: 2, path: ".github/workflows/synthe.yml@main", status: "completed", conclusion: "cancelled",
    repository: { id: 42 }, head_repository: { id: 42 }, run_started_at: "2026-11-08T23:58:00Z",
  };
  const save = (updates: Partial<typeof run> = {}) =>
    writeFileSync(path, JSON.stringify({ action: "completed", repository: { id: 42 }, workflow_run: { ...run, ...updates } }));
  const expected = { kind: "finish", run_id: "42141347867", attempt: "2", conclusion: "cancelled" };
  save();
  assert.deepEqual(finishReceipt(path, "42"), expected);
  const { bodies, fetcher } = transport([() => Response.json({ ok: true })]);
  const env = { ...oidc, GITHUB_EVENT_NAME: "workflow_run", GITHUB_EVENT_PATH: path, GITHUB_REPOSITORY_ID: "42" };
  assert.equal(await deliverReceipt("receipt-finish", "fixture-event", "fixture-team", { env, fetcher, now: afterCutoff }), true);
  assert.deepEqual(bodies, [expected]);
  assert.equal(finishReceipt(path, "43"), null);
  for (const updates of [
    { head_repository: { id: 43 } }, { path: ".github/workflows/other/synthe.yml" }, { status: "in_progress" },
    { run_started_at: "2026-11-08T23:59:00Z" },
  ]) {
    save(updates);
    assert.equal(finishReceipt(path, "42"), null);
  }
  save({ run_attempt: 0 });
  assert.throws(() => finishReceipt(path, "42"), /run ID, attempt and conclusion/);
  save({ conclusion: "untrusted prose" });
  assert.throws(() => finishReceipt(path, "42"), /run ID, attempt and conclusion/);
});

test("event workflow gates write and reruns, while the completion workflow only sends metadata", () => {
  const template = readFileSync("templates/synthe.yml", "utf8");
  const standard = renderWorkflow(template, undefined, 17);
  const event = renderWorkflow(template, undefined, 17, true);
  assert.equal(renderWorkflow(template.replaceAll("\n", "\r\n"), undefined, 17, true), event);
  assert.doesNotMatch(standard, /receipt-start|__CRIMSON_/);
  const [write, score, decide] = event.split(/^  (?:write|score|decide):$/m).slice(1);
  for (const job of [write, score]) {
    assert.ok(job.indexOf("step: receipt-start") >= 0 && job.indexOf("step: receipt-start") < job.indexOf("actions/checkout"));
    assert.ok(job.includes(CRIMSON_ACTION));
  }
  assert.match(score, /if: github.run_attempt != '1'/);
  assert.match(decide, /needs.write.outputs.receipt == 'success'/);
  assert.match(decide, /if: github.run_attempt != '1'[\s\S]*step: receipt-start[\s\S]*actions\/download-artifact/);
  const collector = renderCrimsonDiagnostics(CRIMSON_ACTION);
  assert.match(collector, /workflows: \[Synthe\]\n    types: \[completed\]/);
  assert.ok(collector.includes(CRIMSON_ACTION));
  assert.match(collector, /permissions: \{ id-token: write \}/);
  assert.doesNotMatch(collector, /checkout|download-artifact|\brun:|ANTHROPIC/);
});

// GitHub never starts workflow_run workflows for runs started with GITHUB_TOKEN, so every chained round would
// otherwise look unfinished on the organizer dashboard. The workflow's last job reports its own outcome.
test("the workflow's last job reports its own finish; the proxy reads the run from the signed token", async () => {
  const env = { ...oidc, GITHUB_EVENT_NAME: "workflow_dispatch" };
  for (const conclusion of ["success", "failure", "cancelled"]) {
    const { bodies, fetcher } = transport([() => Response.json({ ok: true })]);
    assert.equal(await deliverReceipt("receipt-finish", "fixture-event", "fixture-team", { env, fetcher, now: afterCutoff, conclusion }), true);
    assert.deepEqual(bodies, [{ kind: "finish", conclusion }]);
  }
  const { bodies, fetcher } = transport([]);
  for (const conclusion of [undefined, "", "skipped", "untrusted prose"]) {
    await assert.rejects(deliverReceipt("receipt-finish", "fixture-event", "fixture-team", { env, fetcher, now: beforeCutoff, conclusion }),
      /couldn't tell how this run ended/);
  }
  // Rounds are capped at 40 minutes; a finish more than an hour after the event can't belong to an event run.
  const late = () => Date.parse("2026-11-09T00:59:00Z");
  assert.equal(await deliverReceipt("receipt-finish", "", "", { env, fetcher, now: late, conclusion: "success" }), false);
  assert.equal(bodies.length, 0);
});

test("event workflows end with a finish job that always runs after a started round and can't fail it", () => {
  const template = readFileSync("templates/synthe.yml", "utf8");
  assert.doesNotMatch(renderWorkflow(template, undefined, 17), /^  finish:$|receipt-finish/m);
  const event = renderWorkflow(template, undefined, 17, true);
  const finish = event.split(/^  finish:$/m)[1];
  assert.ok(finish, "event workflow has a finish job");
  assert.match(finish, /needs: \[write, score, decide\]/);
  assert.match(finish, /if: \$\{\{ always\(\) && needs\.write\.result != 'skipped' \}\}/);
  assert.match(finish, /continue-on-error: true/);
  assert.match(finish, /permissions: \{ id-token: write \}/);
  assert.match(finish, /step: receipt-finish/);
  assert.match(finish, /conclusion: \$\{\{ contains\(needs\.\*\.result, 'cancelled'\) && 'cancelled' \|\| contains\(needs\.\*\.result, 'failure'\) && 'failure' \|\| 'success' \}\}/);
  assert.ok(finish.includes(CRIMSON_ACTION));
  assert.doesNotMatch(finish, /checkout|download-artifact|\brun:|ANTHROPIC/);
});

test("the action passes the workflow's conclusion input to its own finish receipt", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "synthe-own-finish-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const preload = join(dir, "network.mjs"), sent = join(dir, "sent.json");
  writeFileSync(preload, `import { writeFileSync } from "node:fs";
Date.now = () => ${Date.parse("2026-11-07T00:00:00Z")};
globalThis.fetch = async (url, init) => {
  if (new URL(String(url)).host === "github.test") return Response.json({ value: "signed-oidc-token" });
  writeFileSync(${JSON.stringify(sent)}, String(init.body));
  return Response.json({ ok: true });
};`);
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, resolve("src/action.ts")], { cwd: dir, env: {
    PATH: process.env.PATH, ...oidc, GITHUB_EVENT_NAME: "workflow_dispatch",
    INPUT_STEP: "receipt-finish", INPUT_CONCLUSION: "failure", "INPUT_EVENT-CODE": "fixture-event", "INPUT_TEAM-CODE": "fixture-team",
  }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  assert.equal(await new Promise((done) => child.on("exit", done)), 0, log);
  assert.deepEqual(JSON.parse(readFileSync(sent, "utf8")), { kind: "finish", conclusion: "failure" });
});
