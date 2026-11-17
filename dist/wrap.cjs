"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/pilot/wrap.ts
var wrap_exports = {};
__export(wrap_exports, {
  ASSIGN_RULE: () => ASSIGN_RULE,
  CALL_LOG_VERSION: () => CALL_LOG_VERSION,
  MAX_FIELD: () => MAX_FIELD,
  MAX_METRICS: () => MAX_METRICS,
  METRIC_NAME: () => METRIC_NAME,
  MIN_ID_KEY_LENGTH: () => MIN_ID_KEY_LENGTH,
  PROBLEM_KINDS: () => PROBLEM_KINDS,
  TOKEN_SHAPE: () => TOKEN_SHAPE,
  bucket: () => bucket,
  pickArm: () => pickArm,
  pickVersion: () => pickVersion,
  pilotRecorder: () => pilotRecorder
});
module.exports = __toCommonJS(wrap_exports);
var import_node_crypto = require("node:crypto");
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
var CALL_LOG_VERSION = 1;
var MAX_FIELD = 200;
var MAX_METRICS = 50;
var METRIC_NAME = /^[A-Za-z0-9_.-]{1,100}$/;
var PROBLEM_KINDS = ["invalid_call", "invalid_outcome", "write_failed"];
var isId = (v) => typeof v === "string" && v.trim() !== "" && v.length <= MAX_FIELD;
var ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
var LETTERS = "abcdefghijklmnop";
var TOKEN_SHAPE = /^[a-p]{32}$/;
var MIN_ID_KEY_LENGTH = 16;
var token = (key, kind, id) => {
  let out = "";
  for (const byte of (0, import_node_crypto.createHmac)("sha256", key).update(`${kind}:${id}`).digest().subarray(0, 16)) out += LETTERS[byte >> 4] + LETTERS[byte & 15];
  return out;
};
function appendLine(path, text) {
  const fd = (0, import_node_fs.openSync)(path, import_node_fs.constants.O_RDWR | import_node_fs.constants.O_APPEND | import_node_fs.constants.O_CREAT | (import_node_fs.constants.O_NOFOLLOW ?? 0), 384);
  try {
    const { size, mode } = (0, import_node_fs.fstatSync)(fd);
    if ((mode & import_node_fs.constants.S_IFMT) !== import_node_fs.constants.S_IFREG) return false;
    let lead = "";
    if (size > 0) {
      const last = Buffer.alloc(1);
      if ((0, import_node_fs.readSync)(fd, last, 0, 1, size - 1) === 1 && last[0] !== 10) lead = "\n";
    }
    (0, import_node_fs.writeSync)(fd, lead + text);
    return true;
  } finally {
    (0, import_node_fs.closeSync)(fd);
  }
}
function pilotRecorder(options) {
  if (typeof options?.logDir !== "string" || options.logDir === "") throw new TypeError("pilotRecorder needs a logDir.");
  if (!isId(options.agent)) throw new TypeError("pilotRecorder needs an agent: your agent's name, 1 to 200 characters.");
  const { rawIds } = options;
  if (options.idKey !== void 0 && (typeof options.idKey !== "string" || options.idKey.trim().length < MIN_ID_KEY_LENGTH)) throw new TypeError(`idKey must be a secret of at least ${MIN_ID_KEY_LENGTH} characters (for example 32 random hex characters). A short or blank key lets anyone reverse the tokens.`);
  if (rawIds !== void 0 && rawIds !== true) throw new TypeError("rawIds must be true when given.");
  if (options.idKey !== void 0 && rawIds === true) throw new TypeError("Pass idKey or rawIds: true, not both: it is ambiguous whether ids are hashed.");
  if (options.idKey === void 0 && rawIds !== true) throw new TypeError("pilotRecorder needs an idKey (ids are written as a keyed token, recommended) or rawIds: true (ids are written as given).");
  const { logDir, idKey, agent } = options;
  let problemCount = 0;
  const clock = () => {
    try {
      const d = options.now ? options.now() : /* @__PURE__ */ new Date();
      if (d instanceof Date && !Number.isNaN(d.getTime())) return d;
    } catch {
    }
    return /* @__PURE__ */ new Date();
  };
  function append(line, at) {
    try {
      (0, import_node_fs.mkdirSync)(logDir, { recursive: true, mode: 448 });
      try {
        (0, import_node_fs.writeFileSync)((0, import_node_path.join)(logDir, ".gitignore"), "*\n", { flag: "wx", mode: 384 });
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
      return appendLine((0, import_node_path.join)(logDir, `calls-${at.toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(line)}
`);
    } catch {
      return false;
    }
  }
  function problem(kind, at) {
    problemCount++;
    try {
      options.onProblem?.({ kind });
    } catch {
    }
    append({ v: CALL_LOG_VERSION, type: "problem", at: at.toISOString(), agent, kind }, at);
  }
  function callLine(ctx, at) {
    if (typeof ctx !== "object" || ctx === null) return null;
    if (!isId(ctx.promptVersion) || !isId(ctx.conversationId)) return null;
    for (const v of [ctx.unitId, ctx.segment, ctx.modelId]) if (v !== void 0 && v !== null && !isId(v)) return null;
    let started;
    if (ctx.startedAt !== void 0 && ctx.startedAt !== null) {
      const raw = ctx.startedAt;
      if (typeof raw === "string" ? !ZONED.test(raw) : !(raw instanceof Date)) return null;
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) return null;
      started = d.toISOString();
    }
    return {
      v: CALL_LOG_VERSION,
      type: "call",
      at: at.toISOString(),
      agent,
      conversation_id: idKey ? token(idKey, "conversation", ctx.conversationId) : ctx.conversationId,
      prompt_version: ctx.promptVersion,
      ...started !== void 0 ? { started_at: started } : {},
      ...ctx.unitId != null ? { unit_id: idKey ? token(idKey, "unit", ctx.unitId) : ctx.unitId } : {},
      ...ctx.segment != null ? { segment: ctx.segment } : {},
      ...ctx.modelId != null ? { model_id: ctx.modelId } : {}
    };
  }
  function record(ctx) {
    const at = clock();
    try {
      const line = callLine(ctx, at);
      if (!line) return problem("invalid_call", at);
      if (!append(line, at)) problem("write_failed", at);
    } catch {
      problem("invalid_call", at);
    }
  }
  function outcome(conversationId, values) {
    const at = clock();
    try {
      if (!isId(conversationId) || typeof values !== "object" || values === null || Array.isArray(values)) return problem("invalid_outcome", at);
      const entries = Object.entries(values);
      if (entries.length > MAX_METRICS || entries.some(([k, v]) => !METRIC_NAME.test(k) || !(v === null || typeof v === "number" && Number.isFinite(v)))) return problem("invalid_outcome", at);
      const line = {
        v: CALL_LOG_VERSION,
        type: "outcome",
        at: at.toISOString(),
        agent,
        conversation_id: idKey ? token(idKey, "conversation", conversationId) : conversationId,
        values: Object.fromEntries(entries)
      };
      if (!append(line, at)) problem("write_failed", at);
    } catch {
      problem("invalid_outcome", at);
    }
  }
  return {
    // The line is written before fn runs, so a call that crashes is still counted as served.
    async call(ctx, fn) {
      record(ctx);
      return await fn();
    },
    record,
    outcome,
    problems: () => problemCount
  };
}
var ASSIGN_RULE = "sha256-v1";
function bucket(unitId, salt) {
  if (typeof unitId !== "string" || typeof salt !== "string") {
    throw new TypeError("bucket: the unit id and the salt must be text.");
  }
  if (new RegExp("\\p{Cs}", "u").test(unitId) || new RegExp("\\p{Cs}", "u").test(salt)) {
    throw new Error("bucket: the unit id and the salt must be valid Unicode text.");
  }
  const hex = (0, import_node_crypto.createHash)("sha256").update(`${salt}:${unitId}`, "utf8").digest("hex");
  return parseInt(hex.slice(0, 8), 16) % 1e4;
}
function pickArm(arms, unitId, salt) {
  for (const arm of arms) {
    if (!Number.isInteger(arm.weight) || arm.weight < 0) {
      throw new Error(`Arm "${arm.id}": weight must be 0 or more and a whole number.`);
    }
  }
  const total = arms.reduce((sum, arm) => sum + arm.weight, 0);
  if (!(total > 0)) throw new Error("Give at least one arm with a weight above 0.");
  if (total > 1e6) throw new Error("Arm weights must add up to 1,000,000 or less.");
  const x = bucket(unitId, salt) * total;
  let cum = 0;
  let last;
  for (const arm of arms) {
    if (arm.weight === 0) continue;
    cum += arm.weight;
    last = arm.id;
    if (x < cum * 1e4) return arm.id;
  }
  return last;
}
function pickVersion(input) {
  if (typeof input !== "object" || input === null) throw new TypeError("pickVersion needs { key, salt, baseline, candidate, candidateShareBp }.");
  if ("candidateShare" in input) throw new TypeError("candidateShare is gone. Pass candidateShareBp: a whole number from 1 to 9999 (5000 is half; the specification's allocation.candidate times 10000).");
  const { key, salt, baseline, candidate, candidateShareBp } = input;
  if (typeof key !== "string" || key === "" || typeof salt !== "string" || salt === "") throw new TypeError("pickVersion needs a non-empty key and salt.");
  if (typeof baseline !== "string" || baseline === "" || typeof candidate !== "string" || candidate === "") throw new TypeError("pickVersion needs a baseline and a candidate tag.");
  if (baseline === candidate) throw new TypeError("The baseline and candidate tags must differ.");
  if (!Number.isInteger(candidateShareBp) || candidateShareBp < 1 || candidateShareBp > 9999) throw new TypeError("candidateShareBp must be a whole number from 1 to 9999 (basis points: 5000 is half).");
  return pickArm([{ id: baseline, weight: 1e4 - candidateShareBp }, { id: candidate, weight: candidateShareBp }], key, salt);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ASSIGN_RULE,
  CALL_LOG_VERSION,
  MAX_FIELD,
  MAX_METRICS,
  METRIC_NAME,
  MIN_ID_KEY_LENGTH,
  PROBLEM_KINDS,
  TOKEN_SHAPE,
  bucket,
  pickArm,
  pickVersion,
  pilotRecorder
});
