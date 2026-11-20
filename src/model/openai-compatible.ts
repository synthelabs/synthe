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
  // provider.max_requests_per_minute: requests are spaced to stay under it, and at most PACED_AT_ONCE are in flight.
  maxRequestsPerMinute?: number;
  // provider.reasoning_effort, sent only when the goal sets it.
  reasoningEffort?: string;
  // Tests shorten the waits and move the clock; the real client waits as the server asks.
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

// A refused or failed request, with what modelProblem needs to say what to do. The key is never in the message.
export class ProviderError extends Error {
  status: number | null; // null when the server couldn't be reached
  host: string;
  model: string;
  loopback: boolean;
  credit: boolean; // out of credit or over a spending limit: a person has to act
  exhausted: boolean; // the free limit is used up for now: the next scheduled run tries again
  constructor(message: string, a: { status: number | null; host: string; model: string; loopback: boolean; credit?: boolean; exhausted?: boolean }) {
    super(message);
    this.status = a.status; this.host = a.host; this.model = a.model; this.loopback = a.loopback; this.credit = a.credit ?? false; this.exhausted = a.exhausted ?? false;
  }
}

const MAX_RETRIES = 4; // as the Anthropic SDK's client is set up in anthropicModel
const TIMEOUT_MS = 10 * 60_000; // the Anthropic SDK's default
const MAX_WAIT_MS = 60_000;
// Out of paid credit: only a person can fix it. Kept narrow, because free tiers' rate-limit messages also talk about
// quotas and billing plans.
const CREDIT = /insufficient_quota|credit balance|out of credits?|insufficient (funds|balance)|spend(ing)? limit reached|payment required/i;
// A daily allowance used up: retrying within the minute can't help, so it isn't retried.
const DAILY = /per[\s_-]?day|daily|requests_per_day|PerDay/i;
// Paced requests in flight at once: a free tier counts requests per minute, and several at once only collide.
const PACED_AT_ONCE = 2;

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
  const now = o.now ?? Date.now;
  const gap = o.maxRequestsPerMinute ? 60_000 / o.maxRequestsPerMinute : 0;
  let nextAt = 0;
  // Each request, retries included, starts at least `gap` after the one before.
  const pace = async () => {
    if (!gap) return;
    const t = now(), at = Math.max(t, nextAt);
    nextAt = at + gap;
    if (at > t) await sleep(at - t);
  };
  let active = 0;
  const waiting: (() => void)[] = [];
  const slot = async (): Promise<() => void> => {
    if (!gap) return () => {};
    while (active >= PACED_AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    return () => { active--; waiting.shift()?.(); };
  };
  const hide = (text: string) => (o.apiKey ? text.split(o.apiKey).join("[your key]") : text);
  // Learned once per model, so a server that refuses a field costs one extra request per run, not one per call.
  const noSchema = new Set<string>();
  const completionTokens = new Set<string>();

  async function post(model: string, body: Record<string, unknown>): Promise<{ status: number; json: any; text: string }> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      await pace();
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
      const text = await response.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* not JSON: kept as text for the error */ }
      const credit = CREDIT.test(text) || response.status === 402;
      const daily = response.status === 429 && DAILY.test(text);
      const retryable = (response.status === 429 && !credit && !daily) || response.status === 408 || response.status >= 500;
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
    async ask(a) {
      const done = await slot();
      try { return await askOnce(a); } finally { done(); }
    },
  };

  async function askOnce({ model, system, user, maxTokens, schema, allowCutOff }: Parameters<Model["ask"]>[0]): ReturnType<Model["ask"]> {
    let jsonInPrompt = Boolean(schema) && noSchema.has(model);
    let tokensField = completionTokens.has(model) ? "max_completion_tokens" : "max_tokens";
    let retriedTokens = false, retriedSchema = false;
    for (;;) {
      const body: Record<string, unknown> = {
        model,
        messages: [...(system === undefined ? [] : [{ role: "system", content: system }]), { role: "user", content: schema && jsonInPrompt ? `${user}${JSON_ONLY(schema)}` : user }],
        [tokensField]: maxTokens,
        ...(o.reasoningEffort ? { reasoning_effort: o.reasoningEffort } : {}),
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
        const credit = CREDIT.test(r.text) || r.status === 402;
        // Only an error is hidden: some servers repeat the key in it. A reply's own text is left as it is.
        // A 429 still there after every retry, or one that names a daily allowance, is a free limit used up for now.
        throw new ProviderError(`${host} answered ${r.status}: ${hide(said(r))}`, { status: r.status, host, model, loopback, credit, exhausted: r.status === 429 && !credit });
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
  }
}

// A provider's own list of models (GET {baseUrl}/models), so setup can check a model id before saving it instead of
// every round failing on a renamed or retired one. free: priced at 0 for both prompt and completion, as OpenRouter
// lists its free models. Gemini lists ids as "models/<id>"; the prefix is dropped to match the ids its API takes.
export interface ListedModel { id: string; free: boolean }
export type ModelList = { ok: true; models: ListedModel[] } | { ok: false; missing: boolean; why: string };

export async function listModels(baseUrl: string, apiKey: string): Promise<ModelList> {
  const url = new URL(`${baseUrl.trim().replace(/\/+$/, "")}/models`);
  const hide = (text: string) => (apiKey ? text.split(apiKey).join("[your key]") : text);
  try {
    const response = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    if (response.status === 404) return { ok: false, missing: true, why: "it has no /models route" };
    if (!response.ok) return { ok: false, missing: false, why: `it answered ${response.status}` };
    const body = await response.json() as { data?: unknown; models?: unknown };
    const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null;
    if (!rows) return { ok: false, missing: false, why: "its answer had no list of models" };
    const zero = (v: unknown) => (typeof v === "number" || (typeof v === "string" && v.trim() !== "")) && Number(v) === 0;
    return { ok: true, models: rows.flatMap((m: any) => (typeof m?.id === "string" && m.id ? [{ id: m.id.replace(/^models\//, ""), free: zero(m.pricing?.prompt) && zero(m.pricing?.completion) }] : [])) };
  } catch (error) {
    return { ok: false, missing: false, why: hide(`it couldn't be reached (${error instanceof Error ? error.message : String(error)})`) };
  }
}
