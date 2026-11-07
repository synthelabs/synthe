import Anthropic from "@anthropic-ai/sdk";
import { setupInstallId } from "./install.ts";
import { costUsd } from "../core/cost.ts";
import { oidcToken, PROXY_AUTH_MESSAGE, PROXY_REFUSED } from "../core/share.ts";

export const PROXY_URL = "https://synthe-crimson.vercel.app/api/claude";
// Organizer-issued team codes, shaped like the server's TEAM_CODE (synthe-share lib/spend.ts). Normalized the same way.
export const TEAM_CODE = /^crim(-[a-hjkmnp-z2-9]{4}){4}$/;
export const normalizeTeamCode = (code: string) => code.trim().toLowerCase().replace(/\s+/g, "");
export class CreditError extends Error {}
export class ProxyError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function eventModels(models: Record<string, string>): void {
  for (const model of Object.values(models)) {
    if (!["claude-haiku-5-5", "claude-sonnet-5-5"].includes(model)) throw new CreditError(`Event credit only supports claude-haiku-5-5 and claude-sonnet-5-5; your goal names ${model}. Use an allowed model or run \`npx synthe key\` to use your own Anthropic key.`);
  }
}

export function proxyModel(eventCode: string, action = false, teamCode?: string, options: { fixedEndpoint?: boolean } = {}): Model {
  const team = teamCode ? normalizeTeamCode(teamCode) : "";
  const client = new Anthropic({ apiKey: "synthe-proxy", baseURL: options.fixedEndpoint ? PROXY_URL : process.env.SYNTHE_PROXY_URL || PROXY_URL,
    maxRetries: options.fixedEndpoint ? 0 : 2, ...(options.fixedEndpoint ? { timeout: 45_000 } : {}), logLevel: "off",
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set("x-synthe-event", eventCode);
      if (team) headers.set("x-synthe-team", team);
      headers.set("x-api-key", "synthe-proxy");
      if (action) headers.set("Authorization", `Bearer ${await oidcToken("synthe-proxy")}`);
      else { headers.delete("Authorization"); headers.set("x-synthe-install", setupInstallId()); }
      const response = await fetch(url, { ...init, headers, ...(options.fixedEndpoint ? { redirect: "error" as const } : {}) });
      if (response.status === 402 || response.status === 403) {
        const body = await response.clone().json().catch(() => null) as { error?: { type?: string; message?: string } } | null;
        if (body?.error?.type === "synthe_credit" && typeof body.error.message === "string") {
          const refusedHeaders = new Headers(response.headers);
          refusedHeaders.set("x-should-retry", "false");
          return new Response(response.body, { status: response.status, headers: refusedHeaders });
        }
      }
      return response;
    },
  });
  const model = sdkModel(client);
  return { async ask(ask) {
    eventModels({ model: ask.model });
    if (ask.maxTokens > 16000) throw new CreditError("Event credit supports at most 16000 output tokens per request.");
    try { return await model.ask(ask); } catch (error) {
      const refused = error as { status?: number; error?: { error?: { type?: string; message?: string } } };
      if ((refused.status === 402 || refused.status === 403) && refused.error?.error?.type === "synthe_credit" && typeof refused.error.error.message === "string") throw new CreditError(refused.error.error.message);
      // A missing, unknown or revoked team code, a wrong event code, or a repo linked to another team: the server's words.
      if (refused.status === 403 && refused.error?.error?.type === "synthe_proxy_auth" && typeof refused.error.error.message === "string") throw new ProxyError(403, `${PROXY_REFUSED}${refused.error.error.message}`);
      if (refused.status === 401) {
        if (refused.error?.error?.type === "synthe_proxy_auth") throw new ProxyError(401, PROXY_AUTH_MESSAGE);
        throw new CreditError("Synthe's sponsored Anthropic key was rejected. Ask at the Synthe table; your workflow does not need upgrading. Once the organizer fixes it, run `npx synthe restart`.");
      }
      if (refused.status === 429) throw new ProxyError(429, "Synthe's proxy is busy. Wait a few minutes and try again.");
      if (refused.status === 503 && typeof refused.error?.error?.message === "string") throw new ProxyError(503, refused.error.error.message);
      throw error;
    }
  } };
}

export function configuredModel(key: string | undefined, eventCode: string | undefined, action = false, teamCode?: string): Model {
  if (key?.trim()) return anthropicModel(key.trim());
  if (eventCode?.trim()) return proxyModel(eventCode.trim(), action, teamCode?.trim() || undefined);
  throw new Error("No Anthropic key or event code is set. Set SYNTHE_EVENT_CODE or SYNTHE_ANTHROPIC_KEY.");
}

// allowCutOff: a reply that ran into maxTokens is returned as it is (truncated: true) instead of as null. Only for plain
// text the caller can judge as it stands; a cut-off JSON reply is broken, so JSON callers never set it.
export interface Ask { model: string; system?: string; user: string; maxTokens: number; schema?: Record<string, unknown>; allowCutOff?: boolean }
export interface Reply { text: string | null; costUsd: number | null; truncated?: boolean }
export interface Model { ask(a: Ask): Promise<Reply> }

export function anthropicModel(apiKey: string): Model {
  const client = new Anthropic({ apiKey, maxRetries: 4 });
  return sdkModel(client);
}

function sdkModel(client: Anthropic): Model {
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
  if (e instanceof CreditError) return e.message;
  if (e instanceof ProxyError) return e.message;
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
