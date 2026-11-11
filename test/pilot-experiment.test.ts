import assert from "node:assert/strict";
import { test } from "node:test";
import { PilotError } from "../src/pilot/errors.ts";
import { analyzeExperiment, buildExperimentSpec, HOLD_FLAGS, renderDecision, renderExperimentSpec } from "../src/pilot/experiment.ts";
import { contentId } from "../src/pilot/ids.ts";
import { meanSummary, newcombeInterval, welchInterval } from "../src/pilot/stats.ts";
import { importTelemetry } from "../src/pilot/telemetry.ts";
import type {
  BaselineReport, ExperimentAnalysis, ExperimentSpec, MetricContract, PilotErrorCode, Stored, TelemetryAggregate, TelemetryExport,
  TelemetryImport, TelemetryRow,
} from "../src/pilot/types.ts";
import {
  APPROVAL_ID, BASE_PROMPT, BASE_TAG, CAND_PROMPT, CAND_TAG, CONFIG_ID, EXPERIMENT_ID, baseExport, cid, contract, exactBits, isoAt, rng,
} from "./pilot-metric-helpers.ts";

const START = "2026-10-01T00:00:00Z"; // window ends Oct 15, cutoff Oct 17 (14-day window, 2-day lag)
const FINAL_AT = "2026-10-18T00:00:00Z";
const INTERIM_AT = "2026-10-09T00:00:00Z";

// Only required_per_arm, config_id and tag matter to the specification; the rest is filled in plausibly.
function fakeReport(required: number | null, c: MetricContract = contract()): BaselineReport {
  const s = (value: number | null) => ({ value, source: "telemetry:000000000000", method: "test" });
  return {
    version: 1, config_id: CONFIG_ID, telemetry_ids: ["0".repeat(64)], tag: BASE_TAG,
    window: { start: "2026-09-01T00:00:00Z", end: "2026-09-15T00:00:00Z" }, rows: 1000, mature: 1000, immature: 0,
    daily_volume: s(150),
    metrics: [{ name: c.primary.name, role: "primary", kind: c.primary.kind, unit: c.primary.unit, n: 1000, missing: 0, estimate: s(0.4), ci: null }],
    required_per_arm: s(required), days_to_required: s(null), flags: [],
  };
}

function spec(required = 600, c: MetricContract = contract(), share?: number): ExperimentSpec {
  return buildExperimentSpec({
    pilot_id: "fernhill-support", config_id: CONFIG_ID, contract: c, baseline: { prompt_id: BASE_PROMPT, tag: BASE_TAG },
    candidate: { prompt_id: CAND_PROMPT, tag: CAND_TAG }, baseline_report: fakeReport(required, c), start: START, candidate_share: share,
  });
}

// One arm's plan: exact counts, so every number in a test is known.
interface ArmPlan {
  n: number;
  resolved: number;
  escalated: number;
  csatMean?: number;
  // Rows with no recorded value, per metric.
  missing?: Partial<Record<"resolved" | "escalated" | "csat", number>>;
  segments?: [string, number][];
}

const OFFSETS = [-1, -0.5, 0, 0.5, 1];

function armValues(plan: ArmPlan, rand: () => number, names: string[]): Record<string, number | null>[] {
  const shuffle = <T>(xs: T[]): T[] => {
    for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; }
    return xs;
  };
  const m = plan.missing ?? {};
  const resolved = shuffle([...exactBits(plan.n - (m.resolved ?? 0), plan.resolved, rand), ...Array<null>(m.resolved ?? 0).fill(null)]);
  const escalated = shuffle([...exactBits(plan.n - (m.escalated ?? 0), plan.escalated, rand), ...Array<null>(m.escalated ?? 0).fill(null)]);
  const csat = shuffle([...Array.from({ length: plan.n - (m.csat ?? 0) }, (_, i) => (plan.csatMean ?? 4) + OFFSETS[i % 5]), ...Array<null>(m.csat ?? 0).fill(null)]);
  return Array.from({ length: plan.n }, (_, i) => {
    const all: Record<string, number | null> = { resolved: resolved[i], escalated: escalated[i], csat: csat[i] };
    return Object.fromEntries(names.map((k) => [k, all[k]]));
  });
}

// Rows for both arms, interleaved in a seeded random order and spread evenly over `days` days from the start.
function makeRows(base: ArmPlan, cand: ArmPlan, opts: { seed?: number; days?: number; start?: string; firstId?: number; names?: string[] } = {}): TelemetryRow[] {
  const rand = rng(opts.seed ?? 7);
  const names = opts.names ?? ["resolved", "escalated", "csat"];
  const draft: Omit<TelemetryRow, "conversation_id" | "started_at">[] = [];
  for (const [plan, tag] of [[base, BASE_TAG], [cand, CAND_TAG]] as const) {
    const values = armValues(plan, rand, names);
    const segs = (plan.segments ?? []).flatMap(([s, k]) => Array<string>(k).fill(s));
    values.forEach((v, i) => draft.push({ prompt_version: tag, values: v, ...(segs[i] ? { segment: segs[i] } : {}) }));
  }
  for (let i = draft.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [draft[i], draft[j]] = [draft[j], draft[i]]; }
  const span = (opts.days ?? 14) * 24 * 60;
  return draft.map((d, i) => ({ conversation_id: cid((opts.firstId ?? 1) + i), started_at: isoAt(opts.start ?? START, Math.floor((i * span) / draft.length)), ...d }));
}

function exportOf(rows: TelemetryRow[], exportedAt: string, over: Partial<TelemetryExport> = {}): TelemetryExport {
  return baseExport({
    export_id: `fernhill-exp-${exportedAt}`, exported_at: exportedAt, window: { start: START, end: "2026-10-15T00:00:00Z" },
    assignment: "randomized", expected_rows: new Set(rows.map((r) => r.conversation_id)).size, rows, ...over,
  });
}

function imp(e: TelemetryExport, c: MetricContract = contract()): Stored<TelemetryImport> {
  const value = importTelemetry({
    text: JSON.stringify(e), purpose: "experiment", scope_id: EXPERIMENT_ID, contract: c, tags: [BASE_TAG, CAND_TAG],
    window: { start: START, end: "2026-10-15T00:00:00Z" },
  });
  return { id: contentId(value), value };
}

const analyze = (s: ExperimentSpec, imports: Stored<TelemetryImport>[]) => analyzeExperiment({ spec: s, experiment_id: EXPERIMENT_ID, imports, approval_id: APPROVAL_ID });

function run(base: ArmPlan, cand: ArmPlan, opts: { at?: string; required?: number; c?: MetricContract; days?: number; over?: Partial<TelemetryExport>; share?: number; rows?: (r: TelemetryRow[]) => TelemetryRow[] } = {}) {
  const c = opts.c ?? contract();
  const names = [c.primary.name, ...c.guards.map((g) => g.name)];
  let rows = makeRows(base, cand, { days: opts.days, names });
  if (opts.rows) rows = opts.rows(rows);
  const s = spec(opts.required ?? 600, c, opts.share);
  const units = Object.fromEntries([c.primary, ...c.guards].map((m) => [m.name, m.unit]));
  const i = imp(exportOf(rows, opts.at ?? FINAL_AT, { units, ...opts.over }), c);
  return { s, i, rows, a: analyze(s, [i]) };
}

// A clean final result: resolved 40% -> 50%, escalation 10% -> 9%, csat unchanged.
const GOOD_BASE: ArmPlan = { n: 1000, resolved: 400, escalated: 100 };
const GOOD_CAND: ArmPlan = { n: 1000, resolved: 500, escalated: 90 };

const refusal = (fn: () => unknown, code: PilotErrorCode, pattern?: RegExp) =>
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof PilotError, `expected PilotError, got ${e}`);
    assert.equal(e.code, code, e.message);
    if (pattern) assert.match(e.message, pattern);
    return true;
  });

// ---------------------------------------------------------------------------------------------------------------
// Specification
// ---------------------------------------------------------------------------------------------------------------

test("the specification sets the window, cutoff, allocation and predeclared methods from the contract", () => {
  const s = spec();
  assert.deepEqual(s.window, { start: START, end: "2026-10-15T00:00:00Z" });
  assert.equal(s.analysis_cutoff, "2026-10-17T00:00:00Z");
  assert.deepEqual(s.allocation, { baseline: 0.5, candidate: 0.5 });
  assert.equal(s.required_per_arm, 600);
  assert.equal(s.early_stop_level, 0.999);
  assert.equal(s.integrity_alpha, 0.001);
  assert.equal(s.assignment, "randomized");
  assert.equal(s.alpha, 0.05);
  assert.deepEqual(s.primary, contract().primary);
  assert.deepEqual(s.guards, contract().guards);
  assert.deepEqual(s.rollback.tag, BASE_TAG);
  assert.equal(s.rollback.prompt_id, BASE_PROMPT);
  assert.match(s.rollback.instructions, /rollout owner/);
  assert.match(s.rollback.instructions, /Synthe does not change traffic/);
  for (const k of ["rate", "mean", "keep", "revert", "hold", "early_stop", "integrity"] as const) assert.ok(s.methods[k].length > 20, k);
  assert.match(s.methods.rate, /Newcombe/);
  assert.match(s.methods.mean, /Welch/);
  assert.match(s.methods.early_stop, /99\.9%/);
  assert.ok(s.telemetry_fields.some((f) => f.includes("resolved") && f.includes("fraction of conversations")));
  assert.ok(s.telemetry_fields.some((f) => f.startsWith("conversation_id")));
  assert.deepEqual(spec(600, contract(), 0.2).allocation, { baseline: 0.8, candidate: 0.2 });

  const md = renderExperimentSpec(s, EXPERIMENT_ID);
  for (const needle of [BASE_TAG, CAND_TAG, BASE_PROMPT, CAND_PROMPT, EXPERIMENT_ID, "2026-10-17T00:00:00Z", "600", "synthe-pilot-telemetry/v1", "Newcombe", "operates the traffic split"]) {
    assert.ok(md.includes(needle), `spec markdown is missing ${needle}`);
  }
});

test("the specification refuses bad inputs", () => {
  const base = { pilot_id: "fernhill-support", config_id: CONFIG_ID, contract: contract(), baseline: { prompt_id: BASE_PROMPT, tag: BASE_TAG }, candidate: { prompt_id: CAND_PROMPT, tag: CAND_TAG }, baseline_report: fakeReport(600), start: START };
  refusal(() => buildExperimentSpec({ ...base, start: "2026-10-01" }), "usage", /start/);
  refusal(() => buildExperimentSpec({ ...base, candidate_share: 1 }), "usage", /candidate_share/);
  refusal(() => buildExperimentSpec({ ...base, candidate_share: 0 }), "usage", /candidate_share/);
  refusal(() => buildExperimentSpec({ ...base, candidate: { prompt_id: CAND_PROMPT, tag: BASE_TAG } }), "conflict", /tag/);
  refusal(() => buildExperimentSpec({ ...base, candidate: { prompt_id: BASE_PROMPT, tag: CAND_TAG } }), "conflict", /prompt/);
  refusal(() => buildExperimentSpec({ ...base, baseline_report: fakeReport(null) }), "invalid_telemetry", /required/);
});

// ---------------------------------------------------------------------------------------------------------------
// Decision boundaries
// ---------------------------------------------------------------------------------------------------------------

test("keep: final, enough samples, primary clears and every guard passes", () => {
  const { a, s, i } = run(GOOD_BASE, GOOD_CAND);
  assert.equal(a.final, true);
  assert.deepEqual(a.flags, []);
  assert.equal(a.recommendation, "keep");
  assert.equal(a.stopped_by, undefined);
  assert.equal(a.primary.status, "clears");
  assert.deepEqual(a.guards.map((g) => g.status), ["pass", "pass"]);
  assert.equal(a.primary.baseline.n, 1000);
  assert.equal(a.primary.baseline.estimate, 0.4);
  assert.equal(a.primary.candidate.estimate, 0.5);
  assert.ok(Math.abs(a.primary.difference! - 0.1) < 1e-12);
  const ci = newcombeInterval(500, 1000, 400, 1000, 0.95)!;
  assert.deepEqual(a.primary.ci, ci);
  assert.match(a.primary.method, /Newcombe/);
  assert.match(a.guards[1].method, /Welch/);
  assert.equal(a.as_of, FINAL_AT);
  assert.deepEqual(a.telemetry_ids, [i.id]);
  assert.equal(a.approval_id, APPROVAL_ID);
  assert.equal(a.experiment_id, EXPERIMENT_ID);
  assert.deepEqual(a.rollback, s.rollback);
  assert.deepEqual(a.allocation, { intended: 0.5, observed: 0.5, srm_p: 1, flagged: false });
  assert.deepEqual(a.coverage, { rows: 2000, mature: 2000, immature: 0, unattributed: 0, missing_rate: 0, unattributed_rate: 0, duplicates_dropped: 0, required_per_arm: 600, late_rows: 0 });
  assert.deepEqual(a.arms.baseline, { tag: BASE_TAG, rows: 1000, mature: 1000, immature: 0, unattributed: 0, segments: { "(none)": 1000 } });
  assert.ok(a.reasons.length >= 1);
});

test("hold: primary point estimate just below min_effect, although the interval is above zero", () => {
  const { a } = run(GOOD_BASE, { ...GOOD_CAND, resolved: 449 });
  assert.ok(a.primary.difference! < 0.05 && a.primary.ci!.lo > 0, `${a.primary.difference} ${a.primary.ci?.lo}`);
  assert.equal(a.primary.status, "not_clear");
  assert.deepEqual(a.flags, []);
  assert.equal(a.recommendation, "hold");
  // Exactly at min_effect clears: 450 - 400 out of 1000 is 0.05 even though 0.45 - 0.4 is not exactly 0.05 in floating point.
  const at = run(GOOD_BASE, { ...GOOD_CAND, resolved: 450 }).a;
  assert.equal(at.primary.status, "clears");
  assert.equal(at.recommendation, "keep");
});

test("hold: primary interval touches zero although the point estimate clears min_effect", () => {
  const { a } = run({ n: 300, resolved: 120, escalated: 30 }, { n: 300, resolved: 140, escalated: 25 }, { required: 300 });
  assert.ok(a.primary.difference! >= 0.05 && a.primary.ci!.lo <= 0);
  assert.equal(a.primary.status, "not_clear");
  assert.equal(a.recommendation, "hold");
  assert.ok(!a.flags.includes("insufficient_samples"));
});

test("hold: a guard is inconclusive (harm below the margin, but the interval reaches past it)", () => {
  const { a } = run(GOOD_BASE, { ...GOOD_CAND, escalated: 115 });
  const g = a.guards[0];
  assert.ok(g.difference! < 0.03 && g.ci!.hi > 0.03);
  assert.equal(g.status, "inconclusive");
  assert.equal(a.primary.status, "clears");
  assert.equal(a.recommendation, "hold");
  assert.ok(a.reasons.some((r) => r.includes("escalated")));
});

test("hold before the cutoff, even with a large primary win", () => {
  // Every conversation in the first 6 days, exported on day 9: all mature, nothing else wrong.
  const { a } = run(GOOD_BASE, { ...GOOD_CAND, resolved: 700 }, { at: INTERIM_AT, days: 6 });
  assert.equal(a.final, false);
  assert.deepEqual(a.flags, ["before_cutoff"]);
  assert.equal(a.primary.status, "clears");
  assert.equal(a.recommendation, "hold");
  assert.ok(a.reasons.some((r) => r.includes("2026-10-17T00:00:00Z")), "says when to look again");
});

test("hold on insufficient samples", () => {
  const { a } = run({ n: 500, resolved: 200, escalated: 50 }, { n: 500, resolved: 300, escalated: 40 });
  assert.equal(a.primary.status, "clears");
  assert.deepEqual(a.flags, ["insufficient_samples"]);
  assert.equal(a.recommendation, "hold");
  assert.ok(a.reasons.some((r) => /500/.test(r) && /600/.test(r)));
});

test("hold on immature outcomes", () => {
  // Exported Oct 12 with a 2-day lag: rows started after Oct 10 00:00 are immature.
  const { a, rows } = run(GOOD_BASE, GOOD_CAND, { at: "2026-10-12T00:00:00Z", days: 11 });
  const immature = rows.filter((r) => Date.parse(r.started_at) > Date.parse("2026-10-10T00:00:00Z")).length;
  assert.ok(immature > 0);
  assert.equal(a.coverage.immature, immature);
  assert.equal(a.arms.baseline.immature + a.arms.candidate.immature, immature);
  assert.ok(a.flags.includes("inside_lag_window"));
  assert.equal(a.recommendation, "hold");
  assert.equal(a.primary.baseline.n + a.primary.candidate.n, 2000 - immature);
});

test("hold on sample ratio mismatch, measured against the intended allocation", () => {
  const { a } = run(GOOD_BASE, { n: 800, resolved: 400, escalated: 72 });
  assert.ok(a.allocation.srm_p! < 0.001);
  assert.equal(a.allocation.flagged, true);
  assert.ok(Math.abs(a.allocation.observed! - 800 / 1800) < 1e-12);
  assert.deepEqual(a.flags, ["sample_ratio_mismatch"]);
  assert.equal(a.recommendation, "hold");
  // The same split is no mismatch when the plan was 20% candidate.
  const planned = run({ n: 2400, resolved: 960, escalated: 240 }, { n: 600, resolved: 300, escalated: 50 }, { share: 0.2 }).a;
  assert.equal(planned.allocation.intended, 0.2);
  assert.equal(planned.allocation.flagged, false);
  assert.ok(!planned.flags.includes("sample_ratio_mismatch"));
});

test("hold on observational data", () => {
  const { a } = run(GOOD_BASE, GOOD_CAND, { over: { assignment: "observational" } });
  assert.deepEqual(a.flags, ["observational"]);
  assert.equal(a.primary.status, "clears");
  assert.equal(a.recommendation, "hold");
});

test("hold on cohort imbalance between arms", () => {
  const { a } = run({ ...GOOD_BASE, segments: [["returns", 500], ["orders", 500]] }, { ...GOOD_CAND, segments: [["returns", 700], ["orders", 300]] });
  assert.deepEqual(a.flags, ["cohort_imbalance"]);
  assert.equal(a.recommendation, "hold");
  // Balanced segments, including a tiny one that is pooled rather than breaking the test: no flag.
  const ok = run({ ...GOOD_BASE, segments: [["returns", 498], ["orders", 500], ["gift", 2]] }, { ...GOOD_CAND, segments: [["returns", 503], ["orders", 496], ["gift", 1]] }).a;
  assert.deepEqual(ok.flags, []);
  assert.equal(ok.recommendation, "keep");
});

test("hold on missing events: a guard that looks good only because the candidate is missing events is not a keep", () => {
  // Candidate escalation is missing for 100 of 1000 rows (10% > 5%); among the 900 recorded, 60 escalated (6.7%),
  // which looks better than the baseline's 10% and passes the guard on its face.
  const { a } = run(GOOD_BASE, { ...GOOD_CAND, escalated: 60, missing: { escalated: 100 } });
  assert.equal(a.guards[0].status, "pass");
  assert.equal(a.primary.status, "clears");
  assert.equal(a.guards[0].candidate.missing, 100);
  assert.equal(a.guards[0].candidate.n, 900);
  assert.ok(Math.abs(a.coverage.missing_rate - 0.1) < 1e-12);
  assert.deepEqual(a.flags, ["missing_events", "missing_imbalance"]);
  assert.equal(a.recommendation, "hold");
});

test("hold when missing outcomes pile up in one arm, even under the per-arm limit", () => {
  // 4% of the candidate's resolved outcomes are missing (the contract allows 5%), none of the baseline's. Dropping
  // 40 failures lifts the candidate from 42.0% to 43.8%, which would otherwise read as a clean win.
  const honest = run(GOOD_BASE, { ...GOOD_CAND, resolved: 420 }).a;
  assert.equal(honest.recommendation, "hold");
  const { a } = run(GOOD_BASE, { ...GOOD_CAND, resolved: 420, missing: { resolved: 40 } });
  assert.ok(a.coverage.missing_rate < 0.05);
  assert.deepEqual(a.flags, ["missing_imbalance"]);
  assert.equal(a.recommendation, "hold");
  assert.ok(a.reasons.some((r) => r.includes("far more often in one arm")));
  // The same small share missing in both arms is not an imbalance.
  const even = run({ ...GOOD_BASE, missing: { resolved: 40 } }, { ...GOOD_CAND, missing: { resolved: 40 } }).a;
  assert.deepEqual(even.flags, []);
});

test("hold on ambiguous attribution", () => {
  // 30 customers (unit ids) appear in both arms: their 60 rows are 3% of all rows, above the 2% limit.
  const { a } = run(GOOD_BASE, GOOD_CAND, {
    rows: (rows) => {
      const b = rows.filter((r) => r.prompt_version === BASE_TAG).slice(0, 30);
      const c = rows.filter((r) => r.prompt_version === CAND_TAG).slice(0, 30);
      b.forEach((r, k) => { r.unit_id = `u-${String(k).padStart(4, "0")}`; });
      c.forEach((r, k) => { r.unit_id = `u-${String(k).padStart(4, "0")}`; });
      rows.filter((r) => r.unit_id === undefined).forEach((r, k) => { r.unit_id = `u-${String(1000 + k).padStart(4, "0")}`; });
      return rows;
    },
  });
  assert.equal(a.coverage.unattributed, 60);
  assert.ok(Math.abs(a.coverage.unattributed_rate - 0.03) < 1e-12);
  assert.equal(a.arms.baseline.unattributed, 30);
  assert.equal(a.primary.baseline.n, 970);
  assert.deepEqual(a.flags, ["attribution_ambiguous"]);
  assert.equal(a.recommendation, "hold");
});

test("hold when the runtime model changed during the experiment", () => {
  const { a } = run(GOOD_BASE, GOOD_CAND, { rows: (rows) => rows.map((r, k) => ({ ...r, model_id: k < 1000 ? "model-a" : "model-b" })) });
  assert.deepEqual(a.flags, ["runtime_changed"]);
  assert.equal(a.recommendation, "hold");
});

test("hold when the export was made after the cutoff but covers only part of the window", () => {
  // The first seven days only, exported after the cutoff, with more than enough conversations and a clear win.
  const partial = { window: { start: START, end: "2026-10-08T00:00:00Z" } };
  const { a } = run(GOOD_BASE, GOOD_CAND, { days: 7, over: partial });
  assert.equal(a.final, true);
  assert.equal(a.primary.status, "clears");
  assert.deepEqual(a.flags, ["window_not_covered"]);
  assert.equal(a.recommendation, "hold");
  assert.ok(a.reasons.some((r) => r.includes("whole experiment window")));
  // Two partial exports that together span the window still leave no export that vouches for all of it.
  const { s, i } = run(GOOD_BASE, GOOD_CAND, { days: 7, over: partial });
  const tail = makeRows({ n: 5, resolved: 5, escalated: 0 }, { n: 5, resolved: 5, escalated: 0 }, { days: 3, start: "2026-10-10T00:00:00Z", firstId: 900001 });
  const later = imp(exportOf(tail, FINAL_AT, { export_id: "tail", window: { start: "2026-10-08T00:00:00Z", end: "2026-10-15T00:00:00Z" } }));
  assert.equal(analyze(s, [i, later]).recommendation, "hold");
});

test("revert on a final guard breach", () => {
  const { a } = run(GOOD_BASE, { ...GOOD_CAND, escalated: 180 });
  assert.equal(a.guards[0].status, "breach");
  assert.ok(a.guards[0].ci!.lo > 0.03, "the whole interval for harm is beyond the tolerated 0.03");
  assert.equal(a.primary.status, "clears");
  assert.equal(a.recommendation, "revert");
  assert.equal(a.stopped_by, "final");
  assert.ok(a.reasons[0].includes("escalated"));
});

test("no revert when harm is real but inside the tolerated margin: the result is hold, not a breach", () => {
  // Escalation rises from 10% to 12.5% over 4000 per arm: clearly above zero, but below the 3-point margin.
  const { a } = run({ n: 4000, resolved: 1600, escalated: 400 }, { n: 4000, resolved: 2000, escalated: 500 }, { required: 600 });
  const g = a.guards[0];
  assert.ok(g.difference! > 0 && g.difference! < 0.03 && g.ci!.lo > 0 && g.ci!.hi > 0.03, `${g.difference} ${g.ci?.lo} ${g.ci?.hi}`);
  assert.equal(g.status, "inconclusive");
  assert.equal(a.recommendation, "hold");
  assert.equal(a.stopped_by, undefined);
});

test("revert on an early stop of a critical guard before the cutoff", () => {
  const { a } = run({ n: 400, resolved: 160, escalated: 40 }, { n: 400, resolved: 200, escalated: 120 }, { at: INTERIM_AT, days: 6 });
  assert.equal(a.final, false);
  assert.ok(a.guards[0].early_ci && a.guards[0].early_ci.level === 0.999 && a.guards[0].early_ci.lo > 0.03);
  assert.equal(a.recommendation, "revert");
  assert.equal(a.stopped_by, "early_stop");
  assert.ok(a.flags.includes("insufficient_samples") && a.flags.includes("before_cutoff"), "an early stop overrides the hold flags");
  // Below min_per_arm (200) the early stop cannot be looked at.
  const small = run({ n: 150, resolved: 60, escalated: 15 }, { n: 150, resolved: 75, escalated: 60 }, { at: INTERIM_AT, days: 6 }).a;
  assert.equal(small.guards[0].early_ci, null);
  assert.equal(small.recommendation, "hold");
});

test("no revert before the cutoff from a nominal-level breach that is not an early stop", () => {
  // csat is not critical: much worse at the interim look, breach at the nominal level, still only hold.
  const csat = run(GOOD_BASE, { ...GOOD_CAND, csatMean: 3.5 }, { at: INTERIM_AT, days: 6 }).a;
  assert.equal(csat.guards[1].status, "breach");
  assert.equal(csat.guards[1].early_ci, null);
  assert.equal(csat.recommendation, "hold");
  assert.equal(csat.stopped_by, undefined);
  // A critical guard without early_stop: no revert before the cutoff either.
  const c = contract();
  c.guards[0] = { ...c.guards[0], early_stop: undefined };
  delete c.guards[0].early_stop;
  const noEarly = run(GOOD_BASE, { ...GOOD_CAND, escalated: 200 }, { at: INTERIM_AT, days: 6, c }).a;
  assert.equal(noEarly.guards[0].status, "breach");
  assert.equal(noEarly.recommendation, "hold");
  // A critical guard with early_stop that breaches at 95% but not at 99.9%: hold.
  const mild = run(GOOD_BASE, { ...GOOD_CAND, escalated: 175 }, { at: INTERIM_AT, days: 6 }).a;
  assert.equal(mild.guards[0].status, "breach");
  assert.ok(mild.guards[0].early_ci && mild.guards[0].early_ci.lo <= 0.03, "at 99.9% the harm is not shown to be beyond the 0.03 margin");
  assert.equal(mild.recommendation, "hold");
  // The same data at the final analysis reverts.
  assert.equal(run(GOOD_BASE, { ...GOOD_CAND, escalated: 175 }).a.recommendation, "revert");
});

test("revert when the primary is significantly worse at the final analysis", () => {
  const { a } = run({ n: 1000, resolved: 500, escalated: 100 }, { n: 1000, resolved: 420, escalated: 95 });
  assert.equal(a.primary.status, "breach");
  assert.ok(a.primary.ci!.hi < 0);
  assert.equal(a.recommendation, "revert");
  assert.equal(a.stopped_by, "final");
});

test("a lower-is-better primary: a fall is the benefit", () => {
  const c = contract({ primary: { name: "resolved", kind: "rate", unit: "fraction of conversations", direction: "lower_is_better", min_effect: 0.05 } });
  assert.equal(run({ n: 1000, resolved: 500, escalated: 100 }, { n: 1000, resolved: 400, escalated: 95 }, { c }).a.recommendation, "keep");
  assert.equal(run(GOOD_BASE, GOOD_CAND, { c }).a.recommendation, "revert");
});

// ---------------------------------------------------------------------------------------------------------------
// Merging imports
// ---------------------------------------------------------------------------------------------------------------

test("a later export that overlaps an earlier one, with some outcomes matured from null, does not double any count", () => {
  const s = spec();
  const full = makeRows(GOOD_BASE, GOOD_CAND);
  // Interim export: every conversation started so far, one in eight still without a resolved outcome.
  const early = full.filter((r) => r.started_at < "2026-10-12T00:00:00Z").map((r, k) => (k % 8 === 0 ? { ...r, values: { ...r.values, resolved: null } } : r));
  assert.ok(early.length > 1000 && early.length < full.length);
  const earlyImport = imp(exportOf(early, "2026-10-12T00:00:00Z"));
  const finalImport = imp(exportOf(full, FINAL_AT));
  const both = analyze(s, [earlyImport, finalImport]);
  const alone = analyze(s, [finalImport]);
  assert.equal(both.coverage.rows, 2000);
  assert.equal(both.coverage.duplicates_dropped, early.length);
  assert.deepEqual({ ...both, telemetry_ids: [], coverage: { ...both.coverage, duplicates_dropped: 0 } }, { ...alone, telemetry_ids: [], coverage: { ...alone.coverage, duplicates_dropped: 0 } });
  assert.deepEqual(both.telemetry_ids, [earlyImport.id, finalImport.id]);
  // Order of the imports given does not matter.
  assert.deepEqual(analyze(s, [finalImport, earlyImport]), both);
});

test("an outcome exported while the conversation was inside the lag is not final, whatever a later export says", () => {
  const s = spec();
  const full = makeRows(GOOD_BASE, GOOD_CAND);
  // Exported one hour before the window ends, with a value on every row: the last two days are still inside the lag.
  const early = full.filter((r) => r.started_at < "2026-10-14T23:00:00Z");
  const atEnd = imp(exportOf(early, "2026-10-14T23:00:00Z", { window: { start: START, end: "2026-10-14T23:00:00Z" } }));
  assert.ok(atEnd.value.provisional_values_dropped > 100, "values on immature rows are recorded as not known yet");
  assert.ok(atEnd.value.rows!.filter((r) => r.started_at >= "2026-10-13T00:00:00Z").every((r) => Object.values(r.values).every((v) => v === null)));
  const alone = analyze(s, [atEnd]);
  assert.equal(alone.recommendation, "hold");
  // A second export made after the cutoff that holds only the last hour's conversations. It makes the analysis
  // "final" by date, but says nothing about the conversations of the first export.
  const lastHour = imp(exportOf(full.filter((r) => r.started_at >= "2026-10-14T23:00:00Z"), FINAL_AT, { export_id: "last-hour", window: { start: "2026-10-14T23:00:00Z", end: "2026-10-15T00:00:00Z" } }));
  const both = analyze(s, [atEnd, lastHour]);
  assert.equal(both.final, true);
  assert.ok(both.coverage.immature > 100, `${both.coverage.immature} rows still wait for a final outcome`);
  assert.ok(both.flags.includes("inside_lag_window") && both.flags.includes("window_not_covered"));
  assert.equal(both.recommendation, "hold");
  // The whole window, exported after the cutoff, is what makes it final.
  const whole = analyze(s, [atEnd, imp(exportOf(full, FINAL_AT, { export_id: "whole" }))]);
  assert.equal(whole.coverage.immature, 0);
  assert.equal(whole.recommendation, "keep");
});

test("the same conversations under new ids, or dropped from a later export, are refused", () => {
  const s = spec();
  const small: [ArmPlan, ArmPlan] = [{ n: 400, resolved: 160, escalated: 40 }, { n: 400, resolved: 200, escalated: 36 }];
  const first = imp(exportOf(makeRows(...small), FINAL_AT));
  assert.equal(analyze(s, [first]).recommendation, "hold");
  // The same rows again with fresh ids would double the sample and turn hold into keep.
  const rekeyed = imp(exportOf(makeRows(...small, { firstId: 500001 }), "2026-10-19T00:00:00Z", { export_id: "again" }));
  refusal(() => analyze(s, [first, rekeyed]), "telemetry_conflict", /must contain every conversation of earlier exports/);
  // A later export of the same period that leaves conversations out is refused for the same reason.
  const thinner = imp(exportOf(makeRows(...small).filter((_, k) => k % 10 !== 0), "2026-10-19T00:00:00Z", { export_id: "thinner" }));
  refusal(() => analyze(s, [first, thinner]), "telemetry_conflict", /80 conversations/);
});

test("a newer aggregate export that counts less than an older one is refused", () => {
  const c = contract();
  const { s, rows } = run({ n: 2000, resolved: 800, escalated: 200 }, { n: 2000, resolved: 1000, escalated: 600 });
  const big = imp(baseExport({ export_id: "agg-big", exported_at: "2026-10-17T12:00:00Z", window: s.window, assignment: "randomized", aggregates: aggregatesOf(rows, c, s, "2026-10-17T12:00:00Z") }));
  assert.equal(analyze(s, [big]).recommendation, "revert");
  const fewer = run({ n: 700, resolved: 280, escalated: 70 }, { n: 700, resolved: 350, escalated: 63 }).rows;
  const small = imp(baseExport({ export_id: "agg-small", exported_at: FINAL_AT, window: s.window, assignment: "randomized", aggregates: aggregatesOf(fewer, c, s, FINAL_AT) }));
  assert.equal(analyze(s, [small]).recommendation, "keep", "on its own the smaller export reads as a clean win");
  refusal(() => analyze(s, [big, small]), "telemetry_conflict", /not cumulative/);
  refusal(() => analyze(s, [small, big]), "telemetry_conflict", /not cumulative/);
});

test("an aggregate update may move a unit's conversations to unattributed, and nothing else may shrink", () => {
  const c = contract();
  const { s, rows } = run(GOOD_BASE, GOOD_CAND);
  const older = aggregatesOf(rows, c, s, "2026-10-17T12:00:00Z");
  // A unit turned up in both arms after the first export: 10 baseline conversations, 4 of them resolved, leave the
  // counted ones and become unattributed.
  const moved = structuredClone(older);
  const base = moved.find((a) => a.prompt_version === BASE_TAG)!;
  base.n -= 10;
  base.unattributed += 10;
  const resolved = base.metrics.resolved;
  if (resolved.kind === "rate") resolved.successes -= 4;
  const first = imp(baseExport({ export_id: "agg-1", exported_at: "2026-10-17T12:00:00Z", window: s.window, assignment: "randomized", aggregates: older }));
  const update = imp(baseExport({ export_id: "agg-2", exported_at: FINAL_AT, window: s.window, assignment: "randomized", aggregates: moved }));
  assert.equal(analyze(s, [first, update]).arms.baseline.unattributed, 10);
  // The same fall with nothing moved to unattributed is a smaller population, not an update.
  const shrunk = structuredClone(moved);
  shrunk.find((a) => a.prompt_version === BASE_TAG)!.unattributed -= 10;
  const bad = imp(baseExport({ export_id: "agg-3", exported_at: FINAL_AT, window: s.window, assignment: "randomized", aggregates: shrunk }));
  refusal(() => analyze(s, [first, bad]), "telemetry_conflict", /not cumulative/);
  // Resolved conversations that became unresolved, with every total unchanged: a rewritten outcome, not an update.
  const rewritten = structuredClone(older);
  const r = rewritten.find((a) => a.prompt_version === BASE_TAG)!.metrics.resolved;
  if (r.kind === "rate") r.successes -= 50;
  const worse = imp(baseExport({ export_id: "agg-4", exported_at: FINAL_AT, window: s.window, assignment: "randomized", aggregates: rewritten }));
  refusal(() => analyze(s, [first, worse]), "telemetry_conflict", /fewer resolved = 1 conversations/);
});

test("exact copies under new ids are refused when the export is read; conversations that only turn up late are counted, not held", () => {
  const s = spec();
  const small = makeRows({ n: 400, resolved: 160, escalated: 40 }, { n: 400, resolved: 200, escalated: 36 });
  const early = small.filter((r) => r.started_at < "2026-10-12T00:00:00Z");
  const first = imp(exportOf(early, "2026-10-12T00:00:00Z"));
  // Honest: the final export holds the first export's conversations and the ones that started after it.
  const honest = analyze(s, [first, imp(exportOf(small, FINAL_AT))]);
  assert.deepEqual(honest.flags, ["insufficient_samples"]);
  assert.equal(honest.coverage.late_rows, 0);
  // The final export also holds every conversation a second time under a new id, which would read as 800 in each
  // arm and enough. It is refused: nearly every pair of rows that shares a start time is identical, which chance
  // does not do.
  const copies = small.map((r, k) => ({ ...r, conversation_id: `rekeyed-${k}` }));
  refusal(() => imp(exportOf([...small, ...copies], FINAL_AT)), "telemetry_duplicate", /1600 rows have an exact twin under another conversation_id/);
  // A conversation that was inside the outcome lag at the first export may have been unfinished then: not late.
  const young = small.slice(0, 30).map((r, k) => ({ ...r, conversation_id: `young-${k}`, started_at: isoAt("2026-10-10T12:00:00Z", k * 60 + 7) }));
  const withYoung = analyze(s, [first, imp(exportOf([...small, ...young], FINAL_AT))]);
  assert.deepEqual(withYoung.flags, ["insufficient_samples"]);
  assert.equal(withYoung.coverage.late_rows, 0);
  // Conversations older than the outcome lag at the first export, yet only in the final one: they finished late
  // or were delivered late. They are counted and reported. The final export holds them, so they do not hold the
  // result: an honest pilot with slow conversations must not be stuck for good.
  const lateOnes = (n: number) => small.slice(0, n).map((r, k) => ({ ...r, conversation_id: `late-${k}`, started_at: isoAt(r.started_at, 3) }));
  const few = analyze(s, [first, imp(exportOf([...small, ...lateOnes(5)], FINAL_AT))]);
  assert.equal(few.coverage.late_rows, 5);
  assert.deepEqual(few.flags, ["insufficient_samples"]);
  const many = analyze(s, [first, imp(exportOf([...small, ...lateOnes(40)], FINAL_AT))]);
  assert.equal(many.coverage.late_rows, 40);
  assert.deepEqual(many.flags, ["insufficient_samples", "late_rows"]);
  assert.ok(!(HOLD_FLAGS as readonly string[]).includes("late_rows"));
  // With enough conversations the same lateness leaves the decision as it would be without the first export.
  const big = makeRows(GOOD_BASE, GOOD_CAND);
  const bigFirst = imp(exportOf(big.filter((r) => r.started_at < "2026-10-12T00:00:00Z"), "2026-10-12T00:00:00Z"));
  const slow = big.slice(0, 200).map((r, k) => ({ ...r, conversation_id: `slow-${k}`, started_at: isoAt(r.started_at, 3) }));
  const decided = analyze(s, [bigFirst, imp(exportOf([...big, ...slow], FINAL_AT))]);
  assert.equal(decided.recommendation, "keep");
  assert.deepEqual(decided.flags, ["late_rows"]);
  assert.equal(decided.coverage.late_rows, 200);
  assert.match(renderDecision(decided, s, "d".repeat(64)), /late rows 200/);
});

test("with a unit id on every row, one conversation under two ids is refused whatever the timestamps of the others", () => {
  const small = makeRows({ n: 400, resolved: 160, escalated: 40 }, { n: 400, resolved: 200, escalated: 36 }).map((r, k) => ({ ...r, unit_id: `u-${k}` }));
  refusal(() => imp(exportOf([...small, { ...small[0], conversation_id: "again" }], FINAL_AT)), "telemetry_duplicate", /same conversation under a different conversation_id/);
});

test("exports made with different metric queries are refused, and one-sided segments hold", () => {
  const { s, rows } = run(GOOD_BASE, GOOD_CAND);
  const withHash = (hash: string | undefined, id: string, at: string) => imp(exportOf(rows, at, { export_id: id, ...(hash ? { query_hash: hash } : {}) }));
  const a1 = withHash("a".repeat(64), "q1", FINAL_AT);
  assert.equal(a1.value.query_hash, "a".repeat(64));
  refusal(() => analyze(s, [a1, withHash("b".repeat(64), "q2", "2026-10-19T00:00:00Z")]), "telemetry_denominator_mismatch", /same metric query/);
  refusal(() => analyze(s, [a1, withHash(undefined, "q3", "2026-10-19T00:00:00Z")]), "telemetry_denominator_mismatch");
  assert.equal(analyze(s, [a1, withHash("a".repeat(64), "q4", "2026-10-19T00:00:00Z")]).recommendation, "keep");

  const c = contract();
  const aggs = aggregatesOf(run({ ...GOOD_BASE, segments: [["returns", 500], ["orders", 500]] }, { ...GOOD_CAND, segments: [["returns", 500], ["orders", 500]] }).rows, c, s, FINAL_AT);
  const oneSided = aggs.map((a) => (a.prompt_version === CAND_TAG ? { ...a, segments: {} } : a));
  const held = analyze(s, [imp(baseExport({ export_id: "agg-one-sided", exported_at: FINAL_AT, window: s.window, assignment: "randomized", aggregates: oneSided }))]);
  assert.deepEqual(held.flags, ["cohort_imbalance"]);
  assert.equal(held.recommendation, "hold");
  assert.ok(held.reasons.some((r) => r.includes("only one arm reports segments")));
});

test("the same import twice does not double any count, and the analysis is deterministic", () => {
  const { s, i, a } = run(GOOD_BASE, GOOD_CAND);
  assert.deepEqual(analyze(s, [i, i]), a);
  assert.deepEqual(analyze(s, [i]), a);
});

test("a conflicting value across imports is refused", () => {
  const s = spec();
  const full = makeRows(GOOD_BASE, GOOD_CAND);
  const first = imp(exportOf(full, "2026-10-16T00:00:00Z"));
  const k = full.findIndex((r) => r.values.resolved === 1);
  const changed = full.map((r, j) => (j === k ? { ...r, values: { ...r.values, resolved: 0 } } : r));
  refusal(() => analyze(s, [first, imp(exportOf(changed, FINAL_AT))]), "telemetry_conflict", /1 conversation appear/);
  // A later export may not blank out a recorded value.
  const blanked = full.map((r, j) => (j === k ? { ...r, values: { ...r.values, resolved: null } } : r));
  refusal(() => analyze(s, [first, imp(exportOf(blanked, FINAL_AT))]), "telemetry_conflict");
  // An earlier export filling in a value the later one lacks is also a conflict.
  refusal(() => analyze(s, [imp(exportOf(blanked, "2026-10-16T00:00:00Z")), imp(exportOf(full, "2026-10-16T00:00:00Z", { export_id: "other" }))]), "telemetry_conflict");
  // A changed segment is a conflict.
  const reseg = full.map((r, j) => (j === k ? { ...r, segment: "orders" } : r));
  refusal(() => analyze(s, [first, imp(exportOf(reseg, FINAL_AT))]), "telemetry_conflict");
});

function aggregatesOf(rows: TelemetryRow[], c: MetricContract, s: ExperimentSpec, asOf: string): TelemetryAggregate[] {
  return [BASE_TAG, CAND_TAG].map((tag) => {
    const mine = rows.filter((r) => r.prompt_version === tag);
    const mature = mine.filter((r) => Date.parse(r.started_at) + s.outcome_lag_days * 86_400_000 <= Date.parse(asOf));
    const metrics: TelemetryAggregate["metrics"] = {};
    for (const m of [c.primary, ...c.guards]) {
      const vals = mature.map((r) => r.values[m.name]).filter((v): v is number => v !== null);
      const missing = mature.length - vals.length;
      if (m.kind === "rate") metrics[m.name] = { kind: "rate", successes: vals.reduce((x, y) => x + y, 0), missing };
      else { const st = meanSummary(vals); metrics[m.name] = { kind: "mean", mean: st.mean!, sd: st.sd!, missing }; }
    }
    const segments: Record<string, number> = {};
    for (const r of mine) segments[r.segment ?? "(none)"] = (segments[r.segment ?? "(none)"] ?? 0) + 1;
    return { prompt_version: tag, n: mature.length, immature: mine.length - mature.length, unattributed: 0, metrics, segments };
  });
}

test("aggregates give the same recommendation and intervals as the equivalent rows", () => {
  const c = contract();
  for (const [base, cand, expected] of [
    [GOOD_BASE, GOOD_CAND, "keep"], [GOOD_BASE, { ...GOOD_CAND, escalated: 160 }, "revert"], [GOOD_BASE, { ...GOOD_CAND, resolved: 449 }, "hold"],
    [{ ...GOOD_BASE, segments: [["returns", 500], ["orders", 500]] }, { ...GOOD_CAND, segments: [["returns", 700], ["orders", 300]] }, "hold"],
  ] as [ArmPlan, ArmPlan, string][]) {
    const { s, rows, a } = run(base, cand);
    const agg = imp(baseExport({ export_id: "agg", exported_at: FINAL_AT, window: s.window, assignment: "randomized", aggregates: aggregatesOf(rows, c, s, FINAL_AT) }));
    const b = analyze(s, [agg]);
    assert.equal(a.recommendation, expected);
    assert.equal(b.recommendation, expected);
    assert.deepEqual(b.flags, a.flags);
    assert.deepEqual(b.primary, a.primary);
    for (let g = 0; g < a.guards.length; g++) {
      assert.equal(b.guards[g].status, a.guards[g].status);
      assert.ok(Math.abs(b.guards[g].ci!.lo - a.guards[g].ci!.lo) < 1e-9 && Math.abs(b.guards[g].ci!.hi - a.guards[g].ci!.hi) < 1e-9);
    }
    assert.deepEqual(b.arms, a.arms);
  }
});

test("aggregates: only the newest cumulative export is used, and it must start at the experiment start", () => {
  const c = contract();
  const { s, rows } = run(GOOD_BASE, GOOD_CAND);
  const older = imp(baseExport({ export_id: "agg-1", exported_at: "2026-10-16T00:00:00Z", window: s.window, assignment: "randomized", aggregates: aggregatesOf(rows.slice(0, 1000), c, s, "2026-10-16T00:00:00Z") }));
  const newer = imp(baseExport({ export_id: "agg-2", exported_at: FINAL_AT, window: s.window, assignment: "randomized", aggregates: aggregatesOf(rows, c, s, FINAL_AT) }));
  const a = analyze(s, [older, newer]);
  assert.deepEqual(a.telemetry_ids, [newer.id]);
  assert.ok(a.flags.includes("superseded_aggregate"));
  assert.equal(a.coverage.rows, 2000);
  assert.equal(a.recommendation, "keep", "a superseded export is not a data problem");
  assert.ok(a.reasons.some((r) => r.includes(older.id.slice(0, 12))));
  const late = imp(baseExport({ export_id: "agg-3", exported_at: FINAL_AT, window: { start: "2026-10-02T00:00:00Z", end: s.window.end }, assignment: "randomized", aggregates: aggregatesOf(rows, c, s, FINAL_AT) }));
  refusal(() => analyze(s, [late]), "telemetry_window_mismatch");
  // Rows and aggregates cannot be mixed, whichever was exported first: the counts would overlap.
  refusal(() => analyze(s, [newer, run(GOOD_BASE, GOOD_CAND).i]), "telemetry_conflict", /some are aggregates/);
  refusal(() => analyze(s, [run(GOOD_BASE, GOOD_CAND, { at: "2026-10-16T12:00:00Z" }).i, newer]), "telemetry_conflict", /some are aggregates/);
  refusal(() => analyze(s, [older, run(GOOD_BASE, GOOD_CAND).i]), "telemetry_conflict", /some are aggregates/);
});

test("analysis refusals", () => {
  const { s, i } = run(GOOD_BASE, GOOD_CAND);
  refusal(() => analyze(s, []), "telemetry_incomplete");
  refusal(() => analyzeExperiment({ spec: s, experiment_id: "9".repeat(64), imports: [i], approval_id: APPROVAL_ID }), "invalid_telemetry");
  const baseline = { id: "b".repeat(64), value: { ...i.value, purpose: "baseline" as const } };
  refusal(() => analyze(s, [baseline]), "invalid_telemetry");
  const otherTag = { id: "d".repeat(64), value: { ...i.value, rows: i.value.rows!.map((r) => ({ ...r, prompt_version: r.prompt_version === CAND_TAG ? "synthe-999999999999" : r.prompt_version })) } };
  refusal(() => analyze(s, [otherTag]), "telemetry_version_mismatch", /synthe-999999999999/);
});

// ---------------------------------------------------------------------------------------------------------------
// Mean primary metric
// ---------------------------------------------------------------------------------------------------------------

test("a mean-kind primary metric reaches keep and hold correctly", () => {
  const c = contract({
    primary: { name: "csat", kind: "mean", unit: "rating 1-5", direction: "higher_is_better", min_effect: 0.2 },
    guards: [contract().guards[0]],
  });
  const keep = run({ n: 1000, resolved: 0, escalated: 100, csatMean: 4 }, { n: 1000, resolved: 0, escalated: 95, csatMean: 4.3 }, { c }).a;
  assert.equal(keep.primary.kind, "mean");
  assert.match(keep.primary.method, /Welch/);
  assert.ok(Math.abs(keep.primary.difference! - 0.3) < 1e-9);
  const expected = welchInterval({ n: 1000, mean: 4.3, sd: Math.sqrt(0.5 * 1000 / 999) }, { n: 1000, mean: 4, sd: Math.sqrt(0.5 * 1000 / 999) }, 0.95)!;
  assert.ok(Math.abs(keep.primary.ci!.lo - expected.lo) < 1e-9);
  assert.equal(keep.primary.status, "clears");
  assert.equal(keep.recommendation, "keep");
  const hold = run({ n: 1000, resolved: 0, escalated: 100, csatMean: 4 }, { n: 1000, resolved: 0, escalated: 95, csatMean: 4.15 }, { c }).a;
  assert.equal(hold.primary.status, "not_clear");
  assert.equal(hold.recommendation, "hold");
  const worse = run({ n: 1000, resolved: 0, escalated: 100, csatMean: 4 }, { n: 1000, resolved: 0, escalated: 95, csatMean: 3.8 }, { c }).a;
  assert.equal(worse.primary.status, "breach");
  assert.equal(worse.recommendation, "revert");
});

// ---------------------------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------------------------

test("the rendered decision leads with the recommendation and never prints a conversation or unit id", () => {
  const cases: ExperimentAnalysis[] = [
    run(GOOD_BASE, GOOD_CAND).a,
    run(GOOD_BASE, { ...GOOD_CAND, escalated: 160 }).a,
    run(GOOD_BASE, GOOD_CAND, { rows: (rows) => rows.map((r, k) => ({ ...r, unit_id: `u-${String(k % 1900).padStart(4, "0")}` })) }).a,
  ];
  const s = spec();
  const analysisId = "9".repeat(64);
  for (const a of cases) {
    const md = renderDecision(a, s, analysisId);
    assert.ok(md.startsWith(`# ${a.recommendation.toUpperCase()}`), md.slice(0, 80));
    assert.doesNotMatch(md, /c-\d{6}/);
    assert.doesNotMatch(md, /u-\d{4}/);
    for (const needle of [analysisId, EXPERIMENT_ID, APPROVAL_ID, BASE_TAG, BASE_PROMPT, ...a.telemetry_ids, `telemetry:${a.telemetry_ids[0].slice(0, 12)}`, "Newcombe", "Welch"]) {
      assert.ok(md.includes(needle), `decision is missing ${needle}`);
    }
    if (a.recommendation !== "keep") assert.match(md, /## What to do next/);
  }
  assert.match(renderDecision(cases[0], s, analysisId), /resolved/);
  assert.match(renderDecision(cases[2], s, analysisId), /attribution/i);
});
