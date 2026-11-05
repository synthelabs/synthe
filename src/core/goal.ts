export const STATE_BRANCH = "synthe/state";
export const GOAL_FILE = "synthe.json";
export const MAX_CHECKS = 5;

export type Delimiter = "`" | '"' | "'" | '"""';

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
  guardrails: string[];
  scenarios: string;
  models: { writer: string; runner: string; judge: string; checker: string };
  merge_rule: {
    mode: "auto" | "propose"; // propose: open the winning pull request and leave the merge to a person
    min_improvement: number; // points out of 100, on both training and held-back scenarios
    max_p: number; // how likely a win may be by chance, from scenario wins and losses
    noise_margin: number; // points below the replaced prompt before a merge is reverted
    max_rounds: number;
    stall_rounds: number; // rounds in a row without a winner before stopping
    guard_margin: number; // points the guard pass rate may fall before a change is refused, when counter_checks are set
  };
  budget: { max_usd: number };
}

export const DEFAULTS = {
  models: { writer: "claude-sonnet-5-5", runner: "claude-haiku-5-5", judge: "claude-haiku-5-5", checker: "claude-sonnet-5-5" },
  merge_rule: { mode: "auto" as "auto" | "propose", min_improvement: 2, max_p: 0.05, noise_margin: 3, max_rounds: 12, stall_rounds: 3, guard_margin: 3 },
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
  if (typeof g.scenarios !== "string") bad("scenarios path is required");
  if (!(g.budget?.max_usd > 0)) bad("budget.max_usd must be above 0");
  if (g.merge_rule?.mode !== undefined && g.merge_rule.mode !== "auto" && g.merge_rule.mode !== "propose") bad("merge_rule.mode must be auto or propose");
  const margin = g.merge_rule?.guard_margin;
  if (margin !== undefined && !(typeof margin === "number" && Number.isFinite(margin) && margin >= 0)) bad("merge_rule.guard_margin must be 0 or more");
  return {
    ...g,
    guardrails: g.guardrails ?? [],
    models: { ...DEFAULTS.models, ...g.models },
    merge_rule: { ...DEFAULTS.merge_rule, ...g.merge_rule },
  };
}

export interface Scenario { id: string; input: string; expected: string; split: "train" | "holdout" }

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
    if (s?.split !== "train" && s?.split !== "holdout") problems.push(`"split" must be "train" or "holdout"`);
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
