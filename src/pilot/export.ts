// Turns the recorder's call log into the telemetry export that `importTelemetry` reads, so the customer writes no
// glue code. The counting rules decide which conversations may be credited to one prompt; what they leave out is
// counted and reported, never hidden. Messages name counts and fields, never an id or a value from the log.
import { join } from "node:path";
import { contractMetrics, importTelemetry } from "./telemetry.ts";
import { readCallLog, type CallLog } from "./calllog.ts";
import { frozen, type Flags, type PilotDeps } from "./commands.ts";
import { PilotError } from "./errors.ts";
import { ms, shortId } from "./ids.ts";
import { printable, writeAtomic } from "./io.ts";
import type { PilotStore } from "./store.ts";
import { TELEMETRY_FORMAT, type ExperimentSpec, type IsoTime, type MetricContract, type Sha256 } from "./types.ts";

type Assignment = "none" | "randomized" | "observational";

export interface LogExportInput {
  log: CallLog;
  contract: MetricContract;
  tags: string[]; // prompt versions the export may contain
  window: { start: IsoTime; end: IsoTime }; // conversations that started in [start, end)
  exported_at: IsoTime;
  assignment: Assignment;
  export_id: string;
  csv_name: string;
}

export interface LogExport {
  header: Record<string, unknown>;
  csv: string;
  rows: number;
  by_version: Record<string, number>;
  left_out: { no_outcome: number; outcome_without_call: number; served_two_versions: number; outside_window: number };
  other_tags: Record<string, number>;
}

const seconds = (iso: string): IsoTime => iso.replace(/\.\d+Z$/, "Z");
const nowSeconds = (d: Date): IsoTime => seconds(d.toISOString());
const field = (s: string | undefined): string => (s === undefined ? "" : /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);

export function buildLogExport(input: LogExportInput): LogExport {
  const { log, contract } = input;
  // A wrapper export has no query behind it, so it cannot satisfy a contract that pins one.
  if (contract.query_hash !== undefined) throw new PilotError("usage", "The metric contract pins a query hash. A call-log export comes from the wrapper, not from a query, so it cannot carry one. Export from the signed-off query instead.");
  const metrics = contractMetrics(contract).map((m) => m.name);
  const startMs = ms(input.window.start);
  const endIso = ms(input.window.end) <= ms(input.exported_at) ? input.window.end : input.exported_at;
  const endMs = ms(endIso);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) throw new PilotError("usage", "The window and the export time must be UTC times like 2026-11-01T00:00:00Z.");
  if (startMs >= endMs) throw new PilotError("usage", "The window is empty: it must start before both its end and the time of the export.");

  const left = { no_outcome: 0, outcome_without_call: 0, served_two_versions: 0, outside_window: 0 };
  const otherTags: Record<string, number> = {};
  const byVersion: Record<string, number> = {};
  const rows: { id: string; version: string; started: string; segment?: string; unit?: string; model?: string; values: (number | null)[] }[] = [];
  const known = new Set(metrics);

  for (const [id, c] of [...input.log.conversations].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (c.calls.length === 0) { left.outcome_without_call++; continue; }
    const first = c.calls[0];
    const started = seconds(first.started_at ?? first.at);
    // Judged by its start only: a conversation outside the window is not part of this export and is not a defect.
    if (ms(started) < startMs || ms(started) >= endMs) { left.outside_window++; continue; }
    if (c.outcome_lines === 0) { left.no_outcome++; continue; }
    if (c.calls.some((x) => x.prompt_version !== first.prompt_version)) { left.served_two_versions++; continue; }
    for (const name of c.values.keys()) {
      if (!known.has(name)) throw new PilotError("invalid_telemetry", `The log records an outcome named ${printable(name, 40)}, which is not a metric in the contract. Fix the name in the code that calls outcome(); an outcome under another name would be counted as missing.`);
    }
    if (!input.tags.includes(first.prompt_version)) otherTags[first.prompt_version] = (otherTags[first.prompt_version] ?? 0) + 1;
    byVersion[first.prompt_version] = (byVersion[first.prompt_version] ?? 0) + 1;
    rows.push({ id, version: first.prompt_version, started, segment: first.segment, unit: first.unit_id, model: first.model_id, values: metrics.map((m) => c.values.get(m) ?? null) });
  }

  const attributable = rows.length + left.served_two_versions;
  if (attributable > 0 && left.served_two_versions / attributable > contract.max_unattributed_rate) {
    throw new PilotError("telemetry_incomplete", `${left.served_two_versions} of ${attributable} completed conversations were served by more than one prompt version, which is more than the ${contract.max_unattributed_rate} the contract allows. A conversation cannot be credited to one prompt then. Assignment must be sticky per conversation: choose the version once, from the conversation id, and use it for every call of that conversation.`);
  }
  if (rows.length === 0) throw new PilotError("telemetry_incomplete", "There is no completed conversation in the window yet: no conversation has both a recorded call and a recorded outcome. Export again when outcomes have been recorded.");

  const csv = `${[
    ["conversation_id", "prompt_version", "started_at", "segment", "unit_id", "model_id", ...metrics].join(","),
    ...rows.map((r) => [r.id, r.version, r.started, r.segment, r.unit, r.model].map(field).concat(r.values.map((v) => (v === null ? "" : String(v)))).join(",")),
  ].join("\n")}\n`;
  const header = {
    format: TELEMETRY_FORMAT,
    export_id: input.export_id,
    source: `Synthe pilot call log (synthe-pilot-calls v1), ${log.files} file${log.files === 1 ? "" : "s"}`,
    exported_at: input.exported_at,
    window: { start: input.window.start, end: endIso },
    assignment: input.assignment,
    denominator: contract.denominator,
    units: Object.fromEntries(contractMetrics(contract).map((m) => [m.name, m.unit])),
    expected_rows: rows.length,
    rows_csv: input.csv_name,
  };
  return { header, csv, rows: rows.length, by_version: byVersion, left_out: left, other_tags: otherTags };
}

export function writeLogExport(input: {
  store: PilotStore; logDir: string;
  scope: { experiment: Sha256 } | { baseline: { start: IsoTime; end: IsoTime } };
  assignment: Assignment; outDir?: string; now: Date;
}): { path: string; export_id: string; rows: number; by_version: Record<string, number>; notes: string[] } {
  const { store, scope } = input;
  const f = frozen(store);
  const experiment = "experiment" in scope ? store.get<ExperimentSpec>("experiment", scope.experiment) : null;
  let tags: string[];
  let window: { start: IsoTime; end: IsoTime };
  if (experiment) {
    if (input.assignment !== "randomized" && input.assignment !== "observational") throw new PilotError("usage", "An experiment export needs --assignment randomized or --assignment observational.");
    tags = [experiment.arms.baseline.tag, experiment.arms.candidate.tag];
    window = experiment.window;
  } else {
    const b = (scope as { baseline: { start: IsoTime; end: IsoTime } }).baseline;
    if (input.assignment !== "none") throw new PilotError("usage", "A baseline export covers the current prompt only, so its assignment is none.");
    if (!(ms(b.start) < ms(b.end))) throw new PilotError("usage", "The baseline window must be UTC times with --end after --start, like 2026-10-01T00:00:00Z.");
    tags = [f.config.agent.baseline_tag];
    window = b;
  }
  const stamp = nowSeconds(input.now);
  const exportId = `calllog-${experiment ? shortId((scope as { experiment: Sha256 }).experiment) : "baseline"}-${stamp.replace(/[-:]/g, "")}`;
  const csvName = `${exportId}.csv`;
  const log = readCallLog(input.logDir);
  const built = buildLogExport({ log, contract: f.config.metric, tags, window, exported_at: stamp, assignment: input.assignment, export_id: exportId, csv_name: csvName });

  // The same check `analyze` and `baseline` will make, so a problem is reported now and nothing half-right is written.
  importTelemetry({
    text: JSON.stringify(built.header), readSibling: (name) => { if (name !== csvName) throw new Error("unknown"); return built.csv; },
    purpose: experiment ? "experiment" : "baseline", scope_id: experiment ? (scope as { experiment: Sha256 }).experiment : f.config_id,
    contract: f.config.metric, tags, ...(experiment ? { window: experiment.window } : {}),
  });

  const outDir = input.outDir ?? join(store.dir, "exports");
  const path = join(outDir, `${exportId}.json`);
  writeAtomic(join(outDir, csvName), built.csv);
  writeAtomic(path, `${JSON.stringify(built.header, null, 2)}\n`);

  const notes: string[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const l = built.left_out;
  if (l.no_outcome) notes.push(`${plural(l.no_outcome, "conversation was", "conversations were")} left out because no outcome is recorded for ${l.no_outcome === 1 ? "it" : "them"} yet.`);
  if (l.outcome_without_call) notes.push(`${plural(l.outcome_without_call, "conversation has", "conversations have")} an outcome but no recorded call, so ${l.outcome_without_call === 1 ? "it was" : "they were"} left out. Check that every agent call goes through the recorder.`);
  if (l.served_two_versions) notes.push(`${plural(l.served_two_versions, "conversation was", "conversations were")} left out because ${l.served_two_versions === 1 ? "it was" : "they were"} served by more than one prompt version.`);
  if (l.outside_window) notes.push(`${plural(l.outside_window, "conversation", "conversations")} in the log started outside the window and ${l.outside_window === 1 ? "is" : "are"} not in this export.`);
  if (log.malformed) notes.push(`${plural(log.malformed, "line", "lines")} of the log could not be read and ${log.malformed === 1 ? "was" : "were"} skipped.`);
  for (const [kind, n] of Object.entries(log.problems)) notes.push(`The recorder logged ${plural(n, "problem", "problems")} of kind ${kind}: some calls or outcomes may be missing from the log.`);
  const other = Object.values(built.other_tags).reduce((s, n) => s + n, 0);
  if (other) notes.push(`${plural(other, "conversation carries", "conversations carry")} a prompt version that the pilot does not name.`);
  return { path, export_id: exportId, rows: built.rows, by_version: built.by_version, notes };
}

const text = (flags: Flags, name: string): string | undefined => (typeof flags[name] === "string" && (flags[name] as string).trim() !== "" ? (flags[name] as string) : undefined);

export async function exportLog(store: PilotStore, flags: Flags, deps: PilotDeps): Promise<number> {
  const logDir = text(flags, "log");
  if (!logDir) throw new PilotError("usage", "--log is required: the folder the recorder writes to (its logDir).");
  const experiment = text(flags, "experiment");
  if (flags.baseline !== undefined && flags.baseline !== true && flags.baseline !== false) throw new PilotError("usage", "--baseline takes no value.");
  const baseline = flags.baseline === true;
  if (experiment !== undefined && baseline) throw new PilotError("usage", "Give --experiment <id> or --baseline, not both.");
  if (experiment === undefined && !baseline) throw new PilotError("usage", "Give --experiment <id> for an experiment export, or --baseline --start <time> --end <time> for a baseline export.");
  const outDir = text(flags, "out");
  const assignment = text(flags, "assignment");
  let scope: { experiment: Sha256 } | { baseline: { start: IsoTime; end: IsoTime } };
  let how: Assignment;
  if (experiment !== undefined) {
    if (flags.start !== undefined || flags.end !== undefined) throw new PilotError("usage", "--start and --end are for a baseline export. An experiment export uses the experiment's own window.");
    if (assignment !== "randomized" && assignment !== "observational") {
      throw new PilotError("usage", "--assignment is required for an experiment: randomized if traffic was split at random by conversation, observational if it was not. Synthe does not guess; an observational export can never give keep.");
    }
    how = assignment;
    scope = { experiment: store.resolve("experiment", experiment) };
  } else {
    const start = text(flags, "start");
    const end = text(flags, "end");
    if (!start || !end) throw new PilotError("usage", "A baseline export needs --start and --end, UTC times like 2026-10-01T00:00:00Z.");
    if (Number.isNaN(ms(start)) || Number.isNaN(ms(end)) || ms(start) >= ms(end)) throw new PilotError("usage", "--start and --end must be UTC times like 2026-10-01T00:00:00Z, with --end after --start.");
    if (assignment !== undefined && assignment !== "none") throw new PilotError("usage", "A baseline export covers the current prompt only. Leave --assignment out, or use --assignment none.");
    how = "none";
    scope = { baseline: { start, end } };
  }
  const out = writeLogExport({ store, logDir, scope, assignment: how, ...(outDir ? { outDir } : {}), now: deps.now() });
  deps.say(`Wrote the export: ${out.path}`);
  deps.say(`Conversations per prompt version: ${Object.entries(out.by_version).sort().map(([tag, n]) => `${printable(tag, 40)} ${n}`).join(", ")}.`);
  for (const note of out.notes) deps.say(note);
  deps.say("experiment" in scope
    ? `Next: analyze --experiment ${shortId(scope.experiment)} --telemetry ${out.path}`
    : `Next: baseline --telemetry ${out.path}`);
  return 0;
}
