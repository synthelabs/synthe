import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
