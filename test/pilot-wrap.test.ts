import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { personalDataKinds } from "../src/pilot/pii.ts";
import { agentKey, readCallLog } from "../src/pilot/calllog.ts";
import { PilotError } from "../src/pilot/errors.ts";
import { ASSIGN_RULE, bucket, pickArm, pickVersion, pilotRecorder, type PilotRecorderOptions } from "../src/pilot/wrap.ts";
import { tmp } from "./pilot-cli-helpers.ts";

const T0 = new Date("2026-11-01T09:30:00.000Z");
const logFiles = (dir: string): string[] => readdirSync(dir).filter((n) => n.startsWith("calls-")).sort();
const lines = (dir: string): Record<string, unknown>[] => logFiles(dir).flatMap((n) => readFileSync(join(dir, n), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
const AGENT = "support-bot";
// Raw ids unless the test gives an idKey: a recorder with neither is refused (see "a recorder fails closed").
const ids = (over: { idKey?: string }) => (over.idKey === undefined ? { rawIds: true as const } : {});
function recorder(over: Partial<PilotRecorderOptions> = {}) {
  const dir = join(tmp("pilot-wrap-"), "log");
  return { dir, rec: pilotRecorder({ logDir: dir, agent: AGENT, now: () => T0, ...ids(over), ...over } as PilotRecorderOptions) };
}

test("call returns what fn returns, whether it is a value or a promise, and runs it once", async () => {
  const { rec } = recorder();
  let runs = 0;
  assert.equal(await rec.call({ promptVersion: "v1", conversationId: "c1" }, () => { runs++; return 42; }), 42);
  const obj = { reply: "x" };
  assert.equal(await rec.call({ promptVersion: "v1", conversationId: "c2" }, async () => { runs++; return obj; }), obj);
  assert.equal(runs, 2);
});

test("call rethrows exactly what fn throws, and the call is already in the log", async () => {
  const { dir, rec } = recorder();
  const boom = new RangeError("agent crashed");
  await assert.rejects(rec.call({ promptVersion: "v1", conversationId: "c1" }, () => { throw boom; }), (e) => e === boom);
  await assert.rejects(rec.call({ promptVersion: "v1", conversationId: "c2" }, async () => { throw boom; }), (e) => e === boom);
  assert.deepEqual(lines(dir).map((l) => l.conversation_id), ["c1", "c2"], "exposure is logged even when the call crashes");
  assert.equal(rec.problems(), 0);
});

test("the call line is written before fn runs", async () => {
  const { dir, rec } = recorder();
  let seen: unknown[] = [];
  await rec.call({ promptVersion: "v1", conversationId: "c1" }, () => { seen = lines(dir); });
  assert.equal(seen.length, 1);
});

test("a clock hook that returns a broken Date never breaks the call or the line", async () => {
  // A Date whose own methods throw (a test double, a patched clock) is copied to a plain Date first.
  const broken = () => { const d = new Date(T0); d.toISOString = () => { throw new Error("no ISO"); }; return d; };
  const dir = join(tmp("pilot-wrap-"), "log");
  const rec = pilotRecorder({ logDir: dir, agent: "A", idKey: "clock-hook-test-key-0123456789", now: broken });
  assert.equal(await rec.call({ promptVersion: "v1", conversationId: "c1" }, () => 7), 7);
  rec.outcome("c1", { resolved: 1 });
  rec.outcome("c1", { resolved: Number.NaN });
  assert.equal(rec.problems(), 1, "only the invalid outcome is a problem");
  assert.deepEqual(lines(dir).map((l) => l.type), ["call", "outcome", "problem"]);
});

test("a logging failure never breaks the call: fn runs once, the result is intact, the problem is counted", async () => {
  const root = tmp("pilot-wrap-");
  const blocker = join(root, "not-a-folder");
  writeFileSync(blocker, "x"); // a file where the log folder should be
  const reported: string[] = [];
  const rec = pilotRecorder({ logDir: join(blocker, "log"), agent: AGENT, rawIds: true, now: () => T0, onProblem: (p) => { reported.push(p.kind); throw new Error("a failing callback"); } });
  let runs = 0;
  assert.equal(await rec.call({ promptVersion: "v1", conversationId: "c1" }, () => { runs++; return "ok"; }), "ok");
  rec.record({ promptVersion: "v1", conversationId: "c2" });
  rec.outcome("c1", { resolved: 1 });
  assert.equal(runs, 1);
  assert.equal(rec.problems(), 3);
  assert.deepEqual(reported, ["write_failed", "write_failed", "write_failed"]);
});

test("invalid input is a problem and never a row; fn still runs", async () => {
  const { dir, rec } = recorder();
  const bad: unknown[] = [
    { promptVersion: "", conversationId: "c" }, { promptVersion: "v", conversationId: "" }, { promptVersion: "v", conversationId: "x".repeat(201) },
    { promptVersion: "v", conversationId: "c", segment: "" }, { promptVersion: "v", conversationId: "c", unitId: 5 },
    { promptVersion: "v", conversationId: "c", modelId: "m".repeat(201) },
    { promptVersion: "v", conversationId: "c", startedAt: "yesterday" }, { promptVersion: "v", conversationId: "c", startedAt: new Date("nope") },
    { promptVersion: "v", conversationId: "c", startedAt: "2026-11-01T09:30:00" }, null, undefined, "text",
  ];
  let runs = 0;
  for (const ctx of bad) await rec.call(ctx as never, () => { runs++; });
  assert.equal(runs, bad.length);
  assert.equal(rec.problems(), bad.length);
  assert.ok(lines(dir).every((l) => l.type === "problem" && l.kind === "invalid_call"));
  assert.equal(readCallLog(dir).conversations.size, 0);
});

test("outcome validation: finite numbers or null, metric names, at most 50", () => {
  const { dir, rec } = recorder();
  const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`m${i}`, 1]));
  for (const values of [{ resolved: Number.NaN }, { resolved: Infinity }, { resolved: "1" }, { "bad name": 1 }, { "": 1 }, { ["x".repeat(101)]: 1 }, many, null, [1], undefined]) {
    rec.outcome("c1", values as never);
  }
  rec.outcome("", { resolved: 1 });
  rec.outcome("x".repeat(201), { resolved: 1 });
  assert.equal(rec.problems(), 12);
  assert.ok(lines(dir).every((l) => l.type === "problem" && l.kind === "invalid_outcome"));
  rec.outcome("c1", { resolved: 1, refund_usd: 0, "a.b-c_d": null, ["y".repeat(100)]: 2.5 });
  assert.equal(rec.problems(), 12);
  assert.deepEqual(lines(dir).at(-1)?.values, { resolved: 1, refund_usd: 0, "a.b-c_d": null, ["y".repeat(100)]: 2.5 });
  const fifty = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`m${i}`, 1]));
  rec.outcome("c2", fifty);
  assert.equal(rec.problems(), 12, "exactly 50 metrics are allowed");
});

test("a problem line names a kind only: no id, no value, no error text", () => {
  const { dir, rec } = recorder();
  rec.outcome("secret-conversation-77", { resolved: "secret-value" } as never);
  const text = logFiles(dir).map((n) => readFileSync(join(dir, n), "utf8")).join("");
  assert.deepEqual(lines(dir).map((l) => Object.keys(l).sort()), [["agent", "at", "kind", "type", "v"]]);
  assert.doesNotMatch(text, /secret/);
});

test("only the documented fields are written: extra properties on the context never reach the log", async () => {
  const { dir, rec } = recorder();
  await rec.call({ promptVersion: "v1", conversationId: "c1", unitId: "u1", segment: "chat", modelId: "m1", startedAt: "2026-11-01T09:00:00Z", message: "my card is 4111", text: "hello" } as never, () => 1);
  const [line] = lines(dir);
  assert.deepEqual(Object.keys(line), ["v", "type", "at", "agent", "conversation_id", "prompt_version", "started_at", "unit_id", "segment", "model_id"]);
  assert.equal(line.started_at, "2026-11-01T09:00:00.000Z");
  assert.doesNotMatch(readFileSync(join(dir, logFiles(dir)[0]), "utf8"), /4111|hello/);
});

test("log format: one JSON line per record in a file named for the UTC date of the line, with private permissions and a .gitignore", () => {
  let now = new Date("2026-11-01T23:59:59.500Z");
  const { dir, rec } = recorder({ now: () => now });
  rec.record({ promptVersion: "v1", conversationId: "c1" });
  now = new Date("2026-11-02T00:00:00.100Z");
  rec.outcome("c1", { resolved: 1 });
  assert.deepEqual(logFiles(dir), ["calls-2026-11-01.jsonl", "calls-2026-11-02.jsonl"]);
  const [call, outcome] = lines(dir);
  assert.deepEqual(call, { v: 1, type: "call", at: "2026-11-01T23:59:59.500Z", agent: AGENT, conversation_id: "c1", prompt_version: "v1" });
  assert.deepEqual(outcome, { v: 1, type: "outcome", at: "2026-11-02T00:00:00.100Z", agent: AGENT, conversation_id: "c1", values: { resolved: 1 } });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  for (const n of logFiles(dir)) assert.equal(statSync(join(dir, n)).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "*\n");
});

test("an existing .gitignore is left alone", () => {
  const dir = join(tmp("pilot-wrap-"), "log");
  mkdirSync(dir);
  writeFileSync(join(dir, ".gitignore"), "mine\n");
  pilotRecorder({ logDir: dir, agent: AGENT, rawIds: true, now: () => T0 }).record({ promptVersion: "v1", conversationId: "c1" });
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "mine\n");
});

test("appending keeps earlier lines, also from a second recorder on the same folder", () => {
  const { dir, rec } = recorder();
  rec.record({ promptVersion: "v1", conversationId: "c1" });
  pilotRecorder({ logDir: dir, agent: AGENT, rawIds: true, now: () => T0 }).record({ promptVersion: "v1", conversationId: "c2" });
  assert.deepEqual(lines(dir).map((l) => l.conversation_id), ["c1", "c2"]);
});

test("startedAt is written when given and absent when not", () => {
  const { dir, rec } = recorder();
  rec.record({ promptVersion: "v1", conversationId: "c1", startedAt: new Date("2026-11-01T08:00:00Z") });
  rec.record({ promptVersion: "v1", conversationId: "c2", startedAt: "2026-11-01T10:00:00+02:00" });
  rec.record({ promptVersion: "v1", conversationId: "c3" });
  const [a, b, c] = lines(dir);
  assert.equal(a.started_at, "2026-11-01T08:00:00.000Z");
  assert.equal(b.started_at, "2026-11-01T08:00:00.000Z");
  assert.ok(!("started_at" in c));
});

// The token rule, written out independently of the code under test: HMAC-SHA256(key, "<kind>:<id>"), the first 16
// bytes, each nibble as one letter a..p. No digit can appear, so no token can look like a card or national number.
const expectedToken = (key: string, kind: string, id: string): string =>
  [...createHmac("sha256", key).update(`${kind}:${id}`).digest().subarray(0, 16)].map((byte) => "abcdefghijklmnop"[byte >> 4] + "abcdefghijklmnop"[byte & 15]).join("");

test("with idKey, ids are written as a keyed token, the same in call and outcome, and the raw id is nowhere in the log", async () => {
  const { dir, rec } = recorder({ idKey: "test-id-key-0123456789" });
  await rec.call({ promptVersion: "v1", conversationId: "conv-raw-123", unitId: "unit-raw-456" }, () => 0);
  rec.outcome("conv-raw-123", { resolved: 1 });
  const text = logFiles(dir).map((n) => readFileSync(join(dir, n), "utf8")).join("");
  assert.doesNotMatch(text, /conv-raw-123|unit-raw-456/);
  const [call, outcome] = lines(dir);
  assert.equal(call.conversation_id, expectedToken("test-id-key-0123456789", "conversation", "conv-raw-123"));
  assert.equal(call.unit_id, expectedToken("test-id-key-0123456789", "unit", "unit-raw-456"));
  assert.match(call.conversation_id as string, /^[a-p]{32}$/);
  assert.equal(outcome.conversation_id, call.conversation_id, "call and outcome join");
  assert.notEqual(call.conversation_id, call.unit_id, "the conversation and unit tokens for different ids differ");
});

test("the same raw id gives a conversation token and a unit token that differ; a different key gives a different token", () => {
  const { dir, rec } = recorder({ idKey: "test-id-key-0123456789" });
  rec.record({ promptVersion: "v1", conversationId: "same-raw-id", unitId: "same-raw-id" });
  const [line] = lines(dir);
  assert.notEqual(line.conversation_id, line.unit_id);
  assert.equal(line.unit_id, expectedToken("test-id-key-0123456789", "unit", "same-raw-id"));
  const other = recorder({ idKey: "other-id-key-0123456789" });
  other.rec.record({ promptVersion: "v1", conversationId: "same-raw-id" });
  assert.notEqual(lines(other.dir)[0].conversation_id, line.conversation_id);
});

test("a token has no digit, so the import's personal-data checks can never fire on one (100,000 tokens)", () => {
  const dir = join(tmp("pilot-wrap-"), "log");
  const rec = pilotRecorder({ logDir: dir, agent: AGENT, idKey: "wrap-test-id-key-0123456789", now: () => T0 });
  for (let i = 0; i < 50_000; i++) rec.record({ promptVersion: "v1", conversationId: `x-${i}`, unitId: `u-${i}` });
  const all = lines(dir);
  assert.equal(all.length, 50_000);
  const tokens = all.flatMap((l) => [l.conversation_id as string, l.unit_id as string]);
  assert.equal(tokens.length, 100_000);
  assert.ok(tokens.every((t) => /^[a-p]{32}$/.test(t)), "32 letters from a to p, nothing else");
  assert.ok(tokens.every((t) => !/\d/.test(t)), "no digit");
  assert.ok(tokens.every((t) => personalDataKinds(t).length === 0), "personalDataKinds finds nothing");
  assert.equal(new Set(tokens).size, tokens.length, "no two ids share a token");
});

test("without idKey, and with rawIds: true, ids are written as given", () => {
  const { dir, rec } = recorder();
  rec.record({ promptVersion: "v1", conversationId: "c-1", unitId: "u-1" });
  assert.deepEqual([lines(dir)[0].conversation_id, lines(dir)[0].unit_id], ["c-1", "u-1"]);
});

test("a recorder fails closed: it needs a log folder and an agent, and either an idKey or rawIds: true, never both", () => {
  const ok = { logDir: "x", agent: AGENT, rawIds: true as const };
  assert.throws(() => pilotRecorder({ logDir: "", agent: AGENT, rawIds: true }), TypeError);
  assert.throws(() => pilotRecorder({ logDir: "x", agent: AGENT, idKey: "", rawIds: true } as never), TypeError);
  assert.throws(() => pilotRecorder({ logDir: "x", agent: AGENT } as never), (e) => e instanceof TypeError && /idKey/.test(e.message) && /rawIds/.test(e.message), "neither idKey nor rawIds");
  assert.throws(() => pilotRecorder({ logDir: "x", agent: AGENT, idKey: "wrap-test-id-key-0123456789", rawIds: true } as never), (e) => e instanceof TypeError && /both/.test(e.message), "both is ambiguous");
  for (const bad of [false, 1, "true", null]) assert.throws(() => pilotRecorder({ logDir: "x", agent: AGENT, rawIds: bad } as never), TypeError, `rawIds: ${String(bad)}`);
  assert.throws(() => pilotRecorder({ logDir: "x", agent: AGENT, idKey: "" } as never), TypeError);
  assert.throws(() => pilotRecorder({ logDir: "x", agent: AGENT, idKey: 5 } as never), TypeError);
  assert.doesNotThrow(() => pilotRecorder(ok));
  assert.doesNotThrow(() => pilotRecorder({ logDir: "x", agent: AGENT, idKey: "wrap-test-id-key-0123456789" }));
});

test("the agent name is required: 1 to 200 characters, not blank", () => {
  for (const bad of [undefined, null, 5, "", "   ", "\t\n", "a".repeat(201)]) {
    assert.throws(() => pilotRecorder({ logDir: "x", agent: bad as never, rawIds: true }), TypeError, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => pilotRecorder({ logDir: "x", agent: "a", rawIds: true }));
  assert.doesNotThrow(() => pilotRecorder({ logDir: "x", agent: "a".repeat(200), rawIds: true }));
});

test("every call, outcome and problem line carries the agent, written as given", async () => {
  const { dir, rec } = recorder({ agent: "Juniper Support v2" });
  await rec.call({ promptVersion: "v1", conversationId: "c1" }, () => 0);
  rec.outcome("c1", { resolved: 1 });
  rec.outcome("c1", { resolved: Number.NaN });
  rec.record({ promptVersion: "", conversationId: "c1" });
  const all = lines(dir);
  assert.deepEqual(all.map((l) => l.type), ["call", "outcome", "problem", "problem"]);
  assert.ok(all.every((l) => l.agent === "Juniper Support v2"));
});

test("the reader joins calls and outcomes, ignores a torn last line, and counts damaged lines without printing them", () => {
  const { dir, rec } = recorder();
  rec.record({ promptVersion: "v1", conversationId: "c1", segment: "chat" });
  rec.outcome("c1", { resolved: 0, escalated: 1 });
  rec.outcome("c1", { resolved: 1 });
  rec.outcome("orphan", { resolved: 1 });
  rec.record({ promptVersion: "", conversationId: "c9" }); // a problem line
  const file = join(dir, logFiles(dir)[0]);
  writeFileSync(file, `${readFileSync(file, "utf8")}not json\n{"v":1,"type":"call"}\n{"v":2,"type":"call","at":"2026-11-01T09:30:00Z","conversation_id":"c","prompt_version":"v"}\n{"v":1,"type":"call","at":"2026-11-01T09:30:00.000Z","conversation_id":"torn","prompt_ver`);
  const log = readCallLog(dir);
  assert.equal(log.files, 1);
  assert.equal(log.malformed, 3);
  assert.equal(log.lines, 5 + 3);
  assert.deepEqual(log.problems, { invalid_call: 1 });
  assert.ok(!log.conversations.has(agentKey(AGENT, "torn")));
  const c1 = log.conversations.get(agentKey(AGENT, "c1"));
  assert.equal(c1?.calls.length, 1);
  assert.equal(c1?.outcome_lines, 2);
  assert.deepEqual([...(c1?.values ?? [])], [["resolved", 1], ["escalated", 1]]);
  assert.equal(log.conversations.get(agentKey(AGENT, "orphan"))?.calls.length, 0);
  assert.deepEqual(log.agents, { [AGENT]: 5 }, "lines per agent: the 3 damaged lines have no valid agent and are not counted");
});

test("the reader keys conversations by (agent, conversation id) and a line without a valid agent is malformed", () => {
  const dir = join(tmp("pilot-wrap-"), "log");
  mkdirSync(dir);
  const row = (o: object) => `${JSON.stringify({ v: 1, ...o })}\n`;
  const at = "2026-11-01T10:00:00Z";
  writeFileSync(join(dir, "calls-2026-11-01.jsonl"), [
    row({ type: "call", at, agent: "a", conversation_id: "same", prompt_version: "one" }),
    row({ type: "call", at, agent: "b", conversation_id: "same", prompt_version: "two" }),
    row({ type: "outcome", at, agent: "b", conversation_id: "same", values: { resolved: 1 } }),
    row({ type: "call", at, conversation_id: "x", prompt_version: "v" }),
    row({ type: "call", at, agent: "", conversation_id: "x", prompt_version: "v" }),
    row({ type: "call", at, agent: "  ", conversation_id: "x", prompt_version: "v" }),
    row({ type: "call", at, agent: 7, conversation_id: "x", prompt_version: "v" }),
    row({ type: "call", at, agent: "a".repeat(201), conversation_id: "x", prompt_version: "v" }),
    row({ type: "outcome", at, conversation_id: "x", values: { resolved: 1 } }),
    row({ type: "problem", at, kind: "write_failed" }),
    row({ type: "problem", at, agent: "a", kind: "write_failed" }),
  ].join(""));
  const log = readCallLog(dir);
  assert.equal(log.malformed, 7);
  assert.deepEqual(log.agents, { a: 2, b: 2 });
  assert.deepEqual(log.problems, { write_failed: 1 });
  assert.equal(log.conversations.size, 2, "the same conversation id under two agents is two conversations");
  assert.deepEqual([...log.conversations.values()].map((c) => [c.agent, c.calls.map((x) => x.prompt_version), c.outcome_lines]).sort(), [["a", ["one"], 0], ["b", ["two"], 1]]);
});

test("the newest outcome wins a metric; at the same time the later line wins; calls are in time order", () => {
  const dir = join(tmp("pilot-wrap-"), "log");
  mkdirSync(dir);
  const row = (o: object) => `${JSON.stringify({ v: 1, agent: AGENT, ...o })}\n`;
  writeFileSync(join(dir, "calls-2026-11-01.jsonl"), [
    row({ type: "call", at: "2026-11-01T10:00:00Z", conversation_id: "c", prompt_version: "late" }),
    row({ type: "call", at: "2026-11-01T09:00:00Z", conversation_id: "c", prompt_version: "early" }),
    row({ type: "outcome", at: "2026-11-01T12:00:00Z", conversation_id: "c", values: { resolved: 1, escalated: 1 } }),
    row({ type: "outcome", at: "2026-11-01T11:00:00Z", conversation_id: "c", values: { resolved: 0 } }),
    row({ type: "outcome", at: "2026-11-01T13:00:00Z", conversation_id: "c", values: { escalated: 0 } }),
    row({ type: "outcome", at: "2026-11-01T13:00:00Z", conversation_id: "c", values: { escalated: 1 } }),
  ].join(""));
  const c = readCallLog(dir).conversations.get(agentKey(AGENT, "c"));
  assert.deepEqual(c?.calls.map((x) => x.prompt_version), ["early", "late"]);
  assert.deepEqual(Object.fromEntries(c?.values ?? []), { resolved: 1, escalated: 1 });
});

test("the reader reads only calls-*.jsonl files, refuses a missing folder, and a folder with too many files", () => {
  const dir = join(tmp("pilot-wrap-"), "log");
  assert.throws(() => readCallLog(dir), (e) => e instanceof PilotError && e.code === "not_found");
  mkdirSync(dir);
  writeFileSync(join(dir, "notes.jsonl"), "garbage\n");
  writeFileSync(join(dir, "calls-2026-11-01.txt"), "garbage\n");
  mkdirSync(join(dir, "calls-2026-11-02.jsonl"));
  const log = readCallLog(dir);
  assert.deepEqual([log.files, log.lines, log.malformed], [0, 0, 0]);
  for (let i = 0; i < 2001; i++) writeFileSync(join(dir, `calls-${String(i).padStart(5, "0")}.jsonl`), "");
  assert.throws(() => readCallLog(dir), (e) => e instanceof PilotError && e.code === "too_large");
});

test("a log file over the size cap is refused, not read", () => {
  const dir = join(tmp("pilot-wrap-"), "log");
  mkdirSync(dir);
  const big = join(dir, "calls-2026-11-01.jsonl");
  writeFileSync(big, "");
  // A sparse file: the size is 64 MB + 1 without writing that much.
  const fd = openSync(big, "r+");
  ftruncateSync(fd, 64 * 1024 * 1024 + 1);
  closeSync(fd);
  assert.throws(() => readCallLog(dir), (e) => e instanceof PilotError && e.code === "too_large");
  assert.ok(existsSync(big));
});

// ---------------------------------------------------------------------------------------------------------------
// The split rule: one rule, the reviewed sha256-v1, shared byte for byte with the shipped clients' vectors.
// ---------------------------------------------------------------------------------------------------------------

interface Vectors { rule: string; vectors: { unit: string; salt: string; bucket: number }[]; pick: { arms: { id: string; weight: number }[]; unit: string; salt: string; arm: string }[] }
const VECTORS = JSON.parse(readFileSync(new URL("../docs/assign-vectors.json", import.meta.url), "utf8")) as Vectors;

test("the split rule is sha256-v1 and bucket gives every vector in docs/assign-vectors.json", () => {
  assert.equal(ASSIGN_RULE, "sha256-v1");
  assert.equal(VECTORS.rule, ASSIGN_RULE);
  assert.ok(VECTORS.vectors.length >= 5);
  for (const v of VECTORS.vectors) assert.equal(bucket(v.unit, v.salt), v.bucket, JSON.stringify(v));
});

test("pickArm gives every vector in docs/assign-vectors.json", () => {
  assert.ok(VECTORS.pick.length >= 25);
  for (const v of VECTORS.pick) assert.equal(pickArm(v.arms, v.unit, v.salt), v.arm, JSON.stringify(v));
});

test("bucket and pickArm refuse what the shared rule refuses", () => {
  for (const [unit, salt] of [[5, "s"], ["u", 5], [null, "s"], ["u", undefined], ["\ud800", "s"], ["u", "\udc00x"]]) assert.throws(() => bucket(unit as never, salt as never), Error, JSON.stringify([unit, salt]));
  const arm = (weight: number, id = "a") => ({ id, weight });
  for (const arms of [[arm(-1), arm(5, "b")], [arm(1.5)], [arm(Number.NaN)], [arm(0)], [], [arm(0), arm(0, "b")], [arm(1_000_001)], [arm(500_000), arm(500_001, "b")]]) {
    assert.throws(() => pickArm(arms, "u", "s"), Error, JSON.stringify(arms));
  }
  assert.equal(pickArm([arm(0), arm(7, "b")], "u", "s"), "b", "an arm with weight 0 is never picked");
  assert.equal(pickArm([arm(1_000_000)], "u", "s"), "a");
});

const SPLIT = { salt: "exp-a", baseline: "b", candidate: "c" };

test("pickVersion is stable for the same input and a different salt reshuffles", () => {
  const base = { key: "conv-1", ...SPLIT, candidateShareBp: 5000 };
  assert.equal(pickVersion(base), pickVersion({ ...base }));
  const keys = Array.from({ length: 200 }, (_, i) => `k${i}`);
  const a = keys.map((key) => pickVersion({ ...base, key }));
  const b = keys.map((key) => pickVersion({ ...base, key, salt: "exp-b" }));
  assert.notDeepEqual(a, b);
});

test("pickVersion at 5000 bp is pickArm with weights [5000, 5000], for 1,000 keys", () => {
  for (let i = 0; i < 1000; i++) {
    const key = `conversation-${i}`;
    assert.equal(pickVersion({ key, ...SPLIT, candidateShareBp: 5000 }), pickArm([{ id: "b", weight: 5000 }, { id: "c", weight: 5000 }], key, "exp-a"), key);
  }
  for (const bp of [1, 2000, 9999]) {
    for (let i = 0; i < 200; i++) assert.equal(pickVersion({ key: `k${i}`, ...SPLIT, candidateShareBp: bp }), pickArm([{ id: "b", weight: 10000 - bp }, { id: "c", weight: bp }], `k${i}`, "exp-a"));
  }
});

test("pickVersion gives the candidate its share, within 1 percentage point over 100,000 keys at 2000 bp", () => {
  let n = 0;
  for (let i = 0; i < 100_000; i++) if (pickVersion({ key: `conversation-${i}`, ...SPLIT, candidateShareBp: 2000 }) === "c") n++;
  assert.ok(Math.abs(n / 100_000 - 0.2) < 0.01, `candidate share ${n / 100_000}`);
});

test("pickVersion refuses a configuration mistake at the first call", () => {
  const ok = { key: "k", ...SPLIT, candidateShareBp: 5000 };
  for (const bad of [
    { candidateShareBp: 0 }, { candidateShareBp: 10000 }, { candidateShareBp: -1 }, { candidateShareBp: 12000 }, { candidateShareBp: 0.5 }, { candidateShareBp: 5000.5 }, { candidateShareBp: Number.NaN },
    { candidateShareBp: Infinity }, { candidateShareBp: "5000" }, { candidateShareBp: undefined }, { key: "" }, { salt: "" }, { candidate: "b" }, { baseline: "" }, { candidate: "" },
  ]) assert.throws(() => pickVersion({ ...ok, ...bad } as never), TypeError, JSON.stringify(bad));
});

test("the old float share is gone: passing candidateShare throws a TypeError that names candidateShareBp", () => {
  assert.throws(() => pickVersion({ key: "k", ...SPLIT, candidateShare: 0.5 } as never), (e) => e instanceof TypeError && /candidateShareBp/.test(e.message));
  assert.throws(() => pickVersion({ key: "k", ...SPLIT, candidateShare: 0.5, candidateShareBp: 5000 } as never), (e) => e instanceof TypeError && /candidateShareBp/.test(e.message), "the old name is refused even beside the new one");
});

test("pickVersion maps a share at the bounds to a version", () => {
  const ok = { ...SPLIT, key: "k" };
  assert.ok(["b", "c"].includes(pickVersion({ ...ok, candidateShareBp: 1 })));
  assert.ok(["b", "c"].includes(pickVersion({ ...ok, candidateShareBp: 9999 })));
  const shares = [1, 9999].map((bp) => Array.from({ length: 20_000 }, (_, i) => pickVersion({ ...ok, key: `k${i}`, candidateShareBp: bp })).filter((v) => v === "c").length);
  assert.ok(shares[0] < 20 && shares[1] > 19_980, String(shares));
});
