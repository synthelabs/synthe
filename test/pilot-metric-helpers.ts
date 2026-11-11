// Shared synthetic fixtures for the pilot metric, telemetry and experiment tests. Company: Fernhill Outfitters.
import type { MetricContract, TelemetryExport, TelemetryRow } from "../src/pilot/types.ts";

export const CONFIG_ID = "c".repeat(64);
export const EXPERIMENT_ID = "e".repeat(64);
export const APPROVAL_ID = "a".repeat(64);
export const BASE_PROMPT = "1".repeat(64);
export const CAND_PROMPT = "2".repeat(64);
export const BASE_TAG = "fernhill-v7";
export const CAND_TAG = "synthe-222222222222";

// resolved: share of conversations resolved without a human (higher is better).
// escalated: share handed to a human (lower is better), critical with an early stop.
// csat: post-chat rating 1 to 5 (higher is better), not critical.
export function contract(over: Partial<MetricContract> = {}): MetricContract {
  return {
    version: 1,
    primary: { name: "resolved", kind: "rate", unit: "fraction of conversations", direction: "higher_is_better", min_effect: 0.05 },
    guards: [
      { name: "escalated", kind: "rate", unit: "fraction of conversations", direction: "lower_is_better", max_harm: 0.03, critical: true, early_stop: { min_per_arm: 200 } },
      { name: "csat", kind: "mean", unit: "rating 1-5", direction: "higher_is_better", max_harm: 0.2, critical: false },
    ],
    denominator: "completed_conversations",
    randomization_unit: "conversation",
    alpha: 0.05,
    power: 0.8,
    min_samples_per_arm: 100,
    analysis_window_days: 14,
    outcome_lag_days: 2,
    max_missing_rate: 0.05,
    max_unattributed_rate: 0.02,
    signed_off: { by: "Mara Quill, Head of Support, Fernhill Outfitters", at: "2026-09-01T12:00:00Z" },
    ...over,
  };
}

export const UNITS = { resolved: "fraction of conversations", escalated: "fraction of conversations", csat: "rating 1-5" };

// mulberry32: a small seeded generator, so fixtures are random-looking but exactly reproducible.
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// An array of n zeros and ones with exactly k ones, in a seeded random order.
export function exactBits(n: number, k: number, rand: () => number): number[] {
  const bits: number[] = Array.from({ length: n }, (_, i) => (i < k ? 1 : 0));
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [bits[i], bits[j]] = [bits[j], bits[i]];
  }
  return bits;
}

export const cid = (i: number) => `c-${String(i).padStart(6, "0")}`;

export function baseExport(over: Partial<TelemetryExport> = {}): TelemetryExport {
  return {
    format: "synthe-pilot-telemetry/v1",
    export_id: "fernhill-export-001",
    source: "Fernhill Outfitters support warehouse",
    exported_at: "2026-09-20T00:00:00Z",
    window: { start: "2026-09-01T00:00:00Z", end: "2026-09-15T00:00:00Z" },
    assignment: "none",
    denominator: "completed_conversations",
    units: { ...UNITS },
    ...over,
  };
}

export function row(i: number, tag: string, startedAt: string, values: Record<string, number | null>, extra: Partial<TelemetryRow> = {}): TelemetryRow {
  return { conversation_id: cid(i), prompt_version: tag, started_at: startedAt, values, ...extra };
}

export const isoAt = (startIso: string, minutes: number) => new Date(Date.parse(startIso) + minutes * 60_000).toISOString().replace(".000Z", "Z");
