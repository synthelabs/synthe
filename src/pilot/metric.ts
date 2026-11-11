// The metric contract: validation. Lane: metric and experiment evaluation.
//
// The contract is the team's frozen definition of success, so anything that could change its meaning without
// anyone noticing is refused: an unknown key (a misspelt min_effect would otherwise fall back to nothing), a margin
// that can never be shown to pass, an outcome too slow to be attributed inside the window.
import { PilotError } from "./errors.ts";
import { isSha256, ms } from "./ids.ts";
import type { GuardSpec, MetricContract, MetricSpec } from "./types.ts";

const bad = (message: string): never => { throw new PilotError("invalid_metric", message); };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isNonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
// Telemetry row fields and CSV columns. A metric with one of these names would collide with them in a CSV header.
export const RESERVED_METRIC_NAMES = ["conversation_id", "prompt_version", "started_at", "segment", "unit_id", "model_id", "values"];

function onlyKeys(value: Record<string, unknown>, allowed: string[], where: string): void {
  const unknown = Object.keys(value).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    bad(`metric${where} has an unknown field "${unknown[0]}". Allowed fields: ${allowed.join(", ")}. Check the spelling in pilot.json.`);
  }
}

function metricSpec(value: Record<string, unknown>, where: string): MetricSpec {
  const { name, kind, unit, direction } = value;
  if (!isNonEmpty(name) || !NAME.test(name)) bad(`metric.${where}.name must be lowercase letters, digits and underscores, starting with a letter (at most 64 characters).`);
  if (RESERVED_METRIC_NAMES.includes(name as string)) bad(`metric.${where}.name "${name}" is reserved for a telemetry field. Choose another name.`);
  if (kind !== "rate" && kind !== "mean") bad(`metric.${where}.kind must be "rate" or "mean".`);
  if (!isNonEmpty(unit)) bad(`metric.${where}.unit must be a non-empty string, word for word as the telemetry export declares it.`);
  if (direction !== "higher_is_better" && direction !== "lower_is_better") bad(`metric.${where}.direction must be "higher_is_better" or "lower_is_better".`);
  return { name: name as string, kind: kind as MetricSpec["kind"], unit: unit as string, direction: direction as MetricSpec["direction"] };
}

function inRange(v: unknown, lo: number, hi: number, loOpen: boolean, hiOpen: boolean): v is number {
  if (!isFiniteNumber(v)) return false;
  return (loOpen ? v > lo : v >= lo) && (hiOpen ? v < hi : v <= hi);
}

// Validates the `metric` object of pilot.json. Throws PilotError invalid_metric with a plain sentence.
export function parseMetricContract(value: unknown): MetricContract {
  if (!isObject(value)) return bad("metric must be an object.");
  onlyKeys(value, [
    "version", "primary", "guards", "denominator", "randomization_unit", "alpha", "power", "min_samples_per_arm",
    "analysis_window_days", "outcome_lag_days", "max_missing_rate", "max_unattributed_rate", "query_hash", "signed_off",
  ], "");
  if (value.version !== 1) bad("metric.version must be 1.");

  if (!isObject(value.primary)) return bad("metric.primary must be an object.");
  onlyKeys(value.primary, ["name", "kind", "unit", "direction", "min_effect"], ".primary");
  const primarySpec = metricSpec(value.primary, "primary");
  const minEffect = value.primary.min_effect;
  if (!isFiniteNumber(minEffect) || minEffect <= 0) bad("metric.primary.min_effect must be a number greater than 0 (the smallest change in the good direction worth acting on).");
  if (primarySpec.kind === "rate" && (minEffect as number) >= 1) bad("metric.primary.min_effect must be less than 1 for a rate (a rate is a fraction: 0.02 is two percentage points).");
  const primary = { ...primarySpec, min_effect: minEffect as number };

  if (!Array.isArray(value.guards)) return bad("metric.guards must be an array (it may be empty).");
  const seen = new Set<string>([primary.name]);
  const guards: GuardSpec[] = value.guards.map((g: unknown, i: number) => {
    const where = `guards[${i}]`;
    if (!isObject(g)) return bad(`metric.${where} must be an object.`);
    onlyKeys(g, ["name", "kind", "unit", "direction", "max_harm", "critical", "early_stop"], `.${where}`);
    const spec = metricSpec(g, where);
    if (spec.name === primary.name) bad(`metric.${where}.name "${spec.name}" is the primary metric. A guard must be a different metric.`);
    if (seen.has(spec.name)) bad(`metric.${where}.name "${spec.name}" appears more than once. Each guard needs its own name.`);
    seen.add(spec.name);
    const maxHarm = g.max_harm;
    if (maxHarm === 0) bad(`metric.${where}.max_harm is 0. A zero margin can never be shown to pass, so the guard could never let a change be kept. Set the largest harm the team tolerates.`);
    if (!isFiniteNumber(maxHarm) || maxHarm <= 0) bad(`metric.${where}.max_harm must be a number greater than 0.`);
    if (spec.kind === "rate" && (maxHarm as number) >= 1) bad(`metric.${where}.max_harm must be less than 1 for a rate (0.02 is two percentage points).`);
    if (typeof g.critical !== "boolean") bad(`metric.${where}.critical must be true or false.`);
    const guard: GuardSpec = { ...spec, max_harm: maxHarm as number, critical: g.critical as boolean };
    if (g.early_stop !== undefined) {
      if (!isObject(g.early_stop)) return bad(`metric.${where}.early_stop must be an object with min_per_arm.`);
      onlyKeys(g.early_stop, ["min_per_arm"], `.${where}.early_stop`);
      if (!isInt(g.early_stop.min_per_arm) || g.early_stop.min_per_arm < 1) bad(`metric.${where}.early_stop.min_per_arm must be a whole number of at least 1.`);
      if (g.critical !== true) bad(`metric.${where}.early_stop is only allowed on a critical guard. Set critical to true or remove early_stop.`);
      guard.early_stop = { min_per_arm: g.early_stop.min_per_arm as number };
    }
    return guard;
  });

  if (!isNonEmpty(value.denominator)) bad("metric.denominator must be a non-empty string naming the population, e.g. completed_conversations.");
  if (value.randomization_unit !== "conversation") bad('metric.randomization_unit must be "conversation". Other units are not analysed in this version.');
  if (!inRange(value.alpha, 0, 0.2, true, false)) bad("metric.alpha must be greater than 0 and at most 0.2 (0.05 gives 95% intervals).");
  if (!inRange(value.power, 0.5, 1, false, true)) bad("metric.power must be at least 0.5 and less than 1 (0.8 is usual).");
  if (!isInt(value.min_samples_per_arm) || value.min_samples_per_arm < 2) bad("metric.min_samples_per_arm must be a whole number of at least 2.");
  if (!isInt(value.analysis_window_days) || value.analysis_window_days < 1) bad("metric.analysis_window_days must be a whole number of at least 1.");
  if (!isInt(value.outcome_lag_days) || value.outcome_lag_days < 0) bad("metric.outcome_lag_days must be a whole number of 0 or more.");
  if ((value.outcome_lag_days as number) > (value.analysis_window_days as number)) {
    bad(`metric.outcome_lag_days (${value.outcome_lag_days}) is longer than analysis_window_days (${value.analysis_window_days}). An outcome slower than the window cannot be attributed in the pilot. Lengthen the window or choose a faster outcome.`);
  }
  if (!inRange(value.max_missing_rate, 0, 0.5, false, false)) bad("metric.max_missing_rate must be between 0 and 0.5.");
  if (!inRange(value.max_unattributed_rate, 0, 0.5, false, false)) bad("metric.max_unattributed_rate must be between 0 and 0.5.");
  if (value.query_hash !== undefined && !isSha256(value.query_hash)) bad("metric.query_hash must be 64 lowercase hex characters (the SHA-256 of the metric query).");

  if (!isObject(value.signed_off)) return bad("metric.signed_off must be an object with by and at.");
  onlyKeys(value.signed_off, ["by", "at"], ".signed_off");
  if (!isNonEmpty(value.signed_off.by)) bad("metric.signed_off.by must name the person who signed off the metric.");
  if (typeof value.signed_off.at !== "string" || Number.isNaN(ms(value.signed_off.at))) bad("metric.signed_off.at must be a UTC time like 2026-09-01T12:00:00Z.");

  const out: MetricContract = {
    version: 1,
    primary,
    guards,
    denominator: value.denominator as string,
    randomization_unit: "conversation",
    alpha: value.alpha as number,
    power: value.power as number,
    min_samples_per_arm: value.min_samples_per_arm as number,
    analysis_window_days: value.analysis_window_days as number,
    outcome_lag_days: value.outcome_lag_days as number,
    max_missing_rate: value.max_missing_rate as number,
    max_unattributed_rate: value.max_unattributed_rate as number,
    signed_off: { by: value.signed_off.by as string, at: value.signed_off.at as string },
  };
  if (value.query_hash !== undefined) out.query_hash = value.query_hash as string;
  return out;
}
