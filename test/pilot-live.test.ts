import assert from "node:assert/strict";
import { test } from "node:test";
import { PilotError } from "../src/pilot/errors.ts";
import { CALL_TIMEOUT_MS, liveModel } from "../src/pilot/live.ts";
import type { ChatRequest, ProviderApproval } from "../src/pilot/types.ts";

// The live path is proven against a stand-in transport. No request leaves the test process.
const ENDPOINT = "http://127.0.0.1:9/pilot-provider";
const approval: ProviderApproval = {
  provider: "anthropic", endpoint: ENDPOINT, model: "approved-model", key_env: "FERNHILL_PILOT_KEY", data_class: "redacted support conversations (pack)",
  approved_by: "Rhea Castellan", approved_at: "2026-10-01T00:00:00Z", max_calls: 3, max_input_chars: 100_000,
};
const optIn = { live: true, endpoint: ENDPOINT, data_class: "redacted support conversations (pack)" };
const KEY = "test-key-value-not-real";

interface Seen { url: string; headers: Headers; body: Record<string, any> }
function transport(replies: { status?: number; body: unknown }[]) {
  const seen: Seen[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const next = replies.shift() ?? { status: 500, body: { type: "error", error: { type: "api_error", message: "no reply scripted" } } };
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetcher, seen };
}
const message = (content: unknown[], stop: string) => ({ body: { id: "msg_1", type: "message", role: "assistant", model: "approved-model", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } } });
const request = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  purpose: "replay", model: "approved-model", system: "You are Juniper.", max_tokens: 300, temperature: null,
  tools: [{ name: "lookup_order", description: "Look up an order.", input_schema: { type: "object", properties: { order_id: { type: "string" } } } }],
  messages: [{ role: "user", text: "Where is ORD-7Q4Z?" }], ...over,
});
const codeOf = async (fn: () => unknown): Promise<string> => {
  try { await fn(); } catch (e) { return e instanceof PilotError ? e.code : `not a PilotError: ${(e as Error).message}`; }
  return "no error";
};

test("no live model without every part of the opt-in, and nothing is sent when it is refused", async () => {
  const t = transport([]);
  const said: string[] = [];
  const say = (line: string) => said.push(line);
  const env = { FERNHILL_PILOT_KEY: KEY };
  assert.equal(await codeOf(() => liveModel(approval, { ...optIn, live: false }, env, say, t.fetcher)), "live_not_approved");
  assert.equal(await codeOf(() => liveModel(null, optIn, env, say, t.fetcher)), "live_not_approved");
  assert.equal(await codeOf(() => liveModel(approval, { ...optIn, endpoint: "https://api.anthropic.com" }, env, say, t.fetcher)), "live_not_approved");
  assert.equal(await codeOf(() => liveModel(approval, { ...optIn, endpoint: undefined }, env, say, t.fetcher)), "live_not_approved");
  assert.equal(await codeOf(() => liveModel(approval, { ...optIn, data_class: "everything" }, env, say, t.fetcher)), "live_not_approved");
  assert.equal(t.seen.length, 0);
  assert.deepEqual(said, [], "nothing is announced for a run that never starts");
});

test("the key comes only from the variable the approval names: no fallback to any other credential", async () => {
  const t = transport([]);
  const others = { ANTHROPIC_API_KEY: "other-1", SYNTHE_ANTHROPIC_KEY: "other-2", SYNTHE_EVENT_CODE: "crimson-demo-event", ANTHROPIC_AUTH_TOKEN: "other-3" };
  assert.equal(await codeOf(() => liveModel(approval, optIn, others, () => {}, t.fetcher)), "live_not_approved");
  assert.equal(await codeOf(() => liveModel(approval, optIn, { ...others, FERNHILL_PILOT_KEY: "   " }, () => {}, t.fetcher)), "live_not_approved");
  assert.equal(t.seen.length, 0);
});

test("the destination and data class are announced before the first request, which goes only to the approved endpoint", async () => {
  const t = transport([message([{ type: "text", text: "It was delivered." }], "end_turn")]);
  const said: string[] = [];
  const model = liveModel(approval, optIn, { FERNHILL_PILOT_KEY: KEY, ANTHROPIC_API_KEY: "must-not-be-used", ANTHROPIC_AUTH_TOKEN: "must-not-be-used-either" }, (line) => said.push(line), t.fetcher);
  assert.equal(t.seen.length, 0, "building the model sends nothing");
  assert.match(said.join("\n"), /Sending "redacted support conversations \(pack\)" to anthropic at http:\/\/127\.0\.0\.1:9\/pilot-provider \(model approved-model\)/);
  assert.match(said.join("\n"), /Approved by Rhea Castellan .* 3 calls, 100000 characters/);
  assert.ok(!said.join("\n").includes(KEY), "the key is never printed");
  assert.equal(model.destination, `anthropic:${ENDPOINT}:approved-model`);

  const reply = await model.chat(request());
  assert.deepEqual([reply.text, reply.stop, reply.tool_calls], ["It was delivered.", "end", []]);
  assert.equal(t.seen.length, 1);
  assert.ok(t.seen[0].url.startsWith(`${ENDPOINT}/v1/messages`), t.seen[0].url);
  // This SDK sends an API key as a bearer header. Nothing else from the environment may replace or join it.
  assert.equal(t.seen[0].headers.get("authorization"), `Bearer ${KEY}`);
  assert.ok(![...t.seen[0].headers.values()].some((v) => v.includes("must-not-be-used")), "no second credential is attached");
  const body = t.seen[0].body;
  assert.equal(body.model, "approved-model");
  assert.equal(body.system, "You are Juniper.");
  assert.equal(body.max_tokens, 300);
  assert.ok(!("temperature" in body), "no sampling parameter unless the pilot config sets one");
  assert.ok(!("fallbacks" in body), "no fallback model: a reply from another model would break the matched comparison");
  assert.deepEqual(body.tools.map((x: { name: string }) => x.name), ["lookup_order"]);
  assert.deepEqual(body.messages, [{ role: "user", content: "Where is ORD-7Q4Z?" }]);
});

test("a tool request is returned as data, and the recorded result goes back with the assistant turn unchanged", async () => {
  const thinking = { type: "thinking", thinking: "", signature: "sig-abc" };
  const toolUse = { type: "tool_use", id: "toolu_01", name: "lookup_order", input: { order_id: "ORD-7Q4Z" } };
  const t = transport([message([thinking, toolUse], "tool_use"), message([{ type: "text", text: "Delivered." }], "end_turn")]);
  const model = liveModel(approval, optIn, { FERNHILL_PILOT_KEY: KEY }, () => {}, t.fetcher);
  const first = await model.chat(request());
  assert.equal(first.stop, "tool_use");
  assert.deepEqual(first.tool_calls, [{ id: "toolu_01", name: "lookup_order", input: { order_id: "ORD-7Q4Z" } }]);
  const second = await model.chat(request({ messages: [
    { role: "user", text: "Where is ORD-7Q4Z?" },
    { role: "assistant", text: first.text, tool_calls: first.tool_calls },
    { role: "tool", tool_call_id: "toolu_01", name: "lookup_order", result: "Order ORD-7Q4Z: delivered." },
  ] }));
  assert.equal(second.text, "Delivered.");
  const sent = t.seen[1].body.messages;
  assert.deepEqual(sent[1], { role: "assistant", content: [thinking, toolUse] }, "the assistant turn is repeated exactly as the provider returned it");
  assert.deepEqual(sent[2], { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "Order ORD-7Q4Z: delivered." }] });
});

test("recorded history is sent as tool_use and tool_result blocks, with results of one turn in one message", async () => {
  const t = transport([message([{ type: "text", text: "ok" }], "end_turn")]);
  const model = liveModel(approval, optIn, { FERNHILL_PILOT_KEY: KEY }, () => {}, t.fetcher);
  await model.chat(request({ temperature: 0.2, messages: [
    { role: "user", text: "Return ORD-1" },
    { role: "assistant", text: "", tool_calls: [{ id: "case 1/a", name: "lookup_order", input: { order_id: "ORD-1" } }, { id: "case 1/b", name: "lookup_order", input: { order_id: "ORD-2" } }] },
    { role: "tool", tool_call_id: "case 1/a", name: "lookup_order", result: "one" },
    { role: "tool", tool_call_id: "case 1/b", name: "lookup_order", result: "two", is_error: true },
    { role: "assistant", text: "Both found.", tool_calls: [] },
    { role: "user", text: "Thanks" },
  ] }));
  const body = t.seen[0].body;
  assert.equal(body.temperature, 0.2);
  assert.deepEqual(body.messages[1].content.map((b: { type: string; id: string }) => [b.type, b.id]), [["tool_use", "case_1_a"], ["tool_use", "case_1_b"]]);
  assert.deepEqual(body.messages[2], { role: "user", content: [
    { type: "tool_result", tool_use_id: "case_1_a", content: "one" }, { type: "tool_result", tool_use_id: "case_1_b", content: "two", is_error: true },
  ] });
  assert.deepEqual(body.messages[3], { role: "assistant", content: [{ type: "text", text: "Both found." }] });
});

test("a refusal or a cut-off reply is reported as such, not as an answer", async () => {
  const t = transport([message([], "refusal"), message([{ type: "text", text: "partial" }], "max_tokens"), message([{ type: "text", text: "x" }], "pause_turn")]);
  const model = liveModel(approval, optIn, { FERNHILL_PILOT_KEY: KEY }, () => {}, t.fetcher);
  assert.equal((await model.chat(request())).stop, "refusal");
  assert.equal((await model.chat(request())).stop, "max_tokens");
  assert.equal((await model.chat(request())).stop, "other");
});

test("the approved limits stop a run, a different model is refused, and a rejected key ends the run", async () => {
  const ok = () => message([{ type: "text", text: "ok" }], "end_turn");
  const t = transport([ok(), ok(), ok(), ok()]);
  const model = liveModel(approval, optIn, { FERNHILL_PILOT_KEY: KEY }, () => {}, t.fetcher);
  assert.equal(await codeOf(() => model.chat(request({ model: "another-model" }))), "live_not_approved");
  for (let i = 0; i < 2; i++) await model.chat(request());
  assert.equal(await codeOf(() => model.chat(request())), "budget_exceeded", "the wrong-model attempt counted as a call, so the third real call is the fourth");
  assert.equal(t.seen.length, 2);

  const denied = transport([{ status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } }]);
  const rejected = liveModel(approval, optIn, { FERNHILL_PILOT_KEY: KEY }, () => {}, denied.fetcher);
  assert.equal(await codeOf(() => rejected.chat(request())), "live_not_approved");
});

test("settings in the shell cannot add headers, turn on logging, or make the SDK resend a request", async () => {
  const saved = { ...process.env };
  process.env.ANTHROPIC_CUSTOM_HEADERS = "X-Injected: from-the-shell\nx-api-key: a-second-credential";
  process.env.ANTHROPIC_LOG = "debug";
  process.env.ANTHROPIC_BASE_URL = "https://gateway.example.com";
  const printed: string[] = [];
  const realLog = console.log, realDebug = console.debug, realInfo = console.info, realWarn = console.warn;
  console.log = console.debug = console.info = console.warn = (...a: unknown[]) => { printed.push(a.map(String).join(" ")); };
  try {
    const t = transport([{ status: 529, body: { type: "error", error: { type: "overloaded_error", message: "CANARY-PROVIDER-ECHO You are Juniper. Where is ORD-7Q4Z?" } } }]);
    const model = liveModel(approval, optIn, { FERNHILL_PILOT_KEY: KEY }, () => {}, t.fetcher);
    assert.equal(process.env.ANTHROPIC_CUSTOM_HEADERS, "X-Injected: from-the-shell\nx-api-key: a-second-credential", "the shell's own setting is left as it was");
    let message = "";
    try { await model.chat(request()); } catch (e) { message = (e as Error).message; }
    assert.equal(t.seen.length, 1, "one counted call is one request: the SDK does not retry behind the limit");
    assert.equal(t.seen[0].headers.get("x-injected"), null);
    assert.equal(t.seen[0].headers.get("x-api-key"), null);
    assert.ok(t.seen[0].url.startsWith(ENDPOINT));
    assert.match(message, /^The provider request failed \(HTTP 529, \w+\)\.$/, "status and error class only");
    assert.ok(!message.includes("CANARY-PROVIDER-ECHO") && !message.includes("Juniper"), "the provider's echo of the request is not passed on");
    assert.deepEqual(printed.filter((l) => l.includes("Juniper") || l.includes("ORD-7Q4Z")), [], "nothing about the request was logged");
  } finally {
    console.log = realLog; console.debug = realDebug; console.info = realInfo; console.warn = realWarn;
    process.env = saved;
  }
});

test("a provider that never answers is given up on after the time limit, and the call is not sent again", async () => {
  let sent = 0;
  const pending: ((e: Error) => void)[] = [];
  // Never answers; ends only when the client gives up and aborts the request, or when the test lets go of it.
  const stalled = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    sent++;
    pending.push(reject);
    init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  })) as typeof fetch;
  const model = liveModel(approval, optIn, { FERNHILL_PILOT_KEY: KEY }, () => {}, stalled, 50);
  let timer: NodeJS.Timeout | undefined;
  try {
    const outcome = await Promise.race([
      model.chat(request()).then(() => "answered", (e: unknown) => (e as Error).message),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve("still waiting after 3 seconds"), 3000); }),
    ]);
    assert.match(outcome, /^The provider request failed \(no response, \w+\)\.$/);
    assert.equal(sent, 1, "a timed-out call is not retried");
    assert.ok(CALL_TIMEOUT_MS <= 120_000, "the default limit for one call is two minutes or less");
  } finally {
    clearTimeout(timer);
    for (const reject of pending) reject(new Error("test over"));
  }
});
