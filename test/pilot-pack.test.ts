import assert from "node:assert/strict";
import { test } from "node:test";
import { PilotError } from "../src/pilot/errors.ts";
import { discoveryCases, PACK_LIMITS, packSummary, parsePack, turnCount } from "../src/pilot/pack.ts";
import type { PilotErrorCode } from "../src/pilot/types.ts";
import { a, call, escalateCase, makePack, returnCase, simpleCase, threeTurnCase, tr, u } from "./pilot-replay-helpers.ts";

// Applies a change to a fresh valid pack and parses the result.
const parse = (change?: (p: any) => void) => {
  const p: any = makePack();
  change?.(p);
  return parsePack(JSON.stringify(p));
};
const refused = (code: PilotErrorCode, change: (p: any) => void, mention?: RegExp) =>
  assert.throws(() => parse(change), (e: unknown) => {
    assert.ok(e instanceof PilotError, String(e));
    assert.equal(e.code, code, e.message);
    if (mention) assert.match(e.message, mention);
    return true;
  });
const firstCase = (p: any) => p.cases[0];

test("a valid synthetic pack parses and round-trips", () => {
  const p = parse();
  assert.equal(p.cases.length, 3);
  assert.deepEqual(p, makePack());
});

test("summary, turn counts and discovery cases", () => {
  const p = makePack([returnCase(), threeTurnCase("TRI-001"), escalateCase("ESC-9", "heldout")]);
  assert.equal(turnCount(p.cases[0]), 2);
  assert.equal(turnCount(p.cases[1]), 3);
  assert.deepEqual(discoveryCases(p).map((c) => c.id), ["RET-001", "TRI-001"]);
  p.cases[0].regression = { approved_by: "Fernhill QA lead", approved_at: "2026-10-03T00:00:00Z", reason: "must not return", promotion_ref: "promo-1" };
  const s = packSummary(p, "f".repeat(64));
  assert.deepEqual(s, {
    pack_id: "f".repeat(64), name: p.name, pack_version: 1, parent_pack_id: null, cases: 3,
    by_split: { discovery: 2, heldout: 1 }, regression_cases: 1, assistant_turns: 6, checks: 4 + 3 + 2,
  });
});

test("not JSON is invalid_pack", () => {
  assert.throws(() => parsePack("{not json"), (e: any) => e instanceof PilotError && e.code === "invalid_pack");
  assert.throws(() => parsePack("[]"), (e: any) => e instanceof PilotError && e.code === "invalid_pack");
});

test("header rules", () => {
  refused("invalid_pack", (p) => { p.version = 2; });
  refused("invalid_pack", (p) => { p.name = ""; });
  refused("invalid_pack", (p) => { p.pack_version = 0; });
  refused("invalid_pack", (p) => { p.pack_version = 1.5; });
  refused("invalid_pack", (p) => { p.parent_pack_id = "abc"; });
  refused("invalid_pack", (p) => { p.parent_pack_id = "a".repeat(64); }); // v1 has no parent
  refused("invalid_pack", (p) => { p.pack_version = 2; }); // v2 needs one
  refused("invalid_pack", (p) => { p.cases = []; });
  const ok = parse((p) => { p.pack_version = 2; p.parent_pack_id = "a".repeat(64); for (const c of p.cases) c.provenance.added_in_pack_version = 2; });
  assert.equal(ok.pack_version, 2);
});

test("unknown keys are refused at every level", () => {
  refused("invalid_pack", (p) => { p.customer_email_column = "x"; });
  refused("invalid_pack", (p) => { firstCase(p).notes = "x"; }, /RET-001/);
  refused("invalid_pack", (p) => { firstCase(p).messages[0].meta = "x"; }, /RET-001/);
  refused("invalid_pack", (p) => { firstCase(p).checks[0].comment = "x"; }, /RET-001/);
  refused("invalid_pack", (p) => { firstCase(p).provenance.who = "x"; });
  refused("invalid_pack", (p) => { firstCase(p).messages[1].tool_calls[0].extra = 1; });
  refused("invalid_pack", (p) => { p.tools[0].extra = 1; });
});

test("tools and catalog", () => {
  refused("invalid_pack", (p) => { p.tools.push({ ...p.tools[0] }); }, /lookup_order/);
  refused("invalid_pack", (p) => { p.tools[0].input_schema = "x"; });
  refused("invalid_pack", (p) => { p.check_catalog.looks_up_order = ""; });
  refused("invalid_pack", (p) => { p.check_catalog = []; });
});

test("case ids and splits", () => {
  refused("invalid_pack", (p) => { p.cases[1].id = "RET-001"; }, /RET-001/);
  refused("invalid_pack", (p) => { firstCase(p).id = "bad id!"; }, /Case #1/);
  refused("invalid_pack", (p) => { firstCase(p).split = "validation"; });
  refused("invalid_pack", (p) => { firstCase(p).provenance.kind = "scraped"; });
  refused("invalid_pack", (p) => { firstCase(p).provenance.ref = ""; });
  refused("invalid_pack", (p) => { firstCase(p).provenance.added_in_pack_version = 2; });
  refused("invalid_pack", (p) => { firstCase(p).provenance.added_in_pack_version = 0; });
});

test("message structure", () => {
  refused("invalid_pack", (p) => { firstCase(p).messages.shift(); }, /RET-001/); // starts with an assistant message
  refused("invalid_pack", (p) => { firstCase(p).messages.push(u("And another thing")); }, /RET-001/); // user with no reply
  refused("invalid_pack", (p) => { firstCase(p).messages.splice(3, 0, u("Hello?")); }, /RET-001/); // two users in a row
  refused("invalid_pack", (p) => { firstCase(p).messages[3].text = "  "; }); // turn ends with empty text
  refused("invalid_pack", (p) => { firstCase(p).messages[9] = a("x", [call("c9", "lookup_order", {})]); }); // turn ends with a call
  refused("invalid_pack", (p) => { firstCase(p).messages.splice(9, 1); }, /RET-001/); // turn ends on a tool result
});

test("tool call rules", () => {
  // dangling call: no result
  refused("invalid_pack", (p) => { firstCase(p).messages.splice(2, 1); }, /RET-001/);
  // result with no call
  refused("invalid_pack", (p) => { firstCase(p).messages.splice(3, 0, tr("zz", "lookup_order", "{}")); }, /RET-001/);
  // result in a later turn than its call
  refused("invalid_pack", (p) => {
    const m = firstCase(p).messages;
    const [res] = m.splice(2, 1);
    m.splice(5, 0, res);
  });
  // answered twice
  refused("invalid_pack", (p) => { firstCase(p).messages.splice(3, 0, tr("c1", "lookup_order", "{}")); });
  // result names another tool
  refused("invalid_pack", (p) => { firstCase(p).messages[2].name = "start_return"; });
  // duplicate call id within the case
  refused("invalid_pack", (p) => { firstCase(p).messages[5].tool_calls[0].id = "c1"; firstCase(p).messages[6].tool_call_id = "c1"; }, /c1/);
  // unknown tool
  refused("invalid_pack", (p) => { firstCase(p).messages[1].tool_calls[0].name = "wire_money"; firstCase(p).messages[2].name = "wire_money"; });
  // input must be a plain object
  refused("invalid_pack", (p) => { firstCase(p).messages[1].tool_calls[0].input = ["ORD-7Q4Z"]; });
  refused("invalid_pack", (p) => { firstCase(p).messages[1].tool_calls[0].input = null; });
});

test("check rules", () => {
  refused("invalid_pack", (p) => { firstCase(p).checks[0].id = "made_up"; }, /made_up/);
  refused("invalid_pack", (p) => { firstCase(p).checks[0].turn = 3; }, /RET-001/);
  refused("invalid_pack", (p) => { firstCase(p).checks[0].turn = 0; });
  refused("invalid_pack", (p) => { firstCase(p).checks[0].turn = 1.5; });
  refused("invalid_pack", (p) => { firstCase(p).checks[0].role = "judge"; });
  refused("invalid_pack", (p) => { firstCase(p).checks[0].blocking = true; }); // blocking on a primary check
  refused("invalid_pack", (p) => { firstCase(p).checks[3].blocking = "yes"; });
  refused("invalid_pack", (p) => { firstCase(p).checks[0].kind = "vibes_good"; });
  refused("invalid_pack", (p) => { firstCase(p).checks[2].any_of = []; });
  refused("invalid_pack", (p) => { firstCase(p).checks[2].any_of = [""]; });
  refused("invalid_pack", (p) => { firstCase(p).checks[2].any_of = ["x".repeat(201)]; });
  refused("invalid_pack", (p) => { firstCase(p).checks[2].any_of = [1]; });
  refused("invalid_pack", (p) => { firstCase(p).checks[0].tool = "wire_money"; });
  refused("invalid_pack", (p) => { firstCase(p).checks[1].after = "wire_money"; });
  refused("invalid_pack", (p) => { delete firstCase(p).checks[1].after; });
  refused("invalid_pack", (p) => { firstCase(p).checks[0].any_of = ["x"]; }, /RET-001/); // field of another kind
  refused("invalid_pack", (p) => { firstCase(p).checks.push({ ...firstCase(p).checks[0] }); }, /looks_up_order/); // duplicate (id, turn)
  // the same id on another turn is fine
  const ok = parse((p) => { firstCase(p).checks.push({ ...firstCase(p).checks[0], turn: 2 }); });
  assert.equal(ok.cases[0].checks.length, 5);
  // blocking is optional on guards
  assert.equal(parse((p) => { delete firstCase(p).checks[3].blocking; }).cases[0].checks[3].blocking, undefined);
});

test("observed and regression", () => {
  refused("invalid_pack", (p) => { firstCase(p).observed = { resolved: "yes" }; });
  refused("invalid_pack", (p) => { firstCase(p).observed = []; });
  assert.deepEqual(parse((p) => { firstCase(p).observed = { csat: 4, escalated: null, resolved: false }; }).cases[0].observed, { csat: 4, escalated: null, resolved: false });
  const reg = { approved_by: "Fernhill QA lead", approved_at: "2026-10-03T00:00:00Z", reason: "never skip the check", promotion_ref: "promo-1" };
  assert.deepEqual(parse((p) => { firstCase(p).regression = reg; }).cases[0].regression, reg);
  refused("invalid_pack", (p) => { firstCase(p).regression = { ...reg, reason: "" }; });
  refused("invalid_pack", (p) => { firstCase(p).regression = { ...reg, extra: "x" }; });
  const { promotion_ref: _drop, ...partial } = reg;
  refused("invalid_pack", (p) => { firstCase(p).regression = partial; });
});

test("a pack without approval is refused", () => {
  refused("pack_not_approved", (p) => { delete p.source.exported_by; }, /exported_by/);
  refused("pack_not_approved", (p) => { p.source.exported_at = "yesterday"; }, /exported_at/);
  refused("pack_not_approved", (p) => { p.source.exported_at = "2026-10-01"; }, /exported_at/);
  refused("pack_not_approved", (p) => { p.source.redaction.method = ""; }, /method/);
  refused("pack_not_approved", (p) => { delete p.source.redaction.approved_by; }, /approved_by/);
  refused("pack_not_approved", (p) => { p.source.redaction.approved_at = "2026-13-45T00:00:00Z"; }, /approved_at/);
  refused("pack_not_approved", (p) => { p.source.approved_uses = ["training"]; }, /replay/);
  refused("pack_not_approved", (p) => { delete p.source.approved_uses; }, /replay/);
  refused("pack_not_approved", (p) => { delete p.source; });
  assert.equal(parse((p) => { p.source.approved_uses = ["replay", "telemetry"]; p.source.policy_version = "p2"; }).source.policy_version, "p2");
});

test("personal data is refused without echoing it", () => {
  const email = "jo.smith@example.com";
  const refusedWith = (change: (p: any) => void, kind: RegExp, where: RegExp) =>
    assert.throws(() => parse(change), (e: any) => {
      assert.ok(e instanceof PilotError);
      assert.equal(e.code, "pack_not_redacted");
      assert.match(e.message, kind);
      assert.match(e.message, where);
      assert.ok(!e.message.includes(email), "message must not contain the email");
      assert.ok(!e.message.includes("example.com"));
      return true;
    });
  refusedWith((p) => { firstCase(p).messages[2].result = `{"email":"${email}"}`; }, /email address/, /RET-001/);
  refusedWith((p) => { firstCase(p).messages[2].result = `{"email":"${email}"}`; }, /message (number )?3/, /RET-001/);
  refusedWith((p) => { firstCase(p).messages[0].text = `reach me at ${email}`; }, /email address/, /message (number )?1/);
  refusedWith((p) => { firstCase(p).messages[1].tool_calls[0].input = { nested: { list: [{ to: email }] } }; }, /email address/, /message (number )?2/);
  refusedWith((p) => { firstCase(p).messages[3].text = `key ${"sk-" + "ant-abcdefgh12345678"}`; }, /credential/, /message (number )?4/);
  refusedWith((p) => { firstCase(p).messages[0].text = "card 4111 1111 1111 1111"; }, /payment card/, /message (number )?1/);
});

test("bounds are enforced with too_large", () => {
  refused("too_large", (p) => { firstCase(p).messages[0].text = "x".repeat(PACK_LIMITS.message_chars + 1); }, /RET-001/);
  refused("too_large", (p) => { firstCase(p).messages[2].result = "x".repeat(PACK_LIMITS.message_chars + 1); });
  refused("too_large", (p) => {
    const c = firstCase(p);
    c.messages = [];
    for (let i = 0; i <= PACK_LIMITS.messages_per_case / 2; i++) c.messages.push(u("hi"), a("hello"));
    c.checks = [];
  }, /RET-001/);
  refused("too_large", (p) => { firstCase(p).checks = Array.from({ length: PACK_LIMITS.checks_per_case + 1 }, (_, i) => ({ ...firstCase(p).checks[0], turn: 1, id: "looks_up_order", role: "primary", i })); });
  refused("too_large", (p) => { p.tools = Array.from({ length: PACK_LIMITS.tools + 1 }, (_, i) => ({ name: `t${i}`, description: "d", input_schema: {} })); });
  const many = JSON.stringify({ ...makePack(), cases: Array.from({ length: PACK_LIMITS.cases + 1 }, (_, i) => simpleCase(`C-${i}`, "discovery", [{ id: "looks_up_order", role: "primary" }])) });
  assert.throws(() => parsePack(many), (e: any) => e instanceof PilotError && e.code === "too_large");
});
