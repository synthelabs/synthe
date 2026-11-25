import Anthropic from "@anthropic-ai/sdk";
import { costUsd } from "../core/cost.ts";
import { cachedSystem, firstAlone } from "./cache.ts";
import type { Provider } from "../core/goal.ts";
import { openAiCompatibleModel, ProviderError } from "./openai-compatible.ts";

export class MissingKeyError extends Error {}
// provider: from synthe.json. Absent or anthropic is the Anthropic path as before; another provider needs its own key.
export function configuredModel(key: string | undefined, provider?: Provider): Model {
  if (provider?.kind === "openai-compatible") {
    if (key?.trim()) return providerModel(provider, key.trim());
    throw new MissingKeyError(`synthe.json sends model calls to ${providerHost(provider)}, and no key for it is set. On this computer, set SYNTHE_API_KEY. For the GitHub workflow, run \`npx synthe key\` to save it as the SYNTHE_API_KEY secret, and \`npx synthe upgrade\` if your workflow file doesn't pass api-key yet.`);
  }
  if (key?.trim()) return anthropicModel(key.trim());
  throw new MissingKeyError("No Anthropic key is set. Run `npx synthe key` to save one as the repo secret SYNTHE_ANTHROPIC_KEY.");
}

// allowCutOff: a reply that ran into maxTokens is returned as it is (truncated: true) instead of as null. Only for plain
// text the caller can judge as it stands; a cut-off JSON reply is broken, so JSON callers never set it.
export interface Ask { model: string; system?: string; user: string; maxTokens: number; schema?: Record<string, unknown>; allowCutOff?: boolean }
// Tokens one call used. input is the uncached input only. cacheWrite and cacheRead are the prompt-cache tokens
// (Anthropic's cache_creation_input_tokens and cache_read_input_tokens); they are absent when the provider has none.
export interface TokenUsage { input: number; output: number; cacheWrite?: number; cacheRead?: number }
export interface Reply { text: string | null; costUsd: number | null; truncated?: boolean; usage?: TokenUsage; stopReason?: string | null }
export interface Model { ask(a: Ask): Promise<Reply> }

export const ANTHROPIC_API_URL = "https://api.anthropic.com";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

// Where an own key is sent: Anthropic, always. Left to itself the SDK follows ANTHROPIC_BASE_URL, which Claude Code
// and other tools set in the person's shell, so the key would go to that gateway instead. (Passing apiKey already
// keeps ANTHROPIC_AUTH_TOKEN unread; the test checks both.) Tests reach a local fake with SYNTHE_ANTHROPIC_BASE_URL,
// honoured only for a loopback address.
export function ownKeyBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.SYNTHE_ANTHROPIC_BASE_URL?.trim();
  if (!override) return ANTHROPIC_API_URL;
  try {
    const url = new URL(override);
    if ((url.protocol === "http:" || url.protocol === "https:") && LOOPBACK.has(url.hostname)) return override;
  } catch { /* not a URL: Anthropic */ }
  return ANTHROPIC_API_URL;
}

// The team's own key, sent to the provider synthe.json names and nowhere else.
export function providerModel(provider: Provider | undefined, apiKey: string): Model {
  if (provider?.kind === "openai-compatible") return openAiCompatibleModel({ baseUrl: provider.base_url, apiKey, prices: provider.prices, maxRequestsPerMinute: provider.max_requests_per_minute, reasoningEffort: provider.reasoning_effort });
  return anthropicModel(apiKey);
}

// Sends every call to one model, whatever model the caller names. improve asks for Claude models by name; on another
// provider its calls go to the writer model synthe.json names instead.
export function onModel(model: Model, id: string): Model {
  return { ask: (a) => model.ask({ ...a, model: id }) };
}

export function providerHost(provider: Provider | undefined): string {
  if (provider?.kind !== "openai-compatible") return "Anthropic";
  try { return new URL(provider.base_url).host; } catch { return provider.base_url; }
}

// `env` decides only the loopback test override (ownKeyBaseUrl); the key is always the one passed in.
// `transport` replaces the fetch the SDK sends with (solve --record and --replay, src/solve/recording.ts).
export function anthropicModel(apiKey: string, env: NodeJS.ProcessEnv = process.env, transport?: { fetch: typeof fetch; maxRetries?: number }): Model {
  const client = new Anthropic({ apiKey, baseURL: ownKeyBaseUrl(env), maxRetries: transport?.maxRetries ?? 4, ...(transport ? { fetch: transport.fetch } : {}) });
  return sdkModel(client);
}

// Marks the system prompt for prompt caching and sends the first request for each one alone (see cache.ts).
function sdkModel(client: Anthropic): Model {
  const warm = firstAlone();
  return {
    async ask({ model, system, user, maxTokens, schema, allowCutOff }) {
      const send = () => client.messages.create({
        model, max_tokens: maxTokens, system: cachedSystem(system),
        messages: [{ role: "user", content: user }],
        // Haiku's thinking would spend the output limit on short scoring calls.
        ...(model.startsWith("claude-haiku") ? { thinking: { type: "disabled" as const } } : {}),
        output_config: { effort: "low", ...(schema ? { format: { type: "json_schema" as const, schema } } : {}) },
      });
      const res = await warm(model, system, send);
      const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const finished = res.stop_reason === "end_turn" && text.length > 0;
      const cutOff = allowCutOff === true && res.stop_reason === "max_tokens" && text.length > 0;
      return {
        text: finished || cutOff ? text : null, costUsd: costUsd(model, res.usage), ...(cutOff ? { truncated: true } : {}),
        usage: { input: res.usage.input_tokens, output: res.usage.output_tokens, cacheWrite: res.usage.cache_creation_input_tokens ?? 0, cacheRead: res.usage.cache_read_input_tokens ?? 0 }, stopReason: res.stop_reason ?? null,
      };
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
  if (e instanceof ProviderError) return providerProblem(e);
  const err = e as { status?: unknown; message?: unknown } | null;
  const status = typeof err?.status === "number" ? err.status : null;
  const text = typeof err?.message === "string" ? err.message : "";
  if (status === 401) return "Your Anthropic key was rejected. Run `npx synthe key` to replace it.";
  if (/credit balance is too low/i.test(text)) return "Your Anthropic key has no credit left. Run `npx synthe key` to replace it.";
  if (/usage limit|spend limit/i.test(text)) return "Your Anthropic key has reached its spending limit. Run `npx synthe key` to replace it.";
  if (status === 403) return "Your Anthropic key isn't allowed to use this model. Run `npx synthe key` to replace it.";
  if (status === 429 || status === 529 || (status !== null && status >= 500)) return "Anthropic's API is busy right now. Wait a few minutes and try again.";
  if (e instanceof Anthropic.APIConnectionError) return "Couldn't reach Anthropic's API. Check your internet connection and try again.";
  return null;
}

// The same advice for a provider other than Anthropic, naming the host the key went to (provider.base_url).
function providerProblem(e: ProviderError): string {
  const host = e.host;
  if (e.status === null) return e.loopback
    ? `Couldn't reach the model server at ${host}. Start it (for example \`ollama serve\`), or fix provider.base_url in synthe.json, and try again.`
    : `Couldn't reach ${host}. Check your internet connection and provider.base_url in synthe.json, then try again.`;
  if (e.credit) return `Your key for ${host} has no credit left or has reached its spending limit. Add credit with that provider, or run \`npx synthe key\` to replace the key.`;
  // On this computer; the workflow's report says the next scheduled run tries again (QUOTA_MESSAGE).
  if (e.exhausted) return "Your provider's free limit is used up for now. Run the command again later.";
  if (e.status === 401) return `Your key for ${host} was rejected. Run \`npx synthe key\` to replace it.`;
  if (e.status === 402) return `Your key for ${host} has no credit left. Add credit with that provider, or run \`npx synthe key\` to replace the key.`;
  if (e.status === 403) return `Your key for ${host} isn't allowed to use ${e.model}. Check "models" in synthe.json, or run \`npx synthe key\` to replace the key.`;
  if (e.status === 404) return `${host} doesn't have the model ${e.model}, or provider.base_url doesn't point at its OpenAI-compatible API (it usually ends in /v1). Check "models" and "provider" in synthe.json. ${e.message}`;
  if (e.status === 429 || e.status === 408 || e.status >= 500) return `${host} is busy or rate-limiting this key right now. Wait a few minutes and try again.`;
  return `${host} refused the request for ${e.model}. Check "models" and "provider" in synthe.json. ${e.message}`;
}
