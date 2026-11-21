import type { Model } from "../model/client.ts";
import { openAiCompatibleModel } from "../model/openai-compatible.ts";
import { SetupError } from "./loop.ts";
import type { Edit, Problem, Proposal, Proposer, ProposerReply, ProposerRequest } from "./types.ts";

// The model proposer (P16): proposer "model" in a problem file. It gets the same object an outside proposer gets on
// stdin, asks an OpenAI-compatible chat completions endpoint, and reads the reply as the same object an outside
// proposer prints. A reply it cannot read is a failed attempt with a reason, never a crash.
//
// The key comes only from SYNTHE_API_KEY and goes only to problem.model.base_url (openAiCompatibleModel never reads
// another variable and refuses redirects). It never appears in a reason: every reason passes through hide().

// A setup problem (no key, no base_url, no model) is a SetupError: the CLI prints it and exits 1.

const MAX_TOKENS = 16_000;

// The reply shape. Sent as a JSON schema when the server takes one; openAiCompatibleModel puts it in the message
// instead when the server refuses response_format.
export const PROPOSALS_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["proposals"],
  properties: {
    proposals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["summary", "edits"],
        properties: {
          summary: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "search", "replace"],
              properties: { path: { type: "string" }, search: { type: "string" }, replace: { type: "string" } },
            },
          },
        },
      },
    },
  },
};

export const SYSTEM = [
  "You improve files so that a measured score gets better.",
  "You get a JSON object: the goal, the files you may change with their current text, the history of earlier attempts with whether each was kept and why, and how many proposals to make.",
  "Learn from the history: do not repeat an attempt that was not kept, and build on attempts that were kept.",
  "Reply with only a JSON object: {\"proposals\": [{\"summary\": \"...\", \"edits\": [{\"path\": \"...\", \"search\": \"...\", \"replace\": \"...\"}]}]}.",
  "Each proposal is one idea, with a one-sentence summary. Each edit replaces the search text with the replace text in the file at path.",
  "The search text must occur exactly once in that file, copied exactly, with enough context to be unique.",
  "Change only the files you were given. If you have nothing more worth trying, reply with {\"proposals\": []}.",
].join("\n");

// The user message: the stdin object itself, so the model and an outside proposer see exactly the same facts.
export function buildUser(input: ProposerRequest): string {
  const n = input.candidates;
  return `Make ${n === 1 ? "1 proposal" : `up to ${n} proposals, each a different idea`}.\n\n${JSON.stringify(input, null, 2)}`;
}

// The JSON object in a reply: the whole reply, a fenced block, or the span from the first "{" to the last "}".
function jsonIn(text: string): unknown {
  const tries = [text, text.match(/```(?:json)?\s*\n?([\s\S]*?)```/i)?.[1], text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)];
  for (const t of tries) {
    if (!t || !t.trim()) continue;
    try { return JSON.parse(t); } catch { /* try the next form */ }
  }
  throw new Error("not JSON");
}

const short = (s: string) => (s.length > 200 ? `${s.slice(0, 200)}...` : s);

// Reads a reply into proposals. Every shape problem gives a plain reason that says what was wrong.
export function parseProposals(text: string): ProposerReply {
  let json: unknown;
  try { json = jsonIn(text); } catch {
    return { failed: `The model's reply was not valid JSON: ${JSON.stringify(short(text.trim()))}` };
  }
  const list = (json as { proposals?: unknown } | null)?.proposals;
  if (!json || typeof json !== "object" || !Array.isArray(list)) return { failed: 'The model\'s reply had no "proposals" list.' };
  const proposals: Proposal[] = [];
  for (const [i, p] of list.entries()) {
    const at = `Proposal ${i + 1} in the model's reply`;
    if (!p || typeof p !== "object") return { failed: `${at} is not an object.` };
    const { summary, edits } = p as { summary?: unknown; edits?: unknown };
    if (typeof summary !== "string" || !summary.trim()) return { failed: `${at} has no "summary".` };
    if (!Array.isArray(edits) || edits.length === 0) return { failed: `${at} has no "edits".` };
    const out: Edit[] = [];
    for (const [j, e] of edits.entries()) {
      const { path, search, replace } = (e ?? {}) as { path?: unknown; search?: unknown; replace?: unknown };
      if (typeof path !== "string" || typeof search !== "string" || typeof replace !== "string") {
        return { failed: `Edit ${j + 1} of proposal ${i + 1} in the model's reply needs "path", "search" and "replace" as text.` };
      }
      out.push({ path, search, replace });
    }
    proposals.push({ summary: summary.trim(), edits: out });
  }
  return { proposals };
}

// Builds the proposer for proposer "model". Throws SetupError before any call when the problem cannot reach a model.
// Every later problem is `{ failed: reason }`. `client` is for tests; a run builds the OpenAI-compatible client.
export function modelProposer(problem: Problem, env: NodeJS.ProcessEnv = process.env, client?: Model): Proposer {
  const key = env.SYNTHE_API_KEY?.trim() ?? "";
  const config = problem.model;
  if (!config?.model) throw new SetupError('proposer "model" needs model.model in the problem file.');
  if (!client) {
    if (!config.base_url) throw new SetupError('proposer "model" needs model.base_url in the problem file.');
    if (!key) throw new SetupError('proposer "model" needs a key: set the SYNTHE_API_KEY environment variable.');
  }
  const model = client ?? openAiCompatibleModel({ baseUrl: config.base_url, apiKey: key });
  const hide = (s: string) => (key ? s.split(key).join("[your key]") : s);
  const ask = async (request: ProposerRequest): Promise<ProposerReply> => {
    try {
      const reply = await model.ask({ model: config.model, system: SYSTEM, user: buildUser(request), maxTokens: MAX_TOKENS, schema: PROPOSALS_SCHEMA });
      if (reply.text === null) {
        const why = reply.stopReason === "length" ? "it was cut off at the length limit"
          : reply.stopReason === "refusal" ? "the model refused"
          : `it ended with "${reply.stopReason ?? "no reason"}"`;
        return { failed: hide(`The model gave no usable reply: ${why}.`) };
      }
      const parsed = parseProposals(reply.text);
      return "failed" in parsed ? { failed: hide(parsed.failed) } : parsed;
    } catch (error) {
      return { failed: hide(`The model request failed: ${error instanceof Error ? error.message : String(error)}`) };
    }
  };
  // One request is one model call, whatever its outcome: a failed call still counts against max_calls.
  return { propose: async (request) => ({ reply: await ask(request), calls: 1 }) };
}
