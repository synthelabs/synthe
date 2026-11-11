import assert from "node:assert/strict";
import { test } from "node:test";
import { assertEgressSafe, egressProblems, sensitiveIndex, words } from "../src/pilot/egress.ts";
import { PilotError } from "../src/pilot/errors.ts";
import { BASELINE_PROMPT, CANARY_ORDER, CANARY_SENTENCE, CANARY_TOOL_ARG, makeCase, makePack } from "./pilot-review-helpers.ts";

// Three cases: c1 holds the planted customer text; all three share the agent's and the tool's boilerplate.
const index = sensitiveIndex([makePack()]);
const flagged = (text: string, i = index) => egressProblems(text, i).length > 0;

test("a body quoting a customer's words is blocked, and the error does not repeat them", () => {
  const quote = "arrived with a cracked buckle";
  const text = `Case notes: customer wrote "${quote}" and was upset.`;
  assert.ok(egressProblems(text, index).some((p) => /wording copied from pack conversations \(\d+ matches\)/.test(p)));
  assert.throws(() => assertEgressSafe(text, index, "pull request body"), (e: unknown) => {
    assert.ok(e instanceof PilotError);
    assert.equal(e.code, "egress_blocked");
    assert.match(e.message, /pull request body/);
    assert.ok(!e.message.toLowerCase().includes("cracked") && !e.message.toLowerCase().includes("buckle"), "the error must not quote the match");
    return true;
  });
});

test("a short quote, a single distinctive word and a name are caught, not only long runs", () => {
  assert.ok(flagged("nobody answered my"), "three words");
  assert.ok(flagged("Mention crampons in the reply."), "one distinctive word");
  const pack = makePack();
  pack.cases[1].messages[0] = { role: "user", text: "This is Thaddeus Quillfeather. Biscuit chewed my good boots." };
  const named = sensitiveIndex([pack]);
  assert.ok(flagged("Thanks, Thaddeus.", named));
  assert.ok(flagged("the Quillfeather case", named));
  assert.ok(flagged("Biscuit chewed my good boots", named));
  // Short common words alone are not content.
  assert.ok(!flagged("with a my and the", named));
});

test("matching survives case, spacing, punctuation, accents, dash variants and hidden characters", () => {
  assert.ok(flagged("MY   Crampons\nARRIVED... with a (cracked) buckle"));
  const zeroWidth = CANARY_SENTENCE.split(" ").map((w) => `${w.slice(0, 2)}​${w.slice(2)}`).join(" ");
  assert.notEqual(zeroWidth, CANARY_SENTENCE);
  assert.ok(flagged(zeroWidth), "zero-width characters inside words");
  assert.ok(flagged(CANARY_ORDER.replaceAll("-", "‑")), "non-breaking hyphens");
  assert.ok(flagged(CANARY_ORDER.replaceAll("-", "–")), "en dashes");
  assert.ok(flagged("crámpons"), "added accents");
  assert.ok(flagged("ｃｒａｍｐｏｎｓ"), "full-width letters");
  assert.deepEqual(words("ORD‑7Q4Z, Crámpons!"), ["ord", "7q4z", "crampons"]);
});

test("an identifier from a tool call input or a tool result is blocked, and so is a tool input field name", () => {
  assert.match(egressProblems(`see ${CANARY_ORDER}`, index).join(" "), /word or identifier that appears only in particular pack conversations \(\d+ matches\)/);
  assert.match(egressProblems(`value ${CANARY_TOOL_ARG}`, index).join(" "), /identifier/);
  assert.ok(!egressProblems(`see ${CANARY_ORDER}`, index).join(" ").includes(CANARY_ORDER));
  const pack = makePack();
  pack.cases[0].messages[1] = { role: "assistant", text: "Let me look.", tool_calls: [{ id: "t1", name: "lookup_order", input: { order: "ORD-X", passport_number_field: "x" } }] };
  assert.ok(flagged("passport_number_field", sensitiveIndex([pack])));
});

test("wording that many conversations share is the agent's own boilerplate, not customer content", () => {
  // The agent's stock replies and the tool's stock phrasing are in every case.
  assert.deepEqual(egressProblems("I am sorry about that, let me look.", index), []);
  assert.deepEqual(egressProblems("shipped on a Tuesday afternoon", index), []);
  // In a pack of 200 cases, something in three cases is still particular to them.
  const many = makePack(Array.from({ length: 200 }, (_, i) => makeCase(`k${i}`, "discovery", i < 3 ? { messages: [{ role: "user", text: "the harbour ferry was cancelled" }, { role: "assistant", text: "Sorry about that." }] } : {})));
  assert.ok(flagged("harbour ferry was cancelled", sensitiveIndex([many])));
});

test("the same case in two pack versions counts once", () => {
  const v1 = makePack();
  const v2 = { ...makePack(), pack_version: 2 };
  assert.ok(flagged("crampons", sensitiveIndex([v1, v2])), "one case's words stay particular however many versions hold the case");
});

test("an email is blocked even with no index", () => {
  const problems = egressProblems("write to someone@example.com", null);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /contains what looks like an email address/);
  assert.ok(!problems[0].includes("someone@example.com"));
  assert.throws(() => assertEgressSafe("write to someone@example.com", null, "title"), (e: unknown) => e instanceof PilotError && e.code === "egress_blocked");
});

test("text that may leave is allowed: the baseline prompt, and what reports print by design", () => {
  const pack = makePack();
  pack.cases[0].messages.push({ role: "user", text: "Be warm and brief and never promise a refund without checking" }, { role: "assistant", text: "Understood." });
  const plain = sensitiveIndex([pack]);
  const text = "Be warm and brief. Never promise a refund without checking the order first.";
  assert.ok(flagged(text, plain), "the wording is in one conversation, so it is flagged without allow");
  const allowed = sensitiveIndex([pack], [BASELINE_PROMPT]);
  assert.deepEqual(egressProblems(text, allowed), []);
  // Allowing the prompt does not unblock other pack text.
  assert.ok(flagged(CANARY_SENTENCE, allowed));
  // Case ids, check ids, catalog sentences and tool names are printed in every report.
  assert.deepEqual(egressProblems("case c1, turn 1, check looks_up_order: The agent looks up the order before answering a question about it. Tool lookup_order.", plain), []);
});

test("clean report text passes", () => {
  assert.deepEqual(egressProblems("Case c1, turn 1, check looks_up_order: 2 fixes and 0 regressions.", index), []);
  assert.doesNotThrow(() => assertEgressSafe("Synthe pilot fernhill-pilot: candidate 0123456789ab", index, "title"));
});

test("both kinds are reported once each", () => {
  const problems = egressProblems(`${CANARY_SENTENCE} ${CANARY_ORDER} ${CANARY_TOOL_ARG}`, index);
  assert.equal(problems.length, 2);
});
