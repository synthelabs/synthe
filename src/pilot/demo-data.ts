import { addDays, DAY_MS, ms } from "./ids.ts";
import type { ModelScript, ProposerScript } from "./model.ts";
import { TELEMETRY_FORMAT, type CaseCheck, type Pack, type PackCase, type PackMessage, type PromotionRequest, type Split } from "./types.ts";

// Everything the synthetic pilot runs on. All of it is invented: Fernhill Outfitters, its support agent Juniper,
// the people named here, the conversations and every number. Nothing comes from a real company or customer.
//
// The inputs are generated instead of committed as files so the telemetry tags can follow the candidate ids the
// run produces, and so nobody mistakes a large fixture for real data. `demo --out <dir>` writes them all to
// <dir>/inputs, where they can be read as examples of each input format.

export const DEMO = {
  pilot_id: "fernhill-juniper",
  slug: "fernhill/support-agent",
  base: "main",
  prompt_path: "prompts/juniper.md",
  baseline_tag: "juniper-v14",
  model: "juniper-sim",
  metric_owner: "Tomas Lindqvist (head of support, Fernhill)",
  redaction_owner: "Rhea Castellan (data protection, Fernhill)",
  quality_lead: "Imogen Hartley (support quality lead, Fernhill)",
  baseline_window: { start: "2026-10-01T00:00:00Z", days: 14 },
  experiment_b_start: "2026-10-19T00:00:00Z",
  experiment_c_start: "2026-10-27T00:00:00Z",
} as const;

// Synthetic sensitive strings. They stand for the things a redacted pack still holds because correctness depends
// on them (order tokens, the customer's own words). The privacy checks look for them in everything that leaves.
export const CANARIES = {
  discovery_order: "ORD-CANARY-D1SC",
  discovery_words: "the zipper pull snapped while I was packing for Glen Arrow",
  heldout_order: "ORD-CANARY-H3LD",
  heldout_words: "my neighbour's collie chewed straight through the left cuff",
};

export const BASELINE_PROMPT = `You are Juniper, the support assistant for Fernhill Outfitters.

Help customers with orders and returns. Be brief and friendly.

Rules:
- Look up the order before you answer a question about it.
- Returns are accepted inside the 30-day return window. Check return eligibility before you start a return.
- If you cannot help, hand the conversation to the support team.
`;

// The lines each candidate adds. The scripted agent keys its behaviour on these phrases.
const LINE_FAST = "- When a customer asks to return an item, start the return right away and give the return-by date.";
const LINE_DATE = "- After you check eligibility, tell the customer the return-by date.";
const LINE_NO_HANDOFF = "- If an order is past its return-by date, explain the 30-day policy. Do not hand the conversation to the support team for that alone.";

// The candidate a person writes after the first experiment is reverted.
export const HUMAN_CANDIDATE_PROMPT = `${BASELINE_PROMPT}${LINE_DATE}\n${LINE_NO_HANDOFF}\n`;

export function demoConfig(): Record<string, unknown> {
  return {
    version: 1,
    pilot_id: DEMO.pilot_id,
    agent: { name: "Juniper", prompt_path: DEMO.prompt_path, baseline_tag: DEMO.baseline_tag },
    repo: { slug: DEMO.slug, base: DEMO.base },
    metric: {
      version: 1,
      primary: { name: "resolved", kind: "rate", unit: "share of completed conversations resolved without a person", direction: "higher_is_better", min_effect: 0.03 },
      guards: [
        { name: "escalated", kind: "rate", unit: "share of completed conversations handed to a person", direction: "lower_is_better", max_harm: 0.02, critical: true, early_stop: { min_per_arm: 400 } },
        { name: "refund_usd", kind: "mean", unit: "USD refunded per completed conversation", direction: "lower_is_better", max_harm: 0.75, critical: false },
      ],
      denominator: "completed_conversations",
      randomization_unit: "conversation",
      alpha: 0.05,
      power: 0.8,
      min_samples_per_arm: 1000,
      analysis_window_days: 14,
      outcome_lag_days: 2,
      max_missing_rate: 0.02,
      max_unattributed_rate: 0.02,
      signed_off: { by: DEMO.metric_owner, at: "2026-09-29T15:00:00Z" },
    },
    replay: {
      model: DEMO.model, max_tokens: 800, temperature: null, max_steps_per_turn: 4,
      gate: { min_paired_cases: 10, min_paired_coverage: 0.7, min_net_wins: 3, max_unchecked_blocking_guards: 0 },
      min_recurring_cases: 3, max_changed_lines: 6,
    },
    provider: null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The scripted agent and proposer.
// ---------------------------------------------------------------------------------------------------------------

const FAST = "start the return right away";
const DATE = "tell the customer the return-by date";
const NO_HANDOFF = "do not hand the conversation to the support team for that alone";
const ORDER = { order: "(ORD-[A-Z0-9-]+)" };
const TEXT_ELIGIBLE = "Good news: this order can be returned. Do you want me to start the return?";
const TEXT_ELIGIBLE_DATE = "Good news: this order can be returned. Return by {date}. Do you want me to start the return?";
const TEXT_INELIGIBLE = "This order is outside the 30-day return window, so I cannot start a return for it. Is there anything else I can help with?";
const TEXT_STARTED = "Done. Your return is started and the label is on its way to you.";
const TEXT_DELIVERED = "Thanks for waiting. The order shows as delivered. Is there anything else I can help with?";
const TEXT_HANDOFF = "I have passed this to our support team. They will reply by email.";
const TEXT_BYE = "You're welcome. Have a good day.";

export function agentScript(): ModelScript {
  const lookup = { name: "lookup_order", input: { order_id: "{order}" } };
  const check = { name: "check_return_eligibility", input: { order_id: "{order}" } };
  const start = { name: "start_return", input: { order_id: "{order}" } };
  return {
    version: 1,
    name: "juniper-sim",
    fallback: "I can help with orders and returns. What is your order number?",
    rules: [
      // Order status.
      { when: { user_includes: ["where is"], after_tool: null }, capture: ORDER, reply: { tool: lookup } },
      { when: { user_includes: ["where is"], after_tool: "lookup_order" }, reply: { text: TEXT_DELIVERED } },
      // A customer past the return window asks for an exception.
      { when: { user_includes: ["exception"], after_tool: null }, capture: ORDER, reply: { tool: lookup } },
      { when: { user_includes: ["exception"], after_tool: "lookup_order" }, capture: ORDER, reply: { tool: check } },
      { when: { user_includes: ["exception"], after_tool: "check_return_eligibility", system_includes: [DATE], system_excludes: [NO_HANDOFF] }, reply: { tool: { name: "escalate_to_human", input: { reason: "late return exception request" } } } },
      { when: { user_includes: ["exception"], after_tool: "escalate_to_human" }, reply: { text: TEXT_HANDOFF } },
      { when: { user_includes: ["exception"], after_tool: "check_return_eligibility" }, reply: { text: TEXT_INELIGIBLE } },
      // A return request under the "start right away" prompt: it skips the eligibility check.
      { when: { system_includes: [FAST], user_includes: ["return"], after_tool: null, never_called: ["lookup_order"] }, capture: ORDER, reply: { tool: lookup } },
      { when: { system_includes: [FAST], user_includes: ["return"], after_tool: null, ever_called: ["lookup_order"] }, capture: ORDER, reply: { tool: start } },
      { when: { system_includes: [FAST], user_includes: ["return"], after_tool: "lookup_order" }, capture: ORDER, reply: { tool: start } },
      // A return request under every other prompt.
      { when: { user_includes: ["return"], after_tool: null, never_called: ["lookup_order"] }, capture: ORDER, reply: { tool: lookup } },
      { when: { user_includes: ["return"], after_tool: null, ever_called: ["lookup_order"] }, capture: ORDER, reply: { tool: check } },
      { when: { user_includes: ["return"], after_tool: "lookup_order" }, capture: ORDER, reply: { tool: check } },
      { when: { user_includes: ["return"], after_tool: "check_return_eligibility", result_includes: ["eligible: yes"], system_includes: [DATE] }, capture_result: { date: "return by (\\d{4}-\\d{2}-\\d{2})" }, reply: { text: TEXT_ELIGIBLE_DATE } },
      { when: { user_includes: ["return"], after_tool: "check_return_eligibility", result_includes: ["eligible: yes"] }, reply: { text: TEXT_ELIGIBLE } },
      { when: { user_includes: ["return"], after_tool: "check_return_eligibility", result_includes: ["eligible: no"] }, reply: { text: TEXT_INELIGIBLE } },
      // The customer confirms.
      { when: { user_includes: ["yes"], after_tool: null }, capture: ORDER, reply: { tool: start } },
      { when: { user_includes: ["yes"], after_tool: "start_return" }, reply: { text: TEXT_STARTED } },
      { when: { user_includes: ["thanks"] }, reply: { text: TEXT_BYE } },
    ],
  };
}

export function proposerScript(): ProposerScript {
  return {
    version: 1,
    name: "fernhill-proposer-sim",
    findings: {
      "states-return-deadline": [
        { rationale: "Customers who are told the return-by date up front do not need to contact support again to ask for it.", append: [LINE_FAST] },
        { rationale: "State the return-by date right after the eligibility check, and keep the eligibility check in place.", append: [LINE_DATE] },
      ],
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The conversation pack.
// ---------------------------------------------------------------------------------------------------------------

const CATALOG: Record<string, string> = {
  "looks-up-order": "Looks up the order before answering a question about it.",
  "states-return-deadline": "Tells the customer the return-by date when an order can be returned.",
  "confirms-return-started": "Confirms that the return was started.",
  "explains-ineligible": "Explains that the order is outside the 30-day return window.",
  "states-delivery-status": "States the delivery status of the order.",
  "eligibility-before-return": "Checks return eligibility before starting a return.",
  "no-return-when-ineligible": "Does not start a return for an order that is not eligible.",
  "no-handoff-for-late-return": "Does not hand a late return request to the support team when the policy answer is enough.",
};

const ITEMS = ["Trail Jacket", "Ridge Boots", "Summit Tent", "Creek Sandals", "Alpine Gloves", "Canyon Pack"];
const pad = (n: number) => String(n).padStart(2, "0");
const orderToken = (n: number) => `ORD-${(n * 7919 + 1297).toString(36).toUpperCase().padStart(4, "0").slice(-4)}`;

const user = (text: string): PackMessage => ({ role: "user", text });
const says = (text: string): PackMessage => ({ role: "assistant", text });
const calls = (id: string, name: string, input: Record<string, unknown>): PackMessage => ({ role: "assistant", text: "", tool_calls: [{ id, name, input }] });
const result = (id: string, name: string, text: string): PackMessage => ({ role: "tool", tool_call_id: id, name, result: text });

const primary = (id: string, turn: number, rule: Record<string, unknown>): CaseCheck => ({ id, turn, role: "primary", ...rule } as CaseCheck);
const guard = (id: string, turn: number, rule: Record<string, unknown>): CaseCheck => ({ id, turn, role: "guard", blocking: true, ...rule } as CaseCheck);
const LOOKS_UP = (turn: number) => primary("looks-up-order", turn, { kind: "calls_tool", tool: "lookup_order" });
const DEADLINE = (turn: number) => primary("states-return-deadline", turn, { kind: "reply_includes", any_of: ["return by"] });
const STARTED = (turn: number) => primary("confirms-return-started", turn, { kind: "reply_includes", any_of: ["return is started"] });
const INELIGIBLE = (turn: number) => primary("explains-ineligible", turn, { kind: "reply_includes", any_of: ["outside the 30-day"] });
const DELIVERED = (turn: number) => primary("states-delivery-status", turn, { kind: "reply_includes", any_of: ["delivered", "on its way"] });
const ELIGIBILITY_FIRST = (turn: number) => guard("eligibility-before-return", turn, { kind: "tool_requires", tool: "start_return", after: "check_return_eligibility" });
const NO_RETURN = (turn: number) => guard("no-return-when-ineligible", turn, { kind: "avoids_tool", tool: "start_return" });
const NO_ESCALATION = (turn: number) => guard("no-handoff-for-late-return", turn, { kind: "avoids_tool", tool: "escalate_to_human" });

interface Seed { id: string; split: Split; n: number; order?: string; extra?: string }
const lookupResult = (order: string, n: number) => `Order ${order}: ${ITEMS[n % ITEMS.length]}, delivered 2026-09-${pad(10 + (n % 18))}, total ${89 + (n % 7) * 10}.00 USD.`;
const eligible = (n: number) => `eligible: yes; return by 2026-10-${pad(10 + (n % 18))}`;
const ineligible = (n: number) => `eligible: no; return-by date 2026-08-${pad(5 + (n % 20))} has passed`;
const provenance = (s: Seed): PackCase["provenance"] => ({ kind: "export", ref: `fernhill-export-2026-09/${s.id}`, added_in_pack_version: 1 });

// A customer asks to return an item that is still eligible, then confirms.
function returnCase(s: Seed): PackCase {
  const order = s.order ?? orderToken(s.n);
  return {
    id: s.id, split: s.split, provenance: provenance(s), intent: "return",
    messages: [
      user(`Hi, I would like to return the ${ITEMS[s.n % ITEMS.length].toLowerCase()} from order ${order}.${s.extra ? ` ${s.extra}` : ""}`),
      calls(`${s.id}-a`, "lookup_order", { order_id: order }), result(`${s.id}-a`, "lookup_order", lookupResult(order, s.n)),
      calls(`${s.id}-b`, "check_return_eligibility", { order_id: order }), result(`${s.id}-b`, "check_return_eligibility", eligible(s.n)),
      says(TEXT_ELIGIBLE),
      user("Yes please."),
      calls(`${s.id}-c`, "start_return", { order_id: order }), result(`${s.id}-c`, "start_return", "Return started. A label was sent to the address on file."),
      says(TEXT_STARTED),
    ],
    checks: [LOOKS_UP(1), DEADLINE(1), ELIGIBILITY_FIRST(1), STARTED(2), ELIGIBILITY_FIRST(2)],
    observed: { resolved: true, repeat_contact: s.n % 2 === 0 },
  };
}

// A customer asks where an order is, then decides to return it.
function statusThenReturnCase(s: Seed): PackCase {
  const order = orderToken(s.n);
  return {
    id: s.id, split: s.split, provenance: provenance(s), intent: "status then return",
    messages: [
      user(`Where is my order ${order}?`),
      calls(`${s.id}-a`, "lookup_order", { order_id: order }), result(`${s.id}-a`, "lookup_order", lookupResult(order, s.n)),
      says(TEXT_DELIVERED),
      user("Thanks. It does not fit, so I want to return it."),
      calls(`${s.id}-b`, "check_return_eligibility", { order_id: order }), result(`${s.id}-b`, "check_return_eligibility", eligible(s.n)),
      says(TEXT_ELIGIBLE),
      user("Yes please."),
      calls(`${s.id}-c`, "start_return", { order_id: order }), result(`${s.id}-c`, "start_return", "Return started. A label was sent to the address on file."),
      says(TEXT_STARTED),
    ],
    checks: [LOOKS_UP(1), DELIVERED(1), DEADLINE(2), ELIGIBILITY_FIRST(2), STARTED(3), ELIGIBILITY_FIRST(3)],
    observed: { resolved: true, repeat_contact: true },
  };
}

// A customer asks to return an order that is past the window.
function lateReturnCase(s: Seed): PackCase {
  const order = orderToken(s.n);
  return {
    id: s.id, split: s.split, provenance: provenance(s), intent: "late return",
    messages: [
      user(`Can I return order ${order}? It arrived a while ago.`),
      calls(`${s.id}-a`, "lookup_order", { order_id: order }), result(`${s.id}-a`, "lookup_order", lookupResult(order, s.n)),
      calls(`${s.id}-b`, "check_return_eligibility", { order_id: order }), result(`${s.id}-b`, "check_return_eligibility", ineligible(s.n)),
      says(TEXT_INELIGIBLE),
      user("No, that is all. Thanks."),
      says(TEXT_BYE),
    ],
    checks: [LOOKS_UP(1), INELIGIBLE(1), ELIGIBILITY_FIRST(1), NO_RETURN(1), NO_ESCALATION(1)],
    observed: { resolved: true, repeat_contact: false },
  };
}

// A customer only asks where an order is.
function statusCase(s: Seed): PackCase {
  const order = orderToken(s.n);
  return {
    id: s.id, split: s.split, provenance: provenance(s), intent: "order status",
    messages: [
      user(`Where is my order ${order}?`),
      calls(`${s.id}-a`, "lookup_order", { order_id: order }), result(`${s.id}-a`, "lookup_order", lookupResult(order, s.n)),
      says(TEXT_DELIVERED),
      user("Great, thanks."),
      says(TEXT_BYE),
    ],
    checks: [LOOKS_UP(1), DELIVERED(1)],
    observed: { resolved: true, repeat_contact: false },
  };
}

export function demoPack(): Pack {
  const cases: PackCase[] = [];
  let n = 0;
  for (let i = 1; i <= 8; i++) {
    cases.push(returnCase({ id: `ret-d${pad(i)}`, split: "discovery", n: ++n, ...(i === 3 ? { order: CANARIES.discovery_order, extra: `It was ${CANARIES.discovery_words}.` } : {}) }));
  }
  for (let i = 1; i <= 4; i++) {
    cases.push(returnCase({ id: `ret-h${pad(i)}`, split: "heldout", n: ++n, ...(i === 2 ? { order: CANARIES.heldout_order, extra: `Sadly ${CANARIES.heldout_words}.` } : {}) }));
  }
  for (let i = 1; i <= 3; i++) cases.push(statusThenReturnCase({ id: `sta-ret-d${pad(i)}`, split: "discovery", n: ++n }));
  for (let i = 1; i <= 2; i++) cases.push(statusThenReturnCase({ id: `sta-ret-h${pad(i)}`, split: "heldout", n: ++n }));
  for (let i = 1; i <= 3; i++) cases.push(lateReturnCase({ id: `late-d${pad(i)}`, split: "discovery", n: ++n }));
  cases.push(lateReturnCase({ id: "late-h01", split: "heldout", n: ++n }));
  for (let i = 1; i <= 2; i++) cases.push(statusCase({ id: `status-d${pad(i)}`, split: "discovery", n: ++n }));
  cases.push(statusCase({ id: "status-h01", split: "heldout", n: ++n }));
  const input = { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] };
  return {
    version: 1,
    name: "fernhill-juniper-returns",
    pack_version: 1,
    parent_pack_id: null,
    source: {
      exported_by: "Fernhill support operations",
      exported_at: "2026-09-30T12:00:00Z",
      redaction: { method: "tokenised names, emails, addresses and payment details; order tokens kept", approved_by: DEMO.redaction_owner, approved_at: "2026-09-30T16:00:00Z" },
      approved_uses: ["replay"],
      policy_version: "returns-policy-2026-07",
    },
    tools: [
      { name: "lookup_order", description: "Look up an order by its order token.", input_schema: input },
      { name: "check_return_eligibility", description: "Say whether an order can still be returned, and until when.", input_schema: input },
      { name: "start_return", description: "Start a return and send the customer a label.", input_schema: input },
      { name: "escalate_to_human", description: "Hand the conversation to the support team.", input_schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } },
    ],
    check_catalog: CATALOG,
    cases,
  };
}

// Two redacted conversations from the first experiment, where the candidate handed late-return requests to the
// support team. A reviewer approves them as regression cases: one the proposer may see, one held out.
export function experimentFailureCases(): PromotionRequest["added"][number]["case"][] {
  const make = (id: string, split: Split, n: number): PromotionRequest["added"][number]["case"] => {
    const order = orderToken(n);
    return {
      id, split, intent: "late return exception",
      messages: [
        user(`Order ${order} arrived six weeks ago and the strap broke. Can you make an exception and take it back?`),
        calls(`${id}-a`, "lookup_order", { order_id: order }), result(`${id}-a`, "lookup_order", lookupResult(order, n)),
        calls(`${id}-b`, "check_return_eligibility", { order_id: order }), result(`${id}-b`, "check_return_eligibility", ineligible(n)),
        calls(`${id}-c`, "escalate_to_human", { reason: "late return exception request" }), result(`${id}-c`, "escalate_to_human", "Handed to the support team."),
        says(TEXT_HANDOFF),
        user("Ok, thanks."),
        says(TEXT_BYE),
      ],
      checks: [INELIGIBLE(1), NO_ESCALATION(1), NO_RETURN(1)],
      observed: { resolved: false, escalated: true },
    };
  };
  return [make("late-exc-d01", "discovery", 41), make("late-exc-h01", "heldout", 42)];
}

// ---------------------------------------------------------------------------------------------------------------
// Telemetry exports, as the customer would produce them: a JSON header and a CSV of sanitised rows.
// ---------------------------------------------------------------------------------------------------------------

export interface ArmPlan {
  tag: string;
  per_day: number;
  // Shares of each day's conversations.
  resolved: number;
  escalated: number;
  refunded: number;
  refund_usd: number;
}

export interface ExportPlan {
  export_id: string;
  start: string;
  // Days of conversations in the export, counted from `start`.
  days: number;
  exported_at: string;
  assignment: "none" | "randomized" | "observational";
  arms: ArmPlan[];
  lag_days: number;
  csv_name: string;
}

// The same conversation always gets the same values, whichever export it appears in, so a later export that
// overlaps an earlier one only fills in outcomes that had not landed yet.
export function telemetryExport(plan: ExportPlan): { header: Record<string, unknown>; csv: string; rows: number } {
  const lines = ["conversation_id,prompt_version,started_at,segment,unit_id,resolved,escalated,refund_usd"];
  const asOf = ms(plan.exported_at);
  let rows = 0;
  for (const [a, arm] of plan.arms.entries()) {
    const resolved = Math.round(arm.per_day * arm.resolved);
    const escalated = Math.round(arm.per_day * arm.escalated);
    const refunded = Math.round(arm.per_day * arm.refunded);
    for (let d = 0; d < plan.days; d++) {
      for (let i = 0; i < arm.per_day; i++) {
        const at = ms(plan.start) + d * DAY_MS + Math.floor((i * DAY_MS) / arm.per_day);
        // Two fixed shuffles of the day's conversations: one decides resolved or escalated, the other refunds.
        const j = (i * 7919 + d * 131) % arm.per_day;
        const k = (i * 6101 + d * 57) % arm.per_day;
        const mature = at + plan.lag_days * DAY_MS <= asOf;
        const id = `c-${arm.tag}-${pad(d)}-${String(i).padStart(4, "0")}`;
        const values = mature ? [j < resolved ? 1 : 0, j >= arm.per_day - escalated ? 1 : 0, k < refunded ? arm.refund_usd.toFixed(2) : "0.00"] : ["", "", ""];
        lines.push([id, arm.tag, new Date(at).toISOString().replace(".000Z", "Z"), i % 3 === 0 ? "email" : "chat", `u-${arm.tag}-${pad(d)}-${String(i).padStart(4, "0")}`, ...values].join(","));
        rows++;
      }
    }
  }
  const header = {
    format: TELEMETRY_FORMAT,
    export_id: plan.export_id,
    source: "Fernhill analytics warehouse, saved query support_outcomes_by_prompt_version",
    exported_at: plan.exported_at,
    window: { start: plan.start, end: addDays(plan.start, plan.days) },
    assignment: plan.assignment,
    denominator: "completed_conversations",
    units: {
      resolved: "share of completed conversations resolved without a person",
      escalated: "share of completed conversations handed to a person",
      refund_usd: "USD refunded per completed conversation",
    },
    expected_rows: rows,
    rows_csv: plan.csv_name,
  };
  return { header, csv: `${lines.join("\n")}\n`, rows };
}

const BASE_ARM = { resolved: 0.62, escalated: 0.12, refunded: 0.15, refund_usd: 28 };

export const baselineExport = () => telemetryExport({
  export_id: "fernhill-baseline-2026-10", start: DEMO.baseline_window.start, days: DEMO.baseline_window.days, exported_at: "2026-10-17T00:00:00Z",
  assignment: "none", lag_days: 2, csv_name: "baseline.csv", arms: [{ tag: DEMO.baseline_tag, per_day: 640, ...BASE_ARM }],
});

const B_ARMS = (candidateTag: string): ArmPlan[] => [
  { tag: DEMO.baseline_tag, per_day: 320, ...BASE_ARM },
  { tag: candidateTag, per_day: 320, resolved: 0.63, escalated: 0.24, refunded: 0.15, refund_usd: 28 },
];

// First experiment, five days in: the candidate hands far more conversations to people.
export const experimentBInterim = (candidateTag: string) => telemetryExport({
  export_id: "fernhill-exp1-day5", start: DEMO.experiment_b_start, days: 5, exported_at: addDays(DEMO.experiment_b_start, 5),
  assignment: "randomized", lag_days: 2, csv_name: "experiment-1-day5.csv",
  arms: B_ARMS(candidateTag),
});

// The same experiment, exported after its cutoff. By then it had already been stopped.
export const experimentBAfterStop = (candidateTag: string) => telemetryExport({
  export_id: "fernhill-exp1-after-stop", start: DEMO.experiment_b_start, days: 14, exported_at: addDays(DEMO.experiment_b_start, 16),
  assignment: "randomized", lag_days: 2, csv_name: "experiment-1-after-stop.csv", arms: B_ARMS(candidateTag),
});

// The same export with the candidate arm under a tag the experiment does not know.
export const experimentBMistagged = (candidateTag: string) => {
  const good = experimentBInterim(candidateTag);
  return { header: { ...good.header, export_id: "fernhill-exp1-day5-mistagged", rows_csv: "experiment-1-mistagged.csv" }, csv: good.csv.replaceAll(candidateTag, "juniper-v15-draft"), rows: good.rows };
};

const C_ARMS = (candidateTag: string): ArmPlan[] => [
  { tag: DEMO.baseline_tag, per_day: 320, ...BASE_ARM },
  { tag: candidateTag, per_day: 320, resolved: 0.665, escalated: 0.12, refunded: 0.15, refund_usd: 28.4 },
];

// Second experiment, six days in: too few mature conversations, and the window is still open.
export const experimentCInterim = (candidateTag: string) => telemetryExport({
  export_id: "fernhill-exp2-day6", start: DEMO.experiment_c_start, days: 6, exported_at: addDays(DEMO.experiment_c_start, 6),
  assignment: "randomized", lag_days: 2, csv_name: "experiment-2-day6.csv", arms: C_ARMS(candidateTag),
});

// Second experiment at the cutoff: the full window, including every conversation of the day-6 export.
export const experimentCFinal = (candidateTag: string) => telemetryExport({
  export_id: "fernhill-exp2-final", start: DEMO.experiment_c_start, days: 14, exported_at: addDays(DEMO.experiment_c_start, 16),
  assignment: "randomized", lag_days: 2, csv_name: "experiment-2-final.csv", arms: C_ARMS(candidateTag),
});
