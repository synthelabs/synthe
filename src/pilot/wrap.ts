// The customer-facing recorder of the enterprise pilot (shipped as `synthe/pilot`).
//
// Wrap each agent call with `recorder.call(...)` and report each outcome with `recorder.outcome(...)`. Both append
// one line to a local log. `synthe pilot export` turns the log into the telemetry export the pilot reads.
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

interface PilotRecorderBase {
  logDir: string;
  // Your agent's name. It is written on every line, so a log that holds more than one agent exports one at a time.
  agent: string;
  now?: () => Date; // tests
  onProblem?: (problem: { kind: string }) => void;
}

// Ids are either hashed with a key you keep (recommended) or written raw on purpose. Neither is refused, so a log
// never holds raw ids by forgetting an option.
export type PilotRecorderOptions =
  | (PilotRecorderBase & { idKey: string; rawIds?: undefined })
  | (PilotRecorderBase & { rawIds: true; idKey?: undefined });

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

// HMAC-SHA256(idKey, "<kind>:<id>"), first 16 bytes, each of the 32 nibbles written as one letter (0 is "a", 15 is
// "p"). A token has no digit, so the import's card-number and national-id checks cannot fire on one, and no retry
// is ever needed: the token is the same every time, so a call and its outcome join. The kind keeps a conversation
// token and a unit token for the same raw id apart. This rule is frozen once published: changing it would split
// one conversation's calls and outcomes across two tokens.
const LETTERS = "abcdefghijklmnop";
const token = (key: string, kind: "conversation" | "unit", id: string): string => {
  let out = "";
  for (const byte of createHmac("sha256", key).update(`${kind}:${id}`).digest().subarray(0, 16)) out += LETTERS[byte >> 4] + LETTERS[byte & 15];
  return out;
};

export function pilotRecorder(options: PilotRecorderOptions): PilotRecorder {
  if (typeof options?.logDir !== "string" || options.logDir === "") throw new TypeError("pilotRecorder needs a logDir.");
  if (!isId(options.agent)) throw new TypeError("pilotRecorder needs an agent: your agent's name, 1 to 200 characters.");
  // Fail closed at startup (not in the agent call): raw ids in a log must be a decision, never a default.
  const { rawIds } = options as { rawIds?: unknown };
  if (options.idKey !== undefined && (typeof options.idKey !== "string" || options.idKey === "")) throw new TypeError("idKey must be a non-empty string when given.");
  if (rawIds !== undefined && rawIds !== true) throw new TypeError("rawIds must be true when given.");
  if (options.idKey !== undefined && rawIds === true) throw new TypeError("Pass idKey or rawIds: true, not both: it is ambiguous whether ids are hashed.");
  if (options.idKey === undefined && rawIds !== true) throw new TypeError("pilotRecorder needs an idKey (ids are written as a keyed token, recommended) or rawIds: true (ids are written as given).");
  const { logDir, idKey, agent } = options;
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
    append({ v: CALL_LOG_VERSION, type: "problem", at: at.toISOString(), agent, kind }, at);
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
      v: CALL_LOG_VERSION, type: "call", at: at.toISOString(), agent,
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
        v: CALL_LOG_VERSION, type: "outcome", at: at.toISOString(), agent,
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

// ---------------------------------------------------------------------------------------------------------------
// The split rule: sha256-v1. Copied from the shipped clients' rule (src/live/assign.ts) so this file imports only
// Node built-ins; docs/assign-vectors.json pins both copies to the same answers. Once customers run it, the hash,
// the modulus and the range rule cannot change without moving real conversations between arms. A change needs a
// new rule name, never an edit here.
// ---------------------------------------------------------------------------------------------------------------
export const ASSIGN_RULE = "sha256-v1";

export interface Arm {
  id: string;
  weight: number;
}

// Maps a unit (for example a conversation id) to a bucket from 0 to 9999. The salt is per experiment,
// so the same unit gets a fresh draw in each one.
// A lone surrogate is rejected: Node would hash it as U+FFFD, but Python raises, so the ports would disagree.
export function bucket(unitId: string, salt: string): number {
  // Other types would stringify differently in each port (null, 100.0, objects), so they are refused here.
  if (typeof unitId !== "string" || typeof salt !== "string") {
    throw new TypeError("bucket: the unit id and the salt must be text.");
  }
  if (/\p{Cs}/u.test(unitId) || /\p{Cs}/u.test(salt)) {
    throw new Error("bucket: the unit id and the salt must be valid Unicode text.");
  }
  const hex = createHash("sha256").update(`${salt}:${unitId}`, "utf8").digest("hex");
  return parseInt(hex.slice(0, 8), 16) % 10000;
}

// Arms take consecutive ranges of the 10000 buckets, in the order given, sized by weight. Weights need not
// add up to 100: the ranges scale to whatever the total is.
//
// The walk is integer-only, so every language gets the same answer. Whole weights capped at 1,000,000 keep
// every product below 2^53, where doubles and integers agree exactly; a fraction would round differently per port.
export function pickArm(arms: Arm[], unitId: string, salt: string): string {
  for (const arm of arms) {
    if (!Number.isInteger(arm.weight) || arm.weight < 0) {
      throw new Error(`Arm "${arm.id}": weight must be 0 or more and a whole number.`);
    }
  }
  const total = arms.reduce((sum, arm) => sum + arm.weight, 0);
  if (!(total > 0)) throw new Error("Give at least one arm with a weight above 0.");
  if (total > 1000000) throw new Error("Arm weights must add up to 1,000,000 or less.");

  const x = bucket(unitId, salt) * total;
  let cum = 0;
  let last: string | undefined;
  for (const arm of arms) {
    if (arm.weight === 0) continue;
    cum += arm.weight;
    last = arm.id;
    // A bucket exactly on an edge (x equal to cum * 10000) belongs to the next arm.
    if (x < cum * 10000) return arm.id;
  }
  // Unreachable: x is at most 9999 * total, below total * 10000, where the last arm with weight above 0 ends. Kept so the function
  // never falls through to undefined.
  return last as string;
}

// Which prompt serves a key: the same salt and key always give the same answer, and a different salt reshuffles.
// Use the conversation id (or the customer's own assignment key) as the key, so every call of one conversation gets
// one version. The share is in basis points of 10,000: 5000 is half, and the pilot specification's
// `allocation.candidate` times 10,000 is the number to pass. A configuration mistake throws here, at the first call,
// and not later in the log.
export function pickVersion(input: { key: string; salt: string; baseline: string; candidate: string; candidateShareBp: number }): string {
  if (typeof input !== "object" || input === null) throw new TypeError("pickVersion needs { key, salt, baseline, candidate, candidateShareBp }.");
  if ("candidateShare" in input) throw new TypeError("candidateShare is gone. Pass candidateShareBp: a whole number from 1 to 9999 (5000 is half; the specification's allocation.candidate times 10000).");
  const { key, salt, baseline, candidate, candidateShareBp } = input;
  if (typeof key !== "string" || key === "" || typeof salt !== "string" || salt === "") throw new TypeError("pickVersion needs a non-empty key and salt.");
  if (typeof baseline !== "string" || baseline === "" || typeof candidate !== "string" || candidate === "") throw new TypeError("pickVersion needs a baseline and a candidate tag.");
  if (baseline === candidate) throw new TypeError("The baseline and candidate tags must differ.");
  if (!Number.isInteger(candidateShareBp) || candidateShareBp < 1 || candidateShareBp > 9999) throw new TypeError("candidateShareBp must be a whole number from 1 to 9999 (basis points: 5000 is half).");
  return pickArm([{ id: baseline, weight: 10000 - candidateShareBp }, { id: candidate, weight: candidateShareBp }], key, salt);
}
