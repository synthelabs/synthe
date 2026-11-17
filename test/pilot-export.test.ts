import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readCallLog } from "../src/pilot/calllog.ts";
import { parsePilotConfig } from "../src/pilot/config.ts";
import type { Flags, PilotDeps } from "../src/pilot/commands.ts";
import { DEMO, demoConfig, telemetryExport } from "../src/pilot/demo-data.ts";
import { PilotError } from "../src/pilot/errors.ts";
import { buildLogExport, exportLog, writeLogExport, type LogExportInput } from "../src/pilot/export.ts";
import { addDays, candidateTag } from "../src/pilot/ids.ts";
import { importTelemetry, parseCsv } from "../src/pilot/telemetry.ts";
import type { ExperimentSpec, MetricContract } from "../src/pilot/types.ts";
import { pilotRecorder } from "../src/pilot/wrap.ts";
import { frozenPilot, replayedPilot, tmp, workspace, json } from "./pilot-cli-helpers.ts";

const contract = (over: Partial<MetricContract> = {}): MetricContract => ({ ...parsePilotConfig(JSON.stringify(demoConfig())).metric, ...over });
const BASE: string = DEMO.baseline_tag;
const CAND: string = "synthe-0123456789ab";
const START = "2026-11-01T00:00:00Z";
const END = "2026-11-15T00:00:00Z";
const EXPORTED = "2026-11-20T00:00:00Z";

// A log folder written line by line, so a test controls every time and field.
type Line = Record<string, unknown>;
const call = (id: string, at: string, version = BASE, extra: Line = {}): Line => ({ v: 1, type: "call", at, conversation_id: id, prompt_version: version, ...extra });
const outcome = (id: string, at: string, values: Record<string, number | null>): Line => ({ v: 1, type: "outcome", at, conversation_id: id, values });
function logOf(lines: Line[]) {
  const dir = join(tmp("pilot-export-"), "log");
  mkdirSync(dir);
  writeFileSync(join(dir, "calls-2026-11-01.jsonl"), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  return readCallLog(dir);
}
const input = (lines: Line[], over: Partial<LogExportInput> = {}): LogExportInput => ({
  log: logOf(lines), contract: contract(), tags: [BASE, CAND], window: { start: START, end: END }, exported_at: EXPORTED,
  assignment: "randomized", export_id: "calllog-test", csv_name: "calllog-test.csv", ...over,
});
const V = { resolved: 1, escalated: 0, refund_usd: 0 };
const done = (id: string, at = "2026-11-02T10:00:00Z", version = BASE, extra: Line = {}): Line[] => [call(id, at, version, extra), outcome(id, "2026-11-09T10:00:00Z", V)];
const csvRows = (csv: string) => parseCsv(csv, "x.csv").map((r) => r.fields);
const refused = (fn: () => unknown, code: string, pattern?: RegExp) => assert.throws(fn, (e) => { assert.ok(e instanceof PilotError, String(e)); assert.equal(e.code, code, e.message); if (pattern) assert.match(e.message, pattern); return true; });

test("one row per conversation with a call and an outcome; the others are counted by reason", () => {
  const x = buildLogExport(input([
    ...done("a"), ...done("b"),
    call("no-outcome", "2026-11-03T10:00:00Z"),
    outcome("no-call", "2026-11-05T10:00:00Z", V),
  ]));
  assert.equal(x.rows, 2);
  assert.deepEqual(x.left_out, { no_outcome: 1, outcome_without_call: 1, served_two_versions: 0, outside_window: 0 });
  assert.equal(x.header.expected_rows, 2);
  assert.deepEqual(csvRows(x.csv).map((r) => r[0]), ["conversation_id", "a", "b"]);
});

test("started_at is the first call's started_at, else its time; first means earliest; milliseconds are dropped", () => {
  const x = buildLogExport(input([
    call("late-first", "2026-11-03T10:00:00.900Z"), call("late-first", "2026-11-02T08:00:00.250Z", BASE, { started_at: "2026-11-02T07:59:00.500Z" }), outcome("late-first", "2026-11-09T00:00:00Z", V),
    call("plain", "2026-11-04T10:00:00.999Z"), outcome("plain", "2026-11-09T00:00:00Z", V),
    call("later-has-start", "2026-11-05T10:00:00Z"), call("later-has-start", "2026-11-05T11:00:00Z", BASE, { started_at: "2026-11-05T09:00:00Z" }), outcome("later-has-start", "2026-11-09T00:00:00Z", V),
  ]));
  const by = Object.fromEntries(csvRows(x.csv).slice(1).map((r) => [r[0], r[2]]));
  assert.deepEqual(by, { "late-first": "2026-11-02T07:59:00Z", plain: "2026-11-04T10:00:00Z", "later-has-start": "2026-11-05T10:00:00Z" });
});

test("the window is [start, end): the start counts, the end does not, and the header ends at the export time if that is earlier", () => {
  const x = buildLogExport(input([
    ...done("at-start", START, BASE), ...done("last-second", "2026-11-14T23:59:59Z"), ...done("at-end", END), ...done("before", "2026-10-31T23:59:59Z"),
  ]));
  assert.deepEqual(csvRows(x.csv).slice(1).map((r) => r[0]), ["at-start", "last-second"]);
  assert.equal(x.left_out.outside_window, 2);
  assert.deepEqual(x.header.window, { start: START, end: END });
  const early = buildLogExport(input([...done("a", "2026-11-02T00:00:00Z"), ...done("b", "2026-11-10T00:00:00Z")], { exported_at: "2026-11-05T00:00:00Z" }));
  assert.deepEqual(early.header.window, { start: START, end: "2026-11-05T00:00:00Z" });
  assert.equal(early.rows, 1, "a conversation that started after the export time is outside the window");
  assert.equal(early.left_out.outside_window, 1);
});

test("a conversation served by two versions is left out, and too many of them refuse the export", () => {
  const two = (id: string): Line[] => [call(id, "2026-11-02T10:00:00Z", BASE), call(id, "2026-11-02T10:05:00Z", CAND), outcome(id, "2026-11-09T00:00:00Z", V)];
  const ok = Array.from({ length: 98 }, (_, i) => done(`ok-${i}`)).flat();
  const x = buildLogExport(input([...ok, ...two("x1"), ...two("x2")]));
  assert.equal(x.rows, 98);
  assert.equal(x.left_out.served_two_versions, 2, "2 of 100 is exactly the limit and is allowed");
  assert.ok(!csvRows(x.csv).some((r) => r[0] === "x1"));
  refused(() => buildLogExport(input([...ok.slice(0, 194), ...two("x1"), ...two("x2"), ...two("x3")])), "telemetry_incomplete", /3 of 100 .*0\.02.*sticky/s);
  refused(() => buildLogExport(input([...two("x1")])), "telemetry_incomplete", /sticky/);
});

test("the version, unit, segment and model come from the first call", () => {
  const x = buildLogExport(input([
    call("c", "2026-11-02T10:00:00Z", BASE, { unit_id: "u1", segment: "chat", model_id: "m1" }),
    call("c", "2026-11-02T10:01:00Z", BASE, { unit_id: "u2", segment: "email", model_id: "m2" }), outcome("c", "2026-11-09T00:00:00Z", V),
  ]));
  assert.deepEqual(csvRows(x.csv)[1].slice(0, 6), ["c", BASE, "2026-11-02T10:00:00Z", "chat", "u1", "m1"]);
});

test("every contract metric is a column; a metric with no recorded value is empty; the newest value is used", () => {
  const x = buildLogExport(input([
    call("c", "2026-11-02T10:00:00Z"), outcome("c", "2026-11-03T00:00:00Z", { resolved: 0 }), outcome("c", "2026-11-04T00:00:00Z", { resolved: 1, refund_usd: 12.5 }),
  ]));
  assert.deepEqual(csvRows(x.csv), [
    ["conversation_id", "prompt_version", "started_at", "segment", "unit_id", "model_id", "resolved", "escalated", "refund_usd"],
    ["c", BASE, "2026-11-02T10:00:00Z", "", "", "", "1", "", "12.5"],
  ]);
  assert.deepEqual(x.header.units, { resolved: contract().primary.unit, escalated: contract().guards[0].unit, refund_usd: contract().guards[1].unit });
});

test("an outcome name that is not in the contract is refused by name, not turned into missing data", () => {
  refused(() => buildLogExport(input([call("c", "2026-11-02T10:00:00Z"), outcome("c", "2026-11-04T00:00:00Z", { resolvd: 1 })])), "invalid_telemetry", /resolvd/);
  // The name is printed safely.
  refused(() => buildLogExport(input([call("c", "2026-11-02T10:00:00Z"), outcome("c", "2026-11-04T00:00:00Z", { ["z".repeat(100)]: 1 })])), "invalid_telemetry", /cut at 40/);
});

test("tags outside the pilot are kept in the rows and counted, and the import refuses them", () => {
  const i = input([...done("a"), ...done("b", "2026-11-02T10:00:00Z", "juniper-v99-draft"), ...done("c", "2026-11-02T10:00:00Z", "juniper-v99-draft")]);
  const x = buildLogExport(i);
  assert.deepEqual(x.other_tags, { "juniper-v99-draft": 2 });
  assert.equal(x.rows, 3);
  assert.deepEqual(x.by_version, { [BASE]: 1, "juniper-v99-draft": 2 });
  refused(() => importTelemetry({ text: JSON.stringify(x.header), readSibling: () => x.csv, purpose: "experiment", scope_id: "0".repeat(64), contract: contract(), tags: [BASE, CAND] }), "telemetry_version_mismatch");
});

test("the header is what the import expects", () => {
  const x = buildLogExport(input(done("a")));
  assert.deepEqual(Object.keys(x.header), ["format", "export_id", "source", "exported_at", "window", "assignment", "denominator", "units", "expected_rows", "rows_csv"]);
  assert.equal(x.header.format, "synthe-pilot-telemetry/v1");
  assert.equal(x.header.source, "Synthe pilot call log (synthe-pilot-calls v1), 1 file");
  assert.equal(x.header.denominator, contract().denominator);
  assert.equal(x.header.rows_csv, "calllog-test.csv");
  assert.equal(x.header.exported_at, EXPORTED);
  assert.equal(x.header.assignment, "randomized");
});

test("ids with commas, quotes, spaces and line breaks survive the CSV and the import", () => {
  const ids = ['a,b', 'say "hi"', "with space", "line\nbreak", "cr\r\nlf", '"', ",", " lead"];
  const x = buildLogExport(input(ids.flatMap((id, i) => done(id, `2026-11-02T10:00:0${i}Z`, BASE, { unit_id: `${id},unit`, segment: `seg "${i}"` }))));
  const imp = importTelemetry({ text: JSON.stringify(x.header), readSibling: () => x.csv, purpose: "experiment", scope_id: "0".repeat(64), contract: contract(), tags: [BASE, CAND], window: { start: START, end: END } });
  assert.deepEqual(imp.rows?.map((r) => r.conversation_id).sort(), [...ids].sort());
  const r = imp.rows?.find((row) => row.conversation_id === 'say "hi"');
  assert.deepEqual([r?.unit_id, r?.segment], ['say "hi",unit', 'seg "1"']);
  assert.match(x.csv, /"say ""hi"""/);
});

test("a contract that pins a query hash is refused: a wrapper export carries none", () => {
  refused(() => buildLogExport(input(done("a"), { contract: contract({ query_hash: "a".repeat(64) }) })), "usage", /query/);
});

test("no completed conversation in the window is an incomplete export", () => {
  refused(() => buildLogExport(input([call("a", "2026-11-02T10:00:00Z")])), "telemetry_incomplete", /no completed conversation/);
  refused(() => buildLogExport(input(done("a", "2026-12-25T10:00:00Z"))), "telemetry_incomplete");
});

test("the window must be valid and non-empty", () => {
  refused(() => buildLogExport(input(done("a"), { window: { start: END, end: START } })), "usage");
  refused(() => buildLogExport(input(done("a"), { exported_at: "2026-10-01T00:00:00Z" })), "usage");
  refused(() => buildLogExport(input(done("a"), { window: { start: "yesterday", end: END } })), "usage");
});

// ---------------------------------------------------------------------------------------------------------------
// The proof: a log written by the real recorder gives the same import as the export it was made from.
// ---------------------------------------------------------------------------------------------------------------

test("a log recorded from a demo export imports to the same arms and rows as the demo export", () => {
  const start = DEMO.experiment_c_start;
  const exportedAt = addDays(start, 16);
  const demo = telemetryExport({
    export_id: "fernhill-direct", start, days: 14, exported_at: exportedAt, assignment: "randomized", lag_days: 2, csv_name: "direct.csv",
    arms: [
      { tag: BASE, per_day: 100, resolved: 0.62, escalated: 0.12, refunded: 0.15, refund_usd: 28 },
      { tag: CAND, per_day: 100, resolved: 0.665, escalated: 0.12, refunded: 0.15, refund_usd: 28.4 },
    ],
  });
  const [head, ...rows] = parseCsv(demo.csv, "direct.csv").map((r) => r.fields);
  const col = Object.fromEntries(head.map((h, i) => [h, i]));
  const dir = join(tmp("pilot-proof-"), "log");
  let clock = new Date(0);
  const rec = pilotRecorder({ logDir: dir, now: () => clock });
  for (const r of rows) {
    const at = new Date(r[col.started_at]);
    clock = new Date(at.getTime() + 5000);
    rec.record({ promptVersion: r[col.prompt_version], conversationId: r[col.conversation_id], unitId: r[col.unit_id], segment: r[col.segment], startedAt: at });
    clock = new Date(at.getTime() + 3_600_000);
    rec.outcome(r[col.conversation_id], Object.fromEntries(["resolved", "escalated", "refund_usd"].map((m) => [m, r[col[m]] === "" ? null : Number(r[col[m]])])));
  }
  assert.equal(rec.problems(), 0);
  const built = buildLogExport({
    log: readCallLog(dir), contract: contract(), tags: [BASE, CAND], window: { start, end: addDays(start, 14) }, exported_at: exportedAt,
    assignment: "randomized", export_id: "fernhill-from-log", csv_name: "from-log.csv",
  });
  assert.equal(built.rows, demo.rows);
  assert.equal(built.rows, 2800);
  const read = (x: { header: Record<string, unknown>; csv: string }) => importTelemetry({
    text: JSON.stringify(x.header), readSibling: () => x.csv, purpose: "experiment", scope_id: "1".repeat(64), contract: contract(), tags: [BASE, CAND], window: { start, end: addDays(start, 14) },
  });
  const a = read(demo);
  const b = read(built);
  assert.deepEqual(b.arms, a.arms);
  assert.deepEqual(b.rows, a.rows);
  assert.deepEqual(b.arms.map((x) => [x.tag, x.rows]), [[BASE, 1400], [CAND, 1400]]);
});

// ---------------------------------------------------------------------------------------------------------------
// Through a real pilot directory.
// ---------------------------------------------------------------------------------------------------------------

// Synthetic conversations for the days of a window: `perDay` per arm, with values that follow the demo's shares.
function writeLog(dir: string, tags: string[], start: string, days: number, perDay: number): void {
  let clock = new Date(0);
  const rec = pilotRecorder({ logDir: dir, idKey: "fernhill-test-key", now: () => clock });
  for (const [a, tag] of tags.entries()) {
    for (let d = 0; d < days; d++) {
      for (let i = 0; i < perDay; i++) {
        const at = new Date(Date.parse(start) + d * 86_400_000 + Math.floor((i * 86_400_000) / perDay) + a * 7000);
        const id = `conv-${tag}-${d}-${i}`;
        clock = at;
        rec.record({ promptVersion: tag, conversationId: id, unitId: `unit-${tag}-${d}-${i}`, segment: i % 3 === 0 ? "email" : "chat" });
        clock = new Date(at.getTime() + 600_000);
        rec.outcome(id, { resolved: (i * 7 + d) % 10 < 6 + a ? 1 : 0, escalated: (i + d) % 8 === 0 ? 1 : 0, refund_usd: i % 7 === 0 ? 28 : 0 });
      }
    }
  }
}
const deps = (lines: string[], now: string): PilotDeps => ({ say: (l) => { lines.push(l); }, env: {}, now: () => new Date(now) });

test("an experiment export from the real recorder is accepted by analyze", async () => {
  const ctx = await replayedPilot();
  try {
    const { eligible } = ctx;
    assert.equal(await ctx.run(["experiment", "--candidate", eligible, "--start", DEMO.experiment_b_start]), 0);
    const experiment = ctx.last("experiment.specified");
    assert.equal(await ctx.run(["review", "--candidate", eligible]), 0);
    ctx.on("2026-10-18");
    assert.equal(await ctx.run(["approve", "--candidate", eligible, "--experiment", experiment, "--approver", "Tomas Lindqvist"]), 0);

    const logDir = join(ctx.root, "agent-log");
    writeLog(logDir, [BASE, candidateTag(eligible)], DEMO.experiment_b_start, 5, 40);
    const lines: string[] = [];
    const now = "2026-10-24T09:00:00Z";
    // Without --assignment nothing is assumed.
    await assert.rejects(exportLog(ctx.store, { log: logDir, experiment: experiment.slice(0, 8) }, deps(lines, now)), (e) => e instanceof PilotError && e.code === "usage" && /--assignment is required/.test(e.message));
    assert.equal(existsSync(join(ctx.dir, "exports")), false, "nothing is written when the command is refused");

    assert.equal(await exportLog(ctx.store, { log: logDir, experiment: experiment.slice(0, 8), assignment: "randomized" }, deps(lines, now)), 0);
    const spec = ctx.store.get<ExperimentSpec>("experiment", experiment);
    assert.equal(spec.arms.candidate.tag, candidateTag(eligible));
    const files = readdirSync(join(ctx.dir, "exports")).sort();
    assert.deepEqual(files, [`calllog-${experiment.slice(0, 12)}-20261024T090000Z.csv`, `calllog-${experiment.slice(0, 12)}-20261024T090000Z.json`]);
    const path = join(ctx.dir, "exports", files[1]);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const said = lines.join("\n");
    assert.match(said, new RegExp(`Wrote the export: ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(said, /Conversations per prompt version: .*200/);
    assert.match(said, new RegExp(`Next: analyze --experiment ${experiment.slice(0, 12)} --telemetry `));
    assert.doesNotMatch(said, /conv-|unit-|fernhill-test-key/);
    assert.doesNotMatch(readFileSync(join(ctx.dir, "exports", files[0]), "utf8"), /conv-|unit-/, "the export holds only tokens");

    ctx.on("2026-10-24");
    assert.equal(await ctx.run(["analyze", "--experiment", experiment, "--telemetry", path]), 0, ctx.lines.slice(-4).join(" | "));
    assert.ok(ctx.lines.some((l) => /RECOMMENDATION/.test(l)));
  } finally { await ctx.stop(); }
});

test("an experiment export refuses a wrong assignment, and a baseline export refuses one that is not none", async () => {
  const ctx = await replayedPilot();
  try {
    await ctx.run(["experiment", "--candidate", ctx.eligible, "--start", DEMO.experiment_b_start]);
    const experiment = ctx.last("experiment.specified");
    const logDir = join(ctx.root, "agent-log");
    writeLog(logDir, [BASE, candidateTag(ctx.eligible)], DEMO.experiment_b_start, 2, 10);
    const run = (flags: Flags) => exportLog(ctx.store, { log: logDir, ...flags }, deps([], "2026-10-24T09:00:00Z"));
    const usage = (flags: Flags, pattern: RegExp) => assert.rejects(run(flags), (e) => e instanceof PilotError && e.code === "usage" && pattern.test(e.message), JSON.stringify(flags));
    await usage({ experiment, assignment: "none" }, /--assignment is required/);
    await usage({ experiment, assignment: "sometimes" }, /--assignment is required/);
    await usage({ experiment, baseline: true, assignment: "randomized" }, /not both/);
    await usage({ assignment: "randomized" }, /--experiment/);
    await usage({ baseline: true, start: "2026-10-01T00:00:00Z", end: "2026-10-15T00:00:00Z", assignment: "randomized" }, /Leave --assignment out/);
    await usage({ baseline: true, start: "2026-10-01T00:00:00Z" }, /--start and --end/);
    await usage({ baseline: true, start: "2026-10-15T00:00:00Z", end: "2026-10-01T00:00:00Z" }, /--end after --start/);
    await usage({ baseline: true, start: "soon", end: "later" }, /UTC times/);
    await usage({ experiment, assignment: "randomized", start: "2026-10-01T00:00:00Z" }, /baseline export/);
    await assert.rejects(exportLog(ctx.store, { experiment, assignment: "randomized" }, deps([], "2026-10-24T09:00:00Z")), (e) => e instanceof PilotError && e.code === "usage" && /--log/.test(e.message));
    await assert.rejects(run({ experiment: "deadbeef", assignment: "randomized" }), (e) => e instanceof PilotError && e.code === "not_found");
    assert.equal(await run({ experiment, assignment: "observational" }), 0);
    // The store-level function checks the same thing for callers that do not come through the command.
    assert.throws(() => writeLogExport({ store: ctx.store, logDir, scope: { experiment }, assignment: "none", now: new Date("2026-10-24T09:00:00Z") }), (e) => e instanceof PilotError && e.code === "usage");
  } finally { await ctx.stop(); }
});

test("a baseline export from the real recorder is accepted by baseline", async () => {
  const ctx = await workspace();
  try {
    assert.equal(await ctx.run(["init", "--config", ctx.put("pilot.json", json(demoConfig())), "--repo-dir", ctx.repoDir]), 0);
    const logDir = join(ctx.root, "agent-log");
    writeLog(logDir, [BASE], DEMO.baseline_window.start, 14, 60);
    const lines: string[] = [];
    const out = join(ctx.root, "elsewhere");
    assert.equal(await exportLog(ctx.store, { log: logDir, baseline: true, start: DEMO.baseline_window.start, end: addDays(DEMO.baseline_window.start, 14), out }, deps(lines, "2026-10-17T00:00:00Z")), 0);
    const path = join(out, "calllog-baseline-20261017T000000Z.json");
    assert.ok(existsSync(path));
    assert.ok(lines.some((l) => /Next: baseline --telemetry /.test(l)));
    ctx.on("2026-10-17");
    assert.equal(await ctx.run(["baseline", "--telemetry", path]), 0, ctx.lines.slice(-4).join(" | "));
  } finally { await ctx.stop(); }
});

test("problems found by the import are reported before anything is written, and the notes name what was left out", async () => {
  const ctx = await frozenPilot();
  try {
    const logDir = join(ctx.root, "agent-log");
    // A tag the pilot does not name: the import refuses it, so no file is written.
    writeLog(logDir, [BASE, "juniper-v99-draft"], DEMO.baseline_window.start, 2, 10);
    const base = { store: ctx.store, logDir, scope: { baseline: { start: DEMO.baseline_window.start, end: addDays(DEMO.baseline_window.start, 14) } }, assignment: "none" as const, outDir: join(ctx.root, "out"), now: new Date("2026-10-17T00:00:00Z") };
    refused(() => writeLogExport(base), "telemetry_version_mismatch");
    assert.equal(existsSync(join(ctx.root, "out")), false);

    // A clean log with some damage: the notes say so, and print no id.
    const clean = join(ctx.root, "clean-log");
    writeLog(clean, [BASE], DEMO.baseline_window.start, 2, 10);
    const file = join(clean, readdirSync(clean).find((n) => n.startsWith("calls-")) as string);
    writeFileSync(file, `${readFileSync(file, "utf8")}garbage\n${JSON.stringify({ v: 1, type: "problem", at: "2026-10-02T00:00:00Z", kind: "write_failed" })}\n${JSON.stringify(call("conv-orphan-secret", "2026-10-02T01:00:00Z"))}\n${JSON.stringify(outcome("conv-nocall-secret", "2026-10-02T01:00:00Z", V))}\n`);
    const done = writeLogExport({ ...base, logDir: clean });
    assert.equal(done.rows, 20);
    assert.deepEqual(done.notes.map((n) => n.replace(/\d+/g, "N")), [
      "N conversation was left out because no outcome is recorded for it yet.",
      "N conversation has an outcome but no recorded call, so it was left out. Check that every agent call goes through the recorder.",
      "N line of the log could not be read and was skipped.",
      "The recorder logged N problem of kind write_failed: some calls or outcomes may be missing from the log.",
    ]);
    assert.doesNotMatch(done.notes.join(" "), /secret/);
  } finally { await ctx.stop(); }
});
