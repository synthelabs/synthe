import type { Model } from "../model/client.ts";
import { openAiCompatibleModel } from "../model/openai-compatible.ts";

// The model proposer (P16): proposer "model" in a problem file. It gets the same object an outside proposer gets on
// stdin, asks an OpenAI-compatible chat completions endpoint, and reads the reply as the same object an outside
// proposer prints. A reply it cannot read is a failed attempt with a reason, never a crash.
//
// The key comes only from SYNTHE_API_KEY and goes only to problem.model.base_url (openAiCompatibleModel never reads
// another variable and refuses redirects). It never appears in a reason: every reason passes through hide().

export interface ProposerInput {
  round: number;
  goal: string;
  files: { path: string; text: string }[];
  history: { round: number; summary: string; kept: boolean; reason: string }[];
  candidates: number;
}

export interface Edit { path: string; search: string; replace: string }
export interface Proposal { summary: string; edits: Edit[] }

// ok: the proposals to measure (an empty list means "nothing more to try"). Not ok: one failed attempt and why.
export type ProposerResult = { ok: true; proposals: Proposal[] } | { ok: false; reason: string };

export interface ModelProposerConfig { base_url: string; model: string }

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
export function buildUser(input: ProposerInput): string {
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
export function parseProposals(text: string): ProposerResult {
  let json: unknown;
  try { json = jsonIn(text); } catch {
    return { ok: false, reason: `The model's reply was not valid JSON: ${JSON.stringify(short(text.trim()))}` };
  }
  const list = (json as { proposals?: unknown } | null)?.proposals;
  if (!json || typeof json !== "object" || !Array.isArray(list)) return { ok: false, reason: 'The model\'s reply had no "proposals" list.' };
  const proposals: Proposal[] = [];
  for (const [i, p] of list.entries()) {
    const at = `Proposal ${i + 1} in the model's reply`;
    if (!p || typeof p !== "object") return { ok: false, reason: `${at} is not an object.` };
    const { summary, edits } = p as { summary?: unknown; edits?: unknown };
    if (typeof summary !== "string" || !summary.trim()) return { ok: false, reason: `${at} has no "summary".` };
    if (!Array.isArray(edits) || edits.length === 0) return { ok: false, reason: `${at} has no "edits".` };
    const out: Edit[] = [];
    for (const [j, e] of edits.entries()) {
      const { path, search, replace } = (e ?? {}) as { path?: unknown; search?: unknown; replace?: unknown };
      if (typeof path !== "string" || typeof search !== "string" || typeof replace !== "string") {
        return { ok: false, reason: `Edit ${j + 1} of proposal ${i + 1} in the model's reply needs "path", "search" and "replace" as text.` };
      }
      out.push({ path, search, replace });
    }
    proposals.push({ summary: summary.trim(), edits: out });
  }
  return { ok: true, proposals };
}

export interface ModelProposerOptions {
  model: ModelProposerConfig;
  env?: NodeJS.ProcessEnv;
  // Tests pass a fake; the real run builds an OpenAI-compatible client from base_url and SYNTHE_API_KEY.
  client?: Model;
}

export interface ModelProposer {
  // Model calls made so far, for budget.max_calls.
  readonly calls: number;
  propose(input: ProposerInput): Promise<ProposerResult>;
}

// Throws only for a setup problem (no key, no base_url, no model): the run cannot start. After that, every problem
// is a failed attempt with a reason.
export function modelProposer(o: ModelProposerOptions): ModelProposer {
  const env = o.env ?? process.env;
  const key = env.SYNTHE_API_KEY?.trim() ?? "";
  if (!o.model?.model) throw new Error('proposer "model" needs model.model in the problem file.');
  if (!o.client) {
    if (!o.model.base_url) throw new Error('proposer "model" needs model.base_url in the problem file.');
    if (!key) throw new Error('proposer "model" needs a key: set the SYNTHE_API_KEY environment variable.');
  }
  const client = o.client ?? openAiCompatibleModel({ baseUrl: o.model.base_url, apiKey: key });
  const hide = (s: string) => (key ? s.split(key).join("[your key]") : s);
  let calls = 0;
  return {
    get calls() { return calls; },
    async propose(input) {
      calls++;
      try {
        const reply = await client.ask({ model: o.model.model, system: SYSTEM, user: buildUser(input), maxTokens: MAX_TOKENS, schema: PROPOSALS_SCHEMA });
        if (reply.text === null) {
          const why = reply.stopReason === "length" ? "it was cut off at the length limit"
            : reply.stopReason === "refusal" ? "the model refused"
            : `it ended with "${reply.stopReason ?? "no reason"}"`;
          return { ok: false, reason: hide(`The model gave no usable reply: ${why}.`) };
        }
        const parsed = parseProposals(reply.text);
        return parsed.ok ? parsed : { ok: false, reason: hide(parsed.reason) };
      } catch (error) {
        return { ok: false, reason: hide(`The model request failed: ${error instanceof Error ? error.message : String(error)}`) };
      }
    },
  };
}
