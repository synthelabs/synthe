// Shared synthetic fixtures for the pilot replay tests. Everything here is fictional: "Fernhill Outfitters", its
// support agent "Juniper", and tokenised personal data only.
import type {
  ArmRun, CaseCheck, CaseRun, ChatMessage, ChatModel, ChatReply, ChatRequest, Pack, PackCase, PackMessage, ReplaySettings,
  Split, ToolCall, TurnStatus,
} from "../src/pilot/types.ts";

export const u = (text: string): PackMessage => ({ role: "user", text });
export const a = (text: string, tool_calls?: ToolCall[]): PackMessage => (tool_calls ? { role: "assistant", text, tool_calls } : { role: "assistant", text });
export const call = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({ id, name, input });
export const tr = (tool_call_id: string, name: string, result: string): PackMessage => ({ role: "tool", tool_call_id, name, result });

export const TOOLS = [
  { name: "lookup_order", description: "Look up an order by its id.", input_schema: { type: "object", properties: { order_id: { type: "string" } } } },
  { name: "check_return_eligibility", description: "Check whether an order can be returned.", input_schema: { type: "object", properties: { order_id: { type: "string" } } } },
  { name: "start_return", description: "Start a return.", input_schema: { type: "object", properties: { order_id: { type: "string" }, reason: { type: "string" } } } },
  { name: "escalate_to_human", description: "Hand the conversation to a person.", input_schema: { type: "object", properties: { reason: { type: "string" } } } },
];

export const SETTINGS: ReplaySettings = { model: "scripted-model", max_tokens: 512, temperature: 0, max_steps_per_turn: 4 };
export const GATE = { min_paired_cases: 2, min_paired_coverage: 0.5, min_net_wins: 1, max_unchecked_blocking_guards: 0 };
export const PACK_ID = "1".repeat(64);
export const BASE_ID = "a".repeat(64);
export const CAND_ID = "b".repeat(64);

export const CATALOG: Record<string, string> = {
  looks_up_order: "The agent looks up the order before talking about it.",
  checks_before_return: "The agent checks return eligibility before it starts a return.",
  offers_label: "The agent tells the customer a return label is coming.",
  no_promise_refund: "The agent does not promise a refund.",
  escalates_when_asked: "The agent hands over to a person when the customer asks.",
  says_shipped: "The agent says the order has shipped.",
  no_invented_policy: "The agent does not invent a return window.",
};

// A two-turn return conversation: look up the order, then check eligibility and start the return.
export function returnCase(id = "RET-001", split: Split = "discovery"): PackCase {
  return {
    id, split,
    provenance: { kind: "export", ref: `ticket-${id}`, added_in_pack_version: 1 },
    intent: "returns",
    messages: [
      u("Hi, I want to return order ORD-7Q4Z."),
      a("", [call("c1", "lookup_order", { order_id: "ORD-7Q4Z" })]),
      tr("c1", "lookup_order", '{"status":"delivered","days_since_delivery":12}'),
      a("Your order ORD-7Q4Z was delivered 12 days ago. Do you want me to start a return?"),
      u("Yes please."),
      a("", [call("c2", "check_return_eligibility", { order_id: "ORD-7Q4Z" })]),
      tr("c2", "check_return_eligibility", '{"eligible":true}'),
      a("", [call("c3", "start_return", { order_id: "ORD-7Q4Z", reason: "unwanted" })]),
      tr("c3", "start_return", '{"return_id":"RET-91"}'),
      a("Your return RET-91 is started. A label will go to [EMAIL_1]."),
    ],
    checks: [
      { id: "looks_up_order", turn: 1, role: "primary", kind: "calls_tool", tool: "lookup_order" },
      { id: "checks_before_return", turn: 2, role: "primary", kind: "tool_requires", tool: "start_return", after: "check_return_eligibility" },
      { id: "offers_label", turn: 2, role: "primary", kind: "reply_includes", any_of: ["label"] },
      { id: "no_promise_refund", turn: 2, role: "guard", blocking: true, kind: "reply_excludes", any_of: ["guaranteed refund"] },
    ],
    observed: { resolved: true, escalated: false },
  };
}

export function escalateCase(id = "ESC-001", split: Split = "discovery"): PackCase {
  return {
    id, split,
    provenance: { kind: "export", ref: `ticket-${id}`, added_in_pack_version: 1 },
    messages: [
      u("Please get me a person about ORD-2M8K."),
      a("", [call("e1", "escalate_to_human", { reason: "customer asked" })]),
      tr("e1", "escalate_to_human", '{"ticket":"ESC-4"}'),
      a("I have passed this to a person. Reference ESC-4."),
    ],
    checks: [
      { id: "escalates_when_asked", turn: 1, role: "primary", kind: "calls_tool", tool: "escalate_to_human" },
      { id: "no_promise_refund", turn: 1, role: "guard", blocking: true, kind: "reply_excludes", any_of: ["guaranteed refund"] },
    ],
    observed: { resolved: false, escalated: true },
  };
}

// Three turns: used to test that later turns are left unreached once an earlier turn stops.
export function threeTurnCase(id = "TRI-001", split: Split = "discovery"): PackCase {
  return {
    id, split,
    provenance: { kind: "export", ref: `ticket-${id}`, added_in_pack_version: 1 },
    messages: [
      u("Where is ORD-7Q4Z?"),
      a("", [call("t1", "lookup_order", { order_id: "ORD-7Q4Z" })]),
      tr("t1", "lookup_order", '{"status":"shipped"}'),
      a("Your order has shipped."),
      u("Can I return it?"),
      a("", [call("t2", "check_return_eligibility", { order_id: "ORD-7Q4Z" })]),
      tr("t2", "check_return_eligibility", '{"eligible":true}'),
      a("Yes, it can be returned. Shall I start it?"),
      u("Go ahead."),
      a("", [call("t3", "start_return", { order_id: "ORD-7Q4Z", reason: "unwanted" })]),
      tr("t3", "start_return", '{"return_id":"RET-92"}'),
      a("Done. A label is on its way."),
    ],
    checks: [
      { id: "says_shipped", turn: 1, role: "primary", kind: "reply_includes", any_of: ["shipped"] },
      { id: "checks_before_return", turn: 3, role: "primary", kind: "tool_requires", tool: "start_return", after: "check_return_eligibility" },
      { id: "offers_label", turn: 3, role: "primary", kind: "reply_includes", any_of: ["label"] },
    ],
  };
}

export function makePack(cases?: PackCase[]): Pack {
  return {
    version: 1,
    name: "Fernhill Outfitters support pack",
    pack_version: 1,
    parent_pack_id: null,
    source: {
      exported_by: "Fernhill data team",
      exported_at: "2026-10-01T00:00:00Z",
      redaction: { method: "token replacement, reviewed by hand", approved_by: "Fernhill privacy lead", approved_at: "2026-10-02T00:00:00Z" },
      approved_uses: ["replay"],
    },
    tools: structuredClone(TOOLS),
    check_catalog: { ...CATALOG },
    cases: cases ?? [returnCase(), escalateCase(), returnCase("HELDOUT-CANARY-07", "heldout")],
  };
}

// ---- Scripted models ------------------------------------------------------------------------------------------

export const text = (t: string): ChatReply => ({ text: t, tool_calls: [], stop: "end" });
export const toolUse = (...calls: ToolCall[]): ChatReply => ({ text: "", tool_calls: calls, stop: "tool_use" });

export interface Recorder extends ChatModel { requests: ChatRequest[] }

export function scripted(handler: (req: ChatRequest, n: number) => ChatReply | Promise<ChatReply>, destination = "scripted:test"): Recorder {
  const requests: ChatRequest[] = [];
  return {
    destination, requests,
    async chat(request: ChatRequest) {
      // Copy, so a later mutation by the code under test cannot rewrite what the model was shown.
      requests.push(structuredClone(request));
      return handler(request, requests.length);
    },
  };
}

const last = (m: ChatMessage[]): ChatMessage => m[m.length - 1];

// A model that repeats the recording of the return cases and the escalation case exactly.
export function faithfulModel(): Recorder {
  return scripted((req) => {
    const m = last(req.messages);
    if (m.role === "user") {
      if (m.text.startsWith("Hi, I want")) return toolUse(call("m1", "lookup_order", { order_id: "ORD-7Q4Z" }));
      if (m.text === "Yes please.") return toolUse(call("m2", "check_return_eligibility", { order_id: "ORD-7Q4Z" }));
      if (m.text.startsWith("Please get me")) return toolUse(call("m3", "escalate_to_human", { reason: "customer asked" }));
    }
    if (m.role === "tool") {
      if (m.name === "lookup_order") return text("Your order ORD-7Q4Z was delivered 12 days ago. Do you want me to start a return?");
      if (m.name === "check_return_eligibility") return toolUse(call("m4", "start_return", { order_id: "ORD-7Q4Z", reason: "unwanted" }));
      if (m.name === "start_return") return text("Your return RET-91 is started. A label will go to [EMAIL_1].");
      if (m.name === "escalate_to_human") return text("I have passed this to a person. Reference ESC-4.");
    }
    return { text: "", tool_calls: [], stop: "other" };
  });
}

// ---- Hand-built arm runs, for pairing tests ---------------------------------------------------------------------

export function simpleCase(id: string, split: Split, checks: Array<Pick<CaseCheck, "id" | "role"> & { blocking?: boolean }>, observed?: PackCase["observed"]): PackCase {
  const c: PackCase = {
    id, split,
    provenance: { kind: "export", ref: `ticket-${id}`, added_in_pack_version: 1 },
    messages: [u("Where is my order?"), a("It is on its way.")],
    checks: checks.map((k) => ({ id: k.id, turn: 1, role: k.role, ...(k.blocking === undefined ? {} : { blocking: k.blocking }), kind: "reply_includes", any_of: ["way"] }) as CaseCheck),
  };
  if (observed) c.observed = observed;
  return c;
}

export interface FakeCase { status?: TurnStatus; passes: Array<boolean | null>; stopped?: CaseRun["stopped"] }

// One-turn cases only: results[case id] gives the status and the pass value of each check, in order.
export function fakeArm(pack: Pack, prompt_id: string, results: Record<string, FakeCase>, over: Partial<ArmRun> = {}): ArmRun {
  const cases: CaseRun[] = pack.cases.map((pc) => {
    const r = results[pc.id];
    const status = r.status ?? "scored";
    const stopped: CaseRun["stopped"] = r.stopped !== undefined ? r.stopped : status === "scored" ? null : { turn: 1, why: status === "unsupported" ? "unsupported" : "inconclusive", detail: "x" };
    return {
      case_id: pc.id, split: pc.split, stopped,
      turns: [{
        turn: 1, status, tools_requested: [], reply_sha256: status === "scored" ? "c".repeat(64) : null,
        checks: pc.checks.map((k, i) => ({ id: k.id, role: k.role, blocking: k.blocking === true, pass: r.passes[i] })),
      }],
    };
  });
  return { prompt_id, pack_id: PACK_ID, settings: SETTINGS, model_destination: "scripted:test", cases, model_calls: cases.length, ...over };
}
