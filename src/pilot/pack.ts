// Conversation pack: parse, validate, bound and summarise. Lane: replay and failure discovery.
import { canonicalJson } from "../core/evidence.ts";
import { PilotError } from "./errors.ts";
import { isSha256, ms } from "./ids.ts";
import { personalDataKinds } from "./pii.ts";
import type { Pack, PackCase, PackSummary, Sha256 } from "./types.ts";

// Hard bounds on a pack, so an unbounded trace dump can never be imported as one.
export const PACK_LIMITS = { cases: 2000, messages_per_case: 200, message_chars: 20_000, checks_per_case: 60, tools: 50 } as const;

const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

const bad = (message: string): never => { throw new PilotError("invalid_pack", message); };

// Errors name ids, never content. A value that is not shaped like an id could itself hold personal data, so it is
// replaced by a position.
const safeName = (v: unknown): string => (typeof v === "string" && NAME.test(v) ? v : "(unnamed)");

// A key outside the schema could carry personal data past the redaction check, so unknown keys are refused.
function onlyKeys(o: Obj, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(o)) if (!allowed.includes(key)) bad(`${where} has a field this pack format does not allow (${NAME.test(key) ? key : "unnamed"}). Remove it and export again.`);
}

// Parses and validates a pack file. Throws PilotError: invalid_pack, pack_not_approved, pack_not_redacted, too_large.
export function parsePack(text: string): Pack {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return bad("The pack file is not valid JSON."); }
  if (!isObj(raw)) return bad("The pack file must be a JSON object.");
  onlyKeys(raw, ["version", "name", "pack_version", "parent_pack_id", "source", "tools", "check_catalog", "cases"], "The pack");

  if (raw.version !== 1) bad("The pack version field must be 1.");
  if (!isStr(raw.name)) bad("The pack needs a non-empty name.");
  if (!isInt(raw.pack_version) || raw.pack_version < 1) bad("pack_version must be a whole number of at least 1.");
  const packVersion = raw.pack_version as number;
  if (raw.parent_pack_id !== null && !isSha256(raw.parent_pack_id)) bad("parent_pack_id must be null or a 64-character hex pack id.");
  if ((raw.parent_pack_id === null) !== (packVersion === 1)) bad("parent_pack_id must be null for pack_version 1 and a pack id for every later version.");

  checkApproval(raw.source);

  if (!Array.isArray(raw.tools)) bad("tools must be an array.");
  if ((raw.tools as unknown[]).length > PACK_LIMITS.tools) throw new PilotError("too_large", `The pack lists ${(raw.tools as unknown[]).length} tools; the limit is ${PACK_LIMITS.tools}.`);
  const toolNames = new Set<string>();
  for (const [i, t] of (raw.tools as unknown[]).entries()) {
    if (!isObj(t)) { bad(`Tool #${i + 1} must be an object.`); continue; }
    onlyKeys(t, ["name", "description", "input_schema"], `Tool #${i + 1}`);
    if (!isStr(t.name)) bad(`Tool #${i + 1} needs a name.`);
    if (typeof t.description !== "string") bad(`Tool ${safeName(t.name)} needs a description.`);
    if (!isObj(t.input_schema)) bad(`Tool ${safeName(t.name)} needs an input_schema object.`);
    if (toolNames.has(t.name as string)) bad(`Tool ${safeName(t.name)} is listed twice.`);
    toolNames.add(t.name as string);
  }

  if (!isObj(raw.check_catalog)) bad("check_catalog must be an object of check id to sentence.");
  const catalog = raw.check_catalog as Obj;
  for (const [id, sentence] of Object.entries(catalog)) {
    if (!isStr(sentence)) bad(`check_catalog entry ${safeName(id)} must be a non-empty sentence.`);
    if (!isStr(id)) bad("check_catalog has an empty check id.");
  }

  if (!Array.isArray(raw.cases) || raw.cases.length === 0) bad("The pack needs at least one case.");
  const cases = raw.cases as unknown[];
  if (cases.length > PACK_LIMITS.cases) throw new PilotError("too_large", `The pack has ${cases.length} cases; the limit is ${PACK_LIMITS.cases}.`);
  const seen = new Set<string>();
  const ctx = { packVersion, toolNames, catalog, seen };
  cases.forEach((c, i) => checkCase(c, i, ctx));

  // Personal data last: structure first, so a malformed pack gets a structural message.
  scanForPersonalData(raw as unknown as Pack);
  return raw as unknown as Pack;
}

function checkApproval(source: unknown): void {
  const refuse = (what: string): never => { throw new PilotError("pack_not_approved", `The pack has no recorded approval: ${what}. Ask the data owner to complete the source block and export again.`); };
  if (!isObj(source)) return refuse("the source block is missing");
  for (const key of ["exported_by", "exported_at"]) if (!isStr(source[key])) refuse(`source.${key} is missing`);
  if (Number.isNaN(ms(source.exported_at as string))) refuse("source.exported_at is not a UTC time like 2026-10-01T00:00:00Z");
  const red = source.redaction;
  if (!isObj(red)) return refuse("source.redaction is missing");
  for (const key of ["method", "approved_by", "approved_at"]) if (!isStr(red[key])) refuse(`source.redaction.${key} is missing`);
  if (Number.isNaN(ms(red.approved_at as string))) refuse("source.redaction.approved_at is not a UTC time like 2026-10-01T00:00:00Z");
  if (!Array.isArray(source.approved_uses) || !source.approved_uses.includes("replay")) refuse('source.approved_uses does not include "replay"');
  onlyKeys(source, ["exported_by", "exported_at", "redaction", "approved_uses", "policy_version"], "source");
  onlyKeys(red, ["method", "approved_by", "approved_at"], "source.redaction");
  if (source.policy_version !== undefined && typeof source.policy_version !== "string") bad("source.policy_version must be a string.");
}

interface Ctx { packVersion: number; toolNames: Set<string>; catalog: Obj; seen: Set<string> }

const MESSAGE_KEYS = { user: ["role", "text"], assistant: ["role", "text", "tool_calls"], tool: ["role", "tool_call_id", "name", "result", "is_error"] } as const;
const CHECK_KEYS = {
  reply_includes: ["any_of"], reply_excludes: ["any_of"], calls_tool: ["tool"], avoids_tool: ["tool"], tool_requires: ["tool", "after"],
} as const;

function checkCase(c: unknown, index: number, ctx: Ctx): void {
  if (!isObj(c)) { bad(`Case #${index + 1} must be an object.`); return; }
  const label = typeof c.id === "string" && CASE_ID.test(c.id) ? `Case ${c.id}` : `Case #${index + 1}`;
  onlyKeys(c, ["id", "split", "provenance", "intent", "messages", "checks", "observed", "regression"], label);
  if (typeof c.id !== "string" || !CASE_ID.test(c.id)) bad(`${label} needs an id of letters, digits, dot, dash or underscore (at most 64 characters).`);
  if (ctx.seen.has(c.id as string)) bad(`${label} has an id that is used by another case.`);
  ctx.seen.add(c.id as string);
  if (c.split !== "discovery" && c.split !== "heldout") bad(`${label} needs split "discovery" or "heldout".`);

  const prov = c.provenance;
  if (!isObj(prov)) { bad(`${label} needs a provenance block.`); return; }
  onlyKeys(prov, ["kind", "ref", "added_in_pack_version"], `${label} provenance`);
  if (prov.kind !== "export" && prov.kind !== "promoted") bad(`${label} provenance.kind must be "export" or "promoted".`);
  if (!isStr(prov.ref)) bad(`${label} provenance.ref is missing.`);
  if (!isInt(prov.added_in_pack_version) || prov.added_in_pack_version < 1 || prov.added_in_pack_version > ctx.packVersion) bad(`${label} provenance.added_in_pack_version must be a whole number from 1 to the pack version.`);
  if (c.intent !== undefined && !isStr(c.intent)) bad(`${label} intent must be a non-empty string when present.`);

  const turns = checkMessages(c, label, ctx);
  checkChecks(c, label, turns, ctx);

  if (c.observed !== undefined) {
    if (!isObj(c.observed)) bad(`${label} observed must be an object.`);
    for (const [k, v] of Object.entries(c.observed as Obj)) {
      if (!(v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)))) bad(`${label} observed value ${safeName(k)} must be a number, true, false or null.`);
    }
  }
  if (c.regression !== undefined) {
    const r = c.regression;
    if (!isObj(r)) { bad(`${label} regression must be an object.`); return; }
    onlyKeys(r, ["approved_by", "approved_at", "reason", "promotion_ref"], `${label} regression`);
    for (const k of ["approved_by", "approved_at", "reason", "promotion_ref"]) if (!isStr(r[k])) bad(`${label} regression.${k} must be a non-empty string.`);
  }
}

// Validates the message list and returns the number of assistant turns.
function checkMessages(c: Obj, label: string, ctx: Ctx): number {
  if (!Array.isArray(c.messages) || c.messages.length === 0) bad(`${label} needs messages.`);
  const messages = c.messages as unknown[];
  if (messages.length > PACK_LIMITS.messages_per_case) throw new PilotError("too_large", `${label} has ${messages.length} messages; the limit is ${PACK_LIMITS.messages_per_case}.`);
  const tooLong = (n: number, what: string): void => { if (n > PACK_LIMITS.message_chars) throw new PilotError("too_large", `${label} ${what} is ${n} characters; the limit is ${PACK_LIMITS.message_chars}.`); };

  // Shape of each message first, so the turn walk below can trust the fields.
  messages.forEach((m, i) => {
    const at = `${label} message ${i + 1}`;
    if (!isObj(m)) { bad(`${at} must be an object.`); return; }
    const role = m.role;
    if (role !== "user" && role !== "assistant" && role !== "tool") bad(`${at} needs role user, assistant or tool.`);
    onlyKeys(m, MESSAGE_KEYS[role as "user"], at);
    if (role === "tool") {
      if (!isStr(m.tool_call_id)) bad(`${at} needs a tool_call_id.`);
      if (!isStr(m.name)) bad(`${at} needs the tool name.`);
      if (typeof m.result !== "string") bad(`${at} needs a result string.`);
      tooLong((m.result as string).length, `message ${i + 1} result`);
      if (m.is_error !== undefined && typeof m.is_error !== "boolean") bad(`${at} is_error must be true or false.`);
      return;
    }
    if (typeof m.text !== "string") bad(`${at} needs a text string.`);
    tooLong((m.text as string).length, `message ${i + 1} text`);
    if (role === "assistant" && m.tool_calls !== undefined) {
      if (!Array.isArray(m.tool_calls)) bad(`${at} tool_calls must be an array.`);
      for (const tc of m.tool_calls as unknown[]) {
        if (!isObj(tc)) { bad(`${at} has a tool call that is not an object.`); continue; }
        onlyKeys(tc, ["id", "name", "input"], `${at} tool call`);
        if (!isStr(tc.id)) bad(`${at} has a tool call without an id.`);
        if (!isStr(tc.name)) bad(`${at} has a tool call without a name.`);
        if (!ctx.toolNames.has(tc.name as string)) bad(`${at} calls tool ${safeName(tc.name)}, which the pack does not list in tools.`);
        if (!isObj(tc.input)) bad(`${at} has a tool call for ${safeName(tc.name)} whose input is not an object.`);
        tooLong(canonicalJson(tc.input).length, `message ${i + 1} tool input`);
      }
    }
  });

  const list = messages as Obj[];
  if (list[0].role !== "user") bad(`${label} must start with a user message.`);
  const callIds = new Set<string>();
  let turns = 0;
  let i = 0;
  while (i < list.length) {
    // list[i] is a user message here: the segment loop below stops at the next one.
    let j = i + 1;
    while (j < list.length && list[j].role !== "user") j++;
    turns++;
    if (j === i + 1) bad(`${label} user message ${i + 1} is not followed by an assistant turn.`);
    const pending = new Map<string, string>(); // call id -> tool name, until answered
    for (let k = i + 1; k < j; k++) {
      const m = list[k];
      if (m.role === "assistant") {
        for (const tc of (m.tool_calls as Obj[] | undefined) ?? []) {
          const id = tc.id as string;
          if (callIds.has(id)) bad(`${label} tool call id ${safeName(id)} is used more than once.`);
          callIds.add(id);
          pending.set(id, tc.name as string);
        }
      } else {
        const want = pending.get(m.tool_call_id as string);
        if (want === undefined) bad(`${label} message ${k + 1} is a tool result with no matching call earlier in the same turn.`);
        else if (want !== m.name) bad(`${label} message ${k + 1} answers call ${safeName(m.tool_call_id)} under a different tool name.`);
        pending.delete(m.tool_call_id as string);
      }
    }
    if (pending.size > 0) bad(`${label} turn ${turns} has a tool call (${[...pending.keys()].map(safeName).join(", ")}) with no result in the same turn.`);
    const end = list[j - 1];
    if (end.role !== "assistant" || ((end.tool_calls as unknown[] | undefined)?.length ?? 0) > 0 || (end.text as string).trim() === "") {
      bad(`${label} turn ${turns} must end with an assistant message that has text and no tool calls.`);
    }
    i = j;
  }
  return turns;
}

function checkChecks(c: Obj, label: string, turns: number, ctx: Ctx): void {
  if (!Array.isArray(c.checks)) bad(`${label} needs a checks array.`);
  const checks = c.checks as unknown[];
  if (checks.length > PACK_LIMITS.checks_per_case) throw new PilotError("too_large", `${label} has ${checks.length} checks; the limit is ${PACK_LIMITS.checks_per_case}.`);
  const pairs = new Set<string>();
  checks.forEach((k, i) => {
    const at = `${label} check #${i + 1}`;
    if (!isObj(k)) { bad(`${at} must be an object.`); return; }
    const kind = k.kind as keyof typeof CHECK_KEYS;
    if (typeof kind !== "string" || !Object.hasOwn(CHECK_KEYS, kind)) bad(`${at} needs a kind of reply_includes, reply_excludes, calls_tool, avoids_tool or tool_requires.`);
    onlyKeys(k, ["id", "turn", "role", "blocking", "kind", ...CHECK_KEYS[kind]], at);
    if (typeof k.id !== "string" || !Object.hasOwn(ctx.catalog, k.id)) bad(`${at} uses check id ${safeName(k.id)}, which is not in check_catalog.`);
    if (!isInt(k.turn) || k.turn < 1 || k.turn > turns) bad(`${label} check ${safeName(k.id)} names a turn outside 1 to ${turns}.`);
    if (k.role !== "primary" && k.role !== "guard") bad(`${label} check ${safeName(k.id)} needs role primary or guard.`);
    if (k.blocking !== undefined && (k.role !== "guard" || typeof k.blocking !== "boolean")) bad(`${label} check ${safeName(k.id)}: blocking is only allowed on guard checks, and must be true or false.`);
    if (kind === "reply_includes" || kind === "reply_excludes") {
      const phrases = k.any_of;
      if (!Array.isArray(phrases) || phrases.length === 0 || phrases.some((p) => !isStr(p) || (p as string).length > 200)) bad(`${label} check ${safeName(k.id)} needs any_of: a non-empty list of phrases of at most 200 characters.`);
    } else {
      const names = kind === "tool_requires" ? ["tool", "after"] : ["tool"];
      for (const field of names) if (typeof k[field] !== "string" || !ctx.toolNames.has(k[field] as string)) bad(`${label} check ${safeName(k.id)} names a ${field} that the pack does not list in tools.`);
    }
    const pair = `${k.id}\u0000${k.turn}`;
    if (pairs.has(pair)) bad(`${label} has check ${safeName(k.id)} twice on turn ${k.turn}.`);
    pairs.add(pair);
  });
}

// Redaction is the customer's job; this is the backstop. Messages say where and what kind, never the text.
function scanForPersonalData(pack: Pack): void {
  const hit = (text: string, where: string): void => {
    const kinds = personalDataKinds(text);
    if (kinds.length > 0) throw new PilotError("pack_not_redacted", `${where} contains what looks like personal data (${kinds.join(", ")}). Replace it with a token such as [EMAIL_1] and export again.`);
  };
  const walk = (value: unknown, where: string): void => {
    if (typeof value === "string") hit(value, where);
    else if (Array.isArray(value)) for (const v of value) walk(v, where);
    else if (isObj(value)) for (const [k, v] of Object.entries(value)) { hit(k, where); walk(v, where); }
  };
  for (const sentence of Object.values(pack.check_catalog)) hit(sentence, "check_catalog");
  for (const c of pack.cases) {
    hit(c.provenance.ref, `Case ${c.id} provenance.ref`);
    if (c.intent !== undefined) hit(c.intent, `Case ${c.id} intent`);
    c.messages.forEach((m, i) => {
      const where = `Case ${c.id} message number ${i + 1} (counting from 1)`;
      if (m.role === "tool") hit(m.result, where);
      else {
        hit(m.text, where);
        if (m.role === "assistant") for (const tc of m.tool_calls ?? []) walk(tc.input, where);
      }
    });
    for (const k of c.checks) if ("any_of" in k) for (const p of k.any_of) hit(p, `Case ${c.id} check ${k.id}`);
  }
}

export function packSummary(pack: Pack, packId: Sha256): PackSummary {
  const by_split = { discovery: 0, heldout: 0 };
  let regression_cases = 0;
  let assistant_turns = 0;
  let checks = 0;
  for (const c of pack.cases) {
    by_split[c.split]++;
    if (c.regression) regression_cases++;
    assistant_turns += turnCount(c);
    checks += c.checks.length;
  }
  return { pack_id: packId, name: pack.name, pack_version: pack.pack_version, parent_pack_id: pack.parent_pack_id, cases: pack.cases.length, by_split, regression_cases, assistant_turns, checks };
}

// Number of assistant turns in a case (one per user message).
export function turnCount(c: PackCase): number {
  return c.messages.filter((m) => m.role === "user").length;
}

// The only cases a proposer may ever be shown.
export function discoveryCases(pack: Pack): PackCase[] {
  return pack.cases.filter((c) => c.split === "discovery");
}
