// USD per million tokens. An unlisted model has an unknown cost, so its round cannot merge.
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
  // Teams still on Sonnet 4.5 need a price to see what moving off it (it retires 2026-11-30) would cost.
  "claude-sonnet-4-5": { input: 3, output: 15 },
};

export const knownModels = () => Object.keys(PRICES);

export interface Usage { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }

export function costUsd(model: string, usage: Usage | null | undefined): number | null {
  const base = PRICES[model];
  if (!base || !usage || usage.input_tokens == null || usage.output_tokens == null) return null;
  const totalInput = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const price = model === "claude-haiku-5-5" && totalInput > 100_000 ? { input: 0.5, output: 2.5 } : base;
  const input = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) * 1.25 + (usage.cache_read_input_tokens ?? 0) * 0.1;
  return (input * price.input + usage.output_tokens * price.output) / 1_000_000;
}

// Adds costs, staying null once any call's cost is unknown.
export function sumCosts(costs: (number | null)[]): number | null {
  let total = 0;
  for (const c of costs) {
    if (c === null) return null;
    total += c;
  }
  return total;
}
