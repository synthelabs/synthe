// Regression test (review, engine lens): analyzeExperiment trusts its specification. A specification with a
// malformed allocation, an assignment other than randomized, or missing guards must never give keep, and every refusal
// must be a PilotError. At 87edaa9 these keep, or throw a TypeError. (The CLI loads specifications by content id, so
// this is defence in depth for direct callers and for verify.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { PilotError } from "../src/pilot/errors.ts";
import { analyzeExperiment, buildExperimentSpec } from "../src/pilot/experiment.ts";
import { contentId } from "../src/pilot/ids.ts";
import { parseMetricContract } from "../src/pilot/metric.ts";
import { demoConfig } from "../src/pilot/demo-data.ts";
import { importTelemetry } from "../src/pilot/telemetry.ts";
import { TELEMETRY_FORMAT, type ExperimentSpec } from "../src/pilot/types.ts";

const contract = parseMetricContract((demoConfig() as { metric: unknown }).metric);
const B = "juniper-v14", C = "synthe-222222222222", EXP = "e".repeat(64), START = "2026-11-02T00:00:00Z";
const s = (value: number | null) => ({ value, source: "telemetry:0", method: "test" });
const spec = buildExperimentSpec({
  pilot_id: "fernhill-juniper", config_id: "c".repeat(64), contract, baseline: { prompt_id: "1".repeat(64), tag: B }, candidate: { prompt_id: "2".repeat(64), tag: C }, start: START,
  baseline_report: { version: 1, config_id: "c".repeat(64), telemetry_ids: [], tag: B, window: { start: START, end: "2026-11-16T00:00:00Z" }, rows: 0, mature: 0, immature: 0, daily_volume: s(1), metrics: [], required_per_arm: s(4040), days_to_required: s(null), flags: [] } as never,
});
const units = Object.fromEntries([contract.primary, ...contract.guards].map((m) => [m.name, m.unit]));
const arm = (tag: string, n: number, resolved: number) => ({ prompt_version: tag, n, immature: 0, unattributed: 0, metrics: {
  resolved: { kind: "rate", successes: Math.round(n * resolved), missing: 0 },
  escalated: { kind: "rate", successes: Math.round(n * 0.12), missing: 0 },
  refund_usd: { kind: "mean", mean: 4.2, sd: 10, missing: 0, nonzero: Math.round(n * 0.15) } } });
function exp(nb: number, nc: number) {
  const v = importTelemetry({ text: JSON.stringify({ format: TELEMETRY_FORMAT, export_id: `x${nb}`, source: "synthetic", exported_at: "2026-11-18T00:00:00Z", window: { start: START, end: "2026-11-16T00:00:00Z" }, assignment: "randomized", denominator: contract.denominator, units, aggregates: [arm(B, nb, 0.62), arm(C, nc, 0.665)] }), purpose: "experiment", scope_id: EXP, contract, tags: [B, C], window: spec.window });
  return { id: contentId(v), value: v };
}
function decide(over: Partial<ExperimentSpec> | Record<string, unknown>, nb = 4480, nc = 4480): string {
  try { return analyzeExperiment({ spec: { ...spec, ...over } as ExperimentSpec, experiment_id: EXP, imports: [exp(nb, nc)], approval_id: "a".repeat(64), approved_at: START }).recommendation; }
  catch (e) { if (e instanceof PilotError) return "refused"; throw e; }
}

test("controls: the clean export keeps; a 6000/4100 split against a 50/50 plan holds", () => {
  assert.equal(decide({}), "keep");
  assert.equal(decide({}, 6000, 4100), "hold");
});
test("a malformed allocation does not switch off the sample ratio check", () => {
  assert.notEqual(decide({ allocation: { baseline: 0.5, candidate: Number.NaN } }, 6000, 4100), "keep");
  assert.notEqual(decide({ allocation: { baseline: -1, candidate: 2 } }, 6000, 4100), "keep");
});
test("a specification whose assignment is not randomized never keeps", () => {
  assert.notEqual(decide({ assignment: "observational" as never }), "keep");
});
test("a specification with no guards array is refused with a PilotError, not a TypeError", () => {
  assert.equal(decide({ guards: undefined as never }), "refused");
});
