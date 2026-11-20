import { pricedCost } from "../core/cost.ts";
import { isLoopback, type ModelPrice } from "../core/goal.ts";
import type { Model } from "./client.ts";

// A model behind any OpenAI-compatible chat completions API: OpenAI, Gemini's OpenAI endpoint, Groq, OpenRouter,
// Together, a local Ollama or vLLM server. Plain fetch, no SDK.
//
// The key goes only to the base URL from synthe.json. Nothing here reads OPENAI_BASE_URL or any other environment
// variable, for the same reason ownKeyBaseUrl exists in client.ts: a gateway set in the person's shell must never
// receive the team's key.

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  prices?: Record<string, ModelPrice>;
  // Tests shorten the waits between retries; the real client waits as the server asks.
  sleep?: (ms: number) => Promise<void>;
}

// A refused or failed request, with what modelProblem needs to say what to do. The key is never in the message.
export class ProviderError extends Error {
  status: number | null; // null when the server couldn't be reached
  host: string;
  model: string;
  loopback: boolean;
  quota: boolean; // out of credit or over a spending limit: waiting won't help
  constructor(message: string, a: { status: number | null; host: string; model: string; loopback: boolean; quota?: boolean }) {
    super(message);
    this.status = a.status; this.host = a.host; this.model = a.model; this.loopback = a.loopback; this.quota = a.quota ?? false;
  }
}

const MAX_RETRIES = 4; // as the Anthropic SDK's client is set up in anthropicModel
const TIMEOUT_MS = 10 * 60_000; // the Anthropic SDK's default
const MAX_WAIT_MS = 60_000;
const QUOTA = /insufficient_quota|exceeded your current quota|credit balance|out of credits?|spend(ing)? limit|billing/i;

// Seconds or an HTTP date, as the standard says, or retry-after-ms as OpenAI sends. Null when absent or unreadable.
export function retryAfterMs(headers: Headers, now = Date.now()): number | null {
  const ms = Number(headers.get("retry-after-ms"));
  if (headers.get("retry-after-ms") && Number.isFinite(ms) && ms >= 0) return Math.min(ms, MAX_WAIT_MS);
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_WAIT_MS);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.min(Math.max(0, at - now), MAX_WAIT_MS) : null;
}

const backoffMs = (attempt: number) => Math.min(500 * 2 ** attempt, 8000) * (0.75 + Math.random() * 0.25);

// When a server won't take a JSON schema, the schema goes into the message instead. Some models then wrap the JSON
// in a code fence, which JSON.parse in askJson would refuse.
const JSON_ONLY = (schema: Record<string, unknown>) => `\n\nReply with only a JSON object that matches this JSON schema, with no other text before or after it:\n${JSON.stringify(schema)}`;
const unfence = (text: string) => text.match(/^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/i)?.[1] ?? text;

function textOf(content: unknown): string | null {
  if (typeof content === "string") return content;
  // A few servers send content as parts, like the request format allows.
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("");
  return null;
}

export function openAiCompatibleModel(o: OpenAiCompatibleOptions): Model {
  const base = o.baseUrl.trim().replace(/\/+$/, "");
  const url = new URL(`${base}/chat/completions`);
  const host = url.host;
  const loopback = isLoopback(url);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const hide = (text: string) => (o.apiKey ? text.split(o.apiKey).join("[your key]") : text);
  // Learned once per model, so a server that refuses a field costs one extra request per run, not one per call.
  const noSchema = new Set<string>();
  const completionTokens = new Set<string>();

  async function post(model: string, body: Record<string, unknown>): Promise<{ status: number; json: any; text: string }> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${o.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
          redirect: "error", // a redirect would carry the key to wherever it points
        });
      } catch (error) {
        if (attempt < MAX_RETRIES) { await sleep(backoffMs(attempt)); continue; }
        throw new ProviderError(`Couldn't reach ${host}: ${hide(error instanceof Error ? error.message : String(error))}`, { status: null, host, model, loopback });
      }
      // Hidden before parsing, so no error message built from the body can repeat the key.
      const text = hide(await response.text());
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* not JSON: kept as text for the error */ }
      const quota = QUOTA.test(text);
      const retryable = (response.status === 429 && !quota) || response.status === 408 || response.status >= 500;
      if (retryable && attempt < MAX_RETRIES) {
        await sleep(retryAfterMs(response.headers) ?? backoffMs(attempt));
        continue;
      }
      return { status: response.status, json, text };
    }
  }

  const said = (r: { json: any; text: string }) => {
    const m = r.json?.error?.message ?? r.json?.message ?? r.json?.error;
    return (typeof m === "string" ? m : r.text).trim().slice(0, 300);
  };

  return {
    async ask({ model, system, user, maxTokens, schema, allowCutOff }) {
      let jsonInPrompt = Boolean(schema) && noSchema.has(model);
      let tokensField = completionTokens.has(model) ? "max_completion_tokens" : "max_tokens";
      let retriedTokens = false, retriedSchema = false;
      for (;;) {
        const body: Record<string, unknown> = {
          model,
          messages: [...(system === undefined ? [] : [{ role: "system", content: system }]), { role: "user", content: schema && jsonInPrompt ? `${user}${JSON_ONLY(schema)}` : user }],
          [tokensField]: maxTokens,
          ...(schema && !jsonInPrompt ? { response_format: { type: "json_schema", json_schema: { name: "reply", schema, strict: true } } } : {}),
        };
        const r = await post(model, body);
        if (r.status === 400) {
          const why = said(r);
          // Newer OpenAI models take max_completion_tokens and refuse max_tokens, and say so.
          if (!retriedTokens && tokensField === "max_tokens" && /max_completion_tokens/.test(why)) {
            retriedTokens = true; tokensField = "max_completion_tokens"; completionTokens.add(model);
            continue;
          }
          if (schema && !jsonInPrompt && !retriedSchema) {
            retriedSchema = true; jsonInPrompt = true; noSchema.add(model);
            continue;
          }
        }
        if (r.status < 200 || r.status >= 300) {
          throw new ProviderError(`${host} answered ${r.status}: ${said(r)}`, { status: r.status, host, model, loopback, quota: QUOTA.test(r.text) });
        }
        const choice = r.json?.choices?.[0];
        const content = textOf(choice?.message?.content);
        const refused = typeof choice?.message?.refusal === "string" && choice.message.refusal.trim().length > 0;
        const reason: string | null = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
        const raw = refused ? null : content;
        const text = raw !== null && jsonInPrompt ? unfence(raw) : raw;
        const finished = reason === "stop" && text !== null && text.length > 0;
        const cutOff = allowCutOff === true && reason === "length" && text !== null && text.length > 0;
        const usage = r.json?.usage;
        const input = typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : null;
        const output = typeof usage?.completion_tokens === "number" ? usage.completion_tokens : null;
        // The team's prices first; else what the provider says it charged (OpenRouter sends usage.cost); else unknown.
        const price = o.prices?.[model];
        const costUsd = price ? pricedCost(price, input, output)
          : typeof usage?.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : null;
        return {
          text: finished || cutOff ? text : null, costUsd, ...(cutOff ? { truncated: true } : {}),
          ...(input !== null && output !== null ? { usage: { input, output } } : {}), stopReason: refused ? "refusal" : reason,
        };
      }
    },
  };
}
