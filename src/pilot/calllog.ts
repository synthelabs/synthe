// Reads the call log that `wrap.ts` writes. A log is a folder of calls-YYYY-MM-DD.jsonl files.
// Nothing here prints a line of the log: a damaged line is only counted.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { PilotError } from "./errors.ts";
import { readBounded } from "./io.ts";
import { CALL_LOG_VERSION, MAX_FIELD, MAX_METRICS, METRIC_NAME, PROBLEM_KINDS } from "./wrap.ts";

export const MAX_LOG_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_LOG_FILES = 2000;

export interface LoggedCall {
  at: string;
  prompt_version: string;
  started_at?: string;
  unit_id?: string;
  segment?: string;
  model_id?: string;
}

export interface LoggedConversation {
  // In time order (ties: the order they were written).
  calls: LoggedCall[];
  // How many outcome lines the conversation has, and for each metric the value of the newest one.
  outcome_lines: number;
  values: Map<string, number | null>;
}

export interface CallLog {
  conversations: Map<string, LoggedConversation>;
  files: number;
  lines: number;
  malformed: number;
  problems: Record<string, number>;
}

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const isUtc = (v: unknown): v is string => typeof v === "string" && UTC.test(v) && !Number.isNaN(Date.parse(v));
const isId = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && v.length <= MAX_FIELD;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function readCallLog(dir: string): CallLog {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.startsWith("calls-") && e.name.endsWith(".jsonl")).map((e) => e.name).sort();
  } catch {
    throw new PilotError("not_found", `${dir} is not a folder that can be read. Give the folder the recorder writes to (logDir).`);
  }
  if (names.length > MAX_LOG_FILES) throw new PilotError("too_large", `${dir} holds ${names.length} log files; the limit is ${MAX_LOG_FILES}. Move the old files away and export again.`);

  const log: CallLog = { conversations: new Map(), files: names.length, lines: 0, malformed: 0, problems: {} };
  const newest = new Map<string, Map<string, number>>(); // conversation -> metric -> time of the value kept
  const conversation = (id: string): LoggedConversation => {
    let c = log.conversations.get(id);
    if (!c) { c = { calls: [], outcome_lines: 0, values: new Map() }; log.conversations.set(id, c); }
    return c;
  };

  for (const name of names) {
    const text = readBounded(join(dir, name), MAX_LOG_FILE_BYTES);
    const parts = text.split("\n");
    // The last part has no newline after it: a write that a crash cut off. It is not a line yet.
    parts.pop();
    for (const part of parts) {
      if (part.trim() === "") continue;
      log.lines++;
      let line: unknown;
      try { line = JSON.parse(part); } catch { log.malformed++; continue; }
      if (!isObject(line) || line.v !== CALL_LOG_VERSION || !isUtc(line.at)) { log.malformed++; continue; }
      if (line.type === "problem") {
        if (typeof line.kind !== "string" || !(PROBLEM_KINDS as readonly string[]).includes(line.kind)) { log.malformed++; continue; }
        log.problems[line.kind] = (log.problems[line.kind] ?? 0) + 1;
        continue;
      }
      if (!isId(line.conversation_id)) { log.malformed++; continue; }
      if (line.type === "call") {
        const optional = [line.unit_id, line.segment, line.model_id];
        if (!isId(line.prompt_version) || optional.some((v) => v !== undefined && !isId(v)) || (line.started_at !== undefined && !isUtc(line.started_at))) { log.malformed++; continue; }
        const call: LoggedCall = { at: line.at, prompt_version: line.prompt_version };
        if (line.started_at !== undefined) call.started_at = line.started_at as string;
        if (line.unit_id !== undefined) call.unit_id = line.unit_id as string;
        if (line.segment !== undefined) call.segment = line.segment as string;
        if (line.model_id !== undefined) call.model_id = line.model_id as string;
        conversation(line.conversation_id).calls.push(call);
        continue;
      }
      if (line.type === "outcome") {
        if (!isObject(line.values)) { log.malformed++; continue; }
        const entries = Object.entries(line.values);
        if (entries.length > MAX_METRICS || entries.some(([k, v]) => !METRIC_NAME.test(k) || !(v === null || (typeof v === "number" && Number.isFinite(v))))) { log.malformed++; continue; }
        const c = conversation(line.conversation_id);
        c.outcome_lines++;
        const seen = newest.get(line.conversation_id) ?? new Map<string, number>();
        newest.set(line.conversation_id, seen);
        const at = Date.parse(line.at);
        // The newest line wins a metric; at the same time the line written later wins.
        for (const [k, v] of entries) {
          if ((seen.get(k) ?? -Infinity) <= at) { seen.set(k, at); c.values.set(k, v as number | null); }
        }
        continue;
      }
      log.malformed++;
    }
  }
  for (const c of log.conversations.values()) c.calls = c.calls.map((call, i) => ({ call, i })).sort((a, b) => Date.parse(a.call.at) - Date.parse(b.call.at) || a.i - b.i).map((x) => x.call);
  return log;
}
