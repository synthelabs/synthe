import { sumCosts } from "./cost.ts";
import type { Model } from "../model/client.ts";
import { ProviderError } from "../model/openai-compatible.ts";

// budget.max_calls: the run's hard cap on model calls. A step gets what is left of it; the call that would go past it
// is refused before anything is sent.
export class CallLimitError extends Error {
  maxCalls: number;
  constructor(maxCalls: number) {
    super(`Synthe made the ${maxCalls} model calls this run allows (budget.max_calls in synthe.json), so it stopped. To go on, raise budget.max_calls in synthe.json.`);
    this.maxCalls = maxCalls;
  }
}

// Counts every call a step makes and what they cost, and refuses calls past `left` (Infinity when there is no cap).
export function countCalls(model: Model, left: number, maxCalls?: number) {
  let calls = 0;
  const costs: (number | null)[] = [];
  return {
    model: {
      async ask(a) {
        if (calls >= left) throw new CallLimitError(maxCalls ?? calls);
        calls++;
        const reply = await model.ask(a);
        costs.push(reply.costUsd);
        return reply;
      },
    } as Model,
    calls: () => calls,
    costUsd: () => sumCosts(costs),
  };
}

// A stop that ends a step cleanly, with the round's state intact: the provider's free limit ran out for now ("quota",
// tried again on the next scheduled run), or the run's call cap is reached ("limit", a finished run). Null otherwise.
export interface CleanStop { kind: "quota" | "limit"; step: string; message: string }
export const QUOTA_MESSAGE = "Your provider's free limit is used up for now. Synthe will try again on the next scheduled run.";

export function cleanStop(step: string, e: unknown): CleanStop | null {
  if (e instanceof CallLimitError) return { kind: "limit", step, message: e.message };
  if (e instanceof ProviderError && e.exhausted) return { kind: "quota", step, message: QUOTA_MESSAGE };
  return null;
}
