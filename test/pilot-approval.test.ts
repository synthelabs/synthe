import assert from "node:assert/strict";
import { test } from "node:test";
import { makeApproval, requireApproval } from "../src/pilot/approval.ts";
import { PilotError } from "../src/pilot/errors.ts";
import type { Approval, Stored } from "../src/pilot/types.ts";
import { fixture, stored } from "./pilot-review-helpers.ts";

const code = (c: string) => (e: unknown) => e instanceof PilotError && e.code === c;
const f = fixture();
const cand = f.bundle.value.candidate_id;
const exp = f.bundle.value.experiment_id;
const make = (decision: "approved" | "rejected", at: string, over: Record<string, unknown> = {}): Stored<Approval> =>
  stored(makeApproval({ pilot_id: "fernhill-pilot", bundle: f.bundle, candidate_id: cand, experiment_id: exp, approver: "Ines Park", decision, at, ...over }));

test("an approval ties to the bundle", () => {
  const a = make("approved", "2026-10-20T10:00:00Z").value;
  assert.equal(a.review_id, f.bundle.id);
  assert.equal(a.scope, "experiment");
  assert.equal(a.candidate_id, cand);
  assert.equal(a.experiment_id, exp);
});

test("makeApproval refuses ids that are not the bundle's", () => {
  for (const over of [{ candidate_id: cand.slice(0, 12) }, { candidate_id: "0".repeat(64) }, { experiment_id: "0".repeat(64) }, { pilot_id: "other" }]) {
    assert.throws(() => make("approved", "2026-10-20T10:00:00Z", over), code("unknown_approval"));
  }
});

test("makeApproval refuses an empty approver and a bad time", () => {
  assert.throws(() => make("approved", "2026-10-20T10:00:00Z", { approver: "  " }), code("usage"));
  assert.throws(() => make("approved", "2026-10-20 10:00", {}), code("usage"));
  assert.throws(() => make("approved", "2026-10-20T10:00:00+02:00", {}), code("usage"));
});

test("requireApproval needs the exact ids", () => {
  const a = make("approved", "2026-10-20T10:00:00Z");
  assert.equal(requireApproval([a], cand, exp).id, a.id);
  assert.throws(() => requireApproval([a], cand.slice(0, 12), exp), code("unknown_approval"));
  assert.throws(() => requireApproval([a], cand, exp.slice(0, 12)), code("unknown_approval"));
  assert.throws(() => requireApproval([a], cand, "0".repeat(64)), code("unknown_approval"));
  assert.throws(() => requireApproval([], cand, exp), code("unknown_approval"));
});

test("a rejection after an approval refuses; an approval after a rejection is accepted", () => {
  const yes = make("approved", "2026-10-20T10:00:00Z");
  const no = make("rejected", "2026-10-21T10:00:00Z");
  assert.throws(() => requireApproval([yes, no], cand, exp), (e: unknown) => code("unknown_approval")(e) && /rejection/.test((e as Error).message));
  assert.throws(() => requireApproval([no, yes], cand, exp), code("unknown_approval"));
  const later = make("approved", "2026-10-22T10:00:00Z");
  assert.equal(requireApproval([later, no], cand, exp).id, later.id);
});

test("a tie on time goes to the later entry", () => {
  const yes = make("approved", "2026-10-20T10:00:00Z");
  const no = make("rejected", "2026-10-20T10:00:00Z");
  assert.throws(() => requireApproval([yes, no], cand, exp), code("unknown_approval"));
  assert.equal(requireApproval([no, yes], cand, exp).id, yes.id);
});
