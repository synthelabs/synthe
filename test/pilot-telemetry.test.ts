import assert from "node:assert/strict";
import { test } from "node:test";
import { PilotError } from "../src/pilot/errors.ts";
import { contentId } from "../src/pilot/ids.ts";
import { baselineReport, importProblem, importTelemetry, parseCsv, renderBaseline, type ImportInput } from "../src/pilot/telemetry.ts";
import { sampleSizeProportions, wilsonInterval } from "../src/pilot/stats.ts";
import type { PilotErrorCode, Stored, TelemetryExport, TelemetryImport, TelemetryRow } from "../src/pilot/types.ts";
import { BASE_TAG, CAND_TAG, CONFIG_ID, EXPERIMENT_ID, UNITS, baseExport, contract, isoAt, row } from "./pilot-metric-helpers.ts";

const C = contract();
const START = "2026-09-01T00:00:00Z";

// Ten baseline rows, one a day from Sep 1 00:30 to Sep 10 00:30. resolved: 1 for even i (5 of 10); escalated: 1 for
// i = 3 (1 of 10); csat: i % 5 + 1 (1 to 5 twice). Segments: five "returns", five "orders".
function tenRows(): TelemetryRow[] {
  return Array.from({ length: 10 }, (_, i) =>
    row(i + 1, BASE_TAG, isoAt(START, i * 24 * 60 + 30), { resolved: i % 2 === 0 ? 1 : 0, escalated: i === 3 ? 1 : 0, csat: (i % 5) + 1 }, { segment: i < 5 ? "returns" : "orders" }));
}

const exp = (over: Partial<TelemetryExport> = {}) => baseExport({ exported_at: "2026-09-15T00:00:00Z", expected_rows: 10, rows: tenRows(), ...over });

function run(e: unknown, over: Partial<ImportInput> = {}): TelemetryImport {
  return importTelemetry({ text: typeof e === "string" ? e : JSON.stringify(e), purpose: "baseline", scope_id: CONFIG_ID, contract: C, tags: [BASE_TAG], ...over });
}

function refused(e: unknown, code: PilotErrorCode, pattern: RegExp, over: Partial<ImportInput> = {}) {
  assert.throws(() => run(e, over), (err: unknown) => {
    assert.ok(err instanceof PilotError, `expected PilotError, got ${err}`);
    assert.equal(err.code, code, err.message);
    assert.match(err.message, pattern);
    // Messages are printed: never a conversation id or a unit id.
    assert.doesNotMatch(err.message, /c-\d{6}|u-\d{4}/);
    return true;
  });
}

const store = (v: TelemetryImport): Stored<TelemetryImport> => ({ id: contentId(v), value: v });

test("rows form imports, with arm counts and only documented fields", () => {
  const r = run(exp());
  assert.equal(r.form, "rows");
  assert.equal(r.purpose, "baseline");
  assert.equal(r.scope_id, CONFIG_ID);
  assert.equal(r.expected_rows, 10);
  assert.equal(r.duplicates_dropped, 0);
  assert.equal(r.rows!.length, 10);
  assert.equal(r.aggregates, null);
  assert.deepEqual(r.arms, [{ tag: BASE_TAG, rows: 10, mature: 10, immature: 0, unattributed: 0, segments: { returns: 5, orders: 5 } }]);
});

test("immature rows are counted from exported_at and the outcome lag", () => {
  // exported_at Sep 11 00:00 with a 2-day lag: rows started Sep 9 00:30 and Sep 10 00:30 mature after the export.
  // The row started Sep 8 00:30 matures Sep 10 00:30, before it.
  const r = run(exp({ exported_at: "2026-09-11T00:00:00Z" }));
  assert.equal(r.arms[0].immature, 2);
  assert.equal(r.arms[0].mature, 8);
});

test("content id does not depend on the order the export lists rows", () => {
  const a = run(exp());
  const b = run(exp({ rows: tenRows().reverse() }));
  assert.equal(contentId(a), contentId(b));
});

test("exact duplicate rows are dropped and counted", () => {
  const rows = tenRows();
  const r = run(exp({ rows: [...rows, rows[2], rows[2], rows[7]] }));
  assert.equal(r.duplicates_dropped, 3);
  assert.equal(r.rows!.length, 10);
  assert.equal(r.arms[0].rows, 10);
});

test("the same conversation twice with different content is telemetry_duplicate", () => {
  const rows = tenRows();
  refused(exp({ rows: [...rows, { ...rows[2], values: { ...rows[2].values, resolved: 0 } }] }), "telemetry_duplicate", /1 row repeat/);
});

test("the same conversation under a second id is telemetry_duplicate when the rows carry a unit id", () => {
  const rows = tenRows().map((r, i) => ({ ...r, unit_id: `u-${i}` }));
  const again = { ...rows[2], conversation_id: "c-rekeyed" };
  refused(exp({ rows: [...rows, again], expected_rows: 11 }), "telemetry_duplicate", /1 row is the same conversation under a different conversation_id/);
  // Another conversation of the same unit, at another time or with another outcome, is not a copy.
  const later = { ...rows[2], conversation_id: "c-later", started_at: isoAt(rows[2].started_at, 1) };
  assert.equal(run(exp({ rows: [...rows, later], expected_rows: 11 })).rows!.length, 11);
  // Without a unit id two conversations can start in the same second with the same outcome, so nothing is refused.
  const anonymous = tenRows();
  assert.equal(run(exp({ rows: [...anonymous, { ...anonymous[2], conversation_id: "c-rekeyed" }], expected_rows: 11 })).rows!.length, 11);
});

test("a stored import must agree with itself", () => {
  const good = run(exp());
  assert.equal(importProblem(good, C.outcome_lag_days), null);
  assert.match(importProblem({ ...good, arms: [] }, C.outcome_lag_days) ?? "", /per-arm counts do not follow from its rows/);
  assert.match(importProblem({ ...good, expected_rows: 11 }, C.outcome_lag_days) ?? "", /row count/);
  assert.match(importProblem({ ...good, rows: [...good.rows!, good.rows![0]], expected_rows: 11 }, C.outcome_lag_days) ?? "", /appears twice/);
  // A value on a conversation that was inside the outcome lag is never stored by an import.
  const young = run(exp({ exported_at: "2026-09-11T00:00:00Z" }));
  assert.ok(young.provisional_values_dropped > 0);
  assert.equal(importProblem(young, C.outcome_lag_days), null);
  const forged = { ...young, rows: young.rows!.map((r) => ({ ...r, values: { ...r.values, resolved: 1 } })) };
  assert.match(importProblem(forged, C.outcome_lag_days) ?? "", /inside the outcome lag|per-arm counts/);
});

test("CSV rows import with RFC 4180 quoting and give the same content id as inline rows", () => {
  const lines = ["conversation_id,prompt_version,started_at,segment,resolved,escalated,csat"];
  for (const r of tenRows()) lines.push([r.conversation_id, r.prompt_version, r.started_at, r.segment, r.values.resolved, r.values.escalated, r.values.csat].join(","));
  const csv = `${lines.join("\r\n")}\r\n`;
  const fromCsv = run(exp({ rows: undefined, rows_csv: "rows.csv" }), { readSibling: (n) => { assert.equal(n, "rows.csv"); return csv; } });
  assert.equal(contentId(fromCsv), contentId(run(exp())));

  // Quoted fields, doubled quotes, commas inside quotes, an empty metric cell is null, an empty optional cell is absent.
  const quoted = [
    "conversation_id,prompt_version,started_at,segment,resolved,escalated,csat,model_id",
    `c-000001,${BASE_TAG},2026-09-01T00:30:00Z,"returns, exchanges",1,0,,`,
    `"c-000002","${BASE_TAG}",2026-09-02T00:30:00Z,"the ""big"" sale",0,0,4.5,model-a`,
  ].join("\n");
  const q = run(exp({ rows: undefined, rows_csv: "q.csv", expected_rows: 2 }), { readSibling: () => quoted });
  assert.deepEqual(q.rows![0], { conversation_id: "c-000001", prompt_version: BASE_TAG, started_at: "2026-09-01T00:30:00Z", segment: "returns, exchanges", values: { resolved: 1, escalated: 0, csat: null } });
  assert.equal(q.rows![1].segment, 'the "big" sale');
  assert.equal(q.rows![1].values.csat, 4.5);
  assert.equal(q.rows![1].model_id, "model-a");
});

test("CSV refusals: wrong field count names the line, unknown column, missing column, bad value, no reader", () => {
  const head = "conversation_id,prompt_version,started_at,resolved,escalated,csat";
  const ok = `c-000001,${BASE_TAG},2026-09-01T00:30:00Z,1,0,3`;
  const e = exp({ rows: undefined, rows_csv: "rows.csv", expected_rows: 1 });
  refused(e, "invalid_telemetry", /rows\.csv line 3 has 5 fields; the header has 6/, { readSibling: () => `${head}\n${ok}\nc-000002,${BASE_TAG},2026-09-01T00:30:00Z,1,0\n` });
  refused(e, "invalid_telemetry", /undocumented column "email"/, { readSibling: () => `${head},email\n${ok},x\n` });
  refused(e, "invalid_telemetry", /no "csat" column/, { readSibling: () => "conversation_id,prompt_version,started_at,resolved,escalated\n" });
  refused(e, "invalid_telemetry", /resolved is a rate/, { readSibling: () => `${head}\nc-000001,${BASE_TAG},2026-09-01T00:30:00Z,0.5,0,3\n` });
  refused(e, "invalid_telemetry", /csat must be a finite number/, { readSibling: () => `${head}\nc-000001,${BASE_TAG},2026-09-01T00:30:00Z,1,0,good\n` });
  refused(e, "invalid_telemetry", /never closed/, { readSibling: () => `${head}\n"c-000001,${BASE_TAG},2026-09-01T00:30:00Z,1,0,3\n` });
  refused(e, "invalid_telemetry", /no way to read files next to the export/);
  assert.deepEqual(parseCsv('a,"b\nc",d\ne,f,g', "x.csv"), [{ line: 1, fields: ["a", "b\nc", "d"] }, { line: 3, fields: ["e", "f", "g"] }]);
});

test("aggregates form imports", () => {
  const e = baseExport({
    aggregates: [{ prompt_version: BASE_TAG, n: 400, immature: 20, unattributed: 0, segments: { returns: 250, orders: 170 }, metrics: {
      resolved: { kind: "rate", successes: 160, missing: 0 }, escalated: { kind: "rate", successes: 40, missing: 4 }, csat: { kind: "mean", mean: 4.1, sd: 0.9, missing: 10 },
    } }],
  });
  const r = run(e);
  assert.equal(r.form, "aggregates");
  assert.equal(r.rows, null);
  assert.equal(r.expected_rows, null);
  assert.deepEqual(r.arms, [{ tag: BASE_TAG, rows: 420, mature: 400, immature: 20, unattributed: 0, segments: { returns: 250, orders: 170 } }]);
});

test("aggregates refusals", () => {
  const agg = (over: Record<string, unknown> = {}, metrics: Record<string, unknown> = {}) => ({
    prompt_version: BASE_TAG, n: 100, immature: 0, unattributed: 0,
    metrics: { resolved: { kind: "rate", successes: 40, missing: 0 }, escalated: { kind: "rate", successes: 5, missing: 0 }, csat: { kind: "mean", mean: 4, sd: 1, missing: 0 }, ...metrics },
    ...over,
  });
  const e = (aggregates: unknown[]) => baseExport({ aggregates: aggregates as never });
  refused(e([agg(), agg()]), "telemetry_duplicate", /two aggregates for fernhill-v7/);
  refused(e([agg({ n: -1 })]), "invalid_telemetry", /n must be a whole number/);
  refused(e([agg({ immature: 1.5 })]), "invalid_telemetry", /immature must be a whole number/);
  refused(e([agg({}, { resolved: { kind: "rate", successes: 90, missing: 20 } })]), "invalid_telemetry", /successes plus missing is more than n/);
  refused(e([agg({}, { resolved: { kind: "mean", mean: 1, sd: 0, missing: 0 } })]), "invalid_telemetry", /kind must be "rate"/);
  refused(e([agg({}, { csat: { kind: "mean", mean: 4, sd: -1, missing: 0 } })]), "invalid_telemetry", /sd must be/);
  refused(e([agg({}, { csat: { kind: "mean", mean: 4, sd: 1, missing: 101 } })]), "invalid_telemetry", /missing must be a whole number from 0 to n/);
  refused(e([agg({ segments: { returns: -2 } })]), "invalid_telemetry", /segment counts/);
  const noCsat = agg();
  delete (noCsat.metrics as Record<string, unknown>).csat;
  refused(e([noCsat]), "invalid_telemetry", /missing csat/);
  refused(e([agg({ prompt_version: "fernhill-v6" })]), "telemetry_version_mismatch", /fernhill-v6/);
  refused(e([]), "telemetry_incomplete", /no conversations/);
});

test("structural refusals are invalid_telemetry", () => {
  refused("{not json", "invalid_telemetry", /not valid JSON/);
  refused(exp({ format: "other/v1" as never }), "invalid_telemetry", /format/);
  refused(exp({ export_id: "" }), "invalid_telemetry", /export_id/);
  refused(exp({ source: "" }), "invalid_telemetry", /source/);
  refused(exp({ exported_at: "2026-09-15" }), "invalid_telemetry", /exported_at/);
  refused(exp({ window: { start: "2026-09-15T00:00:00Z", end: "2026-09-01T00:00:00Z" } }), "invalid_telemetry", /window\.start must be before/);
  refused(exp({ assignment: "ab" as never }), "invalid_telemetry", /assignment must be/);
  refused(exp({ rows_csv: "x.csv" }), "invalid_telemetry", /exactly one of rows, rows_csv or aggregates.*rows and rows_csv/);
  refused(exp({ rows: undefined }), "invalid_telemetry", /exactly one.*none/);
  refused({ ...exp(), customer_email: "x" }, "invalid_telemetry", /undocumented top-level field "customer_email"/);
  refused(exp({ rows: [{ ...tenRows()[0], customer_name: "x" } as never] }), "invalid_telemetry", /row 1 has an undocumented field "customer_name"/);
  refused(exp({ rows: [{ ...tenRows()[0], started_at: 5 } as never] }), "invalid_telemetry", /row 1: started_at must be a non-empty string/);
  refused(exp({ rows: [{ ...tenRows()[0], values: { resolved: 2, escalated: 0, csat: 1 } }] }), "invalid_telemetry", /resolved is a rate/);
  refused(exp({ rows: [{ ...tenRows()[0], values: { resolved: 1, escalated: 0, csat: "4" } as never }] }), "invalid_telemetry", /csat must be a finite number/);
  refused(exp({ rows: [{ ...tenRows()[0], values: { resolved: 1, escalated: 0 } }] }), "invalid_telemetry", /values is missing csat/);
  refused(exp({ assignment: "randomized" }), "invalid_telemetry", /baseline.*assignment must be "none"/);
  refused(exp({ assignment: "none" }), "invalid_telemetry", /experiment.*not "none"/, { purpose: "experiment", scope_id: EXPERIMENT_ID });
  refused(exp({ exported_at: "2026-09-05T00:00:00Z" }), "invalid_telemetry", /earlier than the start of 6 rows/);
  refused(exp({ rows: [{ ...tenRows()[0], conversation_id: "c".repeat(201) }] }), "invalid_telemetry", /longer than 200/);
});

test("personal data in an id is refused, naming the kind and field but never the value", () => {
  const leaked = "jo.bloggs@example.com";
  assert.throws(() => run(exp({ rows: [{ ...tenRows()[0], unit_id: leaked }] })), (err: unknown) => {
    assert.ok(err instanceof PilotError && err.code === "invalid_telemetry");
    assert.match(err.message, /row 1: unit_id contains what looks like a email address/);
    assert.ok(!err.message.includes(leaked));
    return true;
  });
  refused(exp({ rows: [{ ...tenRows()[0], conversation_id: "4111 1111 1111 1111" }] }), "invalid_telemetry", /conversation_id contains what looks like a payment card number/);
  refused(exp({ rows: [{ ...tenRows()[0], segment: "ssn 123-45-6789" }] }), "invalid_telemetry", /segment contains what looks like a national identity number/);
});

test("a version tag the pilot does not name refuses the whole import", () => {
  const rows = tenRows();
  rows[1] = { ...rows[1], prompt_version: "fernhill-v6" };
  rows[2] = { ...rows[2], prompt_version: "fernhill-v6" };
  rows[3] = { ...rows[3], prompt_version: "beta" };
  refused(exp({ rows }), "telemetry_version_mismatch", /3 rows carry a prompt_version.*\(beta, fernhill-v6\)/);
});

test("an experiment export may lack one arm (an interim export), but zero rows is incomplete", () => {
  const rows = tenRows();
  const r = run(exp({ assignment: "randomized", rows }), { purpose: "experiment", scope_id: EXPERIMENT_ID, tags: [BASE_TAG, CAND_TAG] });
  assert.deepEqual(r.arms.map((a) => a.tag), [BASE_TAG]);
  refused(exp({ assignment: "randomized", rows: [], expected_rows: 0 }), "telemetry_incomplete", /no rows/, { purpose: "experiment", scope_id: EXPERIMENT_ID, tags: [BASE_TAG, CAND_TAG] });
});

test("rows outside the window are telemetry_window_mismatch", () => {
  const rows = tenRows();
  rows[0] = { ...rows[0], started_at: "2026-08-31T23:59:59Z" };
  refused(exp({ rows }), "telemetry_window_mismatch", /1 row started outside the export's own window/);
  const atEnd = tenRows();
  atEnd[9] = { ...atEnd[9], started_at: "2026-09-15T00:00:00Z" };
  refused(exp({ rows: atEnd, exported_at: "2026-09-16T00:00:00Z" }), "telemetry_window_mismatch", /outside the export's own window/);
  // The experiment window is narrower than the export's.
  refused(exp(), "telemetry_window_mismatch", /not inside the experiment window/, { window: { start: "2026-09-02T00:00:00Z", end: "2026-09-16T00:00:00Z" } });
});

test("unit, denominator and query hash mismatches", () => {
  refused(exp({ units: { ...UNITS, csat: "rating 1-10" } }), "telemetry_unit_mismatch", /csat is "rating 1-10" but the contract's is "rating 1-5"/);
  const noUnit: Record<string, string> = { ...UNITS };
  delete noUnit.escalated;
  refused(exp({ units: noUnit }), "telemetry_unit_mismatch", /no unit for escalated/);
  refused(exp({ denominator: "all_conversations" }), "telemetry_denominator_mismatch", /all_conversations/);
  const pinned = contract({ query_hash: "a".repeat(64) });
  refused(exp(), "telemetry_denominator_mismatch", /carries no query_hash/, { contract: pinned });
  refused(exp({ query_hash: "b".repeat(64) }), "telemetry_denominator_mismatch", /query_hash differs/, { contract: pinned });
  assert.equal(run(exp({ query_hash: "a".repeat(64) }), { contract: pinned }).form, "rows");
});

test("a truncated export is telemetry_incomplete", () => {
  refused(exp({ expected_rows: 12 }), "telemetry_incomplete", /10 distinct conversations but expected_rows says 12/);
  refused(exp({ expected_rows: undefined }), "telemetry_incomplete", /needs expected_rows/);
  // Exact duplicates do not count towards expected_rows.
  const rows = tenRows();
  assert.equal(run(exp({ rows: [...rows, rows[0]], expected_rows: 10 })).duplicates_dropped, 1);
});

test("baseline report numbers on a small hand-checkable export", () => {
  const imp = store(run(exp()));
  const report = baselineReport({ config_id: CONFIG_ID, contract: C, tag: BASE_TAG, imports: [imp] });
  assert.equal(report.rows, 10);
  assert.equal(report.mature, 10);
  assert.equal(report.immature, 0);
  assert.deepEqual(report.telemetry_ids, [imp.id]);
  const [resolved, escalated, csat] = report.metrics;
  assert.equal(resolved.name, "resolved");
  assert.equal(resolved.role, "primary");
  assert.equal(resolved.n, 10);
  assert.equal(resolved.estimate.value, 0.5);
  assert.deepEqual(resolved.ci, wilsonInterval(5, 10, 0.95));
  assert.equal(resolved.estimate.source, `telemetry:${imp.id.slice(0, 12)}`);
  assert.match(resolved.estimate.method, /Wilson/);
  assert.equal(escalated.estimate.value, 0.1);
  // csat: 1,2,3,4,5,1,2,3,4,5: mean 3, sample sd sqrt(20/9) = 1.4907; t(0.975, 9) = 2.262157.
  assert.equal(csat.estimate.value, 3);
  const half = 2.262157 * Math.sqrt(20 / 9) / Math.sqrt(10);
  assert.ok(Math.abs(csat.ci!.lo - (3 - half)) < 1e-5 && Math.abs(csat.ci!.hi - (3 + half)) < 1e-5);
  assert.match(csat.estimate.method, /one-sample t/);
  // 10 mature conversations over 14 days.
  assert.equal(report.daily_volume.value, 10 / 14);
  // Power for 0.5 -> 0.55: well above min_samples_per_arm.
  const power = sampleSizeProportions(0.5, 0.05, "higher_is_better", 0.05, 0.8)!;
  assert.equal(power, 1565);
  assert.equal(report.required_per_arm.value, 1565);
  assert.match(report.required_per_arm.method, /baseline rate 0\.5, change 0\.05.*alpha 0\.05, power 0\.8/);
  assert.equal(report.days_to_required.value, Math.ceil((2 * 1565) / (10 / 14)));
  assert.deepEqual(report.flags, ["window_too_short_for_required_samples"]);

  const md = renderBaseline(report, C, "f".repeat(64));
  assert.match(md, /^# Baseline: resolved is 50%/);
  assert.ok(md.includes("f".repeat(64)) && md.includes(imp.id) && md.includes(CONFIG_ID));
  assert.doesNotMatch(md, /c-\d{6}/);
});

test("importing the same export twice does not change any count", () => {
  const imp = store(run(exp()));
  const once = baselineReport({ config_id: CONFIG_ID, contract: C, tag: BASE_TAG, imports: [imp] });
  const twice = baselineReport({ config_id: CONFIG_ID, contract: C, tag: BASE_TAG, imports: [imp, imp] });
  assert.deepEqual(twice, once);
  // A second export of the same conversations with a different id overlaps fully: counts still do not double.
  const again = store(run(exp({ export_id: "fernhill-export-002", exported_at: "2026-09-16T00:00:00Z" })));
  const both = baselineReport({ config_id: CONFIG_ID, contract: C, tag: BASE_TAG, imports: [imp, again] });
  assert.equal(both.rows, 10);
  assert.equal(both.metrics[0].n, 10);
});

test("baseline flags and refusals", () => {
  // Missing events: 1 of 5 mature conversations has no csat (20% > 5%). Short window: 5 days.
  const rows = tenRows().slice(0, 5);
  rows[0] = { ...rows[0], values: { ...rows[0].values, csat: null } };
  const imp = store(run(exp({ rows, expected_rows: 5, window: { start: START, end: "2026-09-06T00:00:00Z" }, exported_at: "2026-09-10T00:00:00Z" })));
  const r = baselineReport({ config_id: CONFIG_ID, contract: C, tag: BASE_TAG, imports: [imp] });
  assert.equal(r.metrics[2].missing, 1);
  assert.equal(r.metrics[2].n, 4);
  assert.ok(r.flags.includes("short_window") && r.flags.includes("missing_events"));
  // No mature rows: everything inside the lag. Power cannot be computed.
  const young = store(run(exp({ rows: tenRows().slice(9), expected_rows: 1, exported_at: "2026-09-11T00:00:00Z" })));
  const y = baselineReport({ config_id: CONFIG_ID, contract: C, tag: BASE_TAG, imports: [young] });
  assert.ok(y.flags.includes("no_mature_rows"));
  assert.equal(y.required_per_arm.value, null);
  assert.equal(y.days_to_required.value, null);
  assert.equal(y.metrics[0].estimate.value, null);
  assert.equal(y.metrics[0].ci, null);
  assert.match(renderBaseline(y, C, "f".repeat(64)), /No conversation is old enough/);

  const expImport = store(run(exp({ assignment: "randomized" }), { purpose: "experiment", scope_id: EXPERIMENT_ID }));
  assert.throws(() => baselineReport({ config_id: CONFIG_ID, contract: C, tag: BASE_TAG, imports: [expImport] }), (e: unknown) => e instanceof PilotError && e.code === "invalid_telemetry");
  const other = store(run(exp(), { scope_id: "d".repeat(64) }));
  assert.throws(() => baselineReport({ config_id: CONFIG_ID, contract: C, tag: BASE_TAG, imports: [other] }), (e: unknown) => e instanceof PilotError && e.code === "invalid_telemetry");
  assert.throws(() => baselineReport({ config_id: CONFIG_ID, contract: C, tag: BASE_TAG, imports: [] }), (e: unknown) => e instanceof PilotError && e.code === "telemetry_incomplete");
  assert.throws(() => baselineReport({ config_id: CONFIG_ID, contract: C, tag: "fernhill-v8", imports: [imp] }), (e: unknown) => e instanceof PilotError && e.code === "telemetry_version_mismatch");
});

test("a mean primary metric is sized from the baseline sd", () => {
  const meanContract = contract({ primary: { name: "csat", kind: "mean", unit: "rating 1-5", direction: "higher_is_better", min_effect: 0.5 }, guards: [] });
  const imp = store(importTelemetry({ text: JSON.stringify(exp({ units: { csat: "rating 1-5" }, rows: tenRows().map((r) => ({ ...r, values: { csat: r.values.csat } })) })), purpose: "baseline", scope_id: CONFIG_ID, contract: meanContract, tags: [BASE_TAG] }));
  const r = baselineReport({ config_id: CONFIG_ID, contract: meanContract, tag: BASE_TAG, imports: [imp] });
  // 2 * (1.959964 + 0.841621)^2 * (20/9) / 0.25 = 139.5 -> 140.
  assert.equal(r.required_per_arm.value, 140);
});

test("a value exported while the conversation is still inside the outcome lag is stored as not known yet", () => {
  // exported_at Sep 11 00:00 with a 2-day lag: the rows of Sep 9 and Sep 10 carry values, but those can still change.
  const r = run(exp({ exported_at: "2026-09-11T00:00:00Z" }));
  assert.equal(r.provisional_values_dropped, 2);
  const late = r.rows!.filter((x) => x.started_at >= "2026-09-09T00:00:00Z");
  assert.equal(late.length, 2);
  assert.ok(late.every((x) => Object.values(x.values).every((v) => v === null)));
  assert.ok(r.rows!.filter((x) => x.started_at < "2026-09-09T00:00:00Z").every((x) => x.values.resolved !== null));
  // An export made after the lag keeps every value.
  assert.equal(run(exp()).provisional_values_dropped, 0);
  // The query hash an export carries is kept, so exports made with different queries can be told apart later.
  assert.equal(run(exp({ query_hash: "a".repeat(64) })).query_hash, "a".repeat(64));
  assert.equal(run(exp()).query_hash, null);
});

test("a refusal never repeats a name the export made up, because it can be data", () => {
  const e = exp({ rows: undefined, rows_csv: "rows.csv", expected_rows: 1 });
  // A CSV with no header line: its first data row is read as the column names.
  const noHeader = `c-juniper-000001,${BASE_TAG},2026-09-01T00:30:00Z,1,0,3\n`;
  assert.throws(() => run(e, { readSibling: () => noHeader }), (err: unknown) => {
    assert.ok(err instanceof PilotError && err.code === "invalid_telemetry", String(err));
    assert.ok(!err.message.includes("c-juniper-000001") && !err.message.includes(BASE_TAG), err.message);
    assert.match(err.message, /undocumented column with a name that is not a plain lowercase word/);
    return true;
  });
  const withField = exp();
  (withField.rows![0] as unknown as Record<string, unknown>)["Jane Doe <jane>"] = 1;
  assert.throws(() => run(withField), (err: unknown) => err instanceof PilotError && !err.message.includes("Jane") && /undocumented field with a name/.test(err.message));
  refused(JSON.parse(JSON.stringify(exp()).replace('"format"', '"__proto__": {"x": 1}, "format"')), "invalid_telemetry", /__proto__, constructor or prototype/);
});
