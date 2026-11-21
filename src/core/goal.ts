export const STATE_BRANCH = "synthe/state";
export const GOAL_FILE = "synthe.json";
export const MAX_CHECKS = 5;

export type Delimiter = "`" | '"' | "'" | '"""';

// Which API Synthe's model calls go to. Absent means Anthropic, exactly as before this field existed.
// prices (openai-compatible only): USD per million tokens for each model the goal names. Synthe can't
// check other providers' current prices, so the team supplies them (see src/core/cost.ts).
export interface ModelPrice { input: number; output: number }
export type Provider =
  | { kind: "anthropic" }
  // max_requests_per_minute: Synthe spaces its requests to stay under it and sends fewer at once (free tiers).
  // reasoning_effort: sent with every request, for models that think by default (Gemini through a preset).
  | { kind: "openai-compatible"; base_url: string; prices?: Record<string, ModelPrice>; max_requests_per_minute?: number; reasoning_effort?: ReasoningEffort };
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export type OtherProvider = Extract<Provider, { kind: "openai-compatible" }>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
export const isLoopback = (url: URL) => LOOPBACK_HOSTS.has(url.hostname);

// The key is sent to this URL, so it must be https, or http only to a server on this machine (Ollama, LM Studio).
// Null when it is fine, otherwise what is wrong in plain words.
export function baseUrlProblem(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return "provider.base_url is required for an openai-compatible provider, for example https://api.openai.com/v1";
  let url: URL;
  try { url = new URL(value.trim()); } catch { return `provider.base_url "${value.slice(0, 80)}" isn't a URL. Use the provider's OpenAI-compatible address, for example https://api.openai.com/v1`; }
  if (url.username || url.password) return "provider.base_url must not contain a user name or password. Synthe sends the key in a header, never in the URL.";
  if (url.search || url.hash) return "provider.base_url must not have a query string or # part. Synthe sends the key in a header, never in the URL.";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && isLoopback(url)) return null;
  if (url.protocol === "http:") return "provider.base_url must use https. Plain http is allowed only for a server on this machine (localhost, 127.0.0.1 or [::1]), because the key travels with every request.";
  return "provider.base_url must start with https://";
}

// The models a goal names whose cost Synthe can't count on: no price, or a price of 0 for both input and output.
export function unpricedModels(models: Partial<Goal["models"]>, provider: { prices?: Record<string, ModelPrice> }): string[] {
  const names = [...new Set([models.writer, models.runner, models.judge, models.checker].filter((m): m is string => typeof m === "string"))];
  return names.filter((m) => { const p = provider.prices?.[m]; return !p || (p.input === 0 && p.output === 0); });
}

// How reports name where model calls go: Anthropic, as always, or the host in provider.base_url.
export function apiName(provider?: Provider): string {
  if (provider?.kind !== "openai-compatible") return "Anthropic's API";
  try { return `the model API at ${new URL(provider.base_url).host}`; } catch { return "your model provider's API"; }
}

export type PromptLocation =
  | { kind: "file"; path: string }
  | { kind: "inline"; path: string; delimiter: Delimiter; initial: string };

export interface Goal {
  version: 1;
  prompt: PromptLocation;
  objective: string;
  policy?: string; // the business rules the agent must follow, so the judge can tell what is and isn't allowed
  // What the agent is for, from the team's repo and confirmed by them, so test cases and judging fit the real app.
  brief?: string;
  // The team's own measure of a good reply: plain sentences, each checkable from one reply. On every test case, the
  // reply that fails fewer of them wins; the AI judge only breaks ties.
  checks?: string[];
  // Guards: one plain sentence per check about what a padded or gamed reply gets wrong (for example "Stays on the
  // customer's question instead of adding filler"). They only measure: a change that passes more checks but fails
  // guards more often by more than merge_rule.guard_margin isn't merged. They never pick a winner.
  counter_checks?: string[];
  share?: "none" | "numbers" | "detail" | "full";
  share_notice?: string; // version of the sharing notice the team saw at setup, so a shared record ties to that text
  guardrails: string[];
  scenarios: string;
  models: { writer: string; runner: string; judge: string; checker: string };
  merge_rule: {
    mode: "auto" | "propose"; // propose: open the winning pull request and leave the merge to a person
    min_improvement: number; // points out of 100, on both training and held-back scenarios
    max_p: number; // how likely a win may be by chance, from scenario wins and losses
    // The same sign-test limit on the held-back scenarios. Before this, the held-back check was only "the mean is
    // ahead by min_improvement", which a change with no real effect passes about half the time.
    holdout_max_p: number;
    noise_margin: number; // points below the replaced prompt before a merge is reverted
    max_rounds: number;
    stall_rounds: number; // rounds in a row without a winner before stopping
    guard_margin: number; // points the guard pass rate may fall before a change is refused, when counter_checks are set
    // Optional cap on the chance that a whole run merges at least one change that does nothing. Unset, the limits
    // above apply as they are. Set, the held-back limit tightens to fit it (see src/core/run-alpha.ts).
    run_alpha?: number;
    // Off by default. When on, rounds after a stall try one deletion, merged if it is no worse (src/loop/shorter.ts).
    allow_shorter?: boolean;
  };
  // max_calls: a hard stop after this many model calls in a run, counted across every step. Required when a model's
  // price is unknown or zero, since a free key can be on a paid plan and then max_usd would never stop anything.
  budget: { max_usd: number; max_calls?: number };
  // Compose (prototype, off by default): after scoring, write one more candidate from how this round's candidates
  // behaved differently, and judge it by the same merge rule. See src/loop/compose.ts.
  compose?: boolean;
  // Population (prototype, off by default): keep changes that won some training cases without winning the round, and
  // each round add one candidate that combines them, judged by the same merge rule. See src/loop/pool.ts.
  population?: boolean;
  // Optional. Absent means Anthropic with Synthe's default models and prices.
  provider?: Provider;
}

export const DEFAULTS = {
  models: { writer: "claude-sonnet-5-5", runner: "claude-haiku-5-5", judge: "claude-haiku-5-5", checker: "claude-sonnet-5-5" },
  merge_rule: { mode: "auto" as "auto" | "propose", min_improvement: 2, max_p: 0.05, holdout_max_p: 0.1, noise_margin: 3, max_rounds: 12, stall_rounds: 3, guard_margin: 3 },
  budget: { max_usd: 3 },
};

export function parseGoal(text: string): Goal {
  const g = JSON.parse(text);
  const bad = (why: string): never => { throw new Error(`${GOAL_FILE}: ${why}`); };
  if (g?.version !== 1) bad("version must be 1");
  if (!g.prompt?.path || typeof g.prompt.path !== "string") bad("prompt.path is required");
  if (g.prompt.kind !== "file" && g.prompt.kind !== "inline") bad("prompt.kind must be file or inline");
  if (g.prompt.kind === "inline" && (!g.prompt.initial || !g.prompt.delimiter)) bad("inline prompts need initial and delimiter");
  if (!g.objective || typeof g.objective !== "string") bad("objective is required");
  if (g.policy !== undefined && typeof g.policy !== "string") bad("policy must be text");
  if (g.brief !== undefined && typeof g.brief !== "string") bad("brief must be text");
  if (g.checks !== undefined && (!Array.isArray(g.checks) || g.checks.length > MAX_CHECKS || g.checks.some((c: unknown) => typeof c !== "string" || !c.trim() || c.length > 300))) {
    bad(`checks must be a list of up to ${MAX_CHECKS} sentences`);
  }
  if (g.counter_checks !== undefined) {
    const list = g.counter_checks;
    if (!Array.isArray(list) || list.length > MAX_CHECKS || list.some((c: unknown) => typeof c !== "string" || !c.trim() || c.length > 300)) {
      bad(`counter_checks must be a list of up to ${MAX_CHECKS} sentences`);
    }
    // A guard that repeats a check measures nothing the check doesn't already.
    const own = new Set((g.checks ?? []).map((c: string) => c.trim().toLowerCase()));
    const same = list.find((c: string) => own.has(c.trim().toLowerCase()));
    if (same !== undefined) bad(`counter_checks repeats a check ("${same.slice(0, 60)}"); a guard should catch a reply that games that check, not restate it`);
    // A guard listed twice is marked and counted twice, so it weighs double in the guard rate for no reason.
    const seen = new Set<string>();
    const dup = list.find((c: string) => { const key = c.trim().toLowerCase(); if (seen.has(key)) return true; seen.add(key); return false; });
    if (dup !== undefined) bad(`counter_checks lists the same guard twice ("${dup.slice(0, 60)}"); each guard should appear once`);
  }
  if (g.share !== undefined && !["none", "numbers", "detail", "full"].includes(g.share)) bad("share must be none, numbers, detail or full");
  if (g.share_notice !== undefined && typeof g.share_notice !== "string") bad("share_notice must be text");
  if (typeof g.scenarios !== "string") bad("scenarios path is required");
  if (!(g.budget?.max_usd > 0)) bad("budget.max_usd must be above 0");
  if (g.budget.max_calls !== undefined && !(Number.isInteger(g.budget.max_calls) && g.budget.max_calls > 0)) bad("budget.max_calls must be a whole number above 0, for example 500");
  if (g.merge_rule?.mode !== undefined && g.merge_rule.mode !== "auto" && g.merge_rule.mode !== "propose") bad("merge_rule.mode must be auto or propose");
  const holdP = g.merge_rule?.holdout_max_p;
  if (holdP !== undefined && !(typeof holdP === "number" && Number.isFinite(holdP) && holdP > 0 && holdP <= 1)) bad("merge_rule.holdout_max_p must be above 0 and at most 1");
  const runAlpha = g.merge_rule?.run_alpha;
  if (runAlpha !== undefined && !(typeof runAlpha === "number" && Number.isFinite(runAlpha) && runAlpha > 0 && runAlpha <= 1)) bad("merge_rule.run_alpha must be above 0 and at most 1, for example 0.05");
  const margin = g.merge_rule?.guard_margin;
  if (margin !== undefined && !(typeof margin === "number" && Number.isFinite(margin) && margin >= 0)) bad("merge_rule.guard_margin must be 0 or more");
  if (g.merge_rule?.allow_shorter !== undefined && typeof g.merge_rule.allow_shorter !== "boolean") bad("merge_rule.allow_shorter must be true or false");
  if (g.compose !== undefined && typeof g.compose !== "boolean") bad("compose must be true or false");
  if (g.population !== undefined && typeof g.population !== "boolean") bad("population must be true or false");
  if (g.provider !== undefined) {
    const p = g.provider;
    if (!p || typeof p !== "object" || Array.isArray(p)) bad('provider must be an object, for example { "kind": "openai-compatible", "base_url": "https://api.openai.com/v1" }');
    if (p.kind !== "anthropic" && p.kind !== "openai-compatible") bad("provider.kind must be anthropic or openai-compatible");
    if (p.kind === "openai-compatible") { const why = baseUrlProblem(p.base_url); if (why) bad(why); }
    if (p.kind === "anthropic" && p.base_url !== undefined) bad("provider.base_url is only for an openai-compatible provider; an Anthropic key is only ever sent to Anthropic");
    if (p.kind === "anthropic" && p.prices !== undefined) bad("provider.prices is only for an openai-compatible provider; Synthe already knows Anthropic's prices");
    if (p.prices !== undefined) {
      if (!p.prices || typeof p.prices !== "object" || Array.isArray(p.prices)) bad('provider.prices must map each model to { "input": USD, "output": USD } per million tokens');
      for (const [model, price] of Object.entries(p.prices as Record<string, any>)) {
        const ok = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
        if (!price || !ok(price.input) || !ok(price.output)) bad(`provider.prices.${model} needs "input" and "output": USD per million tokens, 0 or more`);
      }
    }
    // Every role's model on another provider needs a name Synthe can't guess.
    if (p.kind === "openai-compatible") {
      const missing = (["writer", "runner", "judge", "checker"] as const).filter((role) => typeof g.models?.[role] !== "string" || !g.models[role].trim());
      if (missing.length) bad(`an openai-compatible provider needs every model named in "models": ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing. Synthe's defaults are Claude models.`);
      const rpm = p.max_requests_per_minute;
      if (rpm !== undefined && !(typeof rpm === "number" && Number.isFinite(rpm) && rpm > 0)) bad("provider.max_requests_per_minute must be a number above 0");
      if (p.reasoning_effort !== undefined && !REASONING_EFFORTS.includes(p.reasoning_effort)) bad(`provider.reasoning_effort must be one of ${REASONING_EFFORTS.join(", ")}`);
      // An unknown or zero price never counts as safe: only a call cap can stop such a run.
      const unpriced = unpricedModels(g.models, p);
      if (unpriced.length && g.budget.max_calls === undefined) bad(`${unpriced.join(", ")} ${unpriced.length === 1 ? "has" : "have"} no price, or a price of 0, in provider.prices, so budget.max_usd can't stop the run. Set budget.max_calls (the most model calls a run may make, for example 500), or add real prices: { "input": USD, "output": USD } per million tokens.`);
    }
  }
  return {
    ...g,
    guardrails: g.guardrails ?? [],
    models: { ...DEFAULTS.models, ...g.models },
    merge_rule: { ...DEFAULTS.merge_rule, ...g.merge_rule },
  };
}

// vault: kept out of every round, so picking winners round after round can't slowly fit it the way it can fit the
// held-back cases. Only `npx synthe vault` reads it, once a run is over. Optional.
export interface Scenario { id: string; input: string; expected: string; split: "train" | "holdout" | "vault" }

export function parseScenarios(text: string): Scenario[] {
  const file = ".synthe/scenarios.jsonl"; // named in every message, so a team knows which file to open
  const rows: Scenario[] = [];
  const lineOf = new Map<string, number>();
  text.split("\n").forEach((l, i) => {
    if (!l.trim()) return;
    // Counts blank lines too, so the number matches what an editor shows.
    const line = i + 1;
    let s: any;
    try {
      s = JSON.parse(l);
    } catch (e) {
      throw new Error(`${file} line ${line} isn't valid JSON: ${(e as Error).message}`);
    }
    const problems = ["id", "input", "expected"].filter((k) => !s?.[k]).map((k) => `"${k}" is missing`);
    if (s?.split !== "train" && s?.split !== "holdout" && s?.split !== "vault") problems.push(`"split" must be "train", "holdout" or "vault"`);
    if (problems.length) throw new Error(`${file} line ${line} has a problem: ${problems.join("; ")}.`);
    // Paired comparisons match rows by id, so a repeated id would break scoring later with a vaguer error.
    if (lineOf.has(s.id)) throw new Error(`${file}: lines ${lineOf.get(s.id)} and ${line} both use the id "${s.id}"; give each test case its own id`);
    lineOf.set(s.id, line);
    rows.push(s);
  });
  if (!rows.some((s) => s.split === "train") || !rows.some((s) => s.split === "holdout")) {
    throw new Error("scenarios need both train and holdout rows");
  }
  // Fewer can never clear the merge rule: even 4 wins and no losses could be chance.
  if (rows.filter((s) => s.split === "train").length < 5) throw new Error("scenarios need at least 5 train rows");
  return rows;
}

// The frozen attack set: written once by init, in .synthe/attacks.jsonl next to the scenarios.
// Synthe never edits it after init; teams can. A typo stops the round with a plain error, like scenarios.
export const ATTACKS_FILE = ".synthe/attacks.jsonl";
export const MAX_ATTACKS = 12;

export interface Attack {
  id: string;
  input: string;
  must: string; // one sentence about the reply, written so it can be answered yes or no
}

export function parseAttacks(text: string): Attack[] {
  const file = ATTACKS_FILE;
  const rows: Attack[] = [];
  const seen = new Set<string>();
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error(`${file} line ${i + 1} isn't valid JSON. Fix that line, or delete it.`);
    }
    const { id, input, must } = r as { id?: unknown; input?: unknown; must?: unknown };
    if (typeof id !== "string" || !id.trim()) throw new Error(`${file} line ${i + 1}: every attack needs an id (a short label like a1).`);
    if (seen.has(id.trim())) throw new Error(`${file} line ${i + 1}: the id "${id.trim()}" is used twice; give each attack its own id.`);
    seen.add(id.trim());
    if (typeof input !== "string" || !input.trim()) throw new Error(`${file} line ${i + 1}: every attack needs the message to send.`);
    if (input.trim().length > 1000) throw new Error(`${file} line ${i + 1}: the message is over 1000 characters; shorten it.`);
    if (typeof must !== "string" || !must.trim()) throw new Error(`${file} line ${i + 1}: every attack needs a must sentence: what a good reply must do, written so it can be answered yes or no.`);
    if (must.trim().length > 300) throw new Error(`${file} line ${i + 1}: the must sentence is over 300 characters; shorten it.`);
    rows.push({ id: id.trim(), input: input.trim(), must: must.trim() });
  });
  if (rows.length > MAX_ATTACKS) throw new Error(`${file} has ${rows.length} attacks; Synthe runs at most ${MAX_ATTACKS} per round. Trim the file to the attacks that matter most.`);
  return rows;
}
