import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson } from "../src/core/evidence.ts";
import { PilotError } from "../src/pilot/errors.ts";
import { contentId, shortId } from "../src/pilot/ids.ts";
import { eligibleFailures, promote, renderPromotion } from "../src/pilot/promote.ts";
import type { Pack, PackSummary, PromotionRecord, PromotionRequest, ReplayReport, Stored } from "../src/pilot/types.ts";
import { CANARY_ORDER, CANARY_SENTENCE, CANARY_TOOL_ARG, fixture, makeCase, makePack, makeReplay, stored } from "./pilot-review-helpers.ts";

const code = (c: string) => (e: unknown) => e instanceof PilotError && e.code === c;
const f = fixture();
const EXP = "e".repeat(64);

type Req = PromotionRequest;
function request(over: Partial<Req> = {}, pack: Stored<Pack> = f.pack): Stored<Req> {
  return stored<Req>({
    version: 1, base_pack_id: pack.id, approver: "Ines Park", at: "2026-11-20T09:00:00Z",
    existing: [{ case_id: "c1", reason: "Juniper skipped the order lookup", evidence: { replay_id: f.replay.id, turn: 1, check_id: "looks_up_order" } }],
    added: [], ...over,
  });
}
const added = (id: string, over: Record<string, unknown> = {}) => {
  const { provenance: _p, regression: _r, ...rest } = makeCase(id, "discovery");
  return { case: { ...rest, messages: [{ role: "user" as const, text: "Where is my parcel [ORDER_1]?" }], ...over }, reason: "Seen during the experiment", evidence: { experiment_id: EXP } };
};
const run = (req: Stored<Req>, over: { pack?: Stored<Pack>; replays?: Stored<ReplayReport>[]; experiment_ids?: string[] } = {}) =>
  promote({ pack: over.pack ?? f.pack, request: req, replays: over.replays ?? [f.replay], experiment_ids: over.experiment_ids ?? [EXP] });

test("eligibleFailures lists baseline and candidate failures, de-duplicated and sorted", () => {
  const r = makeReplay(f.pack);
  // The candidate also fails check looks_up_order on c1, and a guard on h1; an undecided check is not a failure.
  r.candidate.cases[0].turns[0].checks[0].pass = false;
  r.candidate.cases[2].turns[0].checks[1].pass = false;
  r.candidate.cases[1].turns[0].checks[1].pass = null;
  const a = stored(r);
  const out = eligibleFailures([a, a]);
  assert.deepEqual(out.map((x) => `${x.case_id}/${x.turn}/${x.check_id}/${x.arm}`), [
    "c1/1/looks_up_order/baseline", "c1/1/looks_up_order/candidate",
    "c2/1/looks_up_order/baseline",
    "h1/1/looks_up_order/baseline", "h1/1/no_early_refund/candidate",
  ]);
  assert.equal(out[0].replay_id, a.id);
  assert.equal(out[0].split, "discovery");
  assert.equal(out[4].split, "heldout");
});

test("promote returns the next pack and leaves the old one untouched", () => {
  const before = canonicalJson(f.pack.value);
  const reqIn = request({ added: [added("n1")] });
  const reqBefore = canonicalJson(reqIn.value);
  const next = run(reqIn);
  assert.equal(canonicalJson(f.pack.value), before);
  assert.equal(contentId(f.pack.value), f.pack.id);
  assert.equal(canonicalJson(reqIn.value), reqBefore);
  assert.equal(next.version, 1);
  assert.equal(next.pack_version, 2);
  assert.equal(next.parent_pack_id, f.pack.id);
  assert.equal(next.name, f.pack.value.name);
  assert.deepEqual(next.source, f.pack.value.source);
  assert.deepEqual(next.tools, f.pack.value.tools);
  assert.deepEqual(next.check_catalog, f.pack.value.check_catalog);
  // The new pack shares no objects with the old one.
  next.cases[0].messages.push({ role: "user", text: "x" });
  next.check_catalog.extra = "x";
  assert.equal(canonicalJson(f.pack.value), before);
});

test("existing cases keep order and bytes, except the promoted one", () => {
  const next = run(request());
  assert.deepEqual(next.cases.map((c) => c.id), ["c1", "c2", "h1"]);
  const ref = `promotion:${shortId(request().id)}`;
  assert.deepEqual(next.cases[0].regression, { approved_by: "Ines Park", approved_at: "2026-11-20T09:00:00Z", reason: "Juniper skipped the order lookup", promotion_ref: ref });
  const { regression: _r, ...c1 } = next.cases[0];
  assert.equal(canonicalJson(c1), canonicalJson(f.pack.value.cases[0]));
  assert.equal(canonicalJson(next.cases[1]), canonicalJson(f.pack.value.cases[1]));
  assert.equal(canonicalJson(next.cases[2]), canonicalJson(f.pack.value.cases[2]));
});

test("a held-out case that is promoted stays held out", () => {
  const req = request({ existing: [{ case_id: "h1", reason: "Fails on both prompts", evidence: { replay_id: f.replay.id, turn: 1, check_id: "looks_up_order" } }] });
  const next = run(req);
  assert.equal(next.cases[2].split, "heldout");
  assert.ok(next.cases[2].regression);
});

test("an added case is appended with provenance and regression", () => {
  const req = request({ added: [added("n1"), added("n2")] });
  const next = run(req);
  assert.deepEqual(next.cases.map((c) => c.id), ["c1", "c2", "h1", "n1", "n2"]);
  const ref = `promotion:${shortId(req.id)}`;
  assert.deepEqual(next.cases[3].provenance, { kind: "promoted", ref, added_in_pack_version: 2 });
  assert.deepEqual(next.cases[3].regression, { approved_by: "Ines Park", approved_at: "2026-11-20T09:00:00Z", reason: "Seen during the experiment", promotion_ref: ref });
  assert.equal(next.cases[3].split, "discovery");
});

test("promote refuses a request for another base pack, a missing approver, a bad time, or nothing to promote", () => {
  const other = stored(makePack([makeCase("z", "discovery")]));
  assert.throws(() => run(request({ base_pack_id: other.id })), code("invalid_promotion"));
  assert.throws(() => run(request({ approver: " " })), code("invalid_promotion"));
  assert.throws(() => run(request({ at: "yesterday" })), code("invalid_promotion"));
  assert.throws(() => run(request({ existing: [], added: [] })), code("invalid_promotion"));
});

test("promote refuses existing entries that are unknown, duplicated, without a reason, or without eligible evidence", () => {
  const ev = { replay_id: f.replay.id, turn: 1, check_id: "looks_up_order" };
  assert.throws(() => run(request({ existing: [{ case_id: "nope", reason: "r", evidence: ev }] })), code("invalid_promotion"));
  assert.throws(() => run(request({ existing: [{ case_id: "c1", reason: "r", evidence: ev }, { case_id: "c1", reason: "r", evidence: ev }] })), code("invalid_promotion"));
  assert.throws(() => run(request({ existing: [{ case_id: "c1", reason: "  ", evidence: ev }] })), code("invalid_promotion"));
  // Evidence that names a check that passed, a wrong turn, a wrong replay, or a replay of another pack.
  assert.throws(() => run(request({ existing: [{ case_id: "c1", reason: "r", evidence: { ...ev, check_id: "no_early_refund" } }] })), (e) => code("invalid_promotion")(e) && /not a failed check/.test((e as Error).message));
  assert.throws(() => run(request({ existing: [{ case_id: "c1", reason: "r", evidence: { ...ev, turn: 2 } }] })), code("invalid_promotion"));
  assert.throws(() => run(request({ existing: [{ case_id: "c1", reason: "r", evidence: { ...ev, replay_id: "0".repeat(64) } }] })), code("invalid_promotion"));
  const foreign = stored(makeReplay(stored(makePack([makeCase("c1", "discovery")]))));
  assert.throws(() => run(request({ existing: [{ case_id: "c1", reason: "r", evidence: { ...ev, replay_id: foreign.id } }] }), { replays: [foreign] }), code("invalid_promotion"));
});

test("promote refuses a case that is already a regression case", () => {
  const pack = stored(makePack([makeCase("c1", "discovery", { regression: { approved_by: "x", approved_at: "2026-10-01T00:00:00Z", reason: "r", promotion_ref: "promotion:abc" } }), makeCase("c2", "discovery"), makeCase("h1", "heldout")]));
  const replay = stored(makeReplay(pack));
  const req = request({ existing: [{ case_id: "c1", reason: "r", evidence: { replay_id: replay.id, turn: 1, check_id: "looks_up_order" } }] }, pack);
  assert.throws(() => run(req, { pack, replays: [replay] }), code("invalid_promotion"));
});

test("promote refuses added cases that clash, repeat, lack evidence, or lack a reason", () => {
  assert.throws(() => run(request({ existing: [], added: [added("c2")] })), code("invalid_promotion"));
  assert.throws(() => run(request({ existing: [], added: [added("n1"), added("n1")] })), code("invalid_promotion"));
  assert.throws(() => run(request({ existing: [], added: [{ ...added("n1"), evidence: { experiment_id: "f".repeat(64) } }] })), code("invalid_promotion"));
  assert.throws(() => run(request({ existing: [], added: [{ ...added("n1"), reason: "" }] })), code("invalid_promotion"));
});

test("promote refuses an added case with an unknown check id, no checks, or personal data", () => {
  const badCheck = added("n1", { checks: [{ id: "invented_check", kind: "calls_tool", tool: "x", turn: 1, role: "primary" }] });
  assert.throws(() => run(request({ existing: [], added: [{ ...added("n1"), case: badCheck.case }] })), (e) => code("invalid_promotion")(e) && /check catalog/.test((e as Error).message));
  assert.throws(() => run(request({ existing: [], added: [added("n1", { checks: [] })] })), code("invalid_promotion"));
  assert.throws(() => run(request({ existing: [], added: [added("n1", { messages: [{ role: "user", text: "mail me at pat@example.com" }] })] })), code("invalid_promotion"));
});

test("promote refuses an added case that sets its own provenance or regression", () => {
  const sneaky = added("n1", { regression: { approved_by: "me", approved_at: "2026-01-01T00:00:00Z", reason: "r", promotion_ref: "promotion:x" } });
  assert.throws(() => run(request({ existing: [], added: [sneaky] })), code("invalid_promotion"));
});

test("an added case that reuses a held-out case id is a holdout leak", () => {
  assert.throws(() => run(request({ existing: [], added: [added("h1")] })), code("holdout_leak"));
});

test("a tampered pack or request is refused", () => {
  const pack = { id: f.pack.id, value: { ...f.pack.value, name: "changed" } };
  assert.throws(() => run(request(), { pack }), code("tampered"));
  const req = { id: "0".repeat(64), value: request().value };
  assert.throws(() => run(req), code("tampered"));
});

test("renderPromotion has the people, ids, cases and counts, and no conversation text", () => {
  const req = request({ added: [added("n1")] });
  const next = run(req);
  const newId = contentId(next);
  const record: PromotionRecord = {
    version: 1, request_id: req.id, base_pack_id: f.pack.id, new_pack_id: newId, approver: "Ines Park", at: "2026-11-20T09:00:00Z",
    promoted: [{ case_id: "c1", split: "discovery", kind: "existing" }, { case_id: "n1", split: "discovery", kind: "added" }],
  };
  const sum = (p: Pack, id: string): PackSummary => ({
    pack_id: id, name: p.name, pack_version: p.pack_version, parent_pack_id: p.parent_pack_id, cases: p.cases.length,
    by_split: { discovery: p.cases.filter((c) => c.split === "discovery").length, heldout: p.cases.filter((c) => c.split === "heldout").length },
    regression_cases: p.cases.filter((c) => c.regression).length, assistant_turns: 0, checks: 0,
  });
  const md = renderPromotion(record, sum(f.pack.value, f.pack.id), sum(next, newId));
  assert.ok(md.includes("Ines Park") && md.includes("2026-11-20T09:00:00Z"));
  assert.ok(md.includes(f.pack.id) && md.includes(newId) && md.includes(req.id));
  assert.ok(md.includes("c1 (discovery, existing)") && md.includes("n1 (discovery, added)"));
  assert.ok(md.includes("Before: 3 cases (2 discovery, 1 held-out)"));
  assert.ok(md.includes("After: 4 cases (3 discovery, 1 held-out)"));
  assert.ok(md.includes("Held-out cases stay held out, and the previous pack is unchanged."));
  for (const canary of [CANARY_SENTENCE, CANARY_ORDER, CANARY_TOOL_ARG, "Where is my parcel", "I am sorry about that"]) assert.ok(!md.includes(canary));
});
