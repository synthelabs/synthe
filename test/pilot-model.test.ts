import assert from "node:assert/strict";
import { test } from "node:test";
import { PilotError } from "../src/pilot/errors.ts";
import { bounded, modelProposer, parseModelScript, parseProposerScript, scriptedModel, scriptedProposer, type ModelScript } from "../src/pilot/model.ts";
import type { ChatMessage, ChatModel, ChatRequest, FailureFinding, ProposerContext } from "../src/pilot/types.ts";

const request = (system: string, messages: ChatMessage[]): ChatRequest => ({ purpose: "replay", model: "sim", system, messages, tools: [], max_tokens: 100, temperature: null });
const codeOf = async (fn: () => unknown): Promise<string> => {
  try { await fn(); } catch (e) { return e instanceof PilotError ? e.code : `not a PilotError: ${(e as Error).message}`; }
  return "no error";
};

const SCRIPT: ModelScript = {
  version: 1, name: "sim", fallback: "What is your order number?",
  rules: [
    { when: { user_includes: ["return"], after_tool: null, never_called: ["lookup_order"] }, capture: { order: "(ORD-[A-Z0-9-]+)" }, reply: { tool: { name: "lookup_order", input: { order_id: "{order}" } } } },
    { when: { user_includes: ["return"], after_tool: "lookup_order", result_includes: ["eligible: yes"], system_includes: ["state the date"] }, capture_result: { date: "return by (\\d{4}-\\d{2}-\\d{2})" }, reply: { text: "Return by {date}." } },
    { when: { user_includes: ["return"], after_tool: "lookup_order" }, reply: { text: "It can be returned." } },
    { when: { user_includes: ["cut"] }, reply: { text: "This reply is cut", stop: "max_tokens" } },
  ],
};

test("the scripted agent answers from its rules, and a prompt phrase changes what it does", async () => {
  const model = scriptedModel(parseModelScript(JSON.stringify(SCRIPT)));
  assert.equal(model.destination, "scripted:sim");
  const first = await model.chat(request("Be brief.", [{ role: "user", text: "I want to return order ORD-7Q4Z" }]));
  assert.equal(first.stop, "tool_use");
  assert.deepEqual(first.tool_calls.map((c) => [c.name, c.input]), [["lookup_order", { order_id: "ORD-7Q4Z" }]]);
  const history: ChatMessage[] = [
    { role: "user", text: "I want to return order ORD-7Q4Z" },
    { role: "assistant", text: "", tool_calls: first.tool_calls },
    { role: "tool", tool_call_id: first.tool_calls[0].id, name: "lookup_order", result: "eligible: yes; return by 2026-10-28" },
  ];
  assert.equal((await model.chat(request("Be brief.", history))).text, "It can be returned.");
  assert.equal((await model.chat(request("Be brief. State the date.", history))).text, "Return by 2026-10-28.");
  assert.equal((await model.chat(request("Be brief.", [{ role: "user", text: "hello" }]))).text, "What is your order number?");
  assert.equal((await model.chat(request("Be brief.", [{ role: "user", text: "cut" }]))).stop, "max_tokens");
});

test("the scripted agent is deterministic: the same request gets the same reply", async () => {
  const model = scriptedModel(SCRIPT);
  const one = await model.chat(request("x", [{ role: "user", text: "return ORD-AB12 please" }]));
  const two = await model.chat(request("x", [{ role: "user", text: "return ORD-AB12 please" }]));
  assert.deepEqual([one.text, one.stop, one.tool_calls.map((c) => [c.name, c.input])], [two.text, two.stop, two.tool_calls.map((c) => [c.name, c.input])]);
});

test("a rule whose capture finds nothing does not match", async () => {
  const model = scriptedModel(SCRIPT);
  assert.equal((await model.chat(request("x", [{ role: "user", text: "I want to return something" }]))).text, "What is your order number?");
});

test("unusable script files are refused with a plain reason", async () => {
  assert.equal(await codeOf(() => parseModelScript("{")), "usage");
  assert.equal(await codeOf(() => parseModelScript(JSON.stringify({ ...SCRIPT, rules: [{ when: {}, reply: {} }] }))), "usage");
  assert.equal(await codeOf(() => parseModelScript(JSON.stringify({ ...SCRIPT, rules: [{ when: {}, capture: { a: "(" }, reply: { text: "x" } }] }))), "usage");
  assert.equal(await codeOf(() => parseProposerScript(JSON.stringify({ version: 1, name: "p", findings: { c: [{ rationale: "" , append: ["x"] }] } }))), "usage");
});

const finding: FailureFinding = { version: 1, pack_id: "p".repeat(64), baseline_prompt_id: "b".repeat(64), check_id: "states-return-deadline", description: "Tells the customer the return-by date.", failing: [{ case_id: "ret-d01", turn: 1 }], discovery_cases_with_check: 1 };
const context = (attempt: number): ProposerContext => ({
  baseline_prompt: "You are Juniper.\n- Check eligibility first.\n", finding, attempt, feedback: ["Blocking guard check x newly fails on case ret-d01 at turn 1."], max_changed_lines: 4,
  examples: [{ case_id: "ret-d01", turn: 1, messages: [{ role: "user", text: "DISCOVERY-TEXT I want to return ORD-AB12" }] }],
});

test("the scripted proposer applies the edit for the attempt, and says so when it has none left", async () => {
  const proposer = scriptedProposer(parseProposerScript(JSON.stringify({
    version: 1, name: "p", findings: { "states-return-deadline": [{ rationale: "first", append: ["- Line one."] }, { rationale: "second", replace: [{ find: "Check eligibility first.", with: "Check eligibility, then state the date." }] }] },
  })));
  assert.deepEqual(await proposer.propose(context(0)), { prompt: "You are Juniper.\n- Check eligibility first.\n- Line one.\n", rationale: "first" });
  assert.equal((await proposer.propose(context(1))).prompt, "You are Juniper.\n- Check eligibility, then state the date.\n");
  assert.equal(await codeOf(() => proposer.propose(context(2))), "not_found");
});

test("a model-backed proposer sends only what the context holds, and an off-format reply makes no candidate", async () => {
  const seen: ChatRequest[] = [];
  const reply = (text: string): ChatModel => ({ destination: "fake:model", async chat(r) { seen.push(r); return { text, tool_calls: [], stop: "end" }; } });
  const proposed = await modelProposer(reply("RATIONALE: say the date\nPROMPT:\nYou are Juniper.\n- State the date.\n"), "m", 500).propose(context(0));
  assert.deepEqual(proposed, { rationale: "say the date", prompt: "You are Juniper.\n- State the date.\n" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].purpose, "propose");
  const sent = JSON.stringify(seen[0]);
  assert.ok(sent.includes("DISCOVERY-TEXT") && sent.includes("Tells the customer the return-by date.") && sent.includes("newly fails on case ret-d01"));
  assert.equal(await codeOf(() => modelProposer(reply("Sure! Here is a prompt."), "m", 500).propose(context(0))), "invalid_candidate");
});

test("the call and character limits stop the request that would pass them, before it is sent", async () => {
  let sent = 0;
  const inner: ChatModel = { destination: "fake:model", async chat() { sent++; return { text: "ok", tool_calls: [], stop: "end" }; } };
  const byCalls = bounded(inner, { max_calls: 2, max_input_chars: 10_000 });
  await byCalls.chat(request("s", [{ role: "user", text: "one" }]));
  await byCalls.chat(request("s", [{ role: "user", text: "two" }]));
  assert.equal(await codeOf(() => byCalls.chat(request("s", [{ role: "user", text: "three" }]))), "budget_exceeded");
  assert.equal(sent, 2);
  assert.equal(byCalls.calls(), 2);
  const byChars = bounded(inner, { max_calls: 10, max_input_chars: 20 });
  assert.equal(await codeOf(() => byChars.chat(request("s".repeat(15), [{ role: "user", text: "more than five" }]))), "budget_exceeded");
  assert.equal(sent, 2, "nothing was sent for the refused request");
});
