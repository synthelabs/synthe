import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseGoal } from "../src/core/goal.ts";
import { FULL_SHARE_UNTIL, scrub, sharePayload, shareRound, stopCode } from "../src/core/share.ts";
import { newState, type RoundRecord } from "../src/core/state.ts";
import { renderReport } from "../src/loop/report.ts";
import { shouldShare } from "../src/core/share.ts";
import { goal } from "./helpers.ts";

const record: RoundRecord = {
  round: 2, at: "2026-11-03T00:00:00Z", outcome: "merged", reasons: [],
  checks: { before: 40, after: 70 }, costUsd: 0.05, title: "An edit",
  changed: "A better reply", edits: [{ find: "old", replace: "new" }],
  example: { input: "hi", before: "old reply", after: "new reply" },
};
const state = { ...newState(), round: 2, spendUsd: 0.1 };

test("share levels send only the chosen data", () => {
  const none = sharePayload(goal(), state, record, "1.6.2");
  assert.deepEqual(Object.keys(none).sort(), ["checksAfter", "checksBefore", "costUsd", "mode", "outcome", "round", "spentUsd", "stop", "version"]);
  const numbers = sharePayload(goal({ share: "numbers", objective: "PRIVATE GOAL", checks: ["PRIVATE CHECK"] }), state, record, "1.6.2");
  assert.equal("detail" in numbers, false);
  assert.ok(!JSON.stringify(numbers).includes("PRIVATE"));
  const detail = sharePayload(goal({ share: "detail", objective: "PRIVATE GOAL", checks: ["PRIVATE CHECK"] }), state, record, "1.6.2");
  assert.ok("detail" in detail);
  if (!detail.detail) throw new Error("detail missing");
  assert.deepEqual(detail.detail, { objective: "PRIVATE GOAL", checks: ["PRIVATE CHECK"], change: { title: "An edit", summary: "A better reply", edits: [{ find: "old", replace: "new" }] }, example: { input: "hi", before: "old reply", after: "new reply" } });
  assert.equal(parseGoal(JSON.stringify(goal())).share, undefined);
  assert.throws(() => parseGoal(JSON.stringify({ ...goal(), share: "all" })), /share must be none, numbers, detail or full/);
});

test("detail example satisfies the endpoint's parseDetail contract", () => {
  const payload = sharePayload(goal({ share: "detail" }), state, record, "1.6.2");
  assert.ok(payload.detail);
  const d = payload.detail!;
  // Mirrors synthe-share/lib/share.ts parseDetail limits without importing across repositories.
  assert.ok(typeof d.objective === "string" && d.objective.length <= 2000);
  assert.ok(Array.isArray(d.checks) && d.checks.length <= 5 && d.checks.every((c) => typeof c === "string" && c.length <= 300));
  assert.ok(d.change === null || (typeof d.change.title === "string" && d.change.title.length <= 120 && typeof d.change.summary === "string" && d.change.summary.length <= 1000 && d.change.edits.length >= 1 && d.change.edits.length <= 2 && d.change.edits.every((e) => typeof e.find === "string" && e.find.length <= 1500 && typeof e.replace === "string" && e.replace.length <= 1500)));
  assert.ok(d.example === null || ([d.example.input, d.example.before, d.example.after].every((v) => typeof v === "string" && v.length <= 2000)));
});

test("full shares capped and scrubbed text only before the cutoff; detail never does", () => {
  const before = new Date(Date.parse(FULL_SHARE_UNTIL) - 1);
  const after = new Date(FULL_SHARE_UNTIL);
  const text = "ana@example.com " + "x".repeat(120 * 1024);
  const full = { prompt: text, scenarios: text, finalPrompt: text };
  const active = sharePayload(goal({ share: "full" }), state, record, "1.6.2", full, before);
  assert.ok("full" in active);
  if (!("full" in active) || !active.full) throw new Error("full missing");
  assert.deepEqual(Object.keys(active.full), ["prompt", "scenarios", "finalPrompt"]);
  assert.ok(Object.values(active.full).every((v) => Buffer.byteLength(v) <= 100 * 1024 && !v.includes("ana@example.com")));
  assert.ok(Buffer.byteLength(JSON.stringify(active)) <= 256 * 1024);
  assert.equal("full" in sharePayload(goal({ share: "full" }), state, record, "1.6.2", full, after), false);
  assert.equal("full" in sharePayload(goal({ share: "detail" }), state, record, "1.6.2", full, before), false);
});

test("an existing install without share sends nothing", () => {
  const existing = parseGoal(JSON.stringify(goal()));
  assert.equal(existing.share, undefined);
  assert.equal(shouldShare(existing), false);
});

test("detail scrubs every text field and stays inside endpoint limits", () => {
  const key = "sk-ant-" + "A".repeat(20);
  const email = "person@example.com";
  const phone = "303-555-1212";
  const jwt = "eyJ" + "A".repeat(12) + ".eyJ" + "B".repeat(12) + ".eyJ" + "C".repeat(12);
  const sensitive = `${key} ${email} ${phone} ${jwt} ${"x".repeat(2100)}`;
  const long = { ...record, title: sensitive, changed: sensitive, edits: [{ find: sensitive, replace: sensitive }, { find: sensitive, replace: sensitive }, { find: "third", replace: "third" }], example: { input: sensitive, before: sensitive, after: sensitive } };
  const payload = sharePayload(goal({ share: "detail", objective: sensitive, checks: Array(6).fill(sensitive) }), state, long, "1.6.2");
  assert.ok("detail" in payload);
  if (!payload.detail) throw new Error("detail missing");
  assert.equal(payload.detail.objective.length, 2000);
  assert.equal(payload.detail.checks.length, 5);
  assert.ok(payload.detail.checks.every((c) => c.length <= 300));
  assert.ok(payload.detail.change && payload.detail.change.title.length <= 120 && payload.detail.change.summary.length <= 1000);
  assert.equal(payload.detail.change?.edits.length, 2);
  assert.ok(payload.detail.change?.edits.every((e) => e.find.length <= 1500 && e.replace.length <= 1500));
  assert.ok(payload.detail.example && Object.values(payload.detail.example).every((v) => v.length <= 2000));
  const json = JSON.stringify(payload);
  for (const secret of [key, email, phone, jwt]) assert.ok(!json.includes(secret));
  assert.match(json, /\[key removed\]/);
  assert.equal(scrub("30 days and $50"), "30 days and $50");
});

test("stop reasons use short endpoint codes", () => {
  for (const [reason, code] of [
    [null, null], ["budget of $3 is used", "budget"], ["reached 12 rounds", "max rounds"],
    ["3 rounds in a row found no winner", "stalled"], ["stopped by team", "stopped by team"],
    ["spend could not be measured", "spend unknown"], ["some other reason", "other"],
  ] as const) assert.equal(stopCode(reason), code);
});

test("shareRound posts with OIDC and never throws on HTTP errors or missing permission", async () => {
  const payload = sharePayload(goal({ share: "numbers" }), state, record, "1.6.2");
  const env = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token?x=1", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token" };
  const calls: { url: string; init?: RequestInit }[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return calls.length === 1 ? Response.json({ value: "signed-token" }) : Response.json({ ok: true });
  }) as typeof fetch;
  assert.match(await shareRound(payload, env, fake), /Shared round 2/);
  assert.match(calls[0].url, /audience=synthe-share/);
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "bearer request-token");
  assert.equal(calls[1].url, "https://synthe-share.vercel.app/api/round");
  assert.equal((calls[1].init?.headers as Record<string, string>).Authorization, "Bearer signed-token");
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), payload);
  assert.match(await shareRound(payload, env, (async () => new Response("", { status: 500 })) as typeof fetch), /OIDC returned 500/);
  let count = 0;
  assert.match(await shareRound(payload, env, (async () => ++count === 1 ? Response.json({ value: "signed-token" }) : new Response("", { status: 500 })) as typeof fetch), /endpoint returned 500/);
  assert.match(await shareRound(payload, {}, (async () => { throw new Error("must not fetch"); }) as typeof fetch), /npx synthe upgrade/);
});

test("shareRound times out without failing its caller", async () => {
  const realSetTimeout = globalThis.setTimeout;
  try {
    globalThis.setTimeout = ((handler: TimerHandler) => realSetTimeout(handler, 1)) as typeof setTimeout;
    const message = await shareRound(sharePayload(goal({ share: "numbers" }), state, record, "1.6.2"), {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "token",
    }, (async () => new Promise<Response>(() => {})) as typeof fetch);
    assert.match(message, /timed out/);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test("the report names the share level and workflow skips cancellation", () => {
  for (const share of [undefined, "none"] as const) assert.match(renderReport(goal({ share }), { ...state, rounds: [record] }), /Sharing with Synthe: off\./);
  for (const [share, label] of [["numbers", "numbers only"], ["detail", "numbers and what changed"], ["full", "numbers and what changed"]] as const) assert.match(renderReport(goal({ share }), { ...state, rounds: [record] }, new Date(FULL_SHARE_UNTIL)), new RegExp(`Sharing with Synthe: ${label}\\. Turn it off with "share": "none" in synthe.json`));
  assert.match(renderReport(goal({ share: "full" }), { ...state, rounds: [record] }, new Date(Date.parse(FULL_SHARE_UNTIL) - 1)), /Sharing with Synthe: everything for Crimson Hacks \(prompt and test cases until November 9\), then numbers and what changed\./);
  const workflow = readFileSync("templates/synthe.yml", "utf8");
  assert.match(workflow, /if: \$\{\{ !cancelled\(\) && needs.write.result != 'skipped' && needs.write.outputs.go != 'false' \}\}/);
  assert.match(workflow, /permissions: \{ contents: write, pull-requests: write, issues: write, actions: write, id-token: write \}/);
});

test("no workflow condition starts with a bare !, which YAML would read as a tag and silently drop", () => {
  const workflow = readFileSync("templates/synthe.yml", "utf8");
  const bare = workflow.split("\n").filter((line) => /^\s*if:\s*!/.test(line));
  assert.deepEqual(bare, []);
});
