// Synthetic fixtures for the review lane's tests: Fernhill Outfitters and its agent Juniper. Built by hand from the
// types so these tests do not depend on the other lanes' modules.
import { contentId, promptId, reviewBranch } from "../src/pilot/ids.ts";
import type { Candidate, ExperimentSpec, Pack, PackCase, PilotConfig, ReplayReport, ReviewBundle, SplitTally, Stored } from "../src/pilot/types.ts";
import { buildReviewBundle } from "../src/pilot/review.ts";

export const SLUG = "fernhill/support-agent";
export const PROMPT_PATH = "prompts/juniper.md";
export const CANARY_SENTENCE = "my crampons arrived with a cracked buckle and nobody answered my message";
export const CANARY_ORDER = "ORD-7Q4Z";
export const CANARY_TOOL_ARG = "ZX-91-LANTERN";

export const BASELINE_PROMPT = [
  "You are Juniper, the support agent for Fernhill Outfitters.",
  "Be warm and brief.",
  "Never promise a refund without checking the order first.",
  "",
].join("\n");
export const CANDIDATE_PROMPT = [
  "You are Juniper, the support agent for Fernhill Outfitters.",
  "Be warm and brief.",
  "Never promise a refund without checking the order first.",
  "Always call lookup_order before you mention a refund or a replacement.",
  "",
].join("\n");

export const tally = (cases: number, wins: number, losses: number, ties: number, excluded: number): SplitTally =>
  ({ cases, paired: cases - excluded, wins, losses, ties, excluded });

export function makeConfig(): PilotConfig {
  return {
    version: 1,
    pilot_id: "fernhill-pilot",
    agent: { name: "Juniper", prompt_path: PROMPT_PATH, baseline_tag: "juniper-v1" },
    repo: { slug: SLUG, base: "main" },
    metric: {
      version: 1,
      primary: { name: "resolved_first_contact", kind: "rate", unit: "share of conversations", direction: "higher_is_better", min_effect: 0.03 },
      guards: [{ name: "escalation_rate", kind: "rate", unit: "share of conversations", direction: "lower_is_better", max_harm: 0.02, critical: true, early_stop: { min_per_arm: 200 } }],
      denominator: "completed_conversations",
      randomization_unit: "conversation",
      alpha: 0.05, power: 0.8, min_samples_per_arm: 300, analysis_window_days: 14, outcome_lag_days: 3,
      max_missing_rate: 0.1, max_unattributed_rate: 0.05,
      signed_off: { by: "Dana Whitlock", at: "2026-10-01T00:00:00Z" },
    },
    replay: {
      model: "scripted", max_tokens: 1000, temperature: null, max_steps_per_turn: 4,
      gate: { min_paired_cases: 2, min_paired_coverage: 0.5, min_net_wins: 1 }, min_recurring_cases: 2, max_changed_lines: 10,
    },
    provider: null,
  };
}

export function makeCase(id: string, split: "discovery" | "heldout", extra: Partial<PackCase> = {}): PackCase {
  return {
    id, split,
    provenance: { kind: "export", ref: `export-${id}`, added_in_pack_version: 1 },
    intent: "refund",
    messages: [
      { role: "user", text: `${CANARY_SENTENCE} please help [EMAIL_1]` },
      { role: "assistant", text: "I am sorry about that, let me look.", tool_calls: [{ id: "t1", name: "lookup_order", input: { order: CANARY_ORDER, note: { deep: CANARY_TOOL_ARG } } }] },
      { role: "tool", tool_call_id: "t1", name: "lookup_order", result: `order ${CANARY_ORDER} shipped on a Tuesday afternoon` },
      { role: "assistant", text: "Your order shipped on Tuesday and I can offer a replacement." },
    ],
    checks: [
      { id: "looks_up_order", kind: "calls_tool", tool: "lookup_order", turn: 1, role: "primary" },
      { id: "no_early_refund", kind: "reply_excludes", any_of: ["refund"], turn: 1, role: "guard", blocking: true },
    ],
    ...extra,
  };
}

export function makePack(cases?: PackCase[]): Pack {
  return {
    version: 1, name: "fernhill-support", pack_version: 1, parent_pack_id: null,
    source: { exported_by: "Fernhill support ops", exported_at: "2026-09-20T00:00:00Z", redaction: { method: "token-replace", approved_by: "Dana Whitlock", approved_at: "2026-09-21T00:00:00Z" }, approved_uses: ["replay"] },
    tools: [{ name: "lookup_order", description: "Find an order.", input_schema: { type: "object" } }],
    check_catalog: {
      looks_up_order: "The agent looks up the order before answering a question about it.",
      no_early_refund: "The agent does not promise a refund before the order is checked.",
    },
    cases: cases ?? [makeCase("c1", "discovery"), makeCase("c2", "discovery"), makeCase("h1", "heldout")],
  };
}

export const stored = <T>(value: T): Stored<T> => ({ id: contentId(value), value });

export function makeCandidate(): Candidate {
  return {
    version: 1, pilot_id: "fernhill-pilot", baseline_prompt_id: promptId(BASELINE_PROMPT), prompt_id: promptId(CANDIDATE_PROMPT),
    origin: "human", author: "Ines Park", rationale: "Juniper sometimes offers a replacement before looking at the order. This adds one instruction to look it up first.",
    finding_id: null, target_check_id: "looks_up_order", changed_lines: 1,
  };
}

export function makeReplay(pack: Stored<Pack>, over: Partial<ReplayReport> = {}): ReplayReport {
  const arm = (prompt: string, passes: boolean): ReplayReport["baseline"] => ({
    prompt_id: promptId(prompt), pack_id: pack.id,
    settings: { model: "scripted", max_tokens: 1000, temperature: null, max_steps_per_turn: 4 }, model_destination: "scripted:test",
    cases: pack.value.cases.map((c) => ({
      case_id: c.id, split: c.split, stopped: null,
      turns: [{ turn: 1, status: "scored", tools_requested: ["lookup_order"], reply_sha256: null, checks: [
        { id: "looks_up_order", role: "primary", blocking: false, pass: passes },
        { id: "no_early_refund", role: "guard", blocking: true, pass: true },
      ] }],
    })),
    model_calls: 3,
  });
  return {
    version: 1, pack_id: pack.id, baseline_prompt_id: promptId(BASELINE_PROMPT), candidate_id: promptId(CANDIDATE_PROMPT), target_check_id: "looks_up_order",
    settings: { model: "scripted", max_tokens: 1000, temperature: null, max_steps_per_turn: 4 }, model_destination: "scripted:test",
    baseline: arm(BASELINE_PROMPT, false), candidate: arm(CANDIDATE_PROMPT, true),
    paired: pack.value.cases.map((c) => ({ case_id: c.id, split: c.split, outcome: "win" as const, common_turns: 1, total_turns: 1, baseline_passed: 0, candidate_passed: 1, primary_checks: 1 })),
    tally: { all: tally(3, 3, 0, 0, 0), discovery: tally(2, 2, 0, 0, 0), heldout: tally(1, 1, 0, 0, 0) },
    coverage: { paired_cases: 1, common_turns: 1, excluded: [], diverged: [{ case_id: "c2", split: "discovery", turn: 1 }] },
    sign_p: 0.125,
    regressions: [{ case_id: "c2", split: "discovery", turn: 1, check_id: "no_early_refund", role: "guard", blocking: false }],
    fixes: [
      { case_id: "c1", split: "discovery", turn: 1, check_id: "looks_up_order", role: "primary", blocking: false },
      { case_id: "c2", split: "discovery", turn: 1, check_id: "looks_up_order", role: "primary", blocking: false },
    ],
    new_blocking_guard_failures: [],
    observed_outcomes: {},
    gate: { eligible: true, reasons: ["3 of 3 cases paired", "net wins 3"], proposer_feedback: [] },
    ...over,
  };
}

export function makeExperiment(configId: string): ExperimentSpec {
  const cand = promptId(CANDIDATE_PROMPT);
  const base = promptId(BASELINE_PROMPT);
  return {
    version: 1, pilot_id: "fernhill-pilot", config_id: configId,
    arms: { baseline: { prompt_id: base, tag: "juniper-v1" }, candidate: { prompt_id: cand, tag: `synthe-${cand.slice(0, 12)}` } },
    allocation: { baseline: 0.5, candidate: 0.5 }, assignment: "randomized", randomization_unit: "conversation",
    window: { start: "2026-11-01T00:00:00Z", end: "2026-11-15T00:00:00Z" }, analysis_cutoff: "2026-11-18T00:00:00Z",
    required_per_arm: 1200, denominator: "completed_conversations",
    primary: makeConfig().metric.primary, guards: makeConfig().metric.guards, alpha: 0.05, early_stop_level: 0.99, integrity_alpha: 0.001,
    max_missing_rate: 0.1, max_unattributed_rate: 0.05, outcome_lag_days: 3,
    methods: {
      rate: "Rates are compared with a difference interval.", mean: "Means are compared with a Welch interval.",
      keep: "Keep when the primary interval clears the minimum effect and no guard breaches.",
      revert: "Revert when a guard breaches or the primary is clearly worse.",
      hold: "Hold when data is missing, too small or flagged.",
      early_stop: "Stop early only when a critical guard breaches at the stricter level.",
      integrity: "Sample ratio and segment balance are checked.",
    },
    telemetry_fields: ["conversation_id", "prompt_version"],
    rollback: { prompt_id: base, tag: "juniper-v1", instructions: "Serve the prompt tagged juniper-v1 to all traffic again." },
  };
}

export interface Fixture {
  config: PilotConfig; configId: string; pack: Stored<Pack>; candidate: Candidate; replay: Stored<ReplayReport>;
  experiment: Stored<ExperimentSpec>; bundle: Stored<ReviewBundle>;
}

export function fixture(): Fixture {
  const config = makeConfig();
  const configId = contentId(config);
  const pack = stored(makePack());
  const candidate = makeCandidate();
  const replay = stored(makeReplay(pack));
  const experiment = stored(makeExperiment(configId));
  const bundle = stored(buildReviewBundle({ config, config_id: configId, candidate, baseline_prompt: BASELINE_PROMPT, candidate_prompt: CANDIDATE_PROMPT, replay, experiment }));
  return { config, configId, pack, candidate, replay, experiment, bundle };
}

export const BRANCH = reviewBranch(promptId(CANDIDATE_PROMPT));
