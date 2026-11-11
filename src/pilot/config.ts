import { promptPathProblem } from "../core/safety.ts";
import { PilotError } from "./errors.ts";
import { ms } from "./ids.ts";
import { unsafeKey } from "./io.ts";
import { parseMetricContract } from "./metric.ts";
import type { PilotConfig, ProviderApproval, ReplayConfig } from "./types.ts";

export const CONFIG_FILE = "pilot.json";
export const GITHUB_API = "https://api.github.com";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const bad = (why: string): never => { throw new PilotError("invalid_config", `${CONFIG_FILE}: ${why}`); };
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, name: string): string => (typeof v === "string" && v.trim() ? v : bad(`${name} is required`));
const int = (v: unknown, name: string, min: number, max: number): number =>
  (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : bad(`${name} must be a whole number from ${min} to ${max}`));
const fraction = (v: unknown, name: string): number =>
  (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1 ? v : bad(`${name} must be a number from 0 to 1`));

// A typo in a key (for example `min_paired_case`) must not silently fall back to a default, so unknown keys are refused.
function onlyKeys(value: Record<string, unknown>, allowed: string[], where: string): void {
  const extra = Object.keys(value).find((k) => !allowed.includes(k));
  if (extra !== undefined) bad(`${where} has an unknown field "${extra}"`);
}

export const isLoopback = (url: string): boolean => {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && LOOPBACK.has(u.hostname);
  } catch { return false; }
};

function parseReplay(v: unknown): ReplayConfig {
  if (!isObject(v)) return bad("replay is required");
  onlyKeys(v, ["model", "max_tokens", "temperature", "max_steps_per_turn", "gate", "min_recurring_cases", "max_changed_lines"], "replay");
  const gate = v.gate;
  if (!isObject(gate)) return bad("replay.gate is required");
  onlyKeys(gate, ["min_paired_cases", "min_paired_coverage", "min_net_wins", "max_unchecked_blocking_guards"], "replay.gate");
  const temperature = v.temperature === null ? null : fraction(v.temperature, "replay.temperature");
  return {
    model: text(v.model, "replay.model"),
    max_tokens: int(v.max_tokens, "replay.max_tokens", 1, 16000),
    temperature,
    max_steps_per_turn: int(v.max_steps_per_turn, "replay.max_steps_per_turn", 1, 12),
    gate: {
      min_paired_cases: int(gate.min_paired_cases, "replay.gate.min_paired_cases", 1, 100000),
      min_paired_coverage: fraction(gate.min_paired_coverage, "replay.gate.min_paired_coverage"),
      min_net_wins: int(gate.min_net_wins, "replay.gate.min_net_wins", 1, 100000),
      max_unchecked_blocking_guards: int(gate.max_unchecked_blocking_guards, "replay.gate.max_unchecked_blocking_guards", 0, 100000),
    },
    min_recurring_cases: int(v.min_recurring_cases, "replay.min_recurring_cases", 2, 100000),
    max_changed_lines: int(v.max_changed_lines, "replay.max_changed_lines", 1, 200),
  };
}

function parseProvider(v: unknown): ProviderApproval | null {
  if (v === null) return null;
  if (!isObject(v)) return bad("provider must be null (scripted models only) or an approval object");
  onlyKeys(v, ["provider", "endpoint", "model", "key_env", "data_class", "approved_by", "approved_at", "max_calls", "max_input_chars"], "provider");
  if (v.provider !== "anthropic") bad('provider.provider must be "anthropic"');
  const endpoint = text(v.endpoint, "provider.endpoint");
  let url: URL;
  try { url = new URL(endpoint); } catch { return bad("provider.endpoint must be a URL"); }
  // Plain http would send conversation text in the clear; only a loopback test server may use it.
  if (url.protocol !== "https:" && !isLoopback(endpoint)) bad("provider.endpoint must be https");
  if (url.username || url.password || url.search || url.hash) bad("provider.endpoint must be a plain base URL with no credentials or query");
  const keyEnv = text(v.key_env, "provider.key_env");
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(keyEnv)) bad("provider.key_env must be the name of one environment variable, in capitals");
  const approvedAt = text(v.approved_at, "provider.approved_at");
  if (Number.isNaN(ms(approvedAt))) bad("provider.approved_at must be a UTC time like 2026-10-01T00:00:00Z");
  return {
    provider: "anthropic", endpoint, model: text(v.model, "provider.model"), key_env: keyEnv,
    data_class: text(v.data_class, "provider.data_class"), approved_by: text(v.approved_by, "provider.approved_by"), approved_at: approvedAt,
    max_calls: int(v.max_calls, "provider.max_calls", 1, 100000), max_input_chars: int(v.max_input_chars, "provider.max_input_chars", 1, 500_000_000),
  };
}

// Parses pilot.json. Throws PilotError invalid_config (or invalid_metric, from the metric contract).
export function parsePilotConfig(source: string): PilotConfig {
  let v: unknown;
  try { v = JSON.parse(source); } catch { return bad("not valid JSON"); }
  if (!isObject(v)) return bad("must be a JSON object");
  const unsafe = unsafeKey(v);
  if (unsafe) bad(`has a field named "${unsafe}", which is not allowed`);
  onlyKeys(v, ["version", "pilot_id", "agent", "repo", "metric", "replay", "provider"], "the file");
  if (v.version !== 1) bad("version must be 1");
  const pilotId = text(v.pilot_id, "pilot_id");
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(pilotId)) bad("pilot_id must be 3 to 40 lowercase letters, digits or dashes");

  const agent = v.agent;
  if (!isObject(agent)) return bad("agent is required");
  onlyKeys(agent, ["name", "prompt_path", "baseline_tag"], "agent");
  const promptPath = text(agent.prompt_path, "agent.prompt_path");
  const pathProblem = promptPathProblem(promptPath);
  if (pathProblem) bad(`agent.prompt_path: ${pathProblem}`);
  const baselineTag = text(agent.baseline_tag, "agent.baseline_tag");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(baselineTag)) bad("agent.baseline_tag must be 1 to 64 letters, digits, dots, dashes or underscores");

  const repo = v.repo;
  if (!isObject(repo)) return bad("repo is required");
  onlyKeys(repo, ["slug", "base", "api"], "repo");
  const slug = text(repo.slug, "repo.slug");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(slug)) bad("repo.slug must look like owner/name");
  const base = text(repo.base, "repo.base");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(base) || base.includes("..")) bad("repo.base must be a branch name");
  let api: string | undefined;
  if (repo.api !== undefined) {
    api = text(repo.api, "repo.api");
    // Only the real GitHub API or a loopback stand-in: the pull request body must never go to another host.
    if (api !== GITHUB_API && !isLoopback(api)) bad(`repo.api must be ${GITHUB_API} or a loopback address`);
  }

  if (!("provider" in v)) bad("provider is required: null means only scripted models run and nothing is sent to a model provider");
  return {
    version: 1, pilot_id: pilotId,
    agent: { name: text(agent.name, "agent.name"), prompt_path: promptPath, baseline_tag: baselineTag },
    repo: { slug, base, ...(api !== undefined ? { api } : {}) },
    metric: parseMetricContract(v.metric),
    replay: parseReplay(v.replay),
    provider: parseProvider(v.provider),
  };
}
