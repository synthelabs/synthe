// Shared contracts for the enterprise pilot (src/pilot/). One owner: change this file only in the integration
// lane, because replay, telemetry and review code are built against it separately.
//
// The pilot takes one support agent from a frozen business metric and a redacted conversation pack, through a
// replayed prompt change and a human-reviewed pull request, to a keep / hold / revert recommendation from an
// experiment the customer runs. Synthe never operates the traffic split and never runs a real tool.
//
// Every stored object is named by the SHA-256 of its canonical JSON (ids.ts), so a report can cite exactly what it
// was computed from and a reviewer can recompute it.

export type Sha256 = string;
export type IsoTime = string; // UTC, e.g. 2026-10-01T00:00:00Z

// A stored object together with its content id.
export interface Stored<T> { id: Sha256; value: T }

// ---------------------------------------------------------------------------------------------------------------
// Errors. Every refusal carries a code, so tests and the CLI can tell a fail-closed refusal from a crash.
// ---------------------------------------------------------------------------------------------------------------

export type PilotErrorCode =
  | "usage" | "not_found" | "conflict" | "too_large"
  | "invalid_config" | "invalid_metric"
  | "invalid_pack" | "pack_not_approved" | "pack_not_redacted"
  | "invalid_candidate" | "candidate_not_narrow" | "holdout_leak"
  | "invalid_telemetry" | "telemetry_version_mismatch" | "telemetry_window_mismatch" | "telemetry_unit_mismatch"
  | "telemetry_denominator_mismatch" | "telemetry_duplicate" | "telemetry_conflict" | "telemetry_incomplete"
  | "replay_gate_failed" | "experiment_in_flight"
  | "unknown_approval" | "unauthorized_publish" | "wrong_repo" | "wrong_revision" | "egress_blocked"
  | "invalid_promotion" | "live_not_approved" | "budget_exceeded" | "tampered";

// ---------------------------------------------------------------------------------------------------------------
// Pilot configuration (pilot.json). Frozen by content id before any change is proposed.
// ---------------------------------------------------------------------------------------------------------------

export type MetricKind = "rate" | "mean";
export type Direction = "higher_is_better" | "lower_is_better";

export interface MetricSpec {
  // The name the telemetry export uses for this value (a row's values key, or an aggregate's metrics key).
  name: string;
  // rate: each conversation is 0 or 1 and the metric is the share of 1s. mean: a number per conversation, averaged.
  kind: MetricKind;
  // Must equal the unit the telemetry export declares for this metric, word for word.
  unit: string;
  direction: Direction;
}

export interface GuardSpec extends MetricSpec {
  // The largest move in the harmful direction the team tolerates, absolute, in metric units (a rate is a fraction
  // from 0 to 1, so 0.02 is two percentage points).
  max_harm: number;
  // A critical guard may stop the experiment early (early_stop). Any guard can cause a revert at the final analysis.
  critical: boolean;
  // Predeclared early stop, for a critical guard only: looked at before the final analysis, at a stricter
  // confidence level, once each arm has at least min_per_arm mature conversations.
  early_stop?: { min_per_arm: number };
}

export interface MetricContract {
  version: 1;
  primary: MetricSpec & {
    // The smallest change in the good direction the team would act on, absolute, in metric units.
    min_effect: number;
  };
  guards: GuardSpec[];
  // The population every value is over, e.g. "completed_conversations". The telemetry export must declare the same.
  denominator: string;
  // What the customer randomises on. Only "conversation" is analysed in this version.
  randomization_unit: "conversation";
  // Two-sided error rate of the final analysis (0.05 gives 95% intervals).
  alpha: number;
  // Used only to size the experiment (required conversations per arm).
  power: number;
  // Floor on mature conversations per arm before a final analysis, whatever the power calculation says.
  min_samples_per_arm: number;
  analysis_window_days: number;
  // Days after a conversation starts before its outcome is final. Younger conversations are immature and excluded.
  outcome_lag_days: number;
  // Data-quality limits, as fractions of rows. Above either limit the recommendation is hold.
  max_missing_rate: number;
  max_unattributed_rate: number;
  // Optional pin on the customer's metric query: the export must carry the same hash.
  query_hash?: Sha256;
  signed_off: { by: string; at: IsoTime };
}

export interface ReplayGateConfig {
  // Cases scored on both prompts on at least one common turn.
  min_paired_cases: number;
  // paired cases / all cases in the pack, 0 to 1.
  min_paired_coverage: number;
  // wins minus losses across paired cases must reach this.
  min_net_wins: number;
}

export interface ReplayConfig {
  model: string;
  max_tokens: number;
  temperature: number | null;
  // Model calls allowed inside one assistant turn (tool call, result, tool call, ...), so a loop cannot run away.
  max_steps_per_turn: number;
  gate: ReplayGateConfig;
  // A failure is "recurring" when the same check fails in at least this many discovery cases.
  min_recurring_cases: number;
  // A candidate may add, remove or change at most this many lines of the prompt.
  max_changed_lines: number;
}

// Approval for sending pilot data to a model provider. Without it nothing leaves: only scripted models run.
export interface ProviderApproval {
  provider: "anthropic";
  // Exact base URL the data goes to. No other endpoint is ever used.
  endpoint: string;
  model: string;
  // The one environment variable the key is read from. There is no fallback to any other variable.
  key_env: string;
  // What is sent, in the customer's words, e.g. "redacted support conversations (pack)".
  data_class: string;
  approved_by: string;
  approved_at: IsoTime;
  max_calls: number;
  max_input_chars: number;
}

export interface PilotConfig {
  version: 1;
  // Lowercase letters, digits and dashes.
  pilot_id: string;
  agent: {
    name: string;
    // The system prompt file in the customer's repo that a candidate changes.
    prompt_path: string;
    // The tag the customer's telemetry already carries for the current prompt.
    baseline_tag: string;
  };
  repo: {
    // owner/name. A review pull request can go nowhere else.
    slug: string;
    base: string;
    // GitHub API base. Absent means https://api.github.com. Anything else must be loopback (tests, the demo).
    api?: string;
  };
  metric: MetricContract;
  replay: ReplayConfig;
  provider: ProviderApproval | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Models. Multi-turn messages with tool calls and recorded tool results. src/model/client.ts stays text-only.
// ---------------------------------------------------------------------------------------------------------------

export interface ToolSpec { name: string; description: string; input_schema: Record<string, unknown> }
export interface ToolCall { id: string; name: string; input: Record<string, unknown> }

export type ChatMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; tool_calls: ToolCall[] }
  // A recorded tool result. Never produced by running a tool.
  | { role: "tool"; tool_call_id: string; name: string; result: string; is_error?: boolean };

export interface ChatRequest {
  purpose: "replay" | "propose" | "judge";
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  max_tokens: number;
  temperature: number | null;
}

export interface ChatReply {
  text: string;
  tool_calls: ToolCall[];
  // end: a finished reply. tool_use: the model wants tool results. Anything else is not a usable reply.
  stop: "end" | "tool_use" | "max_tokens" | "refusal" | "other";
  usage?: { input: number; output: number };
}

export interface ChatModel {
  // Where requests go, for the record: "scripted:<name>" or "<provider>:<endpoint>:<model>".
  readonly destination: string;
  chat(request: ChatRequest): Promise<ChatReply>;
}

// ---------------------------------------------------------------------------------------------------------------
// Conversation pack. Bounded, approved, redacted; frozen by content hash.
// ---------------------------------------------------------------------------------------------------------------

export type PackMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; result: string; is_error?: boolean };

// discovery: the proposer may see these cases. heldout: it never does, in this pack version or any later one.
export type Split = "discovery" | "heldout";

// A check is one yes/no fact about the assistant's behaviour on one assistant turn. All kinds here are decided by
// code, with no model. `id` names the behaviour and is shared by every case that tests it, so failures can be
// counted across cases.
export type CheckRule =
  // The final reply text contains at least one phrase (case-insensitive).
  | { kind: "reply_includes"; any_of: string[] }
  // The final reply text contains none of the phrases.
  | { kind: "reply_excludes"; any_of: string[] }
  // The assistant requested this tool during the turn.
  | { kind: "calls_tool"; tool: string }
  // The assistant did not request this tool during the turn.
  | { kind: "avoids_tool"; tool: string }
  // If the assistant requested `tool` during the turn, it had requested `after` first (this turn or an earlier
  // recorded one). Passes when `tool` was not requested.
  | { kind: "tool_requires"; tool: string; after: string };

export type CaseCheck = CheckRule & {
  id: string;
  // The assistant turn it applies to, counted from 1: turn n answers the nth user message.
  turn: number;
  // primary checks make the case score. guard checks never add to the score; they only catch harm.
  role: "primary" | "guard";
  // guard only: a candidate that newly fails it is kept out of review.
  blocking?: boolean;
};

export interface PackCase {
  // Stable across pack versions.
  id: string;
  split: Split;
  provenance: {
    // export: came in the customer's redacted export. promoted: added by an approved promotion.
    kind: "export" | "promoted";
    // The customer's own reference for the conversation (already tokenised), or the promotion it came from.
    ref: string;
    added_in_pack_version: number;
  };
  // A topic label, for coverage by topic.
  intent?: string;
  messages: PackMessage[];
  checks: CaseCheck[];
  // What happened to the real conversation under the old prompt. Reported on its own, never mixed into replay.
  observed?: Record<string, number | boolean | null>;
  // Set when a reviewer approved this case as a permanent regression case.
  regression?: { approved_by: string; approved_at: IsoTime; reason: string; promotion_ref: string };
}

export interface Pack {
  version: 1;
  name: string;
  pack_version: number;
  // The pack this one was promoted from. Null for the first.
  parent_pack_id: Sha256 | null;
  source: {
    exported_by: string;
    exported_at: IsoTime;
    redaction: { method: string; approved_by: string; approved_at: IsoTime };
    // What the customer approved this export for. Must include "replay".
    approved_uses: string[];
    policy_version?: string;
  };
  tools: ToolSpec[];
  // Check id -> one plain sentence. Reports print this, never conversation text.
  check_catalog: Record<string, string>;
  cases: PackCase[];
}

export interface PackSummary {
  pack_id: Sha256;
  name: string;
  pack_version: number;
  parent_pack_id: Sha256 | null;
  cases: number;
  by_split: Record<Split, number>;
  regression_cases: number;
  assistant_turns: number;
  checks: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Replay. Both prompts on the same frozen cases, same settings, recorded tool results only.
// ---------------------------------------------------------------------------------------------------------------

export interface ReplaySettings { model: string; max_tokens: number; temperature: number | null; max_steps_per_turn: number }

export interface CheckResult {
  id: string;
  role: "primary" | "guard";
  blocking: boolean;
  // null: could not be decided (the turn did not finish and the check needs the reply text).
  pass: boolean | null;
}

// How one assistant turn went for one prompt.
// scored: the reply finished and every check was decided.
// unsupported: the model asked for a tool call the recording has no result for. No tool is run; tool checks are
//   still decided from the request, text checks are null.
// inconclusive: no usable reply (cut off, refused, too many steps, model error).
// not_reached: an earlier turn left the recording (see CaseRun.stopped), so this turn was not replayed.
export type TurnStatus = "scored" | "unsupported" | "inconclusive" | "not_reached";

export interface TurnRun {
  turn: number;
  status: TurnStatus;
  // Tool names the model requested this turn, in order. Names only: arguments can hold customer data.
  tools_requested: string[];
  checks: CheckResult[];
  // SHA-256 of the reply text, so two runs can be compared without keeping the text.
  reply_sha256: Sha256 | null;
}

export interface CaseRun {
  case_id: string;
  split: Split;
  turns: TurnRun[];
  // Where and why replay of this case stopped before the last turn. Null when every turn was replayed.
  // diverged: the reply at that turn was scored, but it behaves differently from the recorded reply (different
  //   tool calls, or a different result on that turn's checks), so the recorded later turns no longer follow.
  // unsupported / inconclusive: as TurnStatus.
  stopped: { turn: number; why: "diverged" | "unsupported" | "inconclusive"; detail: string } | null;
}

export interface ArmRun {
  prompt_id: Sha256;
  pack_id: Sha256;
  settings: ReplaySettings;
  model_destination: string;
  cases: CaseRun[];
  model_calls: number;
}

export interface TurnRef { case_id: string; split: Split; turn: number; check_id: string; role: "primary" | "guard"; blocking: boolean }

export interface PairedCase {
  case_id: string;
  split: Split;
  // win: the candidate passes more primary checks than the baseline on the turns both were scored on.
  // excluded: no turn was scored for both prompts.
  outcome: "win" | "loss" | "tie" | "excluded";
  excluded_why?: "unsupported" | "inconclusive";
  // Turns scored for both prompts.
  common_turns: number;
  total_turns: number;
  baseline_passed: number;
  candidate_passed: number;
  primary_checks: number;
}

export interface SplitTally { cases: number; paired: number; wins: number; losses: number; ties: number; excluded: number }

export interface ReplayReport {
  version: 1;
  pack_id: Sha256;
  baseline_prompt_id: Sha256;
  candidate_id: Sha256;
  // The check the candidate was written to fix, when it came from a finding.
  target_check_id: string | null;
  settings: ReplaySettings;
  model_destination: string;
  baseline: ArmRun;
  candidate: ArmRun;
  paired: PairedCase[];
  tally: { all: SplitTally; discovery: SplitTally; heldout: SplitTally };
  coverage: {
    // paired cases / cases.
    paired_cases: number;
    // turns scored for both prompts / assistant turns in the pack.
    common_turns: number;
    excluded: { case_id: string; split: Split; why: "unsupported" | "inconclusive"; turn: number }[];
    // Cases where the candidate left the recording, and the turn it happened at.
    diverged: { case_id: string; split: Split; turn: number }[];
  };
  // One-sided exact sign test on wins and losses (ties excluded), from src/core/merge-rule.ts signP.
  sign_p: number;
  // A check the baseline passed and the candidate failed, at the exact turn.
  regressions: TurnRef[];
  // A check the baseline failed and the candidate passed.
  fixes: TurnRef[];
  // Blocking guard checks the candidate fails that the baseline does not fail. Any entry keeps it out of review.
  new_blocking_guard_failures: TurnRef[];
  // Historical outcomes of the real conversations, counted per outcome name. Not used by the gate.
  observed_outcomes: Record<string, { cases: number; true_or_positive: number }>;
  gate: {
    eligible: boolean;
    // For the reviewer: may name held-out cases.
    reasons: string[];
    // For the proposer's next attempt: discovery cases only, never a held-out case id, turn or count.
    proposer_feedback: string[];
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Failure discovery and candidates.
// ---------------------------------------------------------------------------------------------------------------

export interface FailureFinding {
  version: 1;
  pack_id: Sha256;
  baseline_prompt_id: Sha256;
  check_id: string;
  // From the pack's check_catalog.
  description: string;
  // Discovery cases only.
  failing: { case_id: string; turn: number }[];
  discovery_cases_with_check: number;
}

// What a proposer is given. Built only from discovery cases.
export interface ProposerContext {
  baseline_prompt: string;
  finding: FailureFinding;
  // The failing discovery conversations up to the failing turn (the recorded messages, redacted as in the pack).
  examples: { case_id: string; turn: number; messages: PackMessage[] }[];
  // How many candidates were already tried for this finding.
  attempt: number;
  // gate.proposer_feedback of earlier attempts.
  feedback: string[];
  max_changed_lines: number;
}

export interface Proposer {
  readonly destination: string;
  propose(context: ProposerContext): Promise<{ prompt: string; rationale: string }>;
}

export interface Candidate {
  version: 1;
  pilot_id: string;
  baseline_prompt_id: Sha256;
  // SHA-256 of the candidate prompt text. Also the candidate's id everywhere.
  prompt_id: Sha256;
  origin: "proposer" | "human";
  author: string;
  rationale: string;
  // Null for a human-authored candidate not tied to a finding.
  finding_id: Sha256 | null;
  target_check_id: string | null;
  changed_lines: number;
}

// ---------------------------------------------------------------------------------------------------------------
// Telemetry. Read-only boundary: customer-produced exports in, numbers out. Rows stay in the operator's store.
// ---------------------------------------------------------------------------------------------------------------

export const TELEMETRY_FORMAT = "synthe-pilot-telemetry/v1";

export interface TelemetryRow {
  conversation_id: string;
  prompt_version: string;
  started_at: IsoTime;
  // Optional covariates.
  segment?: string;
  // The customer's assignment key (already hashed or tokenised). One unit seen in two arms is ambiguous attribution.
  unit_id?: string;
  model_id?: string;
  // Metric name -> value. null: no outcome recorded.
  values: Record<string, number | null>;
}

export type AggregateMetric =
  | { kind: "rate"; successes: number; missing: number }
  | { kind: "mean"; mean: number; sd: number; missing: number };

export interface TelemetryAggregate {
  prompt_version: string;
  // Mature conversations in the denominator.
  n: number;
  immature: number;
  unattributed: number;
  metrics: Record<string, AggregateMetric>;
  segments?: Record<string, number>;
}

// The customer's export file (documented in docs/PILOT.md).
export interface TelemetryExport {
  format: typeof TELEMETRY_FORMAT;
  // The customer's own id for this export.
  export_id: string;
  source: string;
  query_hash?: Sha256;
  exported_at: IsoTime;
  // Conversations that started in [start, end).
  window: { start: IsoTime; end: IsoTime };
  // none: one prompt, no comparison (a baseline). randomized: the customer split traffic at random.
  // observational: two versions that were not randomised (before/after, opt-in, by region).
  assignment: "none" | "randomized" | "observational";
  denominator: string;
  // Metric name -> unit, word for word as in the contract.
  units: Record<string, string>;
  // rows form: how many conversations the source holds for this window, so a truncated export is caught.
  expected_rows?: number;
  // Exactly one of the three.
  rows?: TelemetryRow[];
  // A CSV file next to the export file, with a header line.
  rows_csv?: string;
  aggregates?: TelemetryAggregate[];
}

export interface ArmCounts {
  tag: string;
  // Rows received for the arm, after exact duplicates are dropped.
  rows: number;
  // Outcome final (started_at + outcome lag is not after exported_at) and attributable.
  mature: number;
  immature: number;
  unattributed: number;
  segments: Record<string, number>;
}

// A validated import. `rows` is kept so later imports can be de-duplicated and the analysis recomputed; it holds
// the customer's conversation ids, so it stays in the object store and is never printed.
export interface TelemetryImport {
  version: 1;
  purpose: "baseline" | "experiment";
  // The frozen config id (baseline) or the experiment id.
  scope_id: Sha256;
  export_id: string;
  source: string;
  form: "rows" | "aggregates";
  exported_at: IsoTime;
  window: { start: IsoTime; end: IsoTime };
  assignment: TelemetryExport["assignment"];
  expected_rows: number | null;
  duplicates_dropped: number;
  arms: ArmCounts[];
  rows: TelemetryRow[] | null;
  aggregates: TelemetryAggregate[] | null;
}

// A number, with where it came from and how it was computed.
export interface Sourced {
  value: number | null;
  // Object ids, e.g. "telemetry:3fa9c2d1e0aa".
  source: string;
  method: string;
}

export interface Interval { lo: number; hi: number; level: number }

export interface BaselineMetric {
  name: string;
  role: "primary" | "guard";
  kind: MetricKind;
  unit: string;
  n: number;
  missing: number;
  estimate: Sourced;
  ci: Interval | null;
}

export interface BaselineReport {
  version: 1;
  config_id: Sha256;
  telemetry_ids: Sha256[];
  tag: string;
  window: { start: IsoTime; end: IsoTime };
  rows: number;
  mature: number;
  immature: number;
  daily_volume: Sourced;
  metrics: BaselineMetric[];
  // Conversations needed in each arm to detect primary.min_effect at the contract's alpha and power.
  required_per_arm: Sourced;
  // Days of traffic at the measured daily volume to fill both arms at an even split.
  days_to_required: Sourced;
  flags: string[];
}

// ---------------------------------------------------------------------------------------------------------------
// Experiment. The customer runs it; Synthe writes the specification and analyses the export.
// ---------------------------------------------------------------------------------------------------------------

export interface ArmRef { prompt_id: Sha256; tag: string }

export interface ExperimentSpec {
  version: 1;
  pilot_id: string;
  config_id: Sha256;
  arms: { baseline: ArmRef; candidate: ArmRef };
  // Intended share of traffic per arm, summing to 1.
  allocation: { baseline: number; candidate: number };
  assignment: "randomized";
  randomization_unit: "conversation";
  window: { start: IsoTime; end: IsoTime };
  // window.end plus the outcome lag. The final analysis needs an export made at or after this time.
  analysis_cutoff: IsoTime;
  required_per_arm: number;
  denominator: string;
  primary: MetricContract["primary"];
  guards: GuardSpec[];
  alpha: number;
  // Confidence level for an early stop, stricter than 1 - alpha because it may be looked at many times.
  early_stop_level: number;
  // Sample-ratio and segment-balance checks flag a problem below this p-value.
  integrity_alpha: number;
  max_missing_rate: number;
  max_unattributed_rate: number;
  outcome_lag_days: number;
  // The predeclared analysis, in plain sentences, printed in the review bundle and the decision.
  methods: { rate: string; mean: string; keep: string; revert: string; hold: string; early_stop: string; integrity: string };
  // What the customer must export.
  telemetry_fields: string[];
  rollback: { prompt_id: Sha256; tag: string; instructions: string };
}

export type Recommendation = "keep" | "hold" | "revert";

export interface MetricReadout {
  name: string;
  role: "primary" | "guard";
  kind: MetricKind;
  unit: string;
  direction: Direction;
  baseline: { n: number; missing: number; estimate: number | null };
  candidate: { n: number; missing: number; estimate: number | null };
  // candidate minus baseline, in metric units.
  difference: number | null;
  // Interval for `difference` at the final level (1 - alpha).
  ci: Interval | null;
  // Guards only: interval for `difference` at the early-stop level.
  early_ci?: Interval | null;
  method: string;
  // primary: clears / not_clear. guard: pass / breach / inconclusive.
  status: "clears" | "not_clear" | "pass" | "breach" | "inconclusive";
  detail: string;
}

export interface ExperimentAnalysis {
  version: 1;
  experiment_id: Sha256;
  telemetry_ids: Sha256[];
  approval_id: Sha256;
  // The newest export's exported_at. The analysis never reads the clock.
  as_of: IsoTime;
  // True when as_of is at or after the cutoff: only then can the result be keep.
  final: boolean;
  arms: { baseline: ArmCounts; candidate: ArmCounts };
  allocation: { intended: number; observed: number | null; srm_p: number | null; flagged: boolean };
  coverage: {
    rows: number; mature: number; immature: number; unattributed: number; missing_rate: number; unattributed_rate: number;
    duplicates_dropped: number; required_per_arm: number;
  };
  primary: MetricReadout;
  guards: MetricReadout[];
  // Named data problems: observational, attribution_ambiguous, cohort_imbalance, missing_events, inside_lag_window,
  // sample_ratio_mismatch, insufficient_samples, runtime_changed, before_cutoff, window_not_covered,
  // superseded_aggregate.
  flags: string[];
  recommendation: Recommendation;
  // revert only: "early_stop" or "final".
  stopped_by?: "early_stop" | "final";
  reasons: string[];
  rollback: ExperimentSpec["rollback"];
}

// ---------------------------------------------------------------------------------------------------------------
// Review, approval, promotion.
// ---------------------------------------------------------------------------------------------------------------

export interface ReviewBundle {
  version: 1;
  pilot_id: string;
  config_id: Sha256;
  candidate_id: Sha256;
  baseline_prompt_id: Sha256;
  pack_id: Sha256;
  replay_id: Sha256;
  experiment_id: Sha256;
  repo: { slug: string; base: string; prompt_path: string; branch: string };
  // Unified diff of the prompt file, baseline to candidate. The only prompt text in the bundle.
  diff: string;
  rationale: string;
  metric: MetricContract;
  replay: {
    tally: ReplayReport["tally"];
    coverage: { paired_cases: number; common_turns: number; excluded: number; diverged: number };
    sign_p: number;
    regressions: TurnRef[];
    fixes: number;
    new_blocking_guard_failures: TurnRef[];
    gate: { eligible: boolean; reasons: string[] };
  };
  experiment: Pick<ExperimentSpec, "arms" | "allocation" | "window" | "analysis_cutoff" | "required_per_arm" | "methods">;
  rollback: ExperimentSpec["rollback"];
}

export interface Approval {
  version: 1;
  pilot_id: string;
  candidate_id: Sha256;
  experiment_id: Sha256;
  review_id: Sha256;
  // What the person approved: starting the customer-run experiment for exactly this candidate.
  scope: "experiment";
  decision: "approved" | "rejected";
  approver: string;
  at: IsoTime;
}

export interface PromotionRequest {
  version: 1;
  base_pack_id: Sha256;
  approver: string;
  at: IsoTime;
  // Cases already in the pack that failed in a stored replay.
  existing: { case_id: string; reason: string; evidence: { replay_id: Sha256; turn: number; check_id: string } }[];
  // New redacted failure cases, e.g. from the experiment period. `case.provenance` and `case.regression` are set by
  // the promotion, so they are not given here.
  added: { case: Omit<PackCase, "provenance" | "regression">; reason: string; evidence: { experiment_id: Sha256 } }[];
}

export interface PromotionRecord {
  version: 1;
  request_id: Sha256;
  base_pack_id: Sha256;
  new_pack_id: Sha256;
  approver: string;
  at: IsoTime;
  promoted: { case_id: string; split: Split; kind: "existing" | "added" }[];
}
