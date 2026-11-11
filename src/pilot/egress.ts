// What may leave the operator's environment. Lane: evidence and review workflow.
import { PilotError } from "./errors.ts";
import { personalDataKinds } from "./pii.ts";
import type { Pack } from "./types.ts";

// Opaque index of the conversation text in one or more packs, for finding it in outgoing text.
export interface SensitiveIndex { readonly phrases: ReadonlySet<string> }

const RUN = 6; // words in a run copied from a conversation
const TOKEN_MIN = 6; // characters in an identifier-like token

// Lowercase, collapse whitespace, trim punctuation off each word. Matching on this form means a quote cannot slip
// through by changing case, spacing, line breaks or the punctuation around a word.
function words(text: string): string[] {
  return text.toLowerCase().split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")).filter((w) => w !== "");
}

// A run holds spaces, a token never does, so one set can hold both and still tell them apart.
function phrasesOf(text: string): { runs: Set<string>; tokens: Set<string> } {
  const w = words(text);
  const runs = new Set<string>();
  const tokens = new Set<string>();
  for (let i = 0; i + RUN <= w.length; i++) runs.add(w.slice(i, i + RUN).join(" "));
  for (const t of w) if (t.length >= TOKEN_MIN && /\d/.test(t)) tokens.add(t);
  return { runs, tokens };
}

function stringsIn(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value !== null && typeof value === "object") for (const v of Object.values(value)) stringsIn(v, out);
}

// `allow` is text that is already in the customer's repo (the baseline prompt): wording the prompt already holds
// is not a leak, so it is taken out of the index.
export function sensitiveIndex(packs: Pack[], allow: string[] = []): SensitiveIndex {
  const texts: string[] = [];
  for (const pack of packs) {
    for (const c of pack.cases) {
      for (const m of c.messages) {
        if (m.role === "tool") texts.push(m.result);
        else {
          texts.push(m.text);
          if (m.role === "assistant") for (const call of m.tool_calls ?? []) stringsIn(call.input, texts);
        }
      }
    }
  }
  const phrases = new Set<string>();
  for (const t of texts) { const p = phrasesOf(t); for (const x of p.runs) phrases.add(x); for (const x of p.tokens) phrases.add(x); }
  for (const t of allow) { const p = phrasesOf(t); for (const x of p.runs) phrases.delete(x); for (const x of p.tokens) phrases.delete(x); }
  return { phrases };
}

// Why this text must not be published or logged: conversation text from a pack, a secret, or personal data.
// Each problem is a plain sentence that names the kind of match and never repeats the matched text.
export function egressProblems(text: string, index: SensitiveIndex | null): string[] {
  const problems = personalDataKinds(text).map((kind) => `contains what looks like ${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}`);
  if (index !== null) {
    const { runs, tokens } = phrasesOf(text);
    let copied = 0;
    let ids = 0;
    for (const r of runs) if (index.phrases.has(r)) copied++;
    for (const t of tokens) if (index.phrases.has(t)) ids++;
    if (copied > 0) problems.push(`contains wording copied from pack conversations (${copied} matches)`);
    if (ids > 0) problems.push(`contains an identifier that appears in pack conversations (${ids} matches)`);
  }
  return problems;
}

// Throws PilotError egress_blocked naming `what` when egressProblems finds anything.
export function assertEgressSafe(text: string, index: SensitiveIndex | null, what: string): void {
  const problems = egressProblems(text, index);
  if (problems.length === 0) return;
  throw new PilotError("egress_blocked", `Nothing was sent: the ${what} ${problems.join("; ")}. Remove that content and try again.`);
}
