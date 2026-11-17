import assert from "node:assert/strict";
import { test } from "node:test";
import { changedLines, discoverFailures, makeCandidate, proposerContext, renderFindings } from "../src/pilot/discover.ts";
import { PilotError } from "../src/pilot/errors.ts";
import { promptId } from "../src/pilot/ids.ts";
import type { ArmRun, FailureFinding, Pack, PilotErrorCode } from "../src/pilot/types.ts";
import { BASE_ID, a, fakeArm, makePack, simpleCase, u } from "./pilot-replay-helpers.ts";

const P = (id: string) => ({ id, role: "primary" as const });
const G = (id: string) => ({ id, role: "guard" as const, blocking: true });

// D-1..D-3 fail says_shipped; D-3 also fails offers_label; held-out cases fail both, with a canary in their text.
function fixture(): { pack: Pack; baseline: ArmRun } {
  const cases = [
    simpleCase("D-1", "discovery", [P("says_shipped"), P("offers_label")]),
    simpleCase("D-2", "discovery", [P("says_shipped")]),
    simpleCase("D-3", "discovery", [P("says_shipped"), P("offers_label"), G("no_promise_refund")]),
    simpleCase("D-4", "discovery", [P("says_shipped")]),
    simpleCase("HELDOUT-CANARY-01", "heldout", [P("says_shipped"), P("offers_label")]),
    simpleCase("HELDOUT-CANARY-02", "heldout", [P("says_shipped"), P("offers_label")]),
    simpleCase("HELDOUT-CANARY-03", "heldout", [P("says_shipped"), P("offers_label")]),
  ];
  cases[4].messages = [u("HELDOUT-CANARY-TEXT where is my order"), a("HELDOUT-CANARY-REPLY on its way")];
  const pack = makePack(cases);
  const baseline = fakeArm(pack, BASE_ID, {
    "D-1": { passes: [false, true] }, "D-2": { passes: [false] }, "D-3": { passes: [false, false, false] }, "D-4": { passes: [true] },
    "HELDOUT-CANARY-01": { passes: [false, false] }, "HELDOUT-CANARY-02": { passes: [false, false] }, "HELDOUT-CANARY-03": { passes: [false, false] },
  });
  return { pack, baseline };
}

test("findings need a recurring failure and use discovery cases only", () => {
  const { pack, baseline } = fixture();
  const f = discoverFailures({ pack, baseline, min_recurring_cases: 2 });
  assert.deepEqual(f.map((x) => x.check_id), ["says_shipped"]); // offers_label fails in 2 discovery cases (D-1 passes it): D-3 only -> below 2
  assert.deepEqual(f[0].failing, [{ case_id: "D-1", turn: 1 }, { case_id: "D-2", turn: 1 }, { case_id: "D-3", turn: 1 }]);
  assert.equal(f[0].discovery_cases_with_check, 4);
  assert.equal(f[0].description, pack.check_catalog.says_shipped);
  assert.equal(f[0].version, 1);
  assert.equal(f[0].pack_id, baseline.pack_id);
  assert.equal(f[0].baseline_prompt_id, BASE_ID);
  assert.ok(!JSON.stringify(f).includes("HELDOUT"));

  const one = discoverFailures({ pack, baseline, min_recurring_cases: 1 });
  assert.deepEqual(one.map((x) => [x.check_id, x.failing.length]), [["says_shipped", 3], ["offers_label", 1]]);
  assert.equal(one[1].discovery_cases_with_check, 2);
  assert.ok(!JSON.stringify(one).includes("HELDOUT"));
  // a guard failure is not a finding
  assert.ok(!one.some((x) => x.check_id === "no_promise_refund"));
});

test("findings are sorted by failing cases, then check id", () => {
  const pack = makePack([
    simpleCase("D-1", "discovery", [P("offers_label"), P("says_shipped")]),
    simpleCase("D-2", "discovery", [P("offers_label"), P("says_shipped")]),
    simpleCase("D-3", "discovery", [P("no_invented_policy"), P("looks_up_order")]),
    simpleCase("D-4", "discovery", [P("no_invented_policy"), P("looks_up_order")]),
    simpleCase("D-5", "discovery", [P("no_invented_policy")]),
  ]);
  const baseline = fakeArm(pack, BASE_ID, {
    "D-1": { passes: [false, false] }, "D-2": { passes: [false, false] }, "D-3": { passes: [false, false] }, "D-4": { passes: [false, false] }, "D-5": { passes: [false] },
  });
  assert.deepEqual(discoverFailures({ pack, baseline, min_recurring_cases: 2 }).map((x) => x.check_id), ["no_invented_policy", "looks_up_order", "offers_label", "says_shipped"]);
});

test("an undecided check is not a failure; a check failing twice in one case counts the case once", () => {
  const pack = makePack([simpleCase("D-1", "discovery", [P("says_shipped"), P("says_shipped")]), simpleCase("D-2", "discovery", [P("says_shipped")])]);
  pack.cases[0].checks[1].turn = 1; // same id twice on a turn is not valid in a pack, but the arm is what matters here
  const baseline = fakeArm(pack, BASE_ID, { "D-1": { passes: [false, false] }, "D-2": { passes: [null] } });
  assert.deepEqual(discoverFailures({ pack, baseline, min_recurring_cases: 2 }), []);
});

test("an arm that does not match the pack's cases is refused", () => {
  const { pack, baseline } = fixture();
  const conflict = (arm: ArmRun) => assert.throws(() => discoverFailures({ pack, baseline: arm, min_recurring_cases: 2 }), (e: unknown) => e instanceof PilotError && e.code === "conflict");
  conflict({ ...baseline, cases: baseline.cases.slice(1) }); // a discovery case is missing
  conflict({ ...baseline, cases: baseline.cases.map((c, i) => (i === 0 ? { ...c, case_id: "OTHER-1" } : c)) });
  conflict({ ...baseline, cases: baseline.cases.map((c) => (c.case_id === "HELDOUT-CANARY-01" ? { ...c, split: "discovery" as const } : c)) });
  // a baseline run of the discovery split alone is fine
  const discoveryOnly = { ...baseline, cases: baseline.cases.filter((c) => c.split === "discovery") };
  assert.equal(discoverFailures({ pack, baseline: discoveryOnly, min_recurring_cases: 2 }).length, 1);
});

const ctxInput = (pack: Pack, finding: FailureFinding) => ({ pack, baseline_prompt: "You are Juniper.\nBe kind.", finding, attempt: 1, feedback: ["fix it"], max_changed_lines: 6 });

test("proposer context holds the recorded conversation up to the failing turn and no held-out text", () => {
  const { pack, baseline } = fixture();
  const finding = discoverFailures({ pack, baseline, min_recurring_cases: 1 })[0];
  const ctx = proposerContext(ctxInput(pack, finding));
  assert.equal(ctx.attempt, 1);
  assert.equal(ctx.max_changed_lines, 6);
  assert.deepEqual(ctx.feedback, ["fix it"]);
  assert.equal(ctx.baseline_prompt, "You are Juniper.\nBe kind.");
  assert.deepEqual(ctx.examples.map((e) => [e.case_id, e.turn]), [["D-1", 1], ["D-2", 1], ["D-3", 1]]);
  assert.deepEqual(ctx.examples[0].messages, [u("Where is my order?")]); // up to and including the user message, not the reply
  assert.ok(!JSON.stringify(ctx).includes("HELDOUT-CANARY"));
});

test("proposer context cuts at the failing turn of a multi-turn case", () => {
  const p = makePack();
  const finding: FailureFinding = { version: 1, pack_id: "1".repeat(64), baseline_prompt_id: BASE_ID, check_id: "offers_label", description: "x", failing: [{ case_id: "RET-001", turn: 2 }], discovery_cases_with_check: 1 };
  const ctx = proposerContext(ctxInput(p, finding));
  assert.equal(ctx.examples[0].messages.length, 5);
  assert.equal(ctx.examples[0].messages[4].role, "user");
});

test("examples are capped at 8", () => {
  const cases = Array.from({ length: 12 }, (_, i) => simpleCase(`D-${i + 1}`, "discovery", [P("says_shipped")]));
  const pack = makePack(cases);
  const finding: FailureFinding = { version: 1, pack_id: "1".repeat(64), baseline_prompt_id: BASE_ID, check_id: "says_shipped", description: "x", failing: cases.map((c) => ({ case_id: c.id, turn: 1 })), discovery_cases_with_check: 12 };
  assert.equal(proposerContext(ctxInput(pack, finding)).examples.length, 8);
});

test("a finding that names a held-out case, or a case not in the pack, is a holdout_leak", () => {
  const { pack } = fixture();
  const finding = (case_id: string, turn = 1): FailureFinding => ({ version: 1, pack_id: "1".repeat(64), baseline_prompt_id: BASE_ID, check_id: "says_shipped", description: "x", failing: [{ case_id: "D-1", turn: 1 }, { case_id, turn }], discovery_cases_with_check: 1 });
  for (const id of ["HELDOUT-CANARY-01", "NOT-IN-PACK"]) {
    assert.throws(() => proposerContext(ctxInput(pack, finding(id))), (e: unknown) => {
      assert.ok(e instanceof PilotError);
      assert.equal(e.code, "holdout_leak");
      assert.ok(!e.message.includes("HELDOUT-CANARY-TEXT"));
      return true;
    });
  }
  // the leak is found even when it would fall beyond the 8-example cap
  const many = { ...finding("HELDOUT-CANARY-01"), failing: [...Array.from({ length: 9 }, () => ({ case_id: "D-1", turn: 1 })), { case_id: "HELDOUT-CANARY-01", turn: 1 }] };
  assert.throws(() => proposerContext(ctxInput(pack, many)), (e: unknown) => e instanceof PilotError && e.code === "holdout_leak");
});

test("changedLines counts added plus removed lines", () => {
  assert.equal(changedLines("a\nb\nc", "a\nb\nc"), 0);
  assert.equal(changedLines("a\nb\nc", "a\nb\nc\nd"), 1);
  assert.equal(changedLines("a\nb\nc", "a\nc"), 1);
  assert.equal(changedLines("a\nb\nc", "a\nx\nc"), 2);
  assert.equal(changedLines("a\nb\nc", "c\nb\na"), 4); // LCS is one line, so 2 + 2
  assert.equal(changedLines("a", "x\ny"), 3);
  assert.equal(changedLines("a\nb", "b\na"), 2);
  assert.equal(changedLines("one\ntwo\nthree\nfour", "two\nthree\nfive\nsix"), 4);
  // a huge unrelated rewrite is bounded, and counts as everything changed
  const big = Array.from({ length: 6000 }, (_, i) => `a${i}`).join("\n");
  const other = Array.from({ length: 6000 }, (_, i) => `b${i}`).join("\n");
  assert.equal(changedLines(big, other), 12000);
});

const cand = (over: Record<string, unknown> = {}) => makeCandidate({
  pilot_id: "fernhill", baseline_prompt: "You are Juniper.\nBe kind.", prompt: "You are Juniper.\nBe kind.\nAlways say when an order has shipped.",
  origin: "proposer", author: "proposer:scripted", rationale: "Orders that shipped were not described as shipped.", finding_id: "e".repeat(64),
  target_check_id: "says_shipped", max_changed_lines: 4, ...over,
} as Parameters<typeof makeCandidate>[0]);

test("a narrow candidate is accepted with its ids and size", () => {
  const c = cand();
  assert.deepEqual(c, {
    version: 1, pilot_id: "fernhill", baseline_prompt_id: promptId("You are Juniper.\nBe kind."),
    prompt_id: promptId("You are Juniper.\nBe kind.\nAlways say when an order has shipped."), origin: "proposer", author: "proposer:scripted",
    rationale: "Orders that shipped were not described as shipped.", finding_id: "e".repeat(64), target_check_id: "says_shipped", changed_lines: 1,
  });
  assert.equal(cand({ origin: "human", finding_id: null, target_check_id: null, max_changed_lines: 1 }).changed_lines, 1);
});

test("candidates are refused when empty, unchanged, unsafe or without author and rationale", () => {
  const refuse = (code: PilotErrorCode, over: Record<string, unknown>) =>
    assert.throws(() => cand(over), (e: unknown) => {
      assert.ok(e instanceof PilotError);
      assert.equal(e.code, code, e.message);
      assert.ok(!e.message.includes("sk-ant"), "message must not echo the prompt");
      return true;
    });
  refuse("invalid_candidate", { prompt: "" });
  refuse("invalid_candidate", { prompt: "   \n" });
  refuse("invalid_candidate", { prompt: "You are Juniper.\nBe kind." }); // identical
  refuse("invalid_candidate", { prompt: `You are Juniper.\n${"x".repeat(21_000)}`, max_changed_lines: 10 }); // too long
  refuse("invalid_candidate", { prompt: `You are Juniper.\nUse key ${"sk-" + "ant-abcdefgh12345678"} always.` }); // looks like a secret
  refuse("invalid_candidate", { author: "" });
  refuse("invalid_candidate", { author: "  " });
  refuse("invalid_candidate", { rationale: "" });
  refuse("candidate_not_narrow", { prompt: "a\nb\nc\nd\ne\nf", max_changed_lines: 4 });
  assert.doesNotThrow(() => cand({ prompt: "a\nb\nc", max_changed_lines: 5 })); // 2 removed + 3 added = 5
  refuse("candidate_not_narrow", { prompt: "a\nb\nc", max_changed_lines: 4 });
});

test("findings render with ids, catalog sentences and turns, and no conversation text", () => {
  const { pack, baseline } = fixture();
  const findings = discoverFailures({ pack, baseline, min_recurring_cases: 1 });
  const md = renderFindings(findings, pack);
  assert.match(md, /says_shipped/);
  assert.ok(md.includes(pack.check_catalog.says_shipped));
  assert.match(md, /D-1 \(turn 1\)/);
  assert.match(md, /3 of 4/);
  assert.ok(!md.includes("HELDOUT"));
  assert.ok(!md.includes("Where is my order"));
  assert.match(renderFindings([], pack), /No check/);
});
