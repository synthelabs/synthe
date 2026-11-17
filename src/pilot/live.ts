import Anthropic from "@anthropic-ai/sdk";
import { isLoopback } from "./config.ts";
import { PilotError } from "./errors.ts";
import { printable } from "./io.ts";
import { bounded } from "./model.ts";
import type { ChatMessage, ChatModel, ChatReply, ChatRequest, ProviderApproval } from "./types.ts";

// The only path by which pilot data reaches a model provider. It runs when, and only when:
//   1. pilot.json carries a provider approval (who approved sending what, to which endpoint, with which limits),
//   2. the operator opts in for this one command and repeats the endpoint and the data class, and
//   3. the key is in the one environment variable the approval names.
// It never falls back to another key, to SYNTHE_* settings or to Synthe's event proxy, and it says where the data
// goes before the first request.

export interface LiveOptIn {
  live: boolean;
  // What the operator typed for this run. Both must equal the approval, so a stale shell command cannot send
  // data somewhere the customer did not approve.
  endpoint: string | undefined;
  data_class: string | undefined;
  // --allow-endpoint-host <host>, typed for this run: the one host other than api.anthropic.com that may receive
  // data. A value in pilot.json is never enough.
  allow_host?: string | undefined;
}

// The only host that receives data without the operator naming another one for the run. A loopback address is the
// operator's own machine (a local stand-in or gateway) and needs no flag either.
export const PROVIDER_HOST = "api.anthropic.com";

// One call may take this long. The SDK's own default is ten minutes for each call, which a stalled endpoint would
// use in full for every case.
export const CALL_TIMEOUT_MS = 120_000;

const refuse = (why: string): never => { throw new PilotError("live_not_approved", `No data was sent. ${why}`); };

// Tool ids in a recorded pack are the customer's; the API accepts only letters, digits, dashes and underscores.
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, "_");

export function liveModel(
  approval: ProviderApproval | null,
  optIn: LiveOptIn,
  env: Record<string, string | undefined>,
  say: (line: string) => void,
  fetchImpl?: typeof fetch,
  timeoutMs: number = CALL_TIMEOUT_MS,
): ChatModel {
  if (!optIn.live) return refuse("A live model runs only with --live.");
  if (approval === null) return refuse("pilot.json has provider: null, so only scripted models may run. Record the customer's approval in pilot.json (provider) and start a new pilot directory.");
  if (optIn.endpoint !== approval.endpoint) return refuse(`--confirm-endpoint must repeat the approved endpoint exactly: ${approval.endpoint}`);
  if (optIn.data_class !== approval.data_class) return refuse(`--confirm-data must repeat the approved data class exactly: "${approval.data_class}"`);
  const host = new URL(approval.endpoint).host;
  if (host !== PROVIDER_HOST && !isLoopback(approval.endpoint) && optIn.allow_host !== host) {
    return refuse(`The approved endpoint is on ${host}, not ${PROVIDER_HOST}, and a value in pilot.json is not enough to send data to another host. If the customer approved ${host}, run again with --allow-endpoint-host ${host}.`);
  }
  const key = env[approval.key_env]?.trim();
  if (!key) return refuse(`The key must be in ${approval.key_env}, the one variable the approval names. No other variable is read.`);

  say(`Sending "${printable(approval.data_class)}" to ${approval.provider} at ${printable(approval.endpoint, 120)} (model ${printable(approval.model, 60)}).`);
  say(`Approved by ${printable(approval.approved_by, 60)} on ${printable(approval.approved_at, 30)}. Limits for this command: ${approval.max_calls} calls, ${approval.max_input_chars} characters.`);

  // Nothing in the shell may shape the request. baseURL and apiKey are passed explicitly and authToken is nulled
  // (ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN). The SDK also reads ANTHROPIC_CUSTOM_HEADERS when a client is
  // built, which could add headers, another credential among them, so it is taken out of the environment for
  // that moment. Logging and tracing are off: both can carry prompt and conversation text. Retries are off too,
  // so one counted call is one request and the approved limits mean what they say, and each call has a time limit.
  const savedHeaders = process.env.ANTHROPIC_CUSTOM_HEADERS;
  delete process.env.ANTHROPIC_CUSTOM_HEADERS;
  // A redirect is never followed: a 307 or 308 would send the whole conversation body, and a 301 to 303 the next
  // request, to a host nobody approved. It is wrapped here, whatever transport is used, so no SDK default or
  // header decides it. The call then fails like any other failed call.
  const base = fetchImpl ?? fetch;
  const noRedirect = ((url: Parameters<typeof fetch>[0], init?: RequestInit) => base(url, { ...init, redirect: "error" })) as typeof fetch;
  let client: Anthropic;
  try {
    client = new Anthropic({
      apiKey: key, authToken: null, baseURL: approval.endpoint, maxRetries: 0, timeout: timeoutMs, logLevel: "off",
      openTelemetry: { traces: false, propagation: false }, fetch: noRedirect,
    });
  } finally {
    if (savedHeaders !== undefined) process.env.ANTHROPIC_CUSTOM_HEADERS = savedHeaders;
  }

  // A reply's content blocks as the provider returned them, kept for the rest of the turn: when the model asks
  // for a tool and the recorded result is sent back, the assistant turn must be repeated unchanged (it can carry
  // thinking blocks that this code never reads and must not drop).
  const raw = new Map<string, Anthropic.ContentBlock[]>();

  const toParams = (messages: ChatMessage[]): Anthropic.MessageParam[] => {
    const out: Anthropic.MessageParam[] = [];
    for (const m of messages) {
      if (m.role === "user") {
        out.push({ role: "user", content: m.text });
      } else if (m.role === "assistant") {
        const kept = m.tool_calls.length ? raw.get(m.tool_calls[0].id) : undefined;
        if (kept) { out.push({ role: "assistant", content: kept }); continue; }
        const content: Anthropic.ContentBlockParam[] = [
          ...(m.text.trim() ? [{ type: "text" as const, text: m.text }] : []),
          ...m.tool_calls.map((c) => ({ type: "tool_use" as const, id: safeId(c.id), name: c.name, input: c.input })),
        ];
        out.push({ role: "assistant", content });
      } else {
        const block: Anthropic.ToolResultBlockParam = { type: "tool_result", tool_use_id: safeId(m.tool_call_id), content: m.result, ...(m.is_error ? { is_error: true } : {}) };
        const last = out.at(-1);
        // Results of one assistant turn go back together in a single user message.
        if (last && last.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) last.content.push(block);
        else out.push({ role: "user", content: [block] });
      }
    }
    return out;
  };

  // A provider that fails every call must not read as "no check fails": a failed call only makes one turn
  // inconclusive, so a dead endpoint would leave a run with nothing scored. The run stops instead when the first
  // call fails (nothing has worked yet) or when this many calls in a row have failed.
  const MAX_CONSECUTIVE_FAILURES = 3;
  let succeeded = 0;
  let failedInARow = 0;

  const model: ChatModel = {
    destination: `${approval.provider}:${approval.endpoint}:${approval.model}`,
    async chat(request: ChatRequest): Promise<ChatReply> {
      if (request.model !== approval.model) return refuse(`This command asked for model ${request.model}, but the approval covers ${approval.model}.`);
      let response: Anthropic.Message;
      try {
        // No server-side fallback model: a reply from a different model would break the matched comparison, so a
        // refusal is returned as a refusal and the turn is recorded as inconclusive.
        response = await client.messages.create({
          model: request.model,
          max_tokens: request.max_tokens,
          system: request.system,
          messages: toParams(request.messages),
          ...(request.tools.length ? { tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: { ...t.input_schema, type: "object" } as Anthropic.Tool.InputSchema })) } : {}),
          // Current models reject sampling parameters, so it is sent only when the pilot config sets one.
          ...(request.temperature !== null ? { temperature: request.temperature } : {}),
        });
      } catch (e) {
        // A rejected key fails every call the same way: stop the run instead of marking every case inconclusive.
        if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
          throw new PilotError("live_not_approved", `The provider rejected the key in ${approval.key_env} (HTTP ${e.status}). Nothing was scored. Fix the key and run the command again.`);
        }
        // A provider error can echo the request back. Only its status and class go on from here.
        const status = e instanceof Anthropic.APIError && typeof e.status === "number" ? `HTTP ${e.status}` : "no response";
        const what = `The provider request failed (${status}, ${e instanceof Error ? e.name : "error"}).`;
        failedInARow++;
        if (succeeded === 0) throw new PilotError("live_not_approved", `${what} No call has worked, so nothing was scored. Check the endpoint and the network, then run the command again.`);
        if (failedInARow >= MAX_CONSECUTIVE_FAILURES) throw new PilotError("live_not_approved", `${what} ${failedInARow} calls in a row have failed, so the run was stopped. Run the command again; finished work is kept.`);
        throw new Error(what);
      }
      succeeded++;
      failedInARow = 0;
      const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      const calls = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (calls.length) raw.set(calls[0].id, response.content);
      const stop: ChatReply["stop"] = response.stop_reason === "end_turn" ? "end"
        : response.stop_reason === "tool_use" ? "tool_use"
        : response.stop_reason === "max_tokens" ? "max_tokens"
        : response.stop_reason === "refusal" ? "refusal"
        : "other";
      return {
        text, stop,
        // Tool input is model output: parsed JSON, used only to look up a recorded result, never executed.
        tool_calls: calls.map((c) => ({ id: c.id, name: c.name, input: (c.input !== null && typeof c.input === "object" && !Array.isArray(c.input) ? c.input : {}) as Record<string, unknown> })),
        usage: { input: response.usage.input_tokens, output: response.usage.output_tokens },
      };
    },
  };
  return bounded(model, { max_calls: approval.max_calls, max_input_chars: approval.max_input_chars });
}
