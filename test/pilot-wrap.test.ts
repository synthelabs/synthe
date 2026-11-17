import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { personalDataKinds } from "../src/pilot/pii.ts";
import { readCallLog } from "../src/pilot/calllog.ts";
import { PilotError } from "../src/pilot/errors.ts";
import { pickVersion, pilotRecorder, type PilotRecorderOptions } from "../src/pilot/wrap.ts";
import { tmp } from "./pilot-cli-helpers.ts";

const T0 = new Date("2026-11-01T09:30:00.000Z");
const logFiles = (dir: string): string[] => readdirSync(dir).filter((n) => n.startsWith("calls-")).sort();
const lines = (dir: string): Record<string, unknown>[] => logFiles(dir).flatMap((n) => readFileSync(join(dir, n), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
function recorder(over: Partial<PilotRecorderOptions> = {}) {
  const dir = join(tmp("pilot-wrap-"), "log");
  return { dir, rec: pilotRecorder({ logDir: dir, now: () => T0, ...over }) };
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

test("a logging failure never breaks the call: fn runs once, the result is intact, the problem is counted", async () => {
  const root = tmp("pilot-wrap-");
  const blocker = join(root, "not-a-folder");
  writeFileSync(blocker, "x"); // a file where the log folder should be
  const reported: string[] = [];
  const rec = pilotRecorder({ logDir: join(blocker, "log"), now: () => T0, onProblem: (p) => { reported.push(p.kind); throw new Error("a failing callback"); } });
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
  assert.deepEqual(lines(dir).map((l) => Object.keys(l).sort()), [["at", "kind", "type", "v"]]);
  assert.doesNotMatch(text, /secret/);
});

test("only the documented fields are written: extra properties on the context never reach the log", async () => {
  const { dir, rec } = recorder();
  await rec.call({ promptVersion: "v1", conversationId: "c1", unitId: "u1", segment: "chat", modelId: "m1", startedAt: "2026-11-01T09:00:00Z", message: "my card is 4111", text: "hello" } as never, () => 1);
  const [line] = lines(dir);
  assert.deepEqual(Object.keys(line), ["v", "type", "at", "conversation_id", "prompt_version", "started_at", "unit_id", "segment", "model_id"]);
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
  assert.deepEqual(call, { v: 1, type: "call", at: "2026-11-01T23:59:59.500Z", conversation_id: "c1", prompt_version: "v1" });
  assert.deepEqual(outcome, { v: 1, type: "outcome", at: "2026-11-02T00:00:00.100Z", conversation_id: "c1", values: { resolved: 1 } });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  for (const n of logFiles(dir)) assert.equal(statSync(join(dir, n)).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "*\n");
});

test("an existing .gitignore is left alone", () => {
  const dir = join(tmp("pilot-wrap-"), "log");
  mkdirSync(dir);
  writeFileSync(join(dir, ".gitignore"), "mine\n");
  pilotRecorder({ logDir: dir, now: () => T0 }).record({ promptVersion: "v1", conversationId: "c1" });
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "mine\n");
});

test("appending keeps earlier lines, also from a second recorder on the same folder", () => {
  const { dir, rec } = recorder();
  rec.record({ promptVersion: "v1", conversationId: "c1" });
  pilotRecorder({ logDir: dir, now: () => T0 }).record({ promptVersion: "v1", conversationId: "c2" });
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

test("with idKey, ids are written as a keyed hash, the same in call and outcome, and the raw id is nowhere in the log", async () => {
  const { dir, rec } = recorder({ idKey: "test-key" });
  await rec.call({ promptVersion: "v1", conversationId: "conv-raw-123", unitId: "unit-raw-456" }, () => 0);
  rec.outcome("conv-raw-123", { resolved: 1 });
  const text = logFiles(dir).map((n) => readFileSync(join(dir, n), "utf8")).join("");
  assert.doesNotMatch(text, /conv-raw-123|unit-raw-456/);
  const hmac = (s: string) => createHmac("sha256", "test-key").update(s).digest("hex").slice(0, 32);
  const [call, outcome] = lines(dir);
  assert.equal(call.conversation_id, hmac("conversation:conv-raw-123"));
  assert.equal(call.unit_id, hmac("unit:unit-raw-456"));
  assert.equal(outcome.conversation_id, call.conversation_id, "call and outcome join");
  assert.notEqual(call.conversation_id, call.unit_id);
  // A different key gives a different token.
  const other = recorder({ idKey: "other-key" });
  other.rec.record({ promptVersion: "v1", conversationId: "conv-raw-123" });
  assert.notEqual(lines(other.dir)[0].conversation_id, call.conversation_id);
});

test("a token that could pass for a card number is made again, the same way each time, so the import accepts every token", () => {
  const plain = (id: string) => createHmac("sha256", "k").update(`conversation:${id}`).digest("hex").slice(0, 32);
  const risky: string[] = [];
  for (let i = 0; risky.length < 3 && i < 100_000; i++) if (/\d{13}/.test(plain(`conv-${i}`))) risky.push(`conv-${i}`);
  assert.equal(risky.length, 3, "the search finds ids whose plain token has 13 digits in a row");
  const { dir, rec } = recorder({ idKey: "k" });
  const rec2 = pilotRecorder({ logDir: dir, idKey: "k", now: () => T0 });
  for (const id of risky) { rec.record({ promptVersion: "v1", conversationId: id }); rec2.outcome(id, { resolved: 1 }); }
  const all = lines(dir);
  for (const [i, id] of risky.entries()) {
    const t = all[2 * i].conversation_id as string;
    assert.notEqual(t, plain(id));
    assert.match(t, /^[0-9a-f]{32}$/);
    assert.deepEqual(personalDataKinds(t), []);
    assert.equal(all[2 * i + 1].conversation_id, t, "outcome joins to call");
  }
  // Every other token is the plain one.
  rec.record({ promptVersion: "v1", conversationId: "plain-id" });
  assert.equal(lines(dir).at(-1)?.conversation_id, plain("plain-id"));
  // And no token among many is flagged by the import's personal-data check.
  const many = join(tmp("pilot-wrap-"), "log");
  const r3 = pilotRecorder({ logDir: many, idKey: "k", now: () => T0 });
  for (let i = 0; i < 10_000; i++) r3.record({ promptVersion: "v1", conversationId: `x-${i}`, unitId: `u-${i}` });
  assert.ok(lines(many).every((l) => personalDataKinds(l.conversation_id as string).length === 0 && personalDataKinds(l.unit_id as string).length === 0));
});

test("without idKey, ids are written as given", () => {
  const { dir, rec } = recorder();
  rec.record({ promptVersion: "v1", conversationId: "c-1", unitId: "u-1" });
  assert.deepEqual([lines(dir)[0].conversation_id, lines(dir)[0].unit_id], ["c-1", "u-1"]);
});

test("a recorder needs a log folder, and an idKey that is not empty", () => {
  assert.throws(() => pilotRecorder({ logDir: "" }), TypeError);
  assert.throws(() => pilotRecorder({ logDir: "x", idKey: "" }), TypeError);
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
  assert.ok(!log.conversations.has("torn"));
  const c1 = log.conversations.get("c1");
  assert.equal(c1?.calls.length, 1);
  assert.equal(c1?.outcome_lines, 2);
  assert.deepEqual([...(c1?.values ?? [])], [["resolved", 1], ["escalated", 1]]);
  assert.equal(log.conversations.get("orphan")?.calls.length, 0);
});

test("the newest outcome wins a metric; at the same time the later line wins; calls are in time order", () => {
  const dir = join(tmp("pilot-wrap-"), "log");
  mkdirSync(dir);
  const row = (o: object) => `${JSON.stringify({ v: 1, ...o })}\n`;
  writeFileSync(join(dir, "calls-2026-11-01.jsonl"), [
    row({ type: "call", at: "2026-11-01T10:00:00Z", conversation_id: "c", prompt_version: "late" }),
    row({ type: "call", at: "2026-11-01T09:00:00Z", conversation_id: "c", prompt_version: "early" }),
    row({ type: "outcome", at: "2026-11-01T12:00:00Z", conversation_id: "c", values: { resolved: 1, escalated: 1 } }),
    row({ type: "outcome", at: "2026-11-01T11:00:00Z", conversation_id: "c", values: { resolved: 0 } }),
    row({ type: "outcome", at: "2026-11-01T13:00:00Z", conversation_id: "c", values: { escalated: 0 } }),
    row({ type: "outcome", at: "2026-11-01T13:00:00Z", conversation_id: "c", values: { escalated: 1 } }),
  ].join(""));
  const c = readCallLog(dir).conversations.get("c");
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

test("pickVersion is stable for the same input and a different salt reshuffles", () => {
  const base = { key: "conv-1", salt: "exp-a", baseline: "b", candidate: "c", candidateShare: 0.5 };
  assert.equal(pickVersion(base), pickVersion({ ...base }));
  const keys = Array.from({ length: 200 }, (_, i) => `k${i}`);
  const a = keys.map((key) => pickVersion({ ...base, key }));
  const b = keys.map((key) => pickVersion({ ...base, key, salt: "exp-b" }));
  assert.notDeepEqual(a, b);
  assert.ok(a.some((v, i) => v !== b[i]));
});

test("pickVersion gives the candidate its share", () => {
  for (const [share, tol] of [[0.5, 0.02], [0.1, 0.01]] as const) {
    let n = 0;
    for (let i = 0; i < 20_000; i++) if (pickVersion({ key: `conversation-${i}`, salt: "s", baseline: "b", candidate: "c", candidateShare: share }) === "c") n++;
    assert.ok(Math.abs(n / 20_000 - share) < tol, `share ${share}: ${n / 20_000}`);
  }
});

test("pickVersion refuses a configuration mistake at the first call", () => {
  const ok = { key: "k", salt: "s", baseline: "b", candidate: "c", candidateShare: 0.5 };
  for (const bad of [
    { candidateShare: 0 }, { candidateShare: 1 }, { candidateShare: -0.1 }, { candidateShare: 1.5 }, { candidateShare: Number.NaN }, { candidateShare: Infinity },
    { candidateShare: "0.5" }, { key: "" }, { salt: "" }, { candidate: "b" }, { baseline: "" }, { candidate: "" },
  ]) assert.throws(() => pickVersion({ ...ok, ...bad } as never), TypeError, JSON.stringify(bad));
});

test("pickVersion maps a share just inside the bounds to a version", () => {
  const ok = { key: "k", salt: "s", baseline: "b", candidate: "c" };
  assert.equal(pickVersion({ ...ok, candidateShare: 1 - 1e-12 }), "c");
  assert.equal(pickVersion({ ...ok, candidateShare: 1e-12 }), "b");
});
