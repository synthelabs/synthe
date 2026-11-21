// The shared types of `synthe solve`. swarm/GOAL.md fixes the problem file, the proposer protocol and result.json;
// the types here mirror that contract. Each module in this folder owns one concern and meets the others only here.

export type Direction = "higher" | "lower";

export interface CommandMeasure { command: string; direction: Direction; unit?: string; runs: number }
export interface JudgeMeasure { judge: { cases: string; run: string; compare: string | "model" }; runs: number }
export type Measure = CommandMeasure | JudgeMeasure;
export const isJudged = (m: Measure): m is JudgeMeasure => "judge" in m;

// GOAL-2.md: provider defaults to "openai-compatible" when base_url is set, else "anthropic". base_url is set for
// "openai-compatible" and optional for "anthropic" (unused: SYNTHE_ANTHROPIC_BASE_URL points tests at a fake).
export interface ModelPrices { input_per_mtok: number; output_per_mtok: number }
export interface ModelConfig { provider: "anthropic" | "openai-compatible"; base_url?: string; model: string; prices?: ModelPrices }

// A validated problem file, with the defaults filled in. `dir` is the folder that holds the file and `file` is
// its absolute path; every path and glob in the problem is relative to `dir`.
export interface Problem {
  version: 1;
  name: string;
  goal: string;
  artifact: string[];
  protect: string[];
  measure: Measure;
  guards: string[];
  split: { holdout: boolean };
  proposer: { command: string } | "model";
  // max_usd (GOAL-2.md): stop before a model call that would take the known cost above it. Needs model.prices.
  budget: { max_rounds: number; max_calls: number | null; max_usd?: number };
  model?: ModelConfig;
  candidates: number;
  dir: string;
  file: string;
}

export const DEFAULT_RUNS = 3;
export const DEFAULT_MAX_ROUNDS = 6;
export const MAX_MISSES = 3;

// The proposer protocol (GOAL.md, "The proposer protocol").
export interface ProposerFile { path: string; text: string }
export interface HistoryEntry { round: number; summary: string; kept: boolean; reason: string }
export interface ProposerRequest { round: number; goal: string; files: ProposerFile[]; history: HistoryEntry[]; candidates: number }
export interface Edit { path: string; search: string; replace: string }
export interface Proposal { summary: string; edits: Edit[] }
// `failed` is a plain reason: the reply was not valid JSON, had the wrong shape, or the command failed.
// A failed reply is one failed attempt in the history. It never crashes the run.
// `summary` is set when one proposal in the reply was malformed and it had a summary.
export type ProposerReply = { proposals: Proposal[] } | { failed: string; summary?: string };
// `calls` is how many model calls the request used (0 for an outside command); the loop counts it against max_calls.
export interface Proposer { propose(request: ProposerRequest): Promise<{ reply: ProposerReply; calls: number }> }

// One measurement of one version of the files. `value` is the summary the report shows (the median of `runs`).
// `train` is what the proposer may hear about; holdout numbers stay inside the loop.
export interface Measurement { value: number; runs: number[] }

// The keep rule's answer. `reason` is a plain sentence for the history, result.json and report.md.
export interface Decision { keep: boolean; reason: string }

// One row of result.json's `attempts`. `before` and `after` are absent when the attempt was never measured.
export interface Attempt { round: number; summary: string; kept: boolean; reason: string; before?: number; after?: number }

// GOAL-2.md: model calls of every kind and their tokens. usd is null when calls were made without model.prices.
export interface SolveCost { calls: number; input_tokens: number; output_tokens: number; usd: number | null }

export interface SolveResult {
  problem: string;
  stopped: string;
  baseline: number;
  final: number;
  branch: string | null;
  attempts: Attempt[];
  cost?: SolveCost;
}

// `resume`: go on with the most recent run of the problem when it stopped before its own stop rule (GOAL-2.md).
export interface SolveOptions { out?: string; seed?: number; resume?: boolean }

// Every problem found in a problem file, one line each, each line names the field.
export type ProblemCheck = { ok: true; problem: Problem } | { ok: false; problems: string[] };
