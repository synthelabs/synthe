// Regression test (review, engine lens): aggregate counts above Number.MAX_SAFE_INTEGER cannot be exact, so an export
// that carries them must be refused, never analysed. At 87edaa9 a consistent export with n = 1e18 per arm imports and
// gives keep.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PilotError } from "../src/pilot/errors.ts";
import { analyzeExperiment, buildExperimentSpec } from "../src/pilot/experiment.ts";
import { contentId } from "../src/pilot/ids.ts";
import { parseMetricContract } from "../src/pilot/metric.ts";
import { demoConfig } from "../src/pilot/demo-data.ts";
import { importTelemetry } from "../src/pilot/telemetry.ts";
import { TELEMETRY_FORMAT } from "../src/pilot/types.ts";

const contract = parseMetricContract((demoConfig() as { metric: unknown }).metric);
const B = "juniper-v14", C = "synthe-222222222222", EXP = "e".repeat(64), START = "2026-11-02T00:00:00Z";
const s = (value: number | null) => ({ value, source: "telemetry:0", method: "test" });
const spec = buildExperimentSpec({
  pilot_id: "fernhill-juniper", config_id: "c".repeat(64), contract, baseline: { prompt_id: "1".repeat(64), tag: B }, candidate: { prompt_id: "2".repeat(64), tag: C }, start: START,
  baseline_report: { version: 1, config_id: "c".repeat(64), telemetry_ids: [], tag: B, window: { start: START, end: "2026-11-16T00:00:00Z" }, rows: 0, mature: 0, immature: 0, daily_volume: s(1), metrics: [], required_per_arm: s(4040), days_to_required: s(null), flags: [] } as never,
});
const units = Object.fromEntries([contract.primary, ...contract.guards].map((m) => [m.name, m.unit]));
function arm(tag: string, n: number, resolved: number) {
  return { prompt_version: tag, n, immature: 0, unattributed: 0, metrics: {
    resolved: { kind: "rate", successes: Math.round(n * resolved), missing: 0 },
    escalated: { kind: "rate", successes: Math.round(n * 0.12), missing: 0 },
    refund_usd: { kind: "mean", mean: 4.2, sd: 10, missing: 0, nonzero: Math.round(n * 0.15) },
  } };
}
const exportOf = (n: number) => JSON.stringify({ format: TELEMETRY_FORMAT, export_id: "huge", source: "synthetic", exported_at: "2026-11-18T00:00:00Z", window: { start: START, end: "2026-11-16T00:00:00Z" }, assignment: "randomized", denominator: contract.denominator, units, aggregates: [arm(B, n, 0.62), arm(C, n, 0.665)] });

test("the same export with ordinary counts gives keep (control)", () => {
  const v = importTelemetry({ text: exportOf(4480), purpose: "experiment", scope_id: EXP, contract, tags: [B, C], window: spec.window });
  assert.equal(analyzeExperiment({ spec, experiment_id: EXP, imports: [{ id: contentId(v), value: v }], approval_id: "a".repeat(64), approved_at: START }).recommendation, "keep");
});

test("aggregate counts above 2^53 are refused with a PilotError, never analysed", () => {
  assert.throws(() => {
    const v = importTelemetry({ text: exportOf(1e18), purpose: "experiment", scope_id: EXP, contract, tags: [B, C], window: spec.window });
    const a = analyzeExperiment({ spec, experiment_id: EXP, imports: [{ id: contentId(v), value: v }], approval_id: "a".repeat(64), approved_at: START });
    assert.fail(`imported and analysed: ${a.recommendation}`);
  }, (e: unknown) => e instanceof PilotError);
});

// The ceiling itself, below 2^53: a count the double still holds exactly, yet larger than any pilot can have.
test("a count above 1e12 is refused even when it is still an exact integer; 1e12 itself is read", () => {
  const read = (n: number) => importTelemetry({ text: exportOf(n), purpose: "experiment", scope_id: EXP, contract, tags: [B, C], window: spec.window });
  assert.ok(Number.isSafeInteger(4e12));
  assert.throws(() => read(4e12), (e: unknown) => e instanceof PilotError && e.code === "invalid_telemetry");
  assert.throws(() => read(1e12 + 2), (e: unknown) => e instanceof PilotError && e.code === "invalid_telemetry");
  assert.equal(read(1e12).arms.length, 2);
});
