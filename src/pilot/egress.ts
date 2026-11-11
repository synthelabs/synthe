// What may leave the operator's environment. Lane: evidence and review workflow.
import { PilotError } from "./errors.ts";
import { personalDataKinds } from "./pii.ts";
import type { Pack } from "./types.ts";

// Opaque index of the case-specific content of one or more packs, for finding it in outgoing text.
export interface SensitiveIndex {
  readonly phrases: ReadonlySet<string>;
  // Matches the identifiers the reports print by design, as whole identifiers; null when the packs have none.
  readonly identifiers: RegExp | null;
}

const RUN = 3; // words in a run copied from a conversation
const WORD_MIN = 5; // letters in a lowercase word worth indexing on its own when it is rare
const TOKEN_MIN = 3; // characters in an identifier-like word (one that has a digit)
const NAME_MIN = 2; // letters in a word the conversations only ever show with a capital

// Cyrillic and Greek letters that look like Latin ones. Folded on both sides, so a name cannot pass by swapping
// a letter for its look-alike.
const LOOKALIKES = new Map<string, string>(
  ("АA ВB ЕE КK МM НH ОO РP СC ТT УY ХX ЅS ІI ЈJ аa еe оo рp сc уy хx ѕs іi јj ԁd ԛq ԝw һh "
    + "ΑA ΒB ΕE ΖZ ΗH ΙI ΚK ΜM ΝN ΟO ΡP ΤT ΥY ΧX οo νv ιi κk ρp").split(" ").map((p) => [p[0], p[1]] as [string, string]),
);

// The same normal form on both sides, so a quote cannot slip through by changing case, spacing, line breaks,
// punctuation, accents, dash variants, look-alike letters, or by hiding zero-width characters inside words.
// Compatibility forms are folded (NFKD), marks and format characters are removed, and everything that is not a
// letter or digit splits words.
const normal = (text: string): string =>
  text.normalize("NFKD").replace(/[\p{M}\p{Cf}]/gu, "").replace(/[\u0370-\u03ff\u0400-\u052f]/g, (ch) => LOOKALIKES.get(ch) ?? ch);

// A word with its case kept, and whether it starts a sentence: a capital there says nothing, anywhere else it marks
// a name. A full stop after a short capitalised word is an abbreviation ("Mr. Okonkwo"), not a sentence end.
interface Token { word: string; lower: string; starts: boolean }
function tokens(text: string): Token[] {
  const t = normal(text);
  const out: Token[] = [];
  let end = 0;
  for (const m of t.matchAll(/[\p{L}\p{N}]+/gu)) {
    const prev = out.at(-1);
    const between = t.slice(end, m.index);
    const abbreviation = prev !== undefined && prev.word.length <= 3 && prev.word !== prev.lower && /^\.\s*$/.test(between);
    out.push({ word: m[0], lower: m[0].toLowerCase(), starts: prev === undefined || (/[.!?]/.test(between) && !abbreviation) });
    end = m.index + m[0].length;
  }
  return out;
}

export function words(text: string): string[] {
  return tokens(text).map((t) => t.lower);
}

// A bracketed all-capital token such as [EMAIL_1] is the redaction's placeholder, not conversation content.
const PLACEHOLDER = /[[<{]{1,2}[A-Z][A-Z0-9_]{1,40}[\]>}]{1,2}/g;

const runsOf = (w: string[]): string[] => {
  const out: string[] = [];
  for (let i = 0; i + RUN <= w.length; i++) out.push(w.slice(i, i + RUN).join(" "));
  return out;
};

// A word written in two alphabets at once is how a look-alike letter is hidden. No ordinary text has one.
const MIXED = /(?=[\p{L}\p{M}]*\p{Script=Latin})(?=[\p{L}\p{M}]*[\p{Script=Cyrillic}\p{Script=Greek}])[\p{L}\p{M}]+/u;

function stringsIn(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value !== null && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.push(k); stringsIn(v, out); }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Case ids, check ids, catalog sentences and tool names are printed by the reports by design. They may leave as
// whole identifiers only: a name inside a case id does not make that name an allowed word anywhere else.
function identifierPattern(packs: Pack[]): RegExp | null {
  const ids = new Set<string>();
  for (const pack of packs) {
    for (const [id, sentence] of Object.entries(pack.check_catalog)) { ids.add(id); ids.add(sentence); }
    for (const tool of pack.tools) ids.add(tool.name);
    for (const c of pack.cases) ids.add(c.id);
  }
  const list = [...ids].filter((s) => s.trim() !== "").sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  if (list.length === 0) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${list.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_-])`, "gu");
}

const withoutIdentifiers = (text: string, identifiers: RegExp | null): string => (identifiers === null ? text : text.replace(identifiers, " "));

// What must not leave is what belongs to particular conversations. Three kinds of item are indexed:
//   - a run of three words that appears in only a few cases (a quote). Wording that many conversations share is
//     the agent's and the tools' own boilerplate ("this order can be returned", "eligible: yes");
//   - a word that appears in only a few cases, when it is long enough to mean something on its own;
//   - a word the conversations write with a capital inside a sentence and never in lowercase (a name, a place), or
//     one that has a digit (an order token, a postcode), however many cases it appears in: a returning customer is
//     in many.
//
// `allow` is text that may leave: the baseline prompt (already in the customer's repo) and the review's own
// generated wording. Identifiers the reports print are taken out of it first, so they allow nothing else.
export function sensitiveIndex(packs: Pack[], allow: string[] = []): SensitiveIndex {
  const identifiers = identifierPattern(packs);
  const byCase = new Map<string, Set<string>>();
  const always = new Set<string>();
  const capital = new Set<string>();
  const lower = new Set<string>();
  for (const pack of packs) {
    for (const c of pack.cases) {
      // The same case in two pack versions is one case, not two.
      const items = byCase.get(c.id) ?? new Set<string>();
      byCase.set(c.id, items);
      // Message text is prose, where the first word of a sentence has a capital whatever it is. The other fields
      // are values (a tool input, a label), where a capital at the start means as much as anywhere else.
      const prose: string[] = [];
      const values: string[] = [];
      for (const m of c.messages) {
        if (m.role === "tool") prose.push(m.result);
        else {
          prose.push(m.text);
          if (m.role === "assistant") for (const call of m.tool_calls ?? []) stringsIn(call.input, values);
        }
      }
      if (c.intent !== undefined) values.push(c.intent);
      values.push(c.provenance.ref);
      values.push(...Object.keys(c.observed ?? {}));
      for (const [texts, isProse] of [[prose, true], [values, false]] as const) {
        for (const t of texts) {
          const toks = tokens(t.replace(PLACEHOLDER, " "));
          for (const run of runsOf(toks.map((x) => x.lower))) items.add(run);
          for (const tok of toks) {
            if (/\p{N}/u.test(tok.lower)) { if (tok.lower.length >= TOKEN_MIN) always.add(tok.lower); continue; }
            if (tok.lower.length >= WORD_MIN) items.add(tok.lower);
            if (tok.word === tok.lower) lower.add(tok.lower);
            else if ((!isProse || !tok.starts) && tok.lower.length >= NAME_MIN) capital.add(tok.lower);
          }
        }
      }
    }
  }
  const allowed = new Set<string>();
  for (const t of allow) {
    const w = words(withoutIdentifiers(t, identifiers));
    for (const word of w) allowed.add(word);
    for (const run of runsOf(w)) allowed.add(run);
  }

  const cases = new Map<string, number>();
  for (const items of byCase.values()) for (const item of items) cases.set(item, (cases.get(item) ?? 0) + 1);
  // "A few cases": two, or 2% of the pack when that is more.
  const few = Math.max(2, Math.ceil(byCase.size * 0.02));
  const phrases = new Set<string>();
  for (const [item, count] of cases) if (count <= few && !allowed.has(item)) phrases.add(item);
  for (const word of always) if (!allowed.has(word)) phrases.add(word);
  // A word that some conversation also writes in lowercase is an ordinary word, not a name.
  for (const word of capital) if (!lower.has(word) && !allowed.has(word)) phrases.add(word);
  return { phrases, identifiers };
}

const listed = (lines: number[]): string => (lines.length === 0 ? "" : `; line${lines.length === 1 ? "" : "s"} ${lines.slice(0, 8).join(", ")}${lines.length > 8 ? " and more" : ""}`);

// Why this text must not be published or logged: conversation text from a pack, a secret, or personal data.
// Each problem is a plain sentence that names the kind of match and where it is, and never repeats the matched
// text.
export function egressProblems(text: string, index: SensitiveIndex | null): string[] {
  const problems = personalDataKinds(text).map((kind) => `contains what looks like ${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind}`);
  if (MIXED.test(text.normalize("NFKD").replace(/\p{Cf}/gu, ""))) problems.push("contains a word that mixes alphabets, which is how a look-alike letter hides a name");
  if (index !== null) {
    const rest = withoutIdentifiers(text, index.identifiers);
    const hits = (part: string): { copied: Set<string>; single: Set<string> } => {
      const w = words(part);
      return { copied: new Set(runsOf(w).filter((r) => index.phrases.has(r))), single: new Set(w.filter((x) => index.phrases.has(x))) };
    };
    const all = hits(rest);
    if (all.copied.size > 0 || all.single.size > 0) {
      const copiedOn: number[] = [];
      const singleOn: number[] = [];
      rest.split("\n").forEach((line, i) => {
        const h = hits(line);
        if (h.copied.size > 0) copiedOn.push(i + 1);
        if (h.single.size > 0) singleOn.push(i + 1);
      });
      if (all.copied.size > 0) problems.push(`contains wording copied from pack conversations (${all.copied.size} matches${listed(copiedOn)})`);
      if (all.single.size > 0) problems.push(`contains a name, identifier or word that belongs to particular pack conversations (${all.single.size} matches${listed(singleOn)})`);
    }
  }
  return problems;
}

// Throws PilotError egress_blocked naming `what` when egressProblems finds anything.
export function assertEgressSafe(text: string, index: SensitiveIndex | null, what: string): void {
  const problems = egressProblems(text, index);
  if (problems.length === 0) return;
  throw new PilotError("egress_blocked", `Nothing was sent: the ${what} ${problems.join("; ")}. Remove that content and try again.`);
}
