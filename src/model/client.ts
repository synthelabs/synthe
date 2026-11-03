import Anthropic from "@anthropic-ai/sdk";
import { costUsd } from "../core/cost.ts";

// allowCutOff: a reply that ran into maxTokens is returned as it is (truncated: true) instead of as null. Only for plain
// text the caller can judge as it stands; a cut-off JSON reply is broken, so JSON callers never set it.
export interface Ask { model: string; system?: string; user: string; maxTokens: number; schema?: Record<string, unknown>; allowCutOff?: boolean }
export interface Reply { text: string | null; costUsd: number | null; truncated?: boolean }
export interface Model { ask(a: Ask): Promise<Reply> }

export function anthropicModel(apiKey: string): Model {
  const client = new Anthropic({ apiKey, maxRetries: 4 });
  return {
    async ask({ model, system, user, maxTokens, schema, allowCutOff }) {
      const res = await client.messages.create({
        model, max_tokens: maxTokens, system,
        messages: [{ role: "user", content: user }],
        // Haiku's thinking would spend the output limit on short scoring calls.
        ...(model.startsWith("claude-haiku") ? { thinking: { type: "disabled" as const } } : {}),
        output_config: { effort: "low", ...(schema ? { format: { type: "json_schema" as const, schema } } : {}) },
      });
      const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const finished = res.stop_reason === "end_turn" && text.length > 0;
      const cutOff = allowCutOff === true && res.stop_reason === "max_tokens" && text.length > 0;
      return { text: finished || cutOff ? text : null, costUsd: costUsd(model, res.usage), ...(cutOff ? { truncated: true } : {}) };
    },
  };
}

export async function askJson<T>(model: Model, a: Ask): Promise<{ value: T | null; costUsd: number | null }> {
  const reply = await model.ask(a);
  if (reply.text === null) return { value: null, costUsd: reply.costUsd };
  try {
    return { value: JSON.parse(reply.text) as T, costUsd: reply.costUsd };
  } catch {
    return { value: null, costUsd: reply.costUsd };
  }
}

export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }));
  return results;
}

// What a team should do about a failed model call, in plain words. Null when it isn't a known problem with the key or
// the API, so the caller shows the raw error.
export function modelProblem(e: unknown): string | null {
  const err = e as { status?: unknown; message?: unknown } | null;
  const status = typeof err?.status === "number" ? err.status : null;
  const text = typeof err?.message === "string" ? err.message : "";
  if (status === 401) return "Your Synthe key was rejected. Check you copied all of it (it starts with sk-ant-), or ask the Synthe table for a new one.";
  if (/credit balance is too low/i.test(text)) return "Your Synthe key has no credit left. Ask the Synthe table for a new key.";
  if (/usage limit|spend limit/i.test(text)) return "Your Synthe key has reached its spending limit. Ask the Synthe table for a new key.";
  if (status === 403) return "Your Synthe key isn't allowed to use this model. Ask the Synthe table for a new key.";
  if (status === 429 || status === 529 || (status !== null && status >= 500)) return "Anthropic's API is busy right now. Wait a few minutes and try again.";
  if (e instanceof Anthropic.APIConnectionError) return "Couldn't reach Anthropic's API. Check your internet connection and try again.";
  return null;
}
