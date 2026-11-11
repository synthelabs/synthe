import assert from "node:assert/strict";
import { test } from "node:test";
import { assertEgressSafe, egressProblems, sensitiveIndex } from "../src/pilot/egress.ts";
import { PilotError } from "../src/pilot/errors.ts";
import { BASELINE_PROMPT, CANARY_ORDER, CANARY_SENTENCE, CANARY_TOOL_ARG, makePack } from "./pilot-review-helpers.ts";

const index = sensitiveIndex([makePack()]);

test("a body quoting six words from a pack message is blocked, and the error does not repeat them", () => {
  const quote = "arrived with a cracked buckle and nobody";
  const text = `Case notes: customer wrote "${quote}" and was upset.`;
  assert.ok(egressProblems(text, index).some((p) => /wording copied from pack conversations \(\d+ matches\)/.test(p)));
  assert.throws(() => assertEgressSafe(text, index, "pull request body"), (e: unknown) => {
    assert.ok(e instanceof PilotError);
    assert.equal(e.code, "egress_blocked");
    assert.match(e.message, /pull request body/);
    assert.ok(!e.message.toLowerCase().includes("cracked buckle"), "the error must not quote the match");
    assert.ok(!e.message.includes(quote));
    return true;
  });
});

test("matching ignores case, spacing and punctuation", () => {
  const text = `MY   Crampons\nARRIVED with a cracked buckle...`;
  assert.equal(egressProblems(text, index).length, 1);
});

test("five copied words are not enough to flag", () => {
  assert.deepEqual(egressProblems("my crampons arrived with a", index), []);
});

test("an identifier from a tool call input or a tool result is blocked", () => {
  assert.match(egressProblems(`see ${CANARY_ORDER}`, index).join(" "), /identifier that appears in pack conversations \(1 matches\)/);
  assert.match(egressProblems(`value ${CANARY_TOOL_ARG}`, index).join(" "), /identifier/);
  assert.ok(!egressProblems(`see ${CANARY_ORDER}`, index).join(" ").includes(CANARY_ORDER));
});

test("an email is blocked even with no index", () => {
  const problems = egressProblems("write to someone@example.com", null);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /contains what looks like an email address/);
  assert.ok(!problems[0].includes("someone@example.com"));
  assert.throws(() => assertEgressSafe("write to someone@example.com", null, "title"), (e: unknown) => e instanceof PilotError && e.code === "egress_blocked");
});

test("text the baseline prompt already holds is allowed", () => {
  const pack = makePack();
  pack.cases[0].messages.push({ role: "user", text: "Be warm and brief and never promise a refund without checking" });
  const plain = sensitiveIndex([pack]);
  const text = "Be warm and brief. Never promise a refund without checking the order first.";
  assert.ok(egressProblems(text, plain).length > 0, "the wording is in the pack, so it is flagged without allow");
  const allowed = sensitiveIndex([pack], [BASELINE_PROMPT]);
  assert.deepEqual(egressProblems(text, allowed), []);
  // Allowing the prompt does not unblock other pack text.
  assert.ok(egressProblems(CANARY_SENTENCE, allowed).length > 0);
});

test("clean report text passes", () => {
  assert.deepEqual(egressProblems("Case c1, turn 1, check looks_up_order: 2 fixes and 0 regressions.", index), []);
  assert.doesNotThrow(() => assertEgressSafe("Synthe pilot fernhill-pilot: candidate 0123456789ab", index, "title"));
});

test("both kinds are reported once each", () => {
  const problems = egressProblems(`${CANARY_SENTENCE} ${CANARY_ORDER} ${CANARY_TOOL_ARG}`, index);
  assert.equal(problems.length, 2);
});
