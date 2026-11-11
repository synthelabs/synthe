// Experiment specification and the keep / hold / revert analysis. Lane: metric and experiment evaluation.
//
// The customer runs the experiment with their own rollout controls; Synthe writes the plan before it starts and
// analyses the customer's export afterwards. The analysis is fixed in advance (spec.methods), never reads the clock,
// and leans to hold: keep needs the final analysis, clean data, a primary win of at least min_effect and every guard
// shown to be within its margin. Revert before the cutoff comes only from a critical guard's predeclared early stop
// at a stricter level, because repeated interim looks at the nominal level would raise false alarms.
import { PilotError } from "./errors.ts";
import { addDays, DAY_MS, ms, shortId } from "./ids.ts";
import { chiSquareGof, chiSquareIndependence, newcombeInterval, welchInterval, type Ci } from "./stats.ts";
import {
  armCountsFromAggregate, armCountsFromRows, armMetricFromAggregate, armMetricFromRows, classifyRows, fmt, mergeImports, pct,
  telemetrySource, versionCheck, type ArmMetric,
} from "./telemetry.ts";
import {
  TELEMETRY_FORMAT,
  type ArmCounts, type ArmRef, type BaselineReport, type ExperimentAnalysis, type ExperimentSpec, type GuardSpec, type Interval,
  type IsoTime, type MetricContract, type MetricKind, type MetricReadout, type MetricSpec, type Sha256, type Stored,
  type TelemetryImport, type TelemetryRow,
} from "./types.ts";

const fail = (code: ConstructorParameters<typeof PilotError>[0], message: string): never => { throw new PilotError(code, message); };

export const EARLY_STOP_LEVEL = 0.999;
export const INTEGRITY_ALPHA = 0.001;
// Pearson's chi-square needs expected counts of about 5 or more per cell to be trusted.
export const MIN_EXPECTED = 5;
// Differences of rates are differences of fractions k/n, which floating point cannot always represent exactly
// (0.45 - 0.4 < 0.05). Comparisons against a threshold allow this much, far below any real difference.
const EPS = 1e-12;

// The flags that hold a final result. Order is the order reasons are given in.
export const HOLD_FLAGS = [
  "insufficient_samples", "sample_ratio_mismatch", "cohort_imbalance", "missing_events", "missing_imbalance", "attribution_ambiguous",
  "observational", "runtime_changed", "inside_lag_window", "window_not_covered",
] as const;

// A few rows can reach the source late. More than this many, and more than this share of the rows that were on
// time, is worth telling the reader.
const LATE_ROWS_MIN = 5;
const LATE_ROWS_SHARE = 0.02;

const pctLevel = (level: number) => `${Number((level * 100).toFixed(2))}%`;

export function buildExperimentSpec(input: {
  pilot_id: string; config_id: Sha256; contract: MetricContract; baseline: ArmRef; candidate: ArmRef;
  baseline_report: BaselineReport; start: IsoTime;
  // Intended share of traffic for the candidate. Absent: 0.5.
  candidate_share?: number;
}): ExperimentSpec {
  const { contract: c } = input;
  if (typeof input.start !== "string" || Number.isNaN(ms(input.start))) fail("usage", `The experiment start must be a UTC time like 2026-10-01T00:00:00Z.`);
  const share = input.candidate_share ?? 0.5;
  if (typeof share !== "number" || !Number.isFinite(share) || share <= 0 || share >= 1) fail("usage", "candidate_share must be a number between 0 and 1, not including either (0.5 is an even split).");
  if (input.baseline.tag === input.candidate.tag) fail("conflict", `The baseline and candidate arms share the tag ${input.baseline.tag}. Each arm needs its own tag so the export can tell them apart.`);
  if (input.baseline.prompt_id === input.candidate.prompt_id) fail("conflict", "The baseline and candidate arms are the same prompt. There is nothing to compare.");
  if (input.baseline_report.config_id !== input.config_id) fail("conflict", "The baseline report was made for a different pilot configuration. Make a baseline report for the current configuration first.");
  const required = input.baseline_report.required_per_arm.value;
  if (required === null) {
    fail("invalid_telemetry", "The baseline report could not compute the required conversations per arm (no usable baseline values for the primary metric). Import a baseline export with mature outcomes and make the report again.");
  }
  const start = input.start;
  const end = addDays(start, c.analysis_window_days);
  const cutoff = addDays(end, c.outcome_lag_days);
  const level = 1 - c.alpha;
  const metrics = [c.primary, ...c.guards];
  const fields = [
    "conversation_id (string, tokenised; one row per conversation)",
    `prompt_version (string: ${input.baseline.tag} or ${input.candidate.tag})`,
    "started_at (UTC time, e.g. 2026-10-01T09:30:00Z)",
    "segment (optional string)",
    "unit_id (optional string: the assignment key, tokenised)",
    "model_id (optional string: the runtime model)",
    ...metrics.map((m) => `values.${m.name}: ${m.unit} (${m.kind === "rate" ? "0, 1 or null" : "a number or null"})`),
  ];
  return {
    version: 1,
    pilot_id: input.pilot_id,
    config_id: input.config_id,
    arms: { baseline: { ...input.baseline }, candidate: { ...input.candidate } },
    allocation: { baseline: 1 - share, candidate: share },
    assignment: "randomized",
    randomization_unit: "conversation",
    window: { start, end },
    analysis_cutoff: cutoff,
    required_per_arm: required as number,
    denominator: c.denominator,
    primary: { ...c.primary },
    guards: c.guards.map((g) => ({ ...g, ...(g.early_stop ? { early_stop: { ...g.early_stop } } : {}) })),
    alpha: c.alpha,
    early_stop_level: EARLY_STOP_LEVEL,
    integrity_alpha: INTEGRITY_ALPHA,
    max_missing_rate: c.max_missing_rate,
    max_unattributed_rate: c.max_unattributed_rate,
    outcome_lag_days: c.outcome_lag_days,
    methods: {
      rate: `Rate metrics: each arm's estimate is the share of mature, attributable conversations whose value is 1 (a null value is missing and left out); the difference is candidate minus baseline, with a Newcombe hybrid score interval (method 10) at ${pctLevel(level)}.`,
      mean: `Mean metrics: each arm's estimate is the mean over mature, attributable conversations with a value; the difference is candidate minus baseline, with a Welch interval (Welch-Satterthwaite degrees of freedom) at ${pctLevel(level)}.`,
      keep: `Keep only at the final analysis (an export made at or after ${cutoff}) with none of the data problems listed under hold, when the primary metric's benefit (the difference in its good direction) is at least ${c.primary.min_effect} and the lower bound of its ${pctLevel(level)} interval is above 0, and every guard passes: the upper bound of the ${pctLevel(level)} interval for its harm is at most its max_harm.`,
      revert: `Revert at the final analysis with no data or sample-size holds when any guard breaches (the lower bound of the ${pctLevel(level)} interval for its harm is above its max_harm) or the primary metric is significantly worse (the upper bound of the ${pctLevel(level)} interval for its benefit is below 0). Before the final analysis only a critical guard's early stop can revert, and only when telemetry integrity checks pass.`,
      hold: `Hold in every other case: before the cutoff; when there are fewer than ${required} conversations with a primary value in either arm, a sample ratio mismatch, a cohort imbalance, missing events above ${pct(c.max_missing_rate)} or far more common in one arm, ambiguous attribution above ${pct(c.max_unattributed_rate)}, observational assignment, more than one runtime model, or outcomes still inside the ${c.outcome_lag_days}-day lag, or no single export covering the whole window; when the primary does not clear; or when a guard is inconclusive.`,
      early_stop: `Early stop: before the cutoff, a critical guard with early_stop is checked at ${pctLevel(EARLY_STOP_LEVEL)} once both arms have at least its min_per_arm mature values; it reverts when the lower bound of the ${pctLevel(EARLY_STOP_LEVEL)} interval for its harm is above its max_harm. No other guard and no primary result is acted on before the cutoff.`,
      integrity: `Integrity: rows per arm are tested against the intended allocation (chi-square goodness of fit), and arm against segment (chi-square test of independence, pooling segments with expected counts below ${MIN_EXPECTED}); a p-value below ${INTEGRITY_ALPHA} holds the result as a sample ratio mismatch or a cohort imbalance.`,
    },
    telemetry_fields: fields,
    rollback: {
      prompt_id: input.baseline.prompt_id,
      tag: input.baseline.tag,
      instructions: `To roll back, the customer's rollout owner routes all traffic back to the baseline prompt (tag ${input.baseline.tag}, prompt ${input.baseline.prompt_id}) with the customer's own rollout controls. Synthe does not change traffic.`,
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------------------------------------------

interface Oriented { point: number; lo: number; hi: number }

// benefit: the difference in the metric's good direction. harm is minus benefit.
function benefitOf(direction: MetricSpec["direction"], diff: number | null, ci: Ci | null): { benefit: number | null; bCi: Oriented | null; hCi: Oriented | null } {
  if (diff === null) return { benefit: null, bCi: null, hCi: null };
  const sign = direction === "higher_is_better" ? 1 : -1;
  const benefit = sign * diff;
  if (ci === null) return { benefit, bCi: null, hCi: null };
  const bLo = sign > 0 ? ci.lo : -ci.hi;
  const bHi = sign > 0 ? ci.hi : -ci.lo;
  return { benefit, bCi: { point: benefit, lo: bLo, hi: bHi }, hCi: { point: -benefit, lo: -bHi, hi: -bLo } };
}

function interval(kind: MetricKind, cand: ArmMetric, base: ArmMetric, level: number): Interval | null {
  const ci = kind === "rate" ? newcombeInterval(cand.successes, cand.n, base.successes, base.n, level) : welchInterval(cand.stats, base.stats, level);
  return ci === null ? null : { lo: ci.lo, hi: ci.hi, level: ci.level };
}

const methodOf = (kind: MetricKind, level: number) =>
  kind === "rate" ? `Newcombe hybrid score interval (method 10) for candidate minus baseline, ${pctLevel(level)}` : `Welch interval (Welch-Satterthwaite df) for candidate minus baseline, ${pctLevel(level)}`;

const signed = (x: number | null) => (x === null ? "n/a" : `${x > 0 ? "+" : ""}${fmt(x)}`);
const ciStr = (ci: { lo: number; hi: number } | null) => (ci === null ? "n/a" : `${fmt(ci.lo)} to ${fmt(ci.hi)}`);

interface GuardEval { readout: MetricReadout; earlyBreach: boolean; spec: GuardSpec; harm: number | null }

function readoutBase(m: MetricSpec, role: "primary" | "guard", base: ArmMetric, cand: ArmMetric, level: number) {
  const diff = base.estimate !== null && cand.estimate !== null ? cand.estimate - base.estimate : null;
  const ci = diff === null ? null : interval(m.kind, cand, base, level);
  return {
    diff, ci,
    readout: {
      name: m.name, role, kind: m.kind, unit: m.unit, direction: m.direction,
      baseline: { n: base.n, missing: base.missing, estimate: base.estimate },
      candidate: { n: cand.n, missing: cand.missing, estimate: cand.estimate },
      difference: diff, ci, method: methodOf(m.kind, level),
    },
  };
}

function primaryReadout(p: ExperimentSpec["primary"], base: ArmMetric, cand: ArmMetric, level: number): MetricReadout {
  const { diff, ci, readout } = readoutBase(p, "primary", base, cand, level);
  const { benefit, bCi } = benefitOf(p.direction, diff, ci);
  let status: MetricReadout["status"] = "not_clear";
  if (benefit !== null && bCi !== null && benefit >= p.min_effect - EPS && bCi.lo > EPS) status = "clears";
  else if (bCi !== null && bCi.hi < -EPS) status = "breach";
  const nums = `candidate ${fmt(cand.estimate)} (n ${cand.n}) vs baseline ${fmt(base.estimate)} (n ${base.n}), difference ${signed(diff)} (${pctLevel(level)} interval ${ciStr(ci)})`;
  const detail = diff === null
    ? `${p.name}: no estimate, because ${base.n === 0 ? "the baseline arm" : "the candidate arm"} has no usable values.`
    : ci === null
      ? `${p.name}: ${nums}; the interval cannot be computed from these values.`
      : status === "clears"
        ? `${p.name}: ${nums}; the benefit ${fmt(benefit)} reaches min_effect ${p.min_effect} and the interval is above 0.`
        : status === "breach"
          ? `${p.name}: ${nums}; the candidate is significantly worse.`
          : `${p.name}: ${nums}; ${(benefit as number) < p.min_effect - EPS ? `the benefit ${fmt(benefit)} is below min_effect ${p.min_effect}` : "the interval for the benefit is not above 0"}.`;
  return { ...readout, status, detail };
}

function guardReadout(g: GuardSpec, base: ArmMetric, cand: ArmMetric, level: number, earlyLevel: number): GuardEval {
  const { diff, ci, readout } = readoutBase(g, "guard", base, cand, level);
  const { benefit, hCi } = benefitOf(g.direction, diff, ci);
  const harm = benefit === null ? null : -benefit;
  let status: MetricReadout["status"] = "inconclusive";
  // Three outcomes, each a statement the interval supports: the harm is shown to be beyond what the team
  // tolerates (breach), shown to be within it (pass), or neither (inconclusive). Harm that is real but may still
  // be inside the tolerated margin is not a breach: the contract says the team accepts that much.
  if (hCi !== null && hCi.lo > g.max_harm + EPS) status = "breach";
  else if (hCi !== null && hCi.hi <= g.max_harm + EPS) status = "pass";
  let early: Interval | null = null;
  let earlyBreach = false;
  if (g.critical && g.early_stop && base.n >= g.early_stop.min_per_arm && cand.n >= g.early_stop.min_per_arm && diff !== null) {
    early = interval(g.kind, cand, base, earlyLevel);
    const e = benefitOf(g.direction, diff, early).hCi;
    earlyBreach = e !== null && e.lo > g.max_harm + EPS;
  }
  const nums = `candidate ${fmt(cand.estimate)} (n ${cand.n}) vs baseline ${fmt(base.estimate)} (n ${base.n}), harm ${signed(harm)} (${pctLevel(level)} interval for harm ${ciStr(hCi)}), tolerated ${g.max_harm}`;
  const detail = diff === null
    ? `${g.name}: no estimate, because ${base.n === 0 ? "the baseline arm" : "the candidate arm"} has no usable values.`
    : status === "breach"
      ? `${g.name}: ${nums}; the whole interval is above the margin.`
      : status === "pass"
        ? `${g.name}: ${nums}; the whole interval is within the margin.`
        : `${g.name}: ${nums}; ${hCi === null ? "the interval cannot be computed from these values" : hCi.lo > EPS ? "harm is above zero, but the interval does not show whether it is within or beyond the margin" : "the interval reaches past the margin, so it is not shown to be safe"}.`;
  return { readout: { ...readout, early_ci: early, status, detail }, earlyBreach, spec: g, harm };
}

// Arm x segment independence. Segments too small for the chi-square approximation are pooled into one column; if
// the pool is still too small it joins the smallest kept segment. Null when fewer than two usable columns remain.
export function cohortTest(base: Record<string, number>, cand: Record<string, number>): number | null {
  const segs = [...new Set([...Object.keys(base), ...Object.keys(cand)])].sort();
  const cols = segs.map((s) => [base[s] ?? 0, cand[s] ?? 0]);
  const nb = cols.reduce((t, c) => t + c[0], 0);
  const nc = cols.reduce((t, c) => t + c[1], 0);
  if (nb === 0 || nc === 0) return null;
  const minShare = Math.min(nb, nc) / (nb + nc);
  const enough = (c: number[]) => (c[0] + c[1]) * minShare >= MIN_EXPECTED;
  const kept = cols.filter(enough);
  const pool = cols.filter((c) => !enough(c)).reduce((t, c) => [t[0] + c[0], t[1] + c[1]], [0, 0]);
  if (pool[0] + pool[1] > 0) {
    if (enough(pool)) kept.push(pool);
    else if (kept.length > 0) {
      const smallest = kept.reduce((best, c, i) => (c[0] + c[1] < kept[best][0] + kept[best][1] ? i : best), 0);
      kept[smallest] = [kept[smallest][0] + pool[0], kept[smallest][1] + pool[1]];
    }
  }
  if (kept.length < 2) return null;
  const r = chiSquareIndependence([kept.map((c) => c[0]), kept.map((c) => c[1])]);
  return r === null ? null : r.p;
}

// Pure, and never reads the clock: the same specification and imports always give the same analysis.
export function analyzeExperiment(input: { spec: ExperimentSpec; experiment_id: Sha256; imports: Stored<TelemetryImport>[]; approval_id: Sha256 }): ExperimentAnalysis {
  const { spec } = input;
  const baseTag = spec.arms.baseline.tag;
  const candTag = spec.arms.candidate.tag;
  for (const imp of input.imports) {
    if (imp.value.purpose !== "experiment") fail("invalid_telemetry", `Import telemetry:${shortId(imp.id)} was made for the baseline, not this experiment. Import the experiment export with purpose experiment.`);
    if (imp.value.scope_id !== input.experiment_id) fail("invalid_telemetry", `Import telemetry:${shortId(imp.id)} belongs to a different experiment. Import the export again for this experiment.`);
  }
  if (input.imports.length === 0) fail("telemetry_incomplete", "No experiment telemetry has been imported yet. Import the customer's export first.");
  const merged = mergeImports(input.imports);
  const allTags = merged.form === "rows" ? (merged.rows as TelemetryRow[]).map((r) => r.prompt_version) : (merged.aggregates ?? []).map((a) => a.prompt_version);
  versionCheck(allTags, [baseTag, candTag], merged.form === "rows" ? "row" : "aggregate");
  if (merged.form === "aggregates" && ms(merged.used[0].value.window.start) !== ms(spec.window.start)) {
    fail("telemetry_window_mismatch", `The newest aggregate export starts at ${merged.used[0].value.window.start}, not at the experiment start ${spec.window.start}. Aggregate exports must be cumulative from the start of the experiment.`);
  }
  if (merged.form === "rows") {
    const outside = (merged.rows as TelemetryRow[]).filter((r) => ms(r.started_at) < ms(spec.window.start) || ms(r.started_at) >= ms(spec.window.end)).length;
    if (outside > 0) fail("telemetry_window_mismatch", `${outside} rows started outside the experiment window ${spec.window.start} to ${spec.window.end}.`);
  }
  const asOf = merged.as_of;
  const final = ms(asOf) >= ms(spec.analysis_cutoff);
  const level = 1 - spec.alpha;

  let arms: { baseline: ArmCounts; candidate: ArmCounts };
  let metricFor: (tag: string, name: string, kind: MetricKind) => ArmMetric;
  let models = 0;
  let hasSegments = false;
  let lateRows = 0;
  if (merged.form === "rows") {
    const rows = merged.rows as TelemetryRow[];
    // Conversations only a later export has, although they were old enough for their outcome to be final when an
    // earlier export of the same period was made. They finished later than the outcome lag, or reached the source
    // late. The final export holds them, so the result stands; the count is reported, because it means earlier
    // exports were incomplete and the contract's outcome lag may be too short. (A second copy of a conversation
    // is a different problem, and is refused when the export is read.)
    const lag = spec.outcome_lag_days * DAY_MS;
    lateRows = rows.filter((r, i) => { const missed = merged.row_missed_at?.[i] ?? null; return missed !== null && ms(r.started_at) + lag <= missed; }).length;
    const classes = classifyRows(rows, spec.outcome_lag_days, asOf, merged.row_as_of ?? undefined);
    arms = { baseline: armCountsFromRows(rows, classes, baseTag), candidate: armCountsFromRows(rows, classes, candTag) };
    metricFor = (tag, name, kind) => armMetricFromRows(rows, classes, tag, name, kind);
    models = new Set(rows.filter((r) => r.model_id !== undefined).map((r) => r.model_id)).size;
    hasSegments = rows.some((r) => r.segment !== undefined);
  } else {
    const aggs = merged.aggregates ?? [];
    const find = (tag: string) => aggs.find((a) => a.prompt_version === tag);
    arms = { baseline: armCountsFromAggregate(find(baseTag), baseTag), candidate: armCountsFromAggregate(find(candTag), candTag) };
    metricFor = (tag, name, kind) => armMetricFromAggregate(find(tag), name, kind);
    hasSegments = aggs.some((a) => a.segments !== undefined && Object.keys(a.segments).length > 0);
  }

  const pm = { base: metricFor(baseTag, spec.primary.name, spec.primary.kind), cand: metricFor(candTag, spec.primary.name, spec.primary.kind) };
  const primary = primaryReadout(spec.primary, pm.base, pm.cand, level);
  const guardMetrics = spec.guards.map((g) => ({ base: metricFor(baseTag, g.name, g.kind), cand: metricFor(candTag, g.name, g.kind) }));
  const guards = spec.guards.map((g, i) => guardReadout(g, guardMetrics[i].base, guardMetrics[i].cand, level, spec.early_stop_level));

  // Data quality.
  const rowsTotal = arms.baseline.rows + arms.candidate.rows;
  const matureTotal = arms.baseline.mature + arms.candidate.mature;
  const immatureTotal = arms.baseline.immature + arms.candidate.immature;
  const unattributedTotal = arms.baseline.unattributed + arms.candidate.unattributed;
  const missingRates: { name: string; arm: string; rate: number }[] = [];
  for (const [name, m] of [[spec.primary.name, pm] as const, ...spec.guards.map((g, i) => [g.name, guardMetrics[i]] as const)]) {
    missingRates.push({ name, arm: "baseline", rate: arms.baseline.mature > 0 ? m.base.missing / arms.baseline.mature : 0 });
    missingRates.push({ name, arm: "candidate", rate: arms.candidate.mature > 0 ? m.cand.missing / arms.candidate.mature : 0 });
  }
  const worstMissing = missingRates.reduce((w, r) => (r.rate > w.rate ? r : w), { name: "", arm: "", rate: 0 });
  const unattributedRate = rowsTotal > 0 ? unattributedTotal / rowsTotal : 0;
  const srm = chiSquareGof([arms.baseline.rows, arms.candidate.rows], [spec.allocation.baseline, spec.allocation.candidate]);
  const srmP = srm === null ? null : srm.p;
  const cohortP = hasSegments ? cohortTest(arms.baseline.segments, arms.candidate.segments) : null;

  // Missing outcomes that pile up in one arm can make that arm look better while each arm stays under the limit:
  // drop the failures and the rate rises. So the arms' missing rates are also compared with each other.
  let missingGap: { name: string; p: number } | null = null;
  for (const [name, m] of [[spec.primary.name, pm] as const, ...spec.guards.map((g, i) => [g.name, guardMetrics[i]] as const)]) {
    const r = chiSquareIndependence([[m.base.missing, m.base.n], [m.cand.missing, m.cand.n]]);
    if (r !== null && r.p < spec.integrity_alpha && (missingGap === null || r.p < missingGap.p)) missingGap = { name, p: r.p };
  }
  // Segments reported for one arm only cannot be compared, which is not the same as balanced.
  const oneSided = hasSegments && (Object.keys(arms.baseline.segments).length === 0) !== (Object.keys(arms.candidate.segments).length === 0);

  const flags: string[] = [];
  if (!final) flags.push("before_cutoff");
  if (immatureTotal > 0) flags.push("inside_lag_window");
  if (pm.base.n < spec.required_per_arm || pm.cand.n < spec.required_per_arm) flags.push("insufficient_samples");
  if (srmP !== null && srmP < spec.integrity_alpha) flags.push("sample_ratio_mismatch");
  if ((cohortP !== null && cohortP < spec.integrity_alpha) || oneSided) flags.push("cohort_imbalance");
  if (missingRates.some((r) => r.rate > spec.max_missing_rate + EPS)) flags.push("missing_events");
  if (missingGap !== null) flags.push("missing_imbalance");
  if (unattributedRate > spec.max_unattributed_rate + EPS) flags.push("attribution_ambiguous");
  const onTime = (merged.rows?.length ?? 0) - lateRows;
  // Informational, like superseded_aggregate: it does not hold the result.
  if (lateRows > Math.max(LATE_ROWS_MIN, LATE_ROWS_SHARE * onTime)) flags.push("late_rows");
  if (merged.observational) flags.push("observational");
  if (models > 1) flags.push("runtime_changed");
  // A final result needs one export that spans the whole predeclared window. Otherwise an export of the first few
  // days, made after the cutoff, would count as final and skip the days the window was set to cover.
  const covered = merged.used.some((i) => ms(i.value.window.start) <= ms(spec.window.start) && ms(i.value.window.end) >= ms(spec.window.end));
  if (final && !covered) flags.push("window_not_covered");
  if (merged.superseded.length > 0) flags.push("superseded_aggregate");

  // Recommendation, in the predeclared order.
  const reasons: string[] = [];
  let recommendation: ExperimentAnalysis["recommendation"];
  let stoppedBy: ExperimentAnalysis["stopped_by"];
  const earlyStops = guards.filter((g) => g.earlyBreach);
  const finalBreaches = guards.filter((g) => g.readout.status === "breach");
  const holdFlags = HOLD_FLAGS.filter((f) => flags.includes(f));
  // Interim guards have their own mature-sample minimum. Integrity failures still block every terminal decision.
  const canStopEarly = holdFlags.every((flag) => flag === "insufficient_samples" || flag === "inside_lag_window");
  if (!final && canStopEarly && earlyStops.length > 0) {
    recommendation = "revert";
    stoppedBy = "early_stop";
    for (const g of earlyStops) {
      const e = benefitOf(g.spec.direction, g.readout.difference, g.readout.early_ci ?? null).hCi as Oriented;
      reasons.push(`Early stop: critical guard ${g.spec.name} has harm ${fmt(g.harm)}, and the ${pctLevel(spec.early_stop_level)} interval for harm (${ciStr(e)}) is wholly above its tolerated ${g.spec.max_harm}, with ${g.readout.baseline.n} baseline and ${g.readout.candidate.n} candidate values (at least ${g.spec.early_stop?.min_per_arm} each).`);
    }
  } else if (final && holdFlags.length === 0 && (finalBreaches.length > 0 || primary.status === "breach")) {
    recommendation = "revert";
    stoppedBy = "final";
    for (const g of finalBreaches) reasons.push(`Guard breach at the final analysis: ${g.readout.detail}`);
    if (primary.status === "breach") reasons.push(`The primary metric is significantly worse at the final analysis: ${primary.detail}`);
  } else if (!final || holdFlags.length > 0) {
    recommendation = "hold";
  } else {
    recommendation = primary.status === "clears" && guards.every((g) => g.readout.status === "pass") ? "keep" : "hold";
  }

  if (recommendation === "hold") {
    if (!final) reasons.push(`This is an interim look: the newest export was made at ${asOf}, before the analysis cutoff ${spec.analysis_cutoff}. A final result needs an export made at or after the cutoff; look again then.`);
    for (const f of holdFlags) reasons.push(holdReason(f, { spec, pm, arms, srmP, cohortP, worstMissing, unattributedRate, immatureTotal, models, asOf, missingGap }));
    if (primary.status !== "clears") reasons.push(`The primary metric does not clear: ${primary.detail}`);
    for (const g of guards) {
      if (g.readout.status === "inconclusive") reasons.push(`Guard ${g.spec.name} is inconclusive: ${g.readout.detail}`);
      if (g.readout.status === "breach" && !final) {
        reasons.push(`Guard ${g.spec.name} looks harmful at the ${pctLevel(level)} level (${g.readout.detail}) but ${g.earlyBreach && !canStopEarly ? "telemetry integrity checks block its early stop" : g.spec.critical && g.spec.early_stop ? `has not met its ${pctLevel(spec.early_stop_level)} early-stop rule` : "has no predeclared early stop"}. A later decision needs valid evidence.`);
      }
    }
    if (final && holdFlags.length === 0 && reasons.length === 0) reasons.push("The result does not meet the keep rule.");
  }
  if (recommendation === "keep") {
    reasons.push(`The primary metric clears: ${primary.detail}`);
    for (const g of guards) reasons.push(`Guard ${g.spec.name} passes: ${g.readout.detail}`);
  }
  if (merged.superseded.length > 0) {
    reasons.push(`Older cumulative aggregate exports were not used because a newer one replaces them: ${merged.superseded.map((s) => `telemetry:${shortId(s.id)}`).join(", ")}.`);
  }

  const out: ExperimentAnalysis = {
    version: 1,
    experiment_id: input.experiment_id,
    telemetry_ids: merged.used.map((i) => i.id),
    approval_id: input.approval_id,
    as_of: asOf,
    final,
    arms,
    allocation: { intended: spec.allocation.candidate, observed: rowsTotal > 0 ? arms.candidate.rows / rowsTotal : null, srm_p: srmP, flagged: flags.includes("sample_ratio_mismatch") },
    coverage: {
      rows: rowsTotal, mature: matureTotal, immature: immatureTotal, unattributed: unattributedTotal, missing_rate: worstMissing.rate,
      unattributed_rate: unattributedRate, duplicates_dropped: merged.duplicates_dropped, required_per_arm: spec.required_per_arm, late_rows: lateRows,
    },
    primary,
    guards: guards.map((g) => g.readout),
    flags,
    recommendation,
    reasons,
    rollback: { ...spec.rollback },
  };
  if (stoppedBy) out.stopped_by = stoppedBy;
  return out;
}

function holdReason(flag: string, x: {
  spec: ExperimentSpec; pm: { base: ArmMetric; cand: ArmMetric }; arms: { baseline: ArmCounts; candidate: ArmCounts };
  srmP: number | null; cohortP: number | null; worstMissing: { name: string; arm: string; rate: number }; unattributedRate: number;
  immatureTotal: number; models: number; asOf: IsoTime; missingGap: { name: string; p: number } | null;
}): string {
  const s = x.spec;
  switch (flag) {
    case "insufficient_samples": return `Not enough data: ${s.primary.name} has ${x.pm.base.n} baseline and ${x.pm.cand.n} candidate values; the experiment needs ${s.required_per_arm} in each arm. Keep the experiment running and export again later.`;
    case "sample_ratio_mismatch": return `Sample ratio mismatch: ${x.arms.candidate.rows} of ${x.arms.baseline.rows + x.arms.candidate.rows} rows are candidate, against an intended ${pct(s.allocation.candidate)} (p = ${x.srmP?.toExponential(2)}, below ${s.integrity_alpha}). The traffic split or the export is not working as planned; the customer should check both before any result is trusted.`;
    case "cohort_imbalance": return x.cohortP === null
      ? "Cohort imbalance: only one arm reports segments, so the mix of the two arms cannot be compared. Export segments for both arms."
      : `Cohort imbalance: the arms have a different mix of segments (p = ${x.cohortP.toExponential(2)}, below ${s.integrity_alpha}), so assignment may not be random. The customer should check how traffic is split.`;
    case "missing_imbalance": return `Missing events differ between the arms: ${x.missingGap?.name} is missing far more often in one arm than the other (p = ${x.missingGap?.p.toExponential(2)}, below ${s.integrity_alpha}). An arm can look better only because its bad outcomes were not recorded; fix the logging and export again.`;
    case "missing_events": return `Missing events: ${pct(x.worstMissing.rate)} of mature ${x.worstMissing.arm} conversations have no ${x.worstMissing.name} value, above the ${pct(s.max_missing_rate)} limit. An arm can look better only because its bad outcomes were not recorded; fix the logging and export again.`;
    case "attribution_ambiguous": return `Ambiguous attribution: ${pct(x.unattributedRate)} of rows belong to units seen in both arms, above the ${pct(s.max_unattributed_rate)} limit. Their outcomes cannot be credited to one prompt; check that assignment is sticky.`;
    case "observational": return "The export says traffic was not randomised (observational), so a difference could come from who saw each prompt rather than the prompt. Run the experiment with a random split.";
    case "runtime_changed": return `The rows carry ${x.models} different runtime models, so a difference could come from the model change rather than the prompt. Rerun with one model, or export only the period with one model.`;
    case "window_not_covered": return `No export covers the whole experiment window ${s.window.start} to ${s.window.end}, so days of the planned window are missing. Export every conversation that started in the window, in one export, and analyse again.`;
    case "inside_lag_window": return `${x.immatureTotal} conversations are younger than the ${s.outcome_lag_days}-day outcome lag at ${x.asOf}, so their outcomes are not final and they are left out. Export again after the cutoff ${s.analysis_cutoff}.`;
    default: return flag;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------------------------

// Markdown the customer runs the experiment from.
export function renderExperimentSpec(spec: ExperimentSpec, experimentId: Sha256): string {
  const p = spec.primary;
  const L: string[] = [];
  L.push(`# Experiment plan: ${spec.pilot_id}`, "");
  L.push("The customer operates the traffic split with their own rollout controls. Synthe never changes traffic; it only analyses the export the customer sends.", "");
  L.push("## Arms", "", "| Arm | Tag | Prompt id | Intended share |", "|---|---|---|---|");
  L.push(`| Baseline | ${spec.arms.baseline.tag} | ${spec.arms.baseline.prompt_id} | ${pct(spec.allocation.baseline)} |`);
  L.push(`| Candidate | ${spec.arms.candidate.tag} | ${spec.arms.candidate.prompt_id} | ${pct(spec.allocation.candidate)} |`, "");
  L.push(`Assign at random per ${spec.randomization_unit}. Tag every conversation with its arm's tag as prompt_version.`, "");
  L.push("## Timing", "");
  L.push(`- Window: conversations that start from ${spec.window.start} up to (not including) ${spec.window.end}`);
  L.push(`- Outcome lag: ${spec.outcome_lag_days} days`);
  L.push(`- Analysis cutoff: ${spec.analysis_cutoff}. The final analysis needs an export made at or after this time; earlier exports are interim looks and can only hold or stop early.`);
  L.push(`- Required: at least ${spec.required_per_arm} conversations with a ${p.name} value in each arm`, "");
  L.push("## Metrics", "", "| Metric | Role | Kind | Unit | Good direction | Threshold |", "|---|---|---|---|---|---|");
  L.push(`| ${p.name} | primary | ${p.kind} | ${p.unit} | ${p.direction.replace(/_/g, " ")} | benefit of at least ${p.min_effect} |`);
  for (const g of spec.guards) {
    L.push(`| ${g.name} | guard${g.critical ? ", critical" : ""} | ${g.kind} | ${g.unit} | ${g.direction.replace(/_/g, " ")} | harm of at most ${g.max_harm}${g.early_stop ? `; early stop from ${g.early_stop.min_per_arm} per arm` : ""} |`);
  }
  L.push("", `Denominator: ${spec.denominator}.`, "");
  L.push("## Stop rules", "", `- ${spec.methods.early_stop}`, `- ${spec.methods.revert}`, `- ${spec.methods.keep}`, `- ${spec.methods.hold}`, "");
  L.push("## What to export", "");
  L.push(`One JSON file with format "${TELEMETRY_FORMAT}", export_id, source, exported_at, window (start and end as above), assignment "randomized", denominator "${spec.denominator}", units (each metric name to its unit, word for word as below), expected_rows (how many conversations the source holds for the window), and exactly one of rows (inline), rows_csv (a CSV file next to it, with a header line) or aggregates (one summary per prompt version: n, immature, unattributed, metrics, optional segments). Each row has only these fields; anything else is refused:`, "");
  for (const f of spec.telemetry_fields) L.push(`- ${f}`);
  L.push("", "## Predeclared analysis", "");
  for (const k of ["rate", "mean", "keep", "revert", "hold", "early_stop", "integrity"] as const) L.push(`- ${k}: ${spec.methods[k]}`);
  L.push("", "## Rollback", "", `Rollback target: tag ${spec.rollback.tag}, prompt ${spec.rollback.prompt_id}.`, spec.rollback.instructions, "");
  L.push("## Ids", "", `- Experiment: ${experimentId}`, `- Configuration: ${spec.config_id}`);
  return `${L.join("\n")}\n`;
}

const FLAG_TEXT: Record<string, string> = {
  before_cutoff: "Interim look: the newest export is from before the analysis cutoff.",
  inside_lag_window: "Some conversations are still inside the outcome lag; their outcomes are not final and are left out.",
  insufficient_samples: "Fewer conversations with a primary value than the plan requires in at least one arm.",
  sample_ratio_mismatch: "The split between arms is not what was planned (sample ratio mismatch).",
  cohort_imbalance: "The arms have a different mix of segments (cohort imbalance).",
  missing_events: "Too many conversations have no recorded value for some metric (missing events).",
  missing_imbalance: "One arm is missing recorded values far more often than the other.",
  attribution_ambiguous: "Too many rows belong to units seen in both arms (ambiguous attribution).",
  late_rows: "Some conversations are only in a later export although they were older than the outcome lag when an earlier export of the same period was made. Earlier exports were incomplete: conversations finish later than the outcome lag, or the source delivers them late. This does not hold the result; check the outcome lag with the customer.",
  observational: "Traffic was not randomised (observational).",
  runtime_changed: "More than one runtime model appears in the rows.",
  superseded_aggregate: "Older cumulative aggregate exports were replaced by a newer one and not used.",
  window_not_covered: "No single export covers the whole experiment window.",
};

const shown = (r: MetricReadout, x: number | null) => (r.kind === "rate" ? pct(x) : `${fmt(x)} ${r.unit}`);

// Markdown decision for the operator: every number with its source and method.
export function renderDecision(analysis: ExperimentAnalysis, spec: ExperimentSpec, analysisId: Sha256): string {
  const a = analysis;
  const p = a.primary;
  const source = `telemetry:${a.telemetry_ids.map(shortId).join(",")}`;
  const L: string[] = [];
  const head = `${p.name} ${shown(p, p.candidate.estimate)} on the candidate vs ${shown(p, p.baseline.estimate)} on the baseline`;
  L.push(`# ${a.recommendation.toUpperCase()}: ${head}`, "");
  const what = a.recommendation === "keep"
    ? "Keep the candidate prompt."
    : a.recommendation === "revert"
      ? `Revert to the baseline prompt${a.stopped_by === "early_stop" ? " now (early stop)" : ""}.`
      : "Hold: no decision yet.";
  L.push(`${what} ${p.name} difference ${signed(p.difference)} (${p.ci ? `${pctLevel(p.ci.level)} interval ${ciStr(p.ci)}` : "no interval"}), as of ${a.as_of}${a.final ? " (final analysis)" : ` (interim; cutoff ${spec.analysis_cutoff})`}.`, "");
  L.push("## Reasons", "", ...a.reasons.map((r) => `- ${r}`), "");
  L.push("## Allocation and coverage", "");
  L.push(`- Intended candidate share ${pct(a.allocation.intended)}, observed ${pct(a.allocation.observed)} (sample ratio p = ${a.allocation.srm_p === null ? "n/a" : a.allocation.srm_p.toPrecision(3)}${a.allocation.flagged ? ", flagged" : ""}). Source ${source}; chi-square goodness of fit.`);
  for (const [label, arm] of [["Baseline", a.arms.baseline], ["Candidate", a.arms.candidate]] as const) {
    L.push(`- ${label} (${arm.tag}): ${arm.rows} rows, ${arm.mature} mature, ${arm.immature} immature (excluded), ${arm.unattributed} unattributed (excluded). Source ${source}.`);
  }
  L.push(`- Largest missing rate ${pct(a.coverage.missing_rate)} (limit ${pct(spec.max_missing_rate)}); unattributed ${pct(a.coverage.unattributed_rate)} (limit ${pct(spec.max_unattributed_rate)}); duplicates dropped ${a.coverage.duplicates_dropped}; late rows ${a.coverage.late_rows}; required per arm ${a.coverage.required_per_arm}.`, "");
  L.push("## Metrics", "", "| Metric | Role | Baseline | Candidate | Difference | Interval | Status | Source | Method |", "|---|---|---|---|---|---|---|---|---|");
  for (const r of [p, ...a.guards]) {
    const arm = (x: MetricReadout["baseline"]) => `${fmt(x.estimate)} (n ${x.n}, missing ${x.missing})`;
    const early = r.early_ci ? `; early ${pctLevel(r.early_ci.level)}: ${ciStr(r.early_ci)}` : "";
    L.push(`| ${r.name} (${r.unit}) | ${r.role} | ${arm(r.baseline)} | ${arm(r.candidate)} | ${signed(r.difference)} | ${ciStr(r.ci)}${early} | ${r.status} | ${source} | ${r.method} |`);
  }
  L.push("");
  if (a.guards.length > 0) {
    L.push("## Guards", "", ...a.guards.map((g) => `- ${g.status}: ${g.detail}`), "");
  }
  L.push("## Data problems", "");
  if (a.flags.length === 0) L.push("None found.");
  else for (const f of a.flags) L.push(`- ${f}: ${FLAG_TEXT[f] ?? f}`);
  L.push("", "## Rollback target", "", `Tag ${a.rollback.tag}, prompt ${a.rollback.prompt_id}. ${a.rollback.instructions}`, "");
  if (a.recommendation !== "keep") {
    L.push("## What to do next", "");
    if (a.recommendation === "revert") {
      L.push(`- The customer's rollout owner routes all traffic to tag ${a.rollback.tag} now. Synthe does not change traffic.`);
      L.push("- Record the revert, then look at which guard or metric failed before proposing another candidate.");
    } else {
      if (!a.final) L.push(`- Keep the experiment running as planned and export again at or after ${spec.analysis_cutoff}.`);
      if (a.flags.some((f) => (HOLD_FLAGS as readonly string[]).includes(f) && f !== "inside_lag_window" && f !== "insufficient_samples")) L.push("- Fix the data problems above with the customer before trusting any result.");
      if (a.flags.includes("insufficient_samples")) L.push(`- Collect at least ${spec.required_per_arm} conversations with a ${p.name} value in each arm.`);
      L.push("- If the final analysis is still hold, the candidate has not shown it is better; the team decides whether to stop it or run longer.");
    }
    L.push("");
  }
  L.push("## Methods", "", ...(["rate", "mean", "keep", "revert", "hold", "early_stop", "integrity"] as const).map((k) => `- ${k}: ${spec.methods[k]}`), "");
  L.push("## Ids", "", `- Analysis: ${analysisId}`, `- Experiment: ${a.experiment_id}`, `- Approval: ${a.approval_id}`, `- Configuration: ${spec.config_id}`);
  L.push(`- Baseline prompt: ${spec.arms.baseline.prompt_id} (${spec.arms.baseline.tag})`, `- Candidate prompt: ${spec.arms.candidate.prompt_id} (${spec.arms.candidate.tag})`);
  for (const id of a.telemetry_ids) L.push(`- Telemetry import: ${id}`);
  return `${L.join("\n")}\n`;
}
