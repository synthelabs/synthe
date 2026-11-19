// Free and deterministic: runs the pilot's real decision rule (importTelemetry, analyzeExperiment) on seeded
// synthetic experiments with known true rates, at exactly the looks the `watch` command's gate allows (lookGate), so
// the rule's error rates are measured, not only calculated. No file is written and nothing leaves the process.
//
//   node scripts/simulate-pilot.ts                  every scenario, 20,000 experiments each, checked against the limits
//   node scripts/simulate-pilot.ts 2000 7           2,000 experiments each, seed 7
//   node scripts/simulate-pilot.ts --rows 1000      the rows form (what `watch --log` imports), 1,000 experiments each
//
// What it covers: one tick a day at 00:00 UTC under `watch`'s look gate, a fair-coin split, independent
// conversations. Each export is the aggregates form by default; `--rows` sends the same counts as one CSV row per
// conversation, through the rows path (per-row maturity, sd from the rows, unit ids). `pilot analyze` run by hand
// has no look gate, so its false-stop rate is not the one measured here. Clustered units are not simulated.
//
// The limits come from scripts/simulate-pilot-reference.mjs, which works them out from theory with its own code.
// They were written before the first run and are never changed to make a run pass.
import { pathToFileURL } from "node:url";
import { parsePilotConfig } from "../src/pilot/config.ts";
import { baselineExport, DEMO, demoConfig } from "../src/pilot/demo-data.ts";
import { analyzeExperiment, buildExperimentSpec, HOLD_FLAGS, KEEP_BLOCKERS } from "../src/pilot/experiment.ts";
import { addDays, contentId, DAY_MS, ms } from "../src/pilot/ids.ts";
import { baselineReport, importTelemetry } from "../src/pilot/telemetry.ts";
import { TELEMETRY_FORMAT, type ExperimentSpec, type MetricContract, type Sha256, type Stored, type TelemetryImport } from "../src/pilot/types.ts";
import { interimLooksAllowed, lookGate, type Look } from "../src/pilot/watch.ts";
import { limits, PLAN, SCENARIOS } from "./simulate-pilot-reference.mjs";

export interface ArmRates { resolved: number; escalated: number; refunded: number; refund_usd: number }
export interface Scenario { base: ArmRates; cand: ArmRates }

export interface SimResult {
  runs: number;
  keep: number;
  // Reverts by the 99.9% early stop, and reverts by the ordinary rule at the final analysis.
  revert_early: number;
  revert_final: number;
  // The experiment reached its final analysis and stayed on hold.
  hold_final: number;
  // revert_early by the day of the look that fired (index = days since the start).
  early_by_day: number[];
  // What held the final analyses that held: each data problem by name, and `no_data_problem` when the data were
  // clean and the result simply did not meet the keep rule.
  final_hold_flags: Record<string, number>;
  // Analyses run before the cutoff, summed over the runs, and the most any one run used.
  interim_looks: number;
  max_interim_looks: number;
  interim_allowed: number;
}

// xoshiro128**, seeded through splitmix32 from (seed, stream): the same seed repeats every run exactly, and each
// stream (one per scenario) starts at an unrelated point of a 2^128 - 1 period, so streams do not overlap. (A
// 2^32-period generator is too short: one scenario at 20,000 runs draws about 5.4 x 10^8 numbers.)
export function seededRandom(seed: number, stream = 0): () => number {
  let x = (seed ^ Math.imul(stream + 1, 0x85ebca6b)) | 0;
  const next = () => {
    x = (x + 0x9e3779b9) | 0;
    let t = x ^ (x >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
  let a = next(), b = next(), c = next(), d = next();
  if ((a | b | c | d) === 0) a = 1;
  return () => {
    const t = b << 9;
    let r = Math.imul(b, 5);
    r = Math.imul((r << 7) | (r >>> 25), 9);
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t;
    d = (d << 11) | (d >>> 21);
    return (r >>> 0) / 4294967296;
  };
}

export type ExportForm = "aggregates" | "rows";

const BASE_PROMPT = contentId("simulate-pilot baseline prompt");
const CAND_PROMPT = contentId("simulate-pilot candidate prompt");
const CAND_TAG = "synthe-simulated";
const APPROVAL = contentId("simulate-pilot approval");
const START = "2026-11-02T00:00:00Z";

// The contract and the experiment specification, built the way the commands build them: the demo contract, a
// baseline report from the demo's baseline export, and the specification sized from that report.
export function simulatedSpec(): { contract: MetricContract; spec: ExperimentSpec; experimentId: Sha256 } {
  const config = parsePilotConfig(JSON.stringify(demoConfig()));
  const contract = config.metric;
  const configId = contentId(config);
  const b = baselineExport();
  const imported = importTelemetry({ text: JSON.stringify(b.header), readSibling: () => b.csv, purpose: "baseline", scope_id: configId, contract, tags: [DEMO.baseline_tag] });
  const report = baselineReport({ config_id: configId, contract, tag: DEMO.baseline_tag, imports: [{ id: contentId(imported), value: imported }] });
  const spec = buildExperimentSpec({
    pilot_id: config.pilot_id, config_id: configId, contract, baseline_report: report, start: START,
    baseline: { prompt_id: BASE_PROMPT, tag: DEMO.baseline_tag }, candidate: { prompt_id: CAND_PROMPT, tag: CAND_TAG },
  });
  return { contract, spec, experimentId: contentId(spec) };
}

interface DayCounts { n: number; resolved: number; escalated: number; refunds: number }

// The same counts as one CSV row per conversation, the way `pilot export` and `watch --log` produce them: each
// conversation starts at its own time in the day and is mature once it is outcome_lag_days old. Within a day, two
// fixed permutations spread the outcomes over the day's conversations, so early and late conversations of a day are
// alike and a day that is only partly mature is not biased. Values never change between exports.
function rowsCsv(tag: string, days: DayCounts[], startedDays: number, start: number, lagMs: number, asOf: number, refundUsd: number): { csv: string; rows: number } {
  const lines = ["conversation_id,prompt_version,started_at,unit_id,resolved,escalated,refund_usd"];
  const refund = refundUsd.toFixed(2);
  for (let d = 0; d < startedDays; d++) {
    const day = days[d];
    for (let i = 0; i < day.n; i++) {
      // 1 ms after midnight at the earliest: a conversation that starts exactly at 00:00 is mature at the 00:00 tick
      // lag_days later (the rows rule is started + lag <= exported_at), which the aggregates form does not count.
      const at = start + d * DAY_MS + 1 + Math.floor((i * (DAY_MS - 1)) / day.n);
      const id = `${tag}-${d}-${i}`;
      if (at + lagMs > asOf) { lines.push(`c-${id},${tag},${new Date(at).toISOString()},u-${id},,,`); continue; }
      const j = (i * 7919 + d * 131) % day.n;
      const k = (i * 6101 + d * 57) % day.n;
      lines.push(`c-${id},${tag},${new Date(at).toISOString()},u-${id},${j < day.resolved ? 1 : 0},${j >= day.n - day.escalated ? 1 : 0},${k < day.refunds ? refund : "0.00"}`);
    }
  }
  return { csv: `${lines.join("\n")}\n`, rows: lines.length - 1 };
}

// One day of one arm: each conversation is resolved, escalated or neither, and has a refund or not.
function drawDay(rng: () => number, n: number, r: ArmRates): DayCounts {
  let resolved = 0, escalated = 0, refunds = 0;
  for (let i = 0; i < n; i++) {
    const u = rng();
    if (u < r.resolved) resolved++; else if (u < r.resolved + r.escalated) escalated++;
    if (rng() < r.refunded) refunds++;
  }
  return { n, resolved, escalated, refunds };
}

// The cumulative per-arm summary a customer's warehouse would export on day `day` (00:00 UTC): the first
// `matureDays` days are older than the outcome lag and are counted; the later ones are only counted as immature.
function aggregate(tag: string, days: DayCounts[], matureDays: number, startedDays: number, refundUsd: number) {
  let n = 0, resolved = 0, escalated = 0, refunds = 0, immature = 0;
  for (let d = 0; d < startedDays; d++) {
    if (d < matureDays) { n += days[d].n; resolved += days[d].resolved; escalated += days[d].escalated; refunds += days[d].refunds; }
    else immature += days[d].n;
  }
  const mean = n > 0 ? (refunds * refundUsd) / n : 0;
  const sd = n > 1 ? Math.sqrt(Math.max(0, (refunds * refundUsd ** 2 - n * mean ** 2) / (n - 1))) : 0;
  return {
    prompt_version: tag, n, immature, unattributed: 0,
    metrics: {
      resolved: { kind: "rate", successes: resolved, missing: 0 },
      escalated: { kind: "rate", successes: escalated, missing: 0 },
      refund_usd: { kind: "mean", mean, sd, missing: 0, nonzero: refunds },
    },
  };
}

// One experiment, from the first tick to its last analysis: a tick every day at 00:00 UTC, an analysis only when the
// watch gate allows one, and the export for that look built from what is known on that day.
function oneExperiment(rng: () => number, scenario: Scenario, x: { contract: MetricContract; spec: ExperimentSpec; experimentId: Sha256 }, form: ExportForm): { outcome: "keep" | "hold" | "revert_early" | "revert_final"; day: number; interim: number; flags: string[] } {
  const { contract, spec, experimentId } = x;
  const base: DayCounts[] = [], cand: DayCounts[] = [];
  for (let d = 0; d < PLAN.days; d++) {
    // A fair coin for each conversation decides its arm.
    let toCand = 0;
    for (let i = 0; i < PLAN.per_day; i++) if (rng() < 0.5) toCand++;
    base.push(drawDay(rng, PLAN.per_day - toCand, scenario.base));
    cand.push(drawDay(rng, toCand, scenario.cand));
  }
  const imports: Stored<TelemetryImport>[] = [];
  const looks: Look[] = [];
  const cutoffDay = Math.round((ms(spec.analysis_cutoff) - ms(spec.window.start)) / DAY_MS);
  for (let day = 1; day <= cutoffDay + 2; day++) {
    const now = addDays(spec.window.start, day);
    const gate = lookGate({ spec, looks, now: new Date(ms(now)) });
    if (gate.action === "done") break;
    if (gate.action === "wait") continue;
    const startedDays = Math.min(PLAN.days, day);
    const matureDays = Math.min(PLAN.days, Math.max(0, day - spec.outcome_lag_days));
    const header = {
      format: TELEMETRY_FORMAT, export_id: `sim-day-${day}`, source: "simulate-pilot", exported_at: now,
      window: { start: spec.window.start, end: addDays(spec.window.start, startedDays) }, assignment: "randomized",
      denominator: contract.denominator, units: Object.fromEntries([contract.primary, ...contract.guards].map((m) => [m.name, m.unit])),
    };
    let text: string, readSibling: (() => string) | undefined;
    if (form === "rows") {
      const at0 = ms(spec.window.start), lagMs = spec.outcome_lag_days * DAY_MS, asOf = ms(now);
      const b = rowsCsv(spec.arms.baseline.tag, base, startedDays, at0, lagMs, asOf, scenario.base.refund_usd);
      const c = rowsCsv(spec.arms.candidate.tag, cand, startedDays, at0, lagMs, asOf, scenario.cand.refund_usd);
      const csv = b.csv + c.csv.slice(c.csv.indexOf("\n") + 1);
      text = JSON.stringify({ ...header, expected_rows: b.rows + c.rows, rows_csv: `sim-day-${day}.csv` });
      readSibling = () => csv;
    } else {
      text = JSON.stringify({ ...header, aggregates: [aggregate(spec.arms.baseline.tag, base, matureDays, startedDays, scenario.base.refund_usd), aggregate(spec.arms.candidate.tag, cand, matureDays, startedDays, scenario.cand.refund_usd)] });
    }
    const imported = importTelemetry({ text, readSibling, purpose: "experiment", scope_id: experimentId, contract, tags: [spec.arms.baseline.tag, spec.arms.candidate.tag], window: spec.window });
    imports.push({ id: contentId(imported), value: imported });
    const analysis = analyzeExperiment({ spec, experiment_id: experimentId, imports, approval_id: APPROVAL, approved_at: addDays(spec.window.start, -1) });
    looks.push({ at: now, final: analysis.final, recommendation: analysis.recommendation });
    const interim = looks.filter((l) => !l.final).length;
    if (analysis.recommendation === "keep") return { outcome: "keep", day, interim, flags: [] };
    if (analysis.recommendation === "revert") return { outcome: analysis.stopped_by === "early_stop" ? "revert_early" : "revert_final", day, interim, flags: [] };
    if (analysis.final) {
      const problems = analysis.flags.filter((f) => (HOLD_FLAGS as readonly string[]).includes(f) || (KEEP_BLOCKERS as readonly string[]).includes(f));
      return { outcome: "hold", day, interim, flags: problems.length ? problems : ["no_data_problem"] };
    }
  }
  throw new Error("the simulated experiment never reached a final analysis");
}

export interface SimOptions {
  // Changes the specification before the run. The tests use it to show that the limits notice a looser rule.
  tweak?: (spec: ExperimentSpec) => ExperimentSpec;
  // Which random stream of the seed to use (runAll gives each scenario its own).
  stream?: number;
  form?: ExportForm;
}

export function simulate(scenario: Scenario, runs: number, seed: number, opts: SimOptions = {}): SimResult {
  const made = simulatedSpec();
  const spec = opts.tweak ? opts.tweak(made.spec) : made.spec;
  const x = { contract: made.contract, spec, experimentId: contentId(spec) };
  const rng = seededRandom(seed, opts.stream ?? 0);
  const form = opts.form ?? "aggregates";
  const cutoffDay = Math.round((ms(x.spec.analysis_cutoff) - ms(x.spec.window.start)) / DAY_MS);
  const r: SimResult = {
    runs, keep: 0, revert_early: 0, revert_final: 0, hold_final: 0, early_by_day: new Array(cutoffDay + 1).fill(0), final_hold_flags: {},
    interim_looks: 0, max_interim_looks: 0, interim_allowed: interimLooksAllowed(x.spec, 1),
  };
  for (let i = 0; i < runs; i++) {
    const one = oneExperiment(rng, scenario, x, form);
    r.interim_looks += one.interim;
    r.max_interim_looks = Math.max(r.max_interim_looks, one.interim);
    if (one.outcome === "keep") r.keep++;
    else if (one.outcome === "revert_early") { r.revert_early++; r.early_by_day[one.day]++; }
    else if (one.outcome === "revert_final") r.revert_final++;
    else { r.hold_final++; for (const f of one.flags) r.final_hold_flags[f] = (r.final_hold_flags[f] ?? 0) + 1; }
  }
  return r;
}

// The rate a limit names, from a scenario's result.
export function measured(r: SimResult, measure: string): number {
  const byDay = /^revert_early_by_day_(\d+)$/.exec(measure);
  if (byDay) return r.early_by_day.slice(0, Number(byDay[1]) + 1).reduce((s, n) => s + n, 0) / r.runs;
  if (measure === "keep") return r.keep / r.runs;
  if (measure === "revert_early") return r.revert_early / r.runs;
  if (measure === "revert_final") return r.revert_final / r.runs;
  if (measure === "revert") return (r.revert_early + r.revert_final) / r.runs;
  throw new Error(`no measure named ${measure}`);
}

export interface Checked { scenario: string; measure: string; kind: "max" | "min"; theory: number; limit: number; value: number; ok: boolean; why: string }

export function runAll(runs: number, seed: number, form: ExportForm = "aggregates"): { results: Record<string, SimResult>; checks: Checked[] } {
  const results: Record<string, SimResult> = {};
  // Each scenario gets its own stream, so adding a scenario does not change the others' numbers.
  for (const [i, name] of Object.keys(SCENARIOS).entries()) results[name] = simulate((SCENARIOS as Record<string, Scenario>)[name], runs, seed, { stream: i, form });
  const checks = (limits(runs) as Omit<Checked, "value" | "ok">[]).map((l) => {
    const value = measured(results[l.scenario], l.measure);
    return { ...l, value, ok: l.kind === "max" ? value <= l.limit : value >= l.limit };
  });
  return { results, checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const form: ExportForm = args[0] === "--rows" ? "rows" : "aggregates";
  if (form === "rows") args.shift();
  const runs = Number(args[0] ?? (form === "rows" ? 1000 : 20000));
  const seed = Number(args[1] ?? 20261117);
  if (!Number.isInteger(runs) || runs < 1 || !Number.isInteger(seed) || args.length > 2) { console.error("Usage: node scripts/simulate-pilot.ts [--rows] [experiments per scenario] [seed]"); process.exit(2); }
  const started = Date.now();
  const { results, checks } = runAll(runs, seed, form);
  const pct = (x: number) => `${(x * 100).toFixed(3)}%`;
  console.log(`Pilot decision rule under the watch look schedule: ${runs} simulated experiments per scenario, seed ${seed}, ${form} form.`);
  console.log(`Each experiment: ${PLAN.days} days, about ${PLAN.per_day / 2} conversations per arm per day, one tick a day at 00:00 UTC.`);
  console.log("");
  console.log("scenario        keep       revert(early)  revert(final)  hold(final)  interim looks (mean, max / allowed)");
  for (const [name, r] of Object.entries(results)) {
    console.log(`${name.padEnd(14)}  ${pct(r.keep / r.runs).padStart(8)}   ${pct(r.revert_early / r.runs).padStart(8)}       ${pct(r.revert_final / r.runs).padStart(8)}       ${pct(r.hold_final / r.runs).padStart(8)}     ${(r.interim_looks / r.runs).toFixed(1)}, ${r.max_interim_looks} / ${r.interim_allowed}`);
  }
  console.log("");
  for (const [name, r] of Object.entries(results)) {
    const flags = Object.entries(r.final_hold_flags).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(", ");
    if (flags) console.log(`${name}: flags on final holds: ${flags}`);
    const early = r.early_by_day.map((n, day) => (n ? `day ${day}: ${n}` : "")).filter(Boolean).join(", ");
    if (early) console.log(`${name}: early stops by look: ${early}`);
  }
  console.log("");
  console.log("Limits (set from theory before the first run; scripts/simulate-pilot-reference.mjs):");
  for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.scenario.padEnd(14)} ${c.measure.padEnd(22)} measured ${pct(c.value).padStart(9)}  ${c.kind === "max" ? "at most " : "at least"} ${pct(c.limit).padStart(9)}  (theory ${pct(c.theory)})`);
  const failed = checks.filter((c) => !c.ok);
  console.log("");
  console.log(failed.length === 0 ? `All ${checks.length} limits hold. ${((Date.now() - started) / 1000).toFixed(0)} s.` : `${failed.length} of ${checks.length} limits do NOT hold. Do not change a limit: find out whether the rule or the theory is wrong.`);
  process.exit(failed.length === 0 ? 0 : 1);
}
