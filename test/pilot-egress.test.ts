import assert from "node:assert/strict";
import { test } from "node:test";
import { assertEgressSafe, egressProblems, rendered, sensitiveIndex, words } from "../src/pilot/egress.ts";
import { PilotError } from "../src/pilot/errors.ts";
import { BASELINE_PROMPT, CANARY_ORDER, CANARY_SENTENCE, CANARY_TOOL_ARG, makeCase, makePack } from "./pilot-review-helpers.ts";

// Three cases: c1 holds the planted customer text; all three share the agent's and the tool's boilerplate.
const index = sensitiveIndex([makePack()]);
const flagged = (text: string, i = index) => egressProblems(text, i).length > 0;

test("a body quoting a customer's words is blocked, and the error does not repeat them", () => {
  const quote = "arrived with a cracked buckle";
  const text = `Case notes: customer wrote "${quote}" and was upset.`;
  assert.ok(egressProblems(text, index).some((p) => /wording copied from pack conversations \(\d+ matches; line 1\)/.test(p)));
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
  // A run of short everyday words is still the customer's sentence: no single word in it would be caught.
  pack.cases[1].messages[0] = { role: "user", text: "Well, the dog ate my left shoe last week." };
  const plain = sensitiveIndex([pack]);
  assert.ok(flagged("it said: ate my left", plain), "three short words in a row");
  assert.ok(!flagged("my left", plain) && !flagged("ate the shoe", plain), "two words, or the words out of order, are not a quote");
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
  assert.match(egressProblems(`see ${CANARY_ORDER}`, index).join(" "), /name, identifier or word that belongs to particular pack conversations \(\d+ matches; line 1\)/);
  assert.match(egressProblems(`value ${CANARY_TOOL_ARG}`, index).join(" "), /identifier/);
  assert.ok(!egressProblems(`see ${CANARY_ORDER}`, index).join(" ").includes(CANARY_ORDER));
  const pack = makePack();
  pack.cases[0].messages[1] = { role: "assistant", text: "Let me look.", tool_calls: [{ id: "t1", name: "lookup_order", input: { order: "ORD-X", passport_number_field: "x" } }] };
  assert.ok(flagged("passport_number_field", sensitiveIndex([pack])));
});

test("wording that many conversations share is the agent's own boilerplate, not customer content", () => {
  // The agent's stock replies and the tool's stock phrasing are in every case.
  assert.deepEqual(egressProblems("I am sorry about that, let me look.", index), []);
  assert.deepEqual(egressProblems("shipped on an afternoon", index), []);
  // A word the conversations only write with a capital may be a name, so it is flagged even when every case has it.
  assert.ok(flagged("shipped on a Tuesday afternoon", index));
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

test("an identifier the reports print passes only as a whole: it does not make its words allowed", () => {
  const pack = makePack([
    makeCase("ret-okonkwo-07", "discovery", { messages: [{ role: "user", text: "This is Mrs Okonkwo about the stove." }, { role: "assistant", text: "Let me look." }] }),
    makeCase("c2", "discovery"), makeCase("h1", "heldout"),
  ]);
  pack.check_catalog.looks_up_order = "The agent checks the Okonkwo account before answering.";
  pack.tools[0].description = "Find the order of a customer such as Okonkwo.";
  const frame = "Fixes: case ret-okonkwo-07, turn 1, check looks_up_order: The agent checks the Okonkwo account before answering.";
  const i = sensitiveIndex([pack], [BASELINE_PROMPT, frame]);
  assert.deepEqual(egressProblems(frame, i), [], "the generated wording itself passes");
  assert.deepEqual(egressProblems("It fails in case ret-okonkwo-07 on check looks_up_order.", i), [], "whole identifiers pass in free text too");
  assert.ok(flagged("Mrs Okonkwo was promised a refund.", i), "the name is not allowed by the case id, the catalog or the tool description");
  assert.ok(flagged("see ret-okonkwo-07b", i), "a longer token that starts with an identifier is not the identifier");
  assert.ok(flagged("case ret-okonkwo", i), "part of an identifier is not the identifier");
});

test("a name is caught however many conversations it is in, with look-alike letters, and when it is short", () => {
  const repeat = (id: string) => makeCase(id, "discovery", { messages: [
    { role: "user", text: "Hello, this is Philippa Wraxall-Thorne of 14 Larkspur Mews again. Please call Zoe Fong or ask for Hope Carey. My ticket is TKT-4471." },
    { role: "assistant", text: "Let me look.", tool_calls: [{ id: "t1", name: "lookup_order", input: { customer: "Philippa Wraxall-Thorne" } }] },
    { role: "tool", tool_call_id: "t1", name: "lookup_order", result: "Account of Thaddeus Quillfeather, order ORD-REPEAT-88 shipped" },
    { role: "assistant", text: "Your order shipped." },
  ] });
  const i = sensitiveIndex([makePack([repeat("r1"), repeat("r2"), repeat("r3"), repeat("r4"), makeCase("c2", "discovery"), makeCase("h1", "heldout")])]);
  for (const leak of ["Philippa", "Wraxall", "the Thorne account", "at Larkspur Mews", "Call Zoe Fong today.", "ask Fong", "Quillfeather"]) assert.ok(flagged(leak, i), leak);
  // Cyrillic and Greek letters that look like Latin ones are read as the Latin ones, and a word that mixes
  // alphabets is refused on its own.
  assert.ok(flagged("Тhaddeus Quіllfeather", i), "Cyrillic look-alikes");
  // A name written wholly in look-alike letters is not a mixed word, so only reading the letters as Latin finds it.
  assert.deepEqual(egressProblems("Норе", null), []);
  assert.ok(flagged("ask Норе", i), "a whole word in Cyrillic look-alikes");
  assert.ok(flagged("ticket 4471", i), "a token with a digit, in four conversations");
  assert.ok(flagged("the Philippa account", i), "a name at the start of a tool input");
  assert.ok(egressProblems("Тhaddeus", null).some((p) => /mixes alphabets/.test(p)));
  assert.deepEqual(egressProblems("Привет, мир. Καλημέρα.", null), [], "text wholly in another alphabet is not a mixed word");
  // The first word of a sentence has a capital whatever it is; so do the words other conversations write in lowercase.
  assert.ok(!flagged("your order", i) && !flagged("hello again, please look", i));
  // A redaction placeholder is not a name.
  assert.ok(!flagged("ask for the email address", i));
});

test("clean report text passes", () => {
  assert.deepEqual(egressProblems("Case c1, turn 1, check looks_up_order: 2 fixes and 0 regressions.", index), []);
  assert.doesNotThrow(() => assertEgressSafe("Synthe pilot fernhill-pilot: candidate 0123456789ab", index, "title"));
});

test("both kinds are reported once each", () => {
  const problems = egressProblems(`${CANARY_SENTENCE} ${CANARY_ORDER} ${CANARY_TOOL_ARG}`, index);
  assert.equal(problems.length, 2);
});

test("a name cut up by markup, spaces or hyphens is still found, and ordinary split words are not", () => {
  const pack = makePack();
  pack.cases[1].messages[0] = { role: "user", text: "This is Thaddeus Quillfeather, ticket TKT-48213. I may be late, maybe." };
  const i = sensitiveIndex([pack]);
  for (const [why, text] of [
    ["character references", "Greet Th&#97;ddeus Quillf&#x65;ather warmly."],
    ["an accent written as a reference", "Greet Thadd&eacute;us."],
    ["an invisible reference inside the word", "Greet Thad&shy;deus."],
    ["empty tags inside words", "Greet Thad<b></b>deus Quill<!-- x -->feather warmly."],
    ["a link around part of the word", "Greet [Thad](https://example.invalid/x)deus."],
    ["emphasis inside words", "Greet Thad**deus** Quill*feather* warmly."],
    ["spaced letters", "Greet T h a d d e u s."],
    ["a hyphen split", "Greet Thad-deus Quill-feather."],
    ["Latin small capitals", "Greet ᴛʜᴀᴅᴅᴇᴜꜱ warmly."],
    ["percent escapes", "See https://x.example/?n=Thadd%65us%20Quillf%65ather"],
    ["a token whose digits are written as references", "Ticket TKT-482&#49;3."],
    ["a token split by a tag", "Ticket TKT-48<i></i>213."],
  ] as const) assert.ok(flagged(text, i), why);
  assert.equal(rendered("Th&#97;d<b></b>d&eacute;us%21"), "Thaddeus!");
  // Only names are looked for across words: "may be" is not the customer's "maybe", and plain markup is not content.
  assert.deepEqual(egressProblems("It may be slower. Use <instructions> tags and **bold** text, 100% of the time.", i), []);
  // A mixed-alphabet word hidden behind a reference is still a mixed-alphabet word.
  assert.ok(egressProblems("Th&#1072;ddeus", null).some((p) => /mixes alphabets/.test(p)));
});
