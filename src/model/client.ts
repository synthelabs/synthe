import Anthropic from "@anthropic-ai/sdk";
import { costUsd } from "../core/cost.ts";

export interface Ask { model: string; system?: string; user: string; maxTokens: number; schema?: Record<string, unknown> }
export interface Reply { text: string | null; costUsd: number | null }
export interface Model { ask(a: Ask): Promise<Reply> }

export function anthropicModel(apiKey: string): Model {
  const client = new Anthropic({ apiKey, maxRetries: 4 });
  return {
    async ask({ model, system, user, maxTokens, schema }) {
      const res = await client.messages.create({
        model, max_tokens: maxTokens, system,
        messages: [{ role: "user", content: user }],
        // Haiku's thinking would spend the output limit on short scoring calls.
        ...(model.startsWith("claude-haiku") ? { thinking: { type: "disabled" as const } } : {}),
        output_config: { effort: "low", ...(schema ? { format: { type: "json_schema" as const, schema } } : {}) },
      });
      const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const finished = res.stop_reason === "end_turn" && text.length > 0;
      return { text: finished ? text : null, costUsd: costUsd(model, res.usage) };
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
