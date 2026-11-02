export const STATE_BRANCH = "synthe/state";
export const GOAL_FILE = "synthe.json";

export type Delimiter = "`" | '"' | "'" | '"""';

export type PromptLocation =
  | { kind: "file"; path: string }
  | { kind: "inline"; path: string; delimiter: Delimiter; initial: string };

export interface Goal {
  version: 1;
  prompt: PromptLocation;
  objective: string;
  policy?: string; // the business rules the agent must follow, so the judge can tell what is and isn't allowed
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
  };
  budget: { max_usd: number };
}

export const DEFAULTS = {
  models: { writer: "claude-sonnet-5-5", runner: "claude-haiku-5-5", judge: "claude-haiku-5-5", checker: "claude-sonnet-5-5" },
  merge_rule: { mode: "auto" as "auto" | "propose", min_improvement: 2, max_p: 0.05, noise_margin: 3, max_rounds: 12, stall_rounds: 3 },
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
  if (typeof g.scenarios !== "string") bad("scenarios path is required");
  if (!(g.budget?.max_usd > 0)) bad("budget.max_usd must be above 0");
  if (g.merge_rule?.mode !== undefined && g.merge_rule.mode !== "auto" && g.merge_rule.mode !== "propose") bad("merge_rule.mode must be auto or propose");
  return {
    ...g,
    guardrails: g.guardrails ?? [],
    models: { ...DEFAULTS.models, ...g.models },
    merge_rule: { ...DEFAULTS.merge_rule, ...g.merge_rule },
  };
}

export interface Scenario { id: string; input: string; expected: string; split: "train" | "holdout" }

export function parseScenarios(text: string): Scenario[] {
  const rows: Scenario[] = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  for (const s of rows) {
    if (!s.id || !s.input || !s.expected || (s.split !== "train" && s.split !== "holdout")) {
      throw new Error(`scenario ${s.id ?? "?"} needs id, input, expected and split`);
    }
  }
  if (!rows.some((s) => s.split === "train") || !rows.some((s) => s.split === "holdout")) {
    throw new Error("scenarios need both train and holdout rows");
  }
  // Fewer can never clear the merge rule: even 4 wins and no losses could be chance.
  if (rows.filter((s) => s.split === "train").length < 5) throw new Error("scenarios need at least 5 train rows");
  return rows;
}
