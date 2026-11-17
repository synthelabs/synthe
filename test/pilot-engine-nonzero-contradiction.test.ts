// Regression test (review, engine lens): a mean guard aggregate that says mean 0 and sd 0 (every value is 0) cannot
// also have non-zero values. At 87edaa9 such an export certifies the mean guard (S-01) and gives keep, while the same
// export with the consistent nonzero 0 holds. It must be refused, or at least not keep.
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
const arm = (tag: string, resolved: number, nonzero: number) => ({ prompt_version: tag, n: 4480, immature: 0, unattributed: 0, metrics: {
  resolved: { kind: "rate", successes: Math.round(4480 * resolved), missing: 0 },
  escalated: { kind: "rate", successes: 538, missing: 0 },
  refund_usd: { kind: "mean", mean: 0, sd: 0, missing: 0, nonzero },
} });
function decide(nonzero: number): string {
  const text = JSON.stringify({ format: TELEMETRY_FORMAT, export_id: "x", source: "synthetic", exported_at: "2026-11-18T00:00:00Z", window: { start: START, end: "2026-11-16T00:00:00Z" }, assignment: "randomized", denominator: contract.denominator, units, aggregates: [arm(B, 0.62, nonzero), arm(C, 0.665, nonzero)] });
  try {
    const v = importTelemetry({ text, purpose: "experiment", scope_id: EXP, contract, tags: [B, C], window: spec.window });
    return analyzeExperiment({ spec, experiment_id: EXP, imports: [{ id: contentId(v), value: v }], approval_id: "a".repeat(64), approved_at: START }).recommendation;
  } catch (e) { if (e instanceof PilotError) return "refused"; throw e; }
}

test("consistent export (no refunds, nonzero 0) holds: the mean guard is not certified (control)", () => {
  assert.equal(decide(0), "hold");
});

test("mean 0 and sd 0 with nonzero = n is contradictory: refused or held, never keep", () => {
  assert.notEqual(decide(4480), "keep");
});

// The rule itself, on the import alone: what is refused and what an honest aggregate still passes.
function imports(refund: Record<string, unknown>): boolean {
  const one = (tag: string) => ({ prompt_version: tag, n: 4480, immature: 0, unattributed: 0, metrics: {
    resolved: { kind: "rate", successes: 2800, missing: 0 }, escalated: { kind: "rate", successes: 538, missing: 0 }, refund_usd: { kind: "mean", missing: 0, ...refund },
  } });
  const text = JSON.stringify({ format: TELEMETRY_FORMAT, export_id: "y", source: "synthetic", exported_at: "2026-11-18T00:00:00Z", window: { start: START, end: "2026-11-16T00:00:00Z" }, assignment: "randomized", denominator: contract.denominator, units, aggregates: [one(B), one(C)] });
  try { importTelemetry({ text, purpose: "experiment", scope_id: EXP, contract, tags: [B, C], window: spec.window }); return true; }
  catch (e) { if (e instanceof PilotError && e.code === "invalid_telemetry" && /nonzero contradicts/.test(e.message)) return false; throw e; }
}

test("nonzero must agree with mean and sd; an honest aggregate, and one without nonzero, still import", () => {
  assert.equal(imports({ mean: 4.2, sd: 10, nonzero: 672 }), true, "the documented example");
  assert.equal(imports({ mean: 4.2, sd: 10 }), true, "nonzero is optional");
  assert.equal(imports({ mean: 0, sd: 0, nonzero: 0 }), true, "no refunds at all");
  assert.equal(imports({ mean: 5, sd: 0, nonzero: 4480 }), true, "every value is 5");
  assert.equal(imports({ mean: 0, sd: 0, nonzero: 4480 }), false, "all zero, yet all non-zero");
  assert.equal(imports({ mean: 5, sd: 0, nonzero: 100 }), false, "every value is 5, so none is zero");
  assert.equal(imports({ mean: 4.2, sd: 10, nonzero: 0 }), false, "no non-zero value, yet a mean above 0");
  assert.equal(imports({ mean: 0, sd: 3, nonzero: 0 }), false, "no non-zero value, yet a spread");
});
