// What may leave the operator's environment. Lane: evidence and review workflow.
import { PilotError } from "./errors.ts";
import { personalDataKinds } from "./pii.ts";
import type { Pack } from "./types.ts";

// Opaque index of the case-specific content of one or more packs, for finding it in outgoing text.
export interface SensitiveIndex { readonly phrases: ReadonlySet<string> }

const RUN = 3; // words in a run copied from a conversation
const WORD_MIN = 5; // letters in a single word worth indexing on its own
const TOKEN_MIN = 3; // characters in an identifier-like word (one that has a digit)

// The same normal form on both sides, so a quote cannot slip through by changing case, spacing, line breaks,
// punctuation, accents, dash variants, or by hiding zero-width characters inside words. Compatibility forms are
// folded (NFKD), marks and format characters are removed, and everything that is not a letter or digit splits
// words.
export function words(text: string): string[] {
  return text.normalize("NFKD").replace(/[\p{M}\p{Cf}]/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== "");
}

// The items a text contributes: every run of RUN words, and every single word long enough to mean something on
// its own (a name, a place, an identifier). A run holds spaces and a word never does, so one set holds both.
function itemsOf(text: string): Set<string> {
  const w = words(text);
  const items = new Set<string>();
  for (let i = 0; i + RUN <= w.length; i++) items.add(w.slice(i, i + RUN).join(" "));
  for (const t of w) if (t.length >= WORD_MIN || (t.length >= TOKEN_MIN && /\p{N}/u.test(t))) items.add(t);
  return items;
}

function stringsIn(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value !== null && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.push(k); stringsIn(v, out); }
}

// Wording that appears in many conversations is the agent's and the tools' own boilerplate ("this order can be
// returned", "eligible: yes"). What must not leave is what belongs to particular conversations: a customer's own
// words, a name, an order token. So an item is indexed when it appears in only a few cases.
//
// `allow` is text that may leave: the baseline prompt (already in the customer's repo) and the review's own
// generated wording. The pack's check catalog, check ids, tool names and case ids are allowed too, because the
// reports print them by design.
export function sensitiveIndex(packs: Pack[], allow: string[] = []): SensitiveIndex {
  const byCase = new Map<string, Set<string>>();
  const allowed = new Set<string>();
  const permit = (text: string) => { for (const item of itemsOf(text)) allowed.add(item); };
  for (const pack of packs) {
    for (const [id, sentence] of Object.entries(pack.check_catalog)) { permit(id); permit(sentence); }
    for (const tool of pack.tools) { permit(tool.name); permit(tool.description); }
    for (const c of pack.cases) {
      permit(c.id);
      // The same case in two pack versions is one case, not two.
      const items = byCase.get(c.id) ?? new Set<string>();
      byCase.set(c.id, items);
      const texts: string[] = [];
      for (const m of c.messages) {
        if (m.role === "tool") texts.push(m.result);
        else {
          texts.push(m.text);
          if (m.role === "assistant") for (const call of m.tool_calls ?? []) stringsIn(call.input, texts);
        }
      }
      if (c.intent !== undefined) texts.push(c.intent);
      texts.push(c.provenance.ref);
      texts.push(...Object.keys(c.observed ?? {}));
      for (const t of texts) for (const item of itemsOf(t)) items.add(item);
    }
  }
  for (const t of allow) permit(t);

  const cases = new Map<string, number>();
  for (const items of byCase.values()) for (const item of items) cases.set(item, (cases.get(item) ?? 0) + 1);
  // "A few cases": two, or 2% of the pack when that is more.
  const few = Math.max(2, Math.ceil(byCase.size * 0.02));
  const phrases = new Set<string>();
  for (const [item, count] of cases) if (count <= few && !allowed.has(item)) phrases.add(item);
  return { phrases };
}

// Why this text must not be published or logged: conversation text from a pack, a secret, or personal data.
// Each problem is a plain sentence that names the kind of match and never repeats the matched text.
export function egressProblems(text: string, index: SensitiveIndex | null): string[] {
  const problems = personalDataKinds(text).map((kind) => `contains what looks like ${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}`);
  if (index !== null) {
    let copied = 0;
    let single = 0;
    for (const item of itemsOf(text)) {
      if (!index.phrases.has(item)) continue;
      if (item.includes(" ")) copied++; else single++;
    }
    if (copied > 0) problems.push(`contains wording copied from pack conversations (${copied} matches)`);
    if (single > 0) problems.push(`contains a word or identifier that appears only in particular pack conversations (${single} matches)`);
  }
  return problems;
}

// Throws PilotError egress_blocked naming `what` when egressProblems finds anything.
export function assertEgressSafe(text: string, index: SensitiveIndex | null, what: string): void {
  const problems = egressProblems(text, index);
  if (problems.length === 0) return;
  throw new PilotError("egress_blocked", `Nothing was sent: the ${what} ${problems.join("; ")}. Remove that content and try again.`);
}
