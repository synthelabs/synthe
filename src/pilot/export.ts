// Turns the recorder's call log into the telemetry export that `importTelemetry` reads, so the customer writes no
// glue code. The counting rules decide which conversations may be credited to one prompt; what they leave out is
// counted and reported, never hidden. Messages name counts and fields, never an id or a value from the log.
import { join } from "node:path";
import { contractMetrics, importTelemetry } from "./telemetry.ts";
import { readCallLog, valuesBefore, type CallLog } from "./calllog.ts";
import { frozen, type Flags, type PilotDeps } from "./commands.ts";
import { PilotError } from "./errors.ts";
import { ms, shortId } from "./ids.ts";
import { printable, writeAtomic } from "./io.ts";
import type { PilotStore } from "./store.ts";
import { TELEMETRY_FORMAT, type ExperimentSpec, type IsoTime, type MetricContract, type Sha256 } from "./types.ts";

type Assignment = "none" | "randomized" | "observational";

export interface LogExportInput {
  log: CallLog;
  agent: string; // only this agent's conversations are exported
  contract: MetricContract;
  tags: string[]; // prompt versions the export may contain
  window: { start: IsoTime; end: IsoTime }; // conversations that started in [start, end)
  exported_at: IsoTime;
  assignment: Assignment;
  export_id: string;
  csv_name: string;
}

export interface LeftOut {
  no_outcome: number; // not left out: exported with empty values, so the analysis counts them as missing outcomes
  outcome_without_call: number; // unattributed: counted in the refusal rate
  served_two_versions: number; // unattributed: counted in the refusal rate; exported with empty values
  outside_window: number;
  other_agent: number; // conversations of other agents in the same log
  outcome_before_call: number; // a note: these rows are in the export
  other_version_after_outcome: number; // a note: a later call under another version; the row is unchanged
  outcome_after_other_version: number; // a note: of those, conversations with a later outcome line that was not used
}

export interface LogExport {
  header: Record<string, unknown>;
  csv: string;
  rows: number;
  by_version: Record<string, number>;
  left_out: LeftOut;
  other_tags: Record<string, number>;
  // Per first-served version, so a one-sided pattern is visible.
  no_outcome_by: Record<string, number>;
  two_versions_by: Record<string, number>;
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

  const exportedMs = ms(input.exported_at);
  const left: LeftOut = { no_outcome: 0, outcome_without_call: 0, served_two_versions: 0, outside_window: 0, other_agent: 0, outcome_before_call: 0, other_version_after_outcome: 0, outcome_after_other_version: 0 };
  const noOutcomeBy: Record<string, number> = {};
  const twoBy: Record<string, number> = {};
  const otherTags: Record<string, number> = {};
  const byVersion: Record<string, number> = {};
  const rows: { id: string; version: string; started: string; segment?: string; unit?: string; model?: string; values: (number | null)[] }[] = [];
  const known = new Set(metrics);
  const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

  const byId = [...input.log.conversations.values()].sort((a, b) => (a.conversation_id < b.conversation_id ? -1 : a.conversation_id > b.conversation_id ? 1 : 0));
  for (const c of byId) {
    const id = c.conversation_id;
    if (c.agent !== input.agent) { left.other_agent++; continue; }
    if (c.calls.length === 0) {
      // An outcome with no recorded call cannot be credited to a prompt, so it is unattributed, and enough of them
      // refuse the export (below). It has no start time, so the window cannot place it: it counts when its newest
      // outcome line is inside [window.start, exported_at). Outcomes older or newer than that belong to another export.
      const newest = c.newest_outcome_at;
      if (newest !== undefined && newest >= startMs && newest < exportedMs) left.outcome_without_call++;
      continue;
    }
    for (const name of c.values.keys()) {
      if (!known.has(name)) throw new PilotError("invalid_telemetry", `The log records an outcome named ${printable(name, 40)}, which is not a metric in the contract. Fix the name in the code that calls outcome(); an outcome under another name would be counted as missing.`);
    }
    const first = c.calls[0];
    const started = seconds(first.started_at ?? first.at);
    // Judged by its start only: a conversation outside the window is not part of this export and is not a defect.
    if (ms(started) < startMs || ms(started) >= endMs) { left.outside_window++; continue; }
    // Calls under another version. Once another version has served the conversation, only what was recorded before
    // that call can be credited to the first version: an outcome recorded at the same time or later may have been
    // influenced by the other prompt and is not used. With nothing recorded before it, the conversation stays in the
    // arm it was assigned to with every value empty, so it counts as a missing outcome there and is never dropped.
    // Outcome lines after that call never change the row, so a retry cannot rewrite what an earlier export said.
    const others = c.calls.filter((x) => x.prompt_version !== first.prompt_version);
    let values = metrics.map((m) => c.values.get(m) ?? null);
    if (others.length > 0) {
      const before = valuesBefore(c, Math.min(...others.map((x) => Date.parse(x.at))));
      if (before.lines === 0) { left.served_two_versions++; bump(twoBy, first.prompt_version); values = metrics.map(() => null); }
      else { left.other_version_after_outcome++; values = metrics.map((m) => before.values.get(m) ?? null); }
      if (before.lines > 0 && before.later > 0) left.outcome_after_other_version++;
    }
    // A call with no outcome is a row with empty values too: the analysis checks missing outcomes in each arm and
    // between the arms, and a failure whose outcome was never recorded must not simply disappear. Inside the outcome
    // lag it is not yet known; a later export fills it in.
    if (c.outcome_lines === 0) { left.no_outcome++; bump(noOutcomeBy, first.prompt_version); }
    // Outcomes may be recorded by another process, so an earlier outcome is still joined; it is only noted.
    if (c.oldest_outcome_at !== undefined && c.oldest_outcome_at < ms(first.at)) left.outcome_before_call++;
    if (!input.tags.includes(first.prompt_version)) bump(otherTags, first.prompt_version);
    bump(byVersion, first.prompt_version);
    rows.push({ id, version: first.prompt_version, started, segment: first.segment, unit: first.unit_id, model: first.model_id, values });
  }

  // Ambiguous or missing attribution can never become a claimed win: a conversation served by two versions and an
  // outcome with no recorded call are both left out, and together they may not exceed the contract's limit.
  const unattributed = left.served_two_versions + left.outcome_without_call;
  // served_two_versions conversations are rows now, so only outcomes with no call are added to the total.
  const attributable = rows.length + left.outcome_without_call;
  if (unattributed > 0 && unattributed / attributable > contract.max_unattributed_rate) {
    throw new PilotError("telemetry_incomplete", `${unattributed} of ${attributable} conversations could not be credited to one prompt version (${left.served_two_versions} were served by more than one version, ${left.outcome_without_call} have an outcome but no recorded call), which is more than the ${contract.max_unattributed_rate} the contract allows. Assignment must be sticky per conversation: choose the version once, from the conversation id, and use it for every call of that conversation. Every agent call must go through the recorder, so that each outcome has a call.`);
  }
  if (rows.length === 0) throw new PilotError("telemetry_incomplete", "There is no conversation with a recorded call in the window yet. Export again once the agent has served conversations.");

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
  return { header, csv, rows: rows.length, by_version: byVersion, left_out: left, other_tags: otherTags, no_outcome_by: noOutcomeBy, two_versions_by: twoBy };
}

export function writeLogExport(input: {
  store: PilotStore; logDir: string;
  scope: { experiment: Sha256 } | { baseline: { start: IsoTime; end: IsoTime } };
  assignment: Assignment; outDir?: string; now: Date;
  agent?: string; // default: the pilot's agent.name
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
  const agent = input.agent ?? f.config.agent.name;
  const agentCount = Object.keys(log.agents).length;
  if (agentCount > 0 && !Object.hasOwn(log.agents, agent)) {
    throw new PilotError("usage", `The log has lines from ${agentCount} agent${agentCount === 1 ? "" : "s"}, and none is named ${printable(agent, 40)}. Pass --agent <name> with the name you gave the recorder (its agent option).`);
  }
  const built = buildLogExport({ log, agent, contract: f.config.metric, tags, window, exported_at: stamp, assignment: input.assignment, export_id: exportId, csv_name: csvName });

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
  if (l.no_outcome) notes.push(`${plural(l.no_outcome, "conversation has", "conversations have")} a recorded call and no outcome yet (by first-served version: ${Object.entries(built.no_outcome_by).sort().map(([t, n]) => `${printable(t, 40)} ${n}`).join(", ")}). They are in the export with empty values, so the analysis counts them as missing outcomes in that version until a later export fills them in.`);
  if (l.outcome_without_call) notes.push(`${plural(l.outcome_without_call, "conversation has", "conversations have")} an outcome but no recorded call, so ${l.outcome_without_call === 1 ? "it was" : "they were"} left out. Check that every agent call goes through the recorder.`);
  if (l.served_two_versions) notes.push(`${plural(l.served_two_versions, "conversation was", "conversations were")} served by a second prompt version before or with the outcome (by first-served version: ${Object.entries(built.two_versions_by).sort().map(([t, n]) => `${printable(t, 40)} ${n}`).join(", ")}). Their outcome cannot be credited to one prompt, so they are in the export under the first version with empty values and count as missing outcomes there.`);
  if (l.other_version_after_outcome) notes.push(`${plural(l.other_version_after_outcome, "conversation was", "conversations were")} served by another prompt version only after the outcome was recorded. The row is unchanged.`);
  if (l.outcome_after_other_version) notes.push(`${plural(l.outcome_after_other_version, "of them has", "of them have")} an outcome recorded again after that call. It is not used: it may have been influenced by the other prompt.`);
  if (l.outside_window) notes.push(`${plural(l.outside_window, "conversation", "conversations")} in the log started outside the window and ${l.outside_window === 1 ? "is" : "are"} not in this export.`);
  if (log.malformed) notes.push(`${plural(log.malformed, "line", "lines")} of the log could not be read and ${log.malformed === 1 ? "was" : "were"} skipped.`);
  for (const [kind, n] of Object.entries(log.problems)) notes.push(`The recorder logged ${plural(n, "problem", "problems")} of kind ${kind}: some calls or outcomes may be missing from the log.`);
  if (l.other_agent) notes.push(`${plural(l.other_agent, "conversation", "conversations")} in the log ${l.other_agent === 1 ? "belongs" : "belong"} to another agent and ${l.other_agent === 1 ? "is" : "are"} not in this export.`);
  if (l.outcome_before_call) notes.push(`${plural(l.outcome_before_call, "conversation has", "conversations have")} an outcome recorded before its first call. ${l.outcome_before_call === 1 ? "It was" : "They were"} still joined, because another process may record outcomes; check that clocks agree.`);
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
  const agent = text(flags, "agent");
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
  const out = writeLogExport({ store, logDir, scope, assignment: how, ...(outDir ? { outDir } : {}), ...(agent ? { agent } : {}), now: deps.now() });
  deps.say(`Wrote the export: ${out.path}`);
  deps.say(`Conversations per prompt version: ${Object.entries(out.by_version).sort().map(([tag, n]) => `${printable(tag, 40)} ${n}`).join(", ")}.`);
  for (const note of out.notes) deps.say(note);
  deps.say("experiment" in scope
    ? `Next: analyze --experiment ${shortId(scope.experiment)} --telemetry ${out.path}`
    : `Next: baseline --telemetry ${out.path}`);
  return 0;
}
