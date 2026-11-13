// The settings for one live experiment. Every setting has a default, so a team
// that sets nothing gets the same rule. Each change is checked here, so a bad
// value fails before any run starts and says which setting to fix.

export type Method = "fixed" | "looks";

export interface LiveRule {
  alpha: number;
  method: Method;
  looks: number; // used only by "looks"
  min_days: number;
  max_days: number;
  min_units_per_arm: number;
  min_events_per_arm: number; // rates only
  srm_p: number; // 0 turns the split check off
  aa_first: boolean;
  holdout_share: number; // 0 turns the holdout off
}

export const DEFAULT_RULE: Readonly<LiveRule> = Object.freeze({
  alpha: 0.05,
  method: "fixed",
  looks: 4,
  min_days: 7,
  max_days: 28,
  min_units_per_arm: 100,
  min_events_per_arm: 25,
  srm_p: 0.001,
  aa_first: true,
  holdout_share: 0.05,
});

const KEYS = Object.keys(DEFAULT_RULE) as (keyof LiveRule)[];

// A value's type is checked with the same message as a bad value: the person
// needs the setting name and the allowed range, not the JavaScript type.
function isWhole(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function resolveRule(partial?: Partial<LiveRule>): { rule: LiveRule; changed: string[] } {
  const given: Partial<Record<keyof LiveRule, unknown>> = {};
  for (const [key, value] of Object.entries(partial ?? {})) {
    if (value === undefined) continue;
    if (!KEYS.includes(key as keyof LiveRule)) throw new Error(`unknown setting: ${key}`);
    given[key as keyof LiveRule] = value;
  }

  const rule = { ...DEFAULT_RULE, ...given } as LiveRule;

  if (!(isNumber(rule.alpha) && rule.alpha > 0 && rule.alpha < 1)) {
    throw new Error("alpha must be above 0 and below 1.");
  }
  if (rule.method !== "fixed" && rule.method !== "looks") {
    throw new Error("method must be fixed or looks.");
  }
  if (!(Number.isInteger(rule.looks) && rule.looks >= 1 && rule.looks <= 60)) {
    throw new Error("looks must be a whole number from 1 to 60.");
  }
  if (!(isNumber(rule.min_days) && rule.min_days >= 0)) {
    throw new Error("min_days must be 0 or more.");
  }
  // Checked against the effective min_days, so a max_days below the default
  // min_days is caught too.
  if (!(isNumber(rule.max_days) && rule.max_days >= rule.min_days)) {
    throw new Error("max_days must be at least min_days.");
  }
  if (!isWhole(rule.min_units_per_arm)) {
    throw new Error("min_units_per_arm must be a whole number, 0 or more.");
  }
  if (!isWhole(rule.min_events_per_arm)) {
    throw new Error("min_events_per_arm must be a whole number, 0 or more.");
  }
  if (!(isNumber(rule.srm_p) && rule.srm_p >= 0 && rule.srm_p < 1)) {
    throw new Error("srm_p must be 0 or more and below 1.");
  }
  if (typeof rule.aa_first !== "boolean") {
    throw new Error("aa_first must be true or false.");
  }
  if (!(isNumber(rule.holdout_share) && rule.holdout_share >= 0 && rule.holdout_share <= 0.5)) {
    throw new Error("holdout_share must be from 0 to 0.5.");
  }

  const changed = (Object.keys(given) as (keyof LiveRule)[])
    .filter((key) => given[key] !== DEFAULT_RULE[key])
    .sort();

  return { rule, changed };
}
