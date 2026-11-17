// The customer-facing recorder of the enterprise pilot (shipped as `synthe/pilot`).
//
// Wrap each agent call with `recorder.call(...)` and report each outcome with `recorder.outcome(...)`. Both append
// one line to a local log. `synthe pilot export-log` turns the log into the telemetry export the pilot reads.
//
// What this file does: it writes ids, prompt tags, times and numbers to files under `logDir`. What it does not do:
// it never reads or writes message text (no function here accepts any), never opens a network connection and never
// throws into the agent call. It imports only Node built-ins so a security review can read it on its own.
import { createHash, createHmac } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CALL_LOG_VERSION = 1;

export const MAX_FIELD = 200;
export const MAX_METRICS = 50;
export const METRIC_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
// The only things a problem line can say. It never carries an id, a value or an error message.
export const PROBLEM_KINDS = ["invalid_call", "invalid_outcome", "write_failed"] as const;
export type ProblemKind = (typeof PROBLEM_KINDS)[number];

export interface PilotCall {
  promptVersion: string; // the tag of the prompt this call serves (baseline tag or candidate tag)
  conversationId: string;
  unitId?: string; // the assignment key
  segment?: string;
  modelId?: string;
  startedAt?: Date | string; // when the conversation started, if the caller knows; default: time of this call
}

export interface PilotRecorderOptions {
  logDir: string;
  // When set, conversation and unit ids are written as a keyed hash and never raw.
  idKey?: string;
  now?: () => Date; // tests
  onProblem?: (problem: { kind: string }) => void;
}

export interface PilotRecorder {
  // Records one line, then runs fn. Returns what fn returns and throws what fn throws.
  call<T>(ctx: PilotCall, fn: () => T | Promise<T>): Promise<T>;
  // The same record without wrapping, for streaming agents.
  record(ctx: PilotCall): void;
  outcome(conversationId: string, values: Record<string, number | null>): void;
  // How many records could not be written or were refused so far.
  problems(): number;
}

const isId = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && v.length <= MAX_FIELD;
// An explicit zone is required: "2026-11-01T09:30:00" would be read in the machine's time zone.
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

// First 32 hex characters of HMAC-SHA256(idKey, "<kind>:<id>"). A run of 13 or more digits in a token can pass for a
// payment card number, and the import refuses a file with one (about 1 token in 600). Such a token is made again
// from the same key and id with a counter, so it is still the same every time and call and outcome still join.
const token = (key: string, kind: "conversation" | "unit", id: string): string => {
  for (let n = 0; ; n++) {
    const t = createHmac("sha256", key).update(`${kind}:${id}${n === 0 ? "" : `\n${n}`}`).digest("hex").slice(0, 32);
    if (!/\d{13}/.test(t) || n >= 64) return t;
  }
};

export function pilotRecorder(options: PilotRecorderOptions): PilotRecorder {
  if (typeof options?.logDir !== "string" || options.logDir === "") throw new TypeError("pilotRecorder needs a logDir.");
  if (options.idKey !== undefined && (typeof options.idKey !== "string" || options.idKey === "")) throw new TypeError("idKey must be a non-empty string when given.");
  const { logDir, idKey } = options;
  let problemCount = 0;

  const clock = (): Date => {
    try { const d = options.now ? options.now() : new Date(); if (d instanceof Date && !Number.isNaN(d.getTime())) return d; } catch { /* use the real clock */ }
    return new Date();
  };

  // True when the line is on disk. One appendFileSync per line, so processes that share a log do not interleave.
  function append(line: Record<string, unknown>, at: Date): boolean {
    try {
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
      // The log holds customer ids: keep it out of `git add -A`.
      try { writeFileSync(join(logDir, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      appendFileSync(join(logDir, `calls-${at.toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(line)}\n`, { mode: 0o600 });
      return true;
    } catch { return false; }
  }

  function problem(kind: ProblemKind, at: Date): void {
    problemCount++;
    try { options.onProblem?.({ kind }); } catch { /* a failing callback must not reach the agent */ }
    append({ v: CALL_LOG_VERSION, type: "problem", at: at.toISOString(), kind }, at);
  }

  // The line for a call, or null when the input is not valid. Nothing outside these fields is ever copied.
  function callLine(ctx: PilotCall, at: Date): Record<string, unknown> | null {
    if (typeof ctx !== "object" || ctx === null) return null;
    if (!isId(ctx.promptVersion) || !isId(ctx.conversationId)) return null;
    for (const v of [ctx.unitId, ctx.segment, ctx.modelId]) if (v !== undefined && v !== null && !isId(v)) return null;
    let started: string | undefined;
    if (ctx.startedAt !== undefined && ctx.startedAt !== null) {
      const raw = ctx.startedAt;
      if (typeof raw === "string" ? !ZONED.test(raw) : !(raw instanceof Date)) return null;
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) return null;
      started = d.toISOString();
    }
    return {
      v: CALL_LOG_VERSION, type: "call", at: at.toISOString(),
      conversation_id: idKey ? token(idKey, "conversation", ctx.conversationId) : ctx.conversationId,
      prompt_version: ctx.promptVersion,
      ...(started !== undefined ? { started_at: started } : {}),
      ...(ctx.unitId != null ? { unit_id: idKey ? token(idKey, "unit", ctx.unitId) : ctx.unitId } : {}),
      ...(ctx.segment != null ? { segment: ctx.segment } : {}),
      ...(ctx.modelId != null ? { model_id: ctx.modelId } : {}),
    };
  }

  function record(ctx: PilotCall): void {
    const at = clock();
    try {
      const line = callLine(ctx, at);
      if (!line) return problem("invalid_call", at);
      if (!append(line, at)) problem("write_failed", at);
    } catch { problem("invalid_call", at); }
  }

  function outcome(conversationId: string, values: Record<string, number | null>): void {
    const at = clock();
    try {
      if (!isId(conversationId) || typeof values !== "object" || values === null || Array.isArray(values)) return problem("invalid_outcome", at);
      const entries = Object.entries(values);
      if (entries.length > MAX_METRICS || entries.some(([k, v]) => !METRIC_NAME.test(k) || !(v === null || (typeof v === "number" && Number.isFinite(v))))) return problem("invalid_outcome", at);
      const line = {
        v: CALL_LOG_VERSION, type: "outcome", at: at.toISOString(),
        conversation_id: idKey ? token(idKey, "conversation", conversationId) : conversationId,
        values: Object.fromEntries(entries),
      };
      if (!append(line, at)) problem("write_failed", at);
    } catch { problem("invalid_outcome", at); }
  }

  return {
    // The line is written before fn runs, so a call that crashes is still counted as served.
    async call<T>(ctx: PilotCall, fn: () => T | Promise<T>): Promise<T> {
      record(ctx);
      return await fn();
    },
    record, outcome, problems: () => problemCount,
  };
}

// Which prompt serves a key: the same salt and key always give the same answer, and a different salt reshuffles.
// Use the conversation id (or the customer's own assignment key) as the key, so every call of one conversation gets
// one version. A configuration mistake throws here, at the first call, and not later in the log.
export function pickVersion(input: { key: string; salt: string; baseline: string; candidate: string; candidateShare: number }): string {
  const { key, salt, baseline, candidate, candidateShare } = input;
  if (typeof key !== "string" || key === "" || typeof salt !== "string" || salt === "") throw new TypeError("pickVersion needs a non-empty key and salt.");
  if (typeof baseline !== "string" || baseline === "" || typeof candidate !== "string" || candidate === "") throw new TypeError("pickVersion needs a baseline and a candidate tag.");
  if (baseline === candidate) throw new TypeError("The baseline and candidate tags must differ.");
  if (typeof candidateShare !== "number" || !Number.isFinite(candidateShare) || candidateShare <= 0 || candidateShare >= 1) throw new TypeError("candidateShare must be a number above 0 and below 1.");
  // 13 hex digits are 52 bits: exact in a double, so the share is not distorted by rounding.
  const u = Number.parseInt(createHash("sha256").update(`${salt}\n${key}`).digest("hex").slice(0, 13), 16) / 2 ** 52;
  return u < candidateShare ? candidate : baseline;
}
