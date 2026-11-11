// Read-only telemetry boundary: customer exports in, validated imports and a baseline report out.
// Lane: metric and experiment evaluation.
//
// The customer produces every export; Synthe only reads it. Anything that could make the numbers mean something
// other than what the contract froze is refused rather than repaired: a different denominator or query, a different
// unit, a tag nobody declared, a truncated file, a conversation listed twice with different content. Messages name
// counts, tags, fields and row positions, never a conversation id, unit id or value, because they are printed.
import { PilotError } from "./errors.ts";
import { DAY_MS, isSha256, ms, shortId } from "./ids.ts";
import { unsafeKey } from "./io.ts";
import { personalDataKinds } from "./pii.ts";
import { canonicalJson } from "../core/evidence.ts";
import {
  meanSummary, oneSampleT, sampleSizeMeans, sampleSizeProportions, wilsonInterval, type MeanStats,
} from "./stats.ts";
import {
  TELEMETRY_FORMAT,
  type AggregateMetric, type ArmCounts, type BaselineMetric, type BaselineReport, type IsoTime, type MetricContract,
  type MetricKind, type Sha256, type Sourced, type Stored, type TelemetryAggregate, type TelemetryImport, type TelemetryRow,
} from "./types.ts";

export interface ImportInput {
  // The export file's text (JSON).
  text: string;
  // Reads a file next to the export file (rows_csv). Absent: rows_csv is refused.
  readSibling?: (name: string) => string;
  purpose: "baseline" | "experiment";
  scope_id: Sha256;
  contract: MetricContract;
  // Every prompt_version the export may contain. Any other tag refuses the whole import.
  tags: string[];
  // experiment: the specification's window. Rows that started outside it refuse the import.
  window?: { start: IsoTime; end: IsoTime };
}

const fail = (code: ConstructorParameters<typeof PilotError>[0], message: string): never => { throw new PilotError(code, message); };
const bad = (message: string): never => fail("invalid_telemetry", message);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const validTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(ms(v));

const TOP_KEYS = [
  "format", "export_id", "source", "query_hash", "exported_at", "window", "assignment", "denominator", "units",
  "expected_rows", "rows", "rows_csv", "aggregates",
];
// The documented row fields. Nothing else is accepted: an extra field could carry personal data.
export const ROW_FIELDS = ["conversation_id", "prompt_version", "started_at", "segment", "unit_id", "model_id", "values"];
const ID_FIELDS = ["conversation_id", "unit_id", "segment", "model_id", "prompt_version"] as const;
const MAX_ID = 200;
export const NO_SEGMENT = "(none)";
const MINIMISE = "Export only the documented fields (see docs/PILOT.md): an extra field could carry personal data.";

export const contractMetrics = (contract: MetricContract): { name: string; kind: MetricKind; unit: string }[] =>
  [contract.primary, ...contract.guards].map((m) => ({ name: m.name, kind: m.kind, unit: m.unit }));

function checkPersonalData(text: string, field: string, where: string): void {
  const kinds = personalDataKinds(text);
  if (kinds.length > 0) {
    bad(`${where}: ${field} contains what looks like a ${kinds[0]}. Ids, segments and model names must be tokenised before export; replace them and export again.`);
  }
}

// A field or column name in a refusal. A name the export invented could be data (a CSV with no header line puts
// its first row there), so only a plain lowercase name is repeated.
const shown = (name: string): string => (/^[a-z][a-z0-9_]{0,63}$/.test(name) ? `"${name}"` : "with a name that is not a plain lowercase word");

// Without a unit id, two conversations can honestly share a start time and every value, so one twin proves
// nothing. A duplicated export does not look like chance, though: every copied row has an exact twin, far more
// rows than the mix of versions and values would pair up among rows that share a start time.
// For each row, the chance that some other row with its start time has its values is worked out from the size of
// that group and how common the row's values are. "How common" is taken from the whole export or from the rows
// nearest in time, whichever is higher: values often follow the clock (chat by day, email by night; a model
// switch), and then rows that share a start time are alike far more often than the whole export suggests.
// The export is refused when the rows that do have a twin exceed the expected number by more than 5% of all rows
// (and at least five) and by more than seven standard deviations. With one timestamp per day nearly every row
// has a twin by chance, so nothing can be said and nothing is refused.
const NEIGHBOURS = 50; // rows before and after, by start time, that show what is common around then
export function likelyCopies(rows: TelemetryRow[]): { twins: number; expected: number } | null {
  if (rows.length < 2) return null;
  const tally = <K>(keys: K[]) => { const m = new Map<K, number>(); for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1); return m; };
  const order = rows.map((_, i) => i).sort((x, y) => ms(rows[x].started_at) - ms(rows[y].started_at) || byString(rows[x].started_at, rows[y].started_at));
  const sorted = order.map((i) => rows[i]);
  const attributes = sorted.map((r) => canonicalJson({ ...r, conversation_id: null, started_at: null }));
  const common = tally(attributes);
  const exact = tally(sorted.map((r, i) => `${r.started_at}|${attributes[i]}`));
  let twins = 0;
  let expected = 0;
  let variance = 0;
  for (let from = 0; from < sorted.length;) {
    let to = from + 1;
    while (to < sorted.length && sorted[to].started_at === sorted[from].started_at) to++;
    // A row alone at its start time cannot have a twin.
    if (to - from > 1) {
      const around = tally([...attributes.slice(Math.max(0, from - NEIGHBOURS), from), ...attributes.slice(to, to + NEIGHBOURS)]);
      const neighbours = Math.min(from, NEIGHBOURS) + Math.min(sorted.length - to, NEIGHBOURS);
      for (let i = from; i < to; i++) {
        if ((exact.get(`${sorted[i].started_at}|${attributes[i]}`) ?? 0) > 1) twins++;
        const share = Math.max((common.get(attributes[i]) ?? 0) / sorted.length, neighbours > 0 ? (around.get(attributes[i]) ?? 0) / neighbours : 0);
        const p = 1 - (1 - share) ** (to - from - 1);
        expected += p;
        variance += p * (1 - p);
      }
    }
    from = to;
  }
  const excess = twins - expected;
  if (excess <= Math.max(5, 0.05 * rows.length) || excess <= 7 * Math.sqrt(variance)) return null;
  return { twins, expected };
}

// One row, from inline JSON or a parsed CSV line. Returns the row with only the documented fields.
function validateRow(raw: unknown, where: string, contract: MetricContract): TelemetryRow {
  if (!isObject(raw)) return bad(`${where} is not an object.`);
  const unknown = Object.keys(raw).filter((k) => !ROW_FIELDS.includes(k));
  if (unknown.length > 0) bad(`${where} has an undocumented field ${shown(unknown[0])}. ${MINIMISE}`);
  for (const field of ["conversation_id", "prompt_version", "started_at"]) {
    if (!isNonEmpty(raw[field])) bad(`${where}: ${field} must be a non-empty string.`);
  }
  for (const field of ["segment", "unit_id", "model_id"]) {
    if (raw[field] !== undefined && !isNonEmpty(raw[field])) bad(`${where}: ${field} must be a non-empty string when present.`);
  }
  for (const field of ID_FIELDS) {
    const v = raw[field];
    if (typeof v !== "string") continue;
    if (v.length > MAX_ID) bad(`${where}: ${field} is longer than ${MAX_ID} characters.`);
    checkPersonalData(v, field, where);
  }
  if (!validTime(raw.started_at)) bad(`${where}: started_at must be a UTC time like 2026-09-01T12:00:00Z.`);
  if (!isObject(raw.values)) return bad(`${where}: values must be an object of metric name to number or null.`);
  const metrics = contractMetrics(contract);
  const extra = Object.keys(raw.values).filter((k) => !metrics.some((m) => m.name === k));
  if (extra.length > 0) bad(`${where}: values has ${shown(extra[0])}, which is not a metric in the contract. ${MINIMISE}`);
  const values: Record<string, number | null> = {};
  for (const m of metrics) {
    if (!(m.name in raw.values)) bad(`${where}: values is missing ${m.name}. Every contract metric must be present, as a number or null when no outcome was recorded.`);
    const v = raw.values[m.name];
    if (v === null) { values[m.name] = null; continue; }
    if (m.kind === "rate" && v !== 0 && v !== 1) bad(`${where}: ${m.name} is a rate, so each value must be 0, 1 or null.`);
    if (m.kind === "mean" && (typeof v !== "number" || !Number.isFinite(v))) bad(`${where}: ${m.name} must be a finite number or null.`);
    values[m.name] = v as number;
  }
  const out: TelemetryRow = { conversation_id: raw.conversation_id as string, prompt_version: raw.prompt_version as string, started_at: raw.started_at as string, values };
  if (raw.segment !== undefined) out.segment = raw.segment as string;
  if (raw.unit_id !== undefined) out.unit_id = raw.unit_id as string;
  if (raw.model_id !== undefined) out.model_id = raw.model_id as string;
  return out;
}

// RFC 4180: comma separated, fields optionally in double quotes, a doubled quote inside quotes is a quote, commas and
// line breaks may sit inside quotes. Returns each record with the line it started on, for error messages.
export function parseCsv(text: string, file: string): { line: number; fields: string[] }[] {
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  const records: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = "";
  let line = 1;
  let recordLine = 1;
  let i = 0;
  let quoted = false; // inside a quoted field
  let wasQuoted = false; // the current field was quoted and has closed
  const endField = () => { fields.push(field); field = ""; wasQuoted = false; };
  const endRecord = () => { endField(); records.push({ line: recordLine, fields }); fields = []; recordLine = line; };
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; wasQuoted = true; i++; continue;
      }
      if (ch === "\n") line++;
      field += ch; i++; continue;
    }
    if (ch === ",") { endField(); i++; continue; }
    if (ch === "\r" && src[i + 1] === "\n") { i++; continue; }
    if (ch === "\n") { line++; endRecord(); i++; continue; }
    if (wasQuoted) bad(`${file} line ${line}: text after a closing quote. Quote the whole field and double any quote inside it.`);
    if (ch === '"') {
      if (field !== "") bad(`${file} line ${line}: a quote inside an unquoted field. Quote the whole field and double any quote inside it.`);
      quoted = true; i++; continue;
    }
    field += ch; i++;
  }
  if (quoted) bad(`${file} line ${recordLine}: a quoted field is never closed.`);
  // A final line break ends the last record; it does not start an empty one.
  if (field !== "" || fields.length > 0 || wasQuoted) endRecord();
  return records;
}

function rowsFromCsv(text: string, file: string, contract: MetricContract): unknown[] {
  const records = parseCsv(text, file);
  if (records.length === 0) bad(`${file} is empty. The first line must be the header.`);
  const header = records[0].fields;
  const metrics = contractMetrics(contract);
  const known = ["conversation_id", "prompt_version", "started_at", "segment", "unit_id", "model_id", ...metrics.map((m) => m.name)];
  const unknown = header.filter((h) => !known.includes(h));
  if (unknown.length > 0) bad(`${file} has an undocumented column ${shown(unknown[0])}. ${MINIMISE}`);
  const dup = header.find((h, i) => header.indexOf(h) !== i);
  if (dup !== undefined) bad(`${file} has the column ${shown(dup)} more than once.`);
  for (const required of ["conversation_id", "prompt_version", "started_at", ...metrics.map((m) => m.name)]) {
    if (!header.includes(required)) bad(`${file} has no "${required}" column. Required: conversation_id, prompt_version, started_at and one column per contract metric.`);
  }
  return records.slice(1).map(({ line, fields }) => {
    if (fields.length !== header.length) bad(`${file} line ${line} has ${fields.length} fields; the header has ${header.length}.`);
    const raw: Record<string, unknown> = {};
    const values: Record<string, unknown> = {};
    header.forEach((h, j) => {
      const cell = fields[j];
      const metric = metrics.find((m) => m.name === h);
      if (metric) {
        if (cell.trim() === "") { values[h] = null; return; }
        // Number("") and Number(" ") are 0, and Number("0x1") is 1, so only plain decimals are read as numbers.
        values[h] = /^\s*-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(cell) ? Number(cell) : cell;
        return;
      }
      if (cell === "" && (h === "segment" || h === "unit_id" || h === "model_id")) return;
      raw[h] = cell;
    });
    raw.values = values;
    return { line, raw };
  }).map(({ line, raw }) => validateRow(raw, `${file} line ${line}`, contract));
}

function validateAggregate(raw: unknown, where: string, contract: MetricContract): TelemetryAggregate {
  if (!isObject(raw)) return bad(`${where} is not an object.`);
  const unknown = Object.keys(raw).filter((k) => !["prompt_version", "n", "immature", "unattributed", "metrics", "segments"].includes(k));
  if (unknown.length > 0) bad(`${where} has an undocumented field ${shown(unknown[0])}. ${MINIMISE}`);
  if (!isNonEmpty(raw.prompt_version)) bad(`${where}: prompt_version must be a non-empty string.`);
  if ((raw.prompt_version as string).length > MAX_ID) bad(`${where}: prompt_version is longer than ${MAX_ID} characters.`);
  checkPersonalData(raw.prompt_version as string, "prompt_version", where);
  for (const field of ["n", "immature", "unattributed"]) {
    if (!isCount(raw[field])) bad(`${where}: ${field} must be a whole number of 0 or more.`);
  }
  const n = raw.n as number;
  if (!isObject(raw.metrics)) return bad(`${where}: metrics must be an object of metric name to summary.`);
  const metrics = contractMetrics(contract);
  const extra = Object.keys(raw.metrics).filter((k) => !metrics.some((m) => m.name === k));
  if (extra.length > 0) bad(`${where}: metrics has "${extra[0]}", which is not a metric in the contract. ${MINIMISE}`);
  const out: Record<string, AggregateMetric> = {};
  for (const m of metrics) {
    const s = raw.metrics[m.name];
    if (!isObject(s)) return bad(`${where}: metrics is missing ${m.name}.`);
    if (s.kind !== m.kind) bad(`${where}: metrics.${m.name}.kind must be "${m.kind}", as in the contract.`);
    if (m.kind === "rate") {
      const unk = Object.keys(s).filter((k) => !["kind", "successes", "missing"].includes(k));
      if (unk.length > 0) bad(`${where}: metrics.${m.name} has an undocumented field "${unk[0]}".`);
      if (!isCount(s.successes)) bad(`${where}: metrics.${m.name}.successes must be a whole number of 0 or more.`);
      if (!isCount(s.missing)) bad(`${where}: metrics.${m.name}.missing must be a whole number of 0 or more.`);
      if ((s.successes as number) + (s.missing as number) > n) bad(`${where}: metrics.${m.name}.successes plus missing is more than n.`);
      out[m.name] = { kind: "rate", successes: s.successes as number, missing: s.missing as number };
    } else {
      const unk = Object.keys(s).filter((k) => !["kind", "mean", "sd", "missing"].includes(k));
      if (unk.length > 0) bad(`${where}: metrics.${m.name} has an undocumented field "${unk[0]}".`);
      if (typeof s.mean !== "number" || !Number.isFinite(s.mean)) bad(`${where}: metrics.${m.name}.mean must be a finite number.`);
      if (typeof s.sd !== "number" || !Number.isFinite(s.sd) || s.sd < 0) bad(`${where}: metrics.${m.name}.sd must be a finite number of 0 or more.`);
      if (!isCount(s.missing) || s.missing > n) bad(`${where}: metrics.${m.name}.missing must be a whole number from 0 to n.`);
      out[m.name] = { kind: "mean", mean: s.mean as number, sd: s.sd as number, missing: s.missing as number };
    }
  }
  const agg: TelemetryAggregate = { prompt_version: raw.prompt_version as string, n, immature: raw.immature as number, unattributed: raw.unattributed as number, metrics: out };
  if (raw.segments !== undefined) {
    if (!isObject(raw.segments)) return bad(`${where}: segments must be an object of segment to count.`);
    const segments: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw.segments)) {
      if (k.length > MAX_ID) bad(`${where}: a segment name is longer than ${MAX_ID} characters.`);
      checkPersonalData(k, "a segment name", where);
      if (!isCount(v)) bad(`${where}: segment counts must be whole numbers of 0 or more.`);
      segments[k] = v as number;
    }
    agg.segments = segments;
  }
  return agg;
}

export function versionCheck(tags: string[], allowed: string[], noun: string): void {
  const unexpected = tags.filter((t) => !allowed.includes(t));
  if (unexpected.length === 0) return;
  const distinct = [...new Set(unexpected)].sort();
  fail("telemetry_version_mismatch", `${unexpected.length} ${noun}${unexpected.length === 1 ? "" : "s"} carry a prompt_version that is not expected here (${distinct.slice(0, 3).join(", ")}${distinct.length > 3 ? `, and ${distinct.length - 3} more` : ""}). Expected only: ${allowed.join(", ")}. Export only the tags the pilot names.`);
}

// Classifies each row as unattributed (its unit appears under more than one tag), immature (outcome not final by
// asOf) or mature. Shared by the import, the baseline report and the experiment analysis so all three agree.
export type RowClass = "mature" | "immature" | "unattributed";
// rowAsOf, when given, is the export time of the newest export that carried each row. A row's outcome is final
// only if THAT export was made after the row matured: a later export of other rows says nothing about it.
export function classifyRows(rows: TelemetryRow[], lagDays: number, asOf: IsoTime, rowAsOf?: number[]): RowClass[] {
  const tagsByUnit = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.unit_id === undefined) continue;
    const set = tagsByUnit.get(r.unit_id) ?? new Set<string>();
    set.add(r.prompt_version);
    tagsByUnit.set(r.unit_id, set);
  }
  const asOfMs = ms(asOf);
  return rows.map((r, i) => {
    if (r.unit_id !== undefined && (tagsByUnit.get(r.unit_id) as Set<string>).size > 1) return "unattributed";
    return ms(r.started_at) + lagDays * DAY_MS > (rowAsOf?.[i] ?? asOfMs) ? "immature" : "mature";
  });
}

export function armCountsFromRows(rows: TelemetryRow[], classes: RowClass[], tag: string): ArmCounts {
  const arm: ArmCounts = { tag, rows: 0, mature: 0, immature: 0, unattributed: 0, segments: {} };
  rows.forEach((r, i) => {
    if (r.prompt_version !== tag) return;
    arm.rows++;
    arm[classes[i]]++;
    const seg = r.segment ?? NO_SEGMENT;
    arm.segments[seg] = (arm.segments[seg] ?? 0) + 1;
  });
  return arm;
}

export function armCountsFromAggregate(agg: TelemetryAggregate | undefined, tag: string): ArmCounts {
  if (!agg) return { tag, rows: 0, mature: 0, immature: 0, unattributed: 0, segments: {} };
  return { tag, rows: agg.n + agg.immature + agg.unattributed, mature: agg.n, immature: agg.immature, unattributed: agg.unattributed, segments: { ...(agg.segments ?? {}) } };
}

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// Validates one export. Throws PilotError telemetry_* / invalid_telemetry.
export function importTelemetry(input: ImportInput): TelemetryImport {
  const { contract } = input;
  let parsed: unknown;
  try { parsed = JSON.parse(input.text); } catch { return bad("The export is not valid JSON. Export it again as one JSON file shaped as docs/PILOT.md describes."); }
  if (!isObject(parsed)) return bad("The export must be a JSON object.");
  const x = parsed;
  if (unsafeKey(x) !== null) bad("The export has a field named __proto__, constructor or prototype, which no export needs.");
  const unknownTop = Object.keys(x).filter((k) => !TOP_KEYS.includes(k));
  if (unknownTop.length > 0) bad(`The export has an undocumented top-level field ${shown(unknownTop[0])}. ${MINIMISE}`);
  if (x.format !== TELEMETRY_FORMAT) bad(`The export's format must be "${TELEMETRY_FORMAT}".`);
  if (!isNonEmpty(x.export_id)) bad("The export needs a non-empty export_id (the customer's own id for this export).");
  if (!isNonEmpty(x.source)) bad("The export needs a non-empty source naming the system it came from.");
  if (!validTime(x.exported_at)) bad("exported_at must be a UTC time like 2026-09-20T00:00:00Z.");
  if (!isObject(x.window)) return bad("window must be an object with start and end.");
  if (Object.keys(x.window).some((k) => k !== "start" && k !== "end")) bad("window may only have start and end.");
  if (!validTime(x.window.start) || !validTime(x.window.end)) bad("window.start and window.end must be UTC times like 2026-09-01T00:00:00Z.");
  if (ms(x.window.start as string) >= ms(x.window.end as string)) bad("window.start must be before window.end.");
  if (x.assignment !== "none" && x.assignment !== "randomized" && x.assignment !== "observational") bad('assignment must be "none", "randomized" or "observational".');
  if (input.purpose === "baseline" && x.assignment !== "none") bad(`A baseline export covers the current prompt only, so assignment must be "none" (it is "${x.assignment}").`);
  if (input.purpose === "experiment" && x.assignment === "none") bad('An experiment export compares two prompts, so assignment must be "randomized" or "observational", not "none".');
  if (!isNonEmpty(x.denominator)) bad("The export needs a non-empty denominator.");
  if (!isObject(x.units) || Object.values(x.units).some((u) => typeof u !== "string")) bad("units must be an object of metric name to unit.");
  if (x.query_hash !== undefined && !isSha256(x.query_hash)) bad("query_hash must be 64 lowercase hex characters.");
  if (x.expected_rows !== undefined && !isCount(x.expected_rows)) bad("expected_rows must be a whole number of 0 or more.");
  const forms = (["rows", "rows_csv", "aggregates"] as const).filter((k) => x[k] !== undefined);
  if (forms.length !== 1) bad(`The export must have exactly one of rows, rows_csv or aggregates (it has ${forms.length === 0 ? "none" : forms.join(" and ")}).`);

  const units = x.units as Record<string, string>;
  for (const m of contractMetrics(contract)) {
    if (units[m.name] === undefined) fail("telemetry_unit_mismatch", `The export declares no unit for ${m.name}. The contract's unit is "${m.unit}"; declare exactly that.`);
    if (units[m.name] !== m.unit) fail("telemetry_unit_mismatch", `The export's unit for ${m.name} is "${units[m.name]}" but the contract's is "${m.unit}". The numbers would not mean the same thing; fix the export or the contract.`);
  }
  if (x.denominator !== contract.denominator) {
    fail("telemetry_denominator_mismatch", `The export counts over "${x.denominator}" but the contract's denominator is "${contract.denominator}". Export over the contract's population.`);
  }
  if (contract.query_hash !== undefined && x.query_hash !== contract.query_hash) {
    fail("telemetry_denominator_mismatch", x.query_hash === undefined
      ? "The contract pins the metric query by hash but the export carries no query_hash. Export with the signed-off query and include its hash."
      : "The export's query_hash differs from the one the contract pins. The query defines the denominator, so a changed query is denominator drift; export with the signed-off query.");
  }
  const window = { start: x.window.start as string, end: x.window.end as string };
  if (input.window && (ms(window.start) < ms(input.window.start) || ms(window.end) > ms(input.window.end))) {
    fail("telemetry_window_mismatch", `The export's window ${window.start} to ${window.end} is not inside the experiment window ${input.window.start} to ${input.window.end}. Export only conversations that started inside the experiment window.`);
  }
  const exportedAt = x.exported_at as string;
  const base = {
    version: 1 as const, purpose: input.purpose, scope_id: input.scope_id, export_id: x.export_id as string, source: x.source as string,
    exported_at: exportedAt, window, assignment: x.assignment as TelemetryImport["assignment"],
    provisional_values_dropped: 0, query_hash: (x.query_hash as Sha256 | undefined) ?? null,
  };

  if (x.aggregates !== undefined) {
    if (!Array.isArray(x.aggregates)) return bad("aggregates must be an array.");
    const aggs = x.aggregates.map((a: unknown, i: number) => validateAggregate(a, `aggregates[${i}]`, contract));
    const tags = aggs.map((a) => a.prompt_version);
    const dupTag = tags.find((t, i) => tags.indexOf(t) !== i);
    if (dupTag !== undefined) fail("telemetry_duplicate", `The export has two aggregates for ${dupTag}. Send one summary per prompt version.`);
    versionCheck(tags, input.tags, "aggregate");
    if (aggs.length === 0 || aggs.every((a) => a.n + a.immature + a.unattributed === 0)) fail("telemetry_incomplete", "The export has no conversations. Export again once the window has traffic.");
    aggs.sort((a, b) => byString(a.prompt_version, b.prompt_version));
    return {
      ...base, form: "aggregates", expected_rows: null, duplicates_dropped: 0,
      arms: aggs.map((a) => armCountsFromAggregate(a, a.prompt_version)), rows: null, aggregates: aggs,
    };
  }

  let rawRows: TelemetryRow[];
  if (x.rows_csv !== undefined) {
    if (!isNonEmpty(x.rows_csv)) return bad("rows_csv must name a CSV file next to the export.");
    if (/[\\/]/.test(x.rows_csv) || x.rows_csv.startsWith(".")) bad("rows_csv must be a plain file name next to the export, with no directory.");
    if (!input.readSibling) return bad("The export names a rows_csv file, but no way to read files next to the export was given. Import it from its folder.");
    let text: string;
    try { text = input.readSibling(x.rows_csv); } catch { return bad(`Could not read ${x.rows_csv} next to the export. Put the CSV beside the export file.`); }
    rawRows = rowsFromCsv(text, x.rows_csv, contract) as TelemetryRow[];
  } else {
    if (!Array.isArray(x.rows)) return bad("rows must be an array.");
    rawRows = x.rows.map((r: unknown, i: number) => validateRow(r, `row ${i + 1}`, contract));
  }

  // Exact duplicates are dropped (an export job retried); the same conversation with different content is refused,
  // because there is no way to tell which version is true.
  const byId = new Map<string, { row: TelemetryRow; key: string }>();
  let duplicates = 0;
  let conflicting = 0;
  for (const r of rawRows) {
    const key = canonicalJson(r);
    const seen = byId.get(r.conversation_id);
    if (!seen) { byId.set(r.conversation_id, { row: r, key }); continue; }
    if (seen.key === key) duplicates++; else conflicting++;
  }
  if (conflicting > 0) fail("telemetry_duplicate", `${conflicting} row${conflicting === 1 ? "" : "s"} repeat a conversation_id with different content. Each conversation must appear once; fix the export query and export again.`);
  const rows = [...byId.values()].map((v) => v.row).sort((a, b) => byString(a.conversation_id, b.conversation_id));
  // The same conversation exported under two ids would be counted twice. With a unit id it can be recognised: one
  // unit does not start two conversations in the same second with the same version, segment and outcomes.
  const twinKeys = new Set<string>();
  let twins = 0;
  for (const r of rows) {
    if (r.unit_id === undefined) continue;
    const key = canonicalJson({ ...r, conversation_id: null });
    if (twinKeys.has(key)) twins++; else twinKeys.add(key);
  }
  if (twins > 0) fail("telemetry_duplicate", `${twins} row${twins === 1 ? " is" : "s are"} the same conversation under a different conversation_id (same unit, start time, version and values). Each conversation must appear once; fix the export query and export again.`);
  const copies = likelyCopies(rows.filter((r) => r.unit_id === undefined));
  if (copies !== null) {
    fail("telemetry_duplicate", `${copies.twins} rows have an exact twin under another conversation_id (same start time, version, segment and values), where chance explains about ${Math.round(copies.expected)}. That is what an export looks like when conversations are in it twice. If these are separate conversations, add unit_id to every row so they can be told apart.`);
  }

  versionCheck(rows.map((r) => r.prompt_version), input.tags, "row");
  const outside = rows.filter((r) => ms(r.started_at) < ms(window.start) || ms(r.started_at) >= ms(window.end)).length;
  if (outside > 0) fail("telemetry_window_mismatch", `${outside} row${outside === 1 ? "" : "s"} started outside the export's own window ${window.start} to ${window.end}. Export only conversations that started inside the window.`);
  if (input.window) {
    const outsideSpec = rows.filter((r) => ms(r.started_at) < ms(input.window!.start) || ms(r.started_at) >= ms(input.window!.end)).length;
    if (outsideSpec > 0) fail("telemetry_window_mismatch", `${outsideSpec} rows started outside the experiment window ${input.window.start} to ${input.window.end}.`);
  }
  const future = rows.filter((r) => ms(r.started_at) > ms(exportedAt)).length;
  if (future > 0) bad(`exported_at (${exportedAt}) is earlier than the start of ${future} row${future === 1 ? "" : "s"}. Check the export's clock and time zone (times must be UTC).`);
  if (x.expected_rows === undefined) fail("telemetry_incomplete", "A rows export needs expected_rows (how many conversations the source holds for the window), so a truncated export can be caught.");
  if (rows.length === 0) fail("telemetry_incomplete", "The export has no rows. Export again once the window has traffic.");
  if (rows.length !== x.expected_rows) {
    fail("telemetry_incomplete", `The export has ${rows.length} distinct conversations but expected_rows says ${x.expected_rows}. It may be truncated; export the whole window again.`);
  }

  const classes = classifyRows(rows, contract.outcome_lag_days, exportedAt);
  // A value on a conversation that is still inside the outcome lag is provisional: the outcome can still change.
  // It is stored as "not known yet", so it is never counted, and the export made after the lag supplies the
  // final value without contradicting this one.
  let provisional = 0;
  const kept = rows.map((r, i) => {
    if (classes[i] !== "immature" || Object.values(r.values).every((v) => v === null)) return r;
    provisional++;
    return { ...r, values: Object.fromEntries(Object.keys(r.values).map((k) => [k, null])) };
  });
  const tags = [...new Set(kept.map((r) => r.prompt_version))].sort(byString);
  return {
    ...base, form: "rows", expected_rows: x.expected_rows as number, duplicates_dropped: duplicates, provisional_values_dropped: provisional,
    arms: tags.map((t) => armCountsFromRows(kept, classes, t)), rows: kept, aggregates: null,
  };
}

// Why a stored import does not agree with itself, or null. An import is written once by importTelemetry, so its
// summary always follows from its rows; a record where it does not was not made by an import.
export function importProblem(imp: TelemetryImport, lagDays: number): string | null {
  if (imp.form === "rows") {
    const rows = imp.rows ?? [];
    if (imp.aggregates !== null) return "it has both rows and aggregates";
    if (rows.length === 0 || rows.length !== imp.expected_rows) return "its row count is not the expected_rows it records";
    if (new Set(rows.map((r) => r.conversation_id)).size !== rows.length) return "a conversation appears twice in its rows";
    const classes = classifyRows(rows, lagDays, imp.exported_at);
    const tags = [...new Set(rows.map((r) => r.prompt_version))].sort(byString);
    if (canonicalJson(tags.map((t) => armCountsFromRows(rows, classes, t))) !== canonicalJson(imp.arms)) return "its per-arm counts do not follow from its rows";
    if (rows.some((r, i) => classes[i] === "immature" && Object.values(r.values).some((v) => v !== null))) return "it holds values for conversations that were inside the outcome lag";
    return null;
  }
  const aggs = imp.aggregates ?? [];
  if (imp.rows !== null) return "it has both rows and aggregates";
  if (canonicalJson(aggs.map((a) => armCountsFromAggregate(a, a.prompt_version))) !== canonicalJson(imp.arms)) return "its per-arm counts do not follow from its aggregates";
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Merging imports. Shared with the experiment analysis.
// ---------------------------------------------------------------------------------------------------------------

export interface MergedTelemetry {
  form: "rows" | "aggregates";
  // Imports the numbers come from, oldest export first.
  used: Stored<TelemetryImport>[];
  // aggregates form: older cumulative exports the newest one replaces.
  superseded: Stored<TelemetryImport>[];
  rows: TelemetryRow[] | null;
  // rows form: for each row, the export time (ms) of the newest export that carried it.
  row_as_of: number[] | null;
  // rows form: for each row, the export time (ms) of the newest earlier export that covered the row's start time
  // but did not have the row; null when every export that could have held it did.
  row_missed_at: (number | null)[] | null;
  aggregates: TelemetryAggregate[] | null;
  duplicates_dropped: number;
  as_of: IsoTime;
  window: { start: IsoTime; end: IsoTime };
  observational: boolean;
}

const sameExceptValues = (a: TelemetryRow, b: TelemetryRow) => canonicalJson({ ...a, values: null }) === canonicalJson({ ...b, values: null });

// Why `newer` cannot be a cumulative update of `older`, or null when it can.
function notCumulative(older: TelemetryImport, newer: TelemetryImport): string | null {
  if (ms(newer.window.end) < ms(older.window.end)) return "its window ends earlier";
  for (const o of older.aggregates ?? []) {
    const n = (newer.aggregates ?? []).find((a) => a.prompt_version === o.prompt_version);
    if (!n) return `it has no summary for ${o.prompt_version}`;
    // A unit that turns up in the other arm later moves its conversations from the counted ones to the
    // unattributed ones, so a count may fall by as much as the unattributed count rose, and no further.
    const moved = Math.max(0, n.unattributed - o.unattributed);
    if (n.n + moved < o.n) return `${o.prompt_version} has fewer mature conversations (${n.n}, was ${o.n})`;
    if (n.n + n.immature + n.unattributed < o.n + o.immature + o.unattributed) return `${o.prompt_version} has fewer conversations in total`;
    for (const [name, was] of Object.entries(o.metrics)) {
      const now = n.metrics[name];
      if (!now || now.kind !== was.kind) return `${o.prompt_version} has no ${name} of the same kind`;
      if (was.kind === "rate" && now.kind === "rate") {
        if (now.successes + moved < was.successes) return `${o.prompt_version} has fewer ${name} = 1 conversations (${now.successes}, was ${was.successes})`;
        if (n.n - now.missing - now.successes + moved < o.n - was.missing - was.successes) return `${o.prompt_version} has fewer ${name} = 0 conversations than before`;
      }
    }
  }
  return null;
}

// Imports with the same id count once. Rows: union by conversation_id; a later export may fill in an outcome that
// was null (it matured), anything else that differs is a conflict. Aggregates: each export is cumulative, so only
// the newest is used.
export function mergeImports(imports: Stored<TelemetryImport>[]): MergedTelemetry {
  if (imports.length === 0) fail("telemetry_incomplete", "No telemetry has been imported yet. Import the customer's export first.");
  const unique = new Map<string, Stored<TelemetryImport>>();
  for (const imp of imports) if (!unique.has(imp.id)) unique.set(imp.id, imp);
  const all = [...unique.values()].sort((a, b) => ms(a.value.exported_at) - ms(b.value.exported_at) || byString(a.id, b.id));
  const forms = new Set(all.map((i) => i.value.form));
  if (forms.size > 1) fail("telemetry_conflict", "Some imports are rows and some are aggregates. Counts from the two forms cannot be combined without double counting; import one form for the whole experiment.");
  // The metric query defines the denominator. Exports made with different queries do not count the same thing.
  if (new Set(all.map((i) => i.value.query_hash ?? "none")).size > 1) {
    fail("telemetry_denominator_mismatch", "The exports do not all carry the same query_hash (or some carry none), so they were not made with the same metric query. Export every period with one query.");
  }
  const asOf = all[all.length - 1].value.exported_at;

  if (all[0].value.form === "aggregates") {
    const newest = all[all.length - 1];
    const tied = all.filter((i) => i.value.exported_at === newest.value.exported_at);
    if (tied.length > 1) fail("telemetry_conflict", `${tied.length} aggregate imports share the newest exported_at, so it is not clear which one is current. Re-export with distinct times.`);
    // Each aggregate export is cumulative, so nothing in it may be smaller than in an older one. A newer export
    // with fewer conversations, successes or failures is a different (or filtered) population, not an update.
    for (const older of all.slice(0, -1)) {
      const shrunk = notCumulative(older.value, newest.value);
      if (shrunk) fail("telemetry_conflict", `The newest aggregate export is not cumulative over an older one: ${shrunk}. Each aggregate export must count everything since the start, including what earlier exports counted.`);
    }
    return {
      form: "aggregates", used: [newest], superseded: all.slice(0, -1), rows: null, row_as_of: null, row_missed_at: null, aggregates: newest.value.aggregates ?? [],
      duplicates_dropped: newest.value.duplicates_dropped, as_of: asOf, window: newest.value.window,
      observational: newest.value.assignment === "observational",
    };
  }

  // A later export must hold every conversation an earlier export had for the time both cover. Otherwise the
  // same conversations under new ids would be counted twice, and conversations dropped from a later export
  // would go unnoticed.
  for (let later = 1; later < all.length; later++) {
    const ids = new Set((all[later].value.rows ?? []).map((r) => r.conversation_id));
    const from = ms(all[later].value.window.start);
    const to = ms(all[later].value.window.end);
    for (let earlier = 0; earlier < later; earlier++) {
      const gone = (all[earlier].value.rows ?? []).filter((r) => ms(r.started_at) >= from && ms(r.started_at) < to && !ids.has(r.conversation_id)).length;
      if (gone > 0) {
        fail("telemetry_conflict", `${gone} conversation${gone === 1 ? "" : "s"} from an earlier export (telemetry:${shortId(all[earlier].id)}) started inside the window of a later export but are not in it. A later export must contain every conversation of earlier exports for the time it covers; it may add new ones and fill in outcomes.`);
      }
    }
  }

  const merged = new Map<string, { row: TelemetryRow; at: number }>();
  let duplicates = 0;
  let conflicts = 0;
  for (const imp of all) {
    duplicates += imp.value.duplicates_dropped;
    const at = ms(imp.value.exported_at);
    for (const r of imp.value.rows ?? []) {
      const prev = merged.get(r.conversation_id);
      if (!prev) { merged.set(r.conversation_id, { row: r, at }); continue; }
      duplicates++;
      if (canonicalJson(prev.row) === canonicalJson(r)) { prev.at = Math.max(prev.at, at); continue; }
      if (!sameExceptValues(prev.row, r) || at <= prev.at) { conflicts++; continue; }
      const values: Record<string, number | null> = { ...prev.row.values };
      let ok = true;
      for (const [k, v] of Object.entries(r.values)) {
        const old = prev.row.values[k];
        if (old === v) continue;
        if (old === null && v !== null) values[k] = v; else ok = false;
      }
      if (!ok || Object.keys(prev.row.values).length !== Object.keys(r.values).length) { conflicts++; continue; }
      merged.set(r.conversation_id, { row: { ...prev.row, values }, at });
    }
  }
  if (conflicts > 0) {
    fail("telemetry_conflict", `${conflicts} conversation${conflicts === 1 ? "" : "s"} appear in more than one import with different content. A later export may only fill in an outcome that was missing; it may not change a recorded value, tag, time, segment or unit. Find which export is wrong before importing again.`);
  }
  const ordered = [...merged.values()].sort((a, b) => byString(a.row.conversation_id, b.row.conversation_id));
  const rows = ordered.map((v) => v.row);
  // An export says it holds every conversation of its window (expected_rows). A conversation that started before
  // an export was made, inside that export's window, and is only in a later export, was not finished then or
  // reached the source late. The analysis counts the ones that were old enough to be final.
  const spans = all.map((i) => ({ from: ms(i.value.window.start), to: ms(i.value.window.end), at: ms(i.value.exported_at), ids: new Set((i.value.rows ?? []).map((r) => r.conversation_id)) }));
  const missedAt = rows.map((r) => {
    const started = ms(r.started_at);
    let missed: number | null = null;
    for (const span of spans) {
      if (span.ids.has(r.conversation_id)) break;
      if (started >= span.from && started < span.to && started <= span.at) missed = span.at;
    }
    return missed;
  });
  return {
    form: "rows", used: all, superseded: [], rows, row_as_of: ordered.map((v) => v.at), row_missed_at: missedAt, aggregates: null, duplicates_dropped: duplicates, as_of: asOf,
    window: {
      start: all.map((i) => i.value.window.start).sort((a, b) => ms(a) - ms(b))[0],
      end: all.map((i) => i.value.window.end).sort((a, b) => ms(b) - ms(a))[0],
    },
    observational: all.some((i) => i.value.assignment === "observational"),
  };
}

// One arm's numbers for one metric. rate: successes out of n. mean: mean and sample sd over n values.
export interface ArmMetric { kind: MetricKind; n: number; missing: number; successes: number; stats: MeanStats; estimate: number | null }

export function armMetricFromRows(rows: TelemetryRow[], classes: RowClass[], tag: string, name: string, kind: MetricKind): ArmMetric {
  const values: number[] = [];
  let missing = 0;
  rows.forEach((r, i) => {
    if (r.prompt_version !== tag || classes[i] !== "mature") return;
    const v = r.values[name];
    if (v === null || v === undefined) missing++; else values.push(v);
  });
  const stats = meanSummary(values);
  const successes = kind === "rate" ? values.reduce((s, v) => s + v, 0) : 0;
  return { kind, n: values.length, missing, successes, stats, estimate: stats.mean };
}

export function armMetricFromAggregate(agg: TelemetryAggregate | undefined, name: string, kind: MetricKind): ArmMetric {
  const empty: ArmMetric = { kind, n: 0, missing: 0, successes: 0, stats: { n: 0, mean: null, sd: null }, estimate: null };
  if (!agg) return empty;
  const m = agg.metrics[name];
  const n = agg.n - m.missing;
  if (m.kind === "rate") {
    const mean = n > 0 ? m.successes / n : null;
    return { kind, n, missing: m.missing, successes: m.successes, stats: { n, mean, sd: null }, estimate: mean };
  }
  const mean = n > 0 ? m.mean : null;
  return { kind, n, missing: m.missing, successes: 0, stats: { n, mean, sd: n >= 2 ? m.sd : null }, estimate: mean };
}

export const telemetrySource = (imports: Stored<TelemetryImport>[]) => `telemetry:${imports.map((i) => shortId(i.id)).join(",")}`;

export const fmt = (x: number | null | undefined, digits = 4): string => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : String(Number(x.toFixed(digits))));
export const pct = (x: number | null | undefined): string => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${Number((x * 100).toFixed(2))}%`);

// ---------------------------------------------------------------------------------------------------------------
// Baseline report.
// ---------------------------------------------------------------------------------------------------------------

export function baselineReport(input: { config_id: Sha256; contract: MetricContract; tag: string; imports: Stored<TelemetryImport>[] }): BaselineReport {
  const { contract, tag } = input;
  for (const imp of input.imports) {
    if (imp.value.purpose !== "baseline") bad(`Import telemetry:${shortId(imp.id)} was made for an experiment, not the baseline. Import the baseline export with purpose baseline.`);
    if (imp.value.scope_id !== input.config_id) bad(`Import telemetry:${shortId(imp.id)} belongs to a different pilot configuration. Import the baseline again for the current configuration.`);
  }
  const merged = mergeImports(input.imports);
  const tags = merged.form === "rows" ? (merged.rows ?? []).map((r) => r.prompt_version) : (merged.aggregates ?? []).map((a) => a.prompt_version);
  versionCheck(tags, [tag], merged.form === "rows" ? "row" : "aggregate");
  if (merged.form === "aggregates") {
    const start = ms(merged.used[0].value.window.start);
    if (merged.superseded.some((s) => ms(s.value.window.start) < start)) {
      fail("telemetry_window_mismatch", "The newest aggregate export starts later than an older one, so it does not cover it. Aggregate exports must be cumulative from the same start.");
    }
  }
  const source = telemetrySource(merged.used);
  let counts: ArmCounts;
  let armMetric: (name: string, kind: MetricKind) => ArmMetric;
  if (merged.form === "rows") {
    const rows = merged.rows as TelemetryRow[];
    const classes = classifyRows(rows, contract.outcome_lag_days, merged.as_of, merged.row_as_of ?? undefined);
    counts = armCountsFromRows(rows, classes, tag);
    armMetric = (name, kind) => armMetricFromRows(rows, classes, tag, name, kind);
  } else {
    const agg = (merged.aggregates ?? []).find((a) => a.prompt_version === tag);
    counts = armCountsFromAggregate(agg, tag);
    armMetric = (name, kind) => armMetricFromAggregate(agg, name, kind);
  }
  const level = 1 - contract.alpha;
  const specs = [{ spec: contract.primary, role: "primary" as const }, ...contract.guards.map((g) => ({ spec: g, role: "guard" as const }))];
  const summaries = new Map<string, ArmMetric>();
  const metrics: BaselineMetric[] = specs.map(({ spec, role }) => {
    const a = armMetric(spec.name, spec.kind);
    summaries.set(spec.name, a);
    const ci = spec.kind === "rate" ? wilsonInterval(a.successes, a.n, level) : oneSampleT(a.stats, level);
    const method = spec.kind === "rate"
      ? `share of mature conversations with ${spec.name} = 1 (${a.successes} of ${a.n}); Wilson score interval at ${fmt(level * 100, 2)}%`
      : `mean over ${a.n} mature conversations with a value (sample sd ${fmt(a.stats.sd)}); one-sample t interval at ${fmt(level * 100, 2)}%`;
    return { name: spec.name, role, kind: spec.kind, unit: spec.unit, n: a.n, missing: a.missing, estimate: { value: a.estimate, source, method }, ci };
  });

  const days = (ms(merged.window.end) - ms(merged.window.start)) / DAY_MS;
  const dailyVolume: Sourced = {
    value: days > 0 ? counts.mature / days : null, source,
    method: `mature conversations (${counts.mature}) / window days (${fmt(days, 2)}, ${merged.window.start} to ${merged.window.end})`,
  };

  const p = contract.primary;
  const primary = summaries.get(p.name) as ArmMetric;
  let power: number | null = null;
  let powerMethod: string;
  if (p.kind === "rate") {
    power = primary.estimate === null ? null : sampleSizeProportions(primary.estimate, p.min_effect, p.direction, contract.alpha, contract.power);
    powerMethod = `two-proportion normal approximation, no continuity correction: baseline rate ${fmt(primary.estimate)}, change ${fmt(p.min_effect)} (${p.direction === "higher_is_better" ? "up" : "down"}, target clamped inside 0 to 1), two-sided alpha ${contract.alpha}, power ${contract.power}`;
  } else {
    power = sampleSizeMeans(primary.stats.sd, p.min_effect, contract.alpha, contract.power);
    powerMethod = `two-sample normal approximation 2(z_(1-alpha/2) + z_power)^2 sd^2 / delta^2: baseline sd ${fmt(primary.stats.sd)}, delta ${fmt(p.min_effect)}, two-sided alpha ${contract.alpha}, power ${contract.power}`;
  }
  const required = power === null ? null : Math.max(contract.min_samples_per_arm, power);
  const requiredPerArm: Sourced = {
    value: required, source,
    method: power === null
      ? `cannot be computed: ${powerMethod}. The baseline has no usable ${p.name} values to size from.`
      : `max(min_samples_per_arm ${contract.min_samples_per_arm}, ${power} from ${powerMethod})`,
  };
  const daysTo = required !== null && dailyVolume.value !== null && dailyVolume.value > 0 ? Math.ceil((2 * required) / dailyVolume.value) : null;
  const daysToRequired: Sourced = {
    value: daysTo, source,
    method: `ceil(2 x required per arm ${required ?? "n/a"} / daily volume ${fmt(dailyVolume.value, 2)}), at an even split`,
  };

  const flags: string[] = [];
  if (days < 7) flags.push("short_window");
  if (counts.mature > 0 && metrics.some((m) => m.missing / counts.mature > contract.max_missing_rate)) flags.push("missing_events");
  if (daysTo !== null && daysTo > contract.analysis_window_days) flags.push("window_too_short_for_required_samples");
  if (counts.mature === 0) flags.push("no_mature_rows");

  return {
    version: 1, config_id: input.config_id, telemetry_ids: merged.used.map((i) => i.id), tag, window: merged.window,
    rows: counts.rows, mature: counts.mature, immature: counts.immature, daily_volume: dailyVolume, metrics,
    required_per_arm: requiredPerArm, days_to_required: daysToRequired, flags,
  };
}

const BASELINE_FLAG_TEXT: Record<string, string> = {
  short_window: "The export covers less than 7 days, so weekly patterns are not in the baseline. Export at least a full week.",
  missing_events: "Some metric is missing for more conversations than the contract allows (max_missing_rate). Fix the outcome logging before the experiment starts.",
  window_too_short_for_required_samples: "At the measured volume the experiment cannot reach the required conversations per arm inside analysis_window_days. Lengthen the window, raise min_effect, or accept that the result will be hold.",
  no_mature_rows: "No conversation is old enough for its outcome to be final. Export again after the outcome lag has passed.",
};

const ciText = (ci: { lo: number; hi: number } | null) => (ci === null ? "n/a" : `${fmt(ci.lo)} to ${fmt(ci.hi)}`);

export function renderBaseline(report: BaselineReport, contract: MetricContract, baselineId: Sha256): string {
  const primary = report.metrics.find((m) => m.role === "primary") as BaselineMetric;
  const shown = (m: BaselineMetric) => (m.kind === "rate" ? pct(m.estimate.value) : `${fmt(m.estimate.value)} ${m.unit}`);
  const lines: string[] = [];
  lines.push(`# Baseline: ${primary.name} is ${shown(primary)}`, "");
  lines.push(`Your current prompt (tag ${report.tag}) measured ${primary.name} = ${shown(primary)} over ${primary.n} mature conversations (${ciText(primary.ci)} at ${fmt((1 - contract.alpha) * 100, 2)}%), ${contract.primary.direction.replace(/_/g, " ")}.`, "");
  lines.push(`- Window: ${report.window.start} to ${report.window.end}`);
  lines.push(`- Conversations: ${report.rows} received, ${report.mature} mature, ${report.immature} still inside the ${contract.outcome_lag_days}-day outcome lag`);
  lines.push(`- Denominator: ${contract.denominator}`, "");
  lines.push("| Number | Value | Interval | Source | Method |", "|---|---|---|---|---|");
  for (const m of report.metrics) {
    lines.push(`| ${m.name} (${m.role}, ${m.unit}) | ${fmt(m.estimate.value)} | ${ciText(m.ci)} | ${m.estimate.source} | ${m.estimate.method}; ${m.missing} mature conversations had no value |`);
  }
  for (const [label, s] of [["Daily volume", report.daily_volume], ["Required per arm", report.required_per_arm], ["Days to required", report.days_to_required]] as const) {
    lines.push(`| ${label} | ${fmt(s.value, 2)} | | ${s.source} | ${s.method} |`);
  }
  lines.push("");
  if (report.flags.length === 0) lines.push("No data problems found.");
  else {
    lines.push("## Problems", "");
    for (const f of report.flags) lines.push(`- ${f}: ${BASELINE_FLAG_TEXT[f] ?? f}`);
  }
  lines.push("", "## Ids", "", `- Baseline report: ${baselineId}`, `- Configuration: ${report.config_id}`, ...report.telemetry_ids.map((id) => `- Telemetry import: ${id}`));
  if (report.required_per_arm.value === null) lines.push("", "Next: export a baseline with mature outcomes for the primary metric, so the experiment can be sized.");
  else lines.push("", `Next: the experiment needs ${report.required_per_arm.value} conversations in each arm${report.days_to_required.value !== null ? `, about ${report.days_to_required.value} days of traffic at an even split` : ""}.`);
  return `${lines.join("\n")}\n`;
}
