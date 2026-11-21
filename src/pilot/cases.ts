// Replay failures as candidate test cases for Synthe's scenarios file. Nothing here calls a model or the network,
// and nothing is added to the team's own scenarios: a person reads the file this writes and copies what they want.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PilotError } from "./errors.ts";
import { frozen, type Flags, type PilotDeps } from "./commands.ts";
import { shortId } from "./ids.ts";
import { printable, writeAtomic } from "./io.ts";
import { personalDataKinds } from "./pii.ts";
import { eligibleFailures } from "./promote.ts";
import type { CaseCheck, Pack, PackCase, ReplayReport, Sha256 } from "./types.ts";
import type { PilotStore } from "./store.ts";

export interface CandidateCase { id: string; input: string; expected: string; split: "train" }
export interface CasesResult {
  cases: CandidateCase[];
  // Why failures were left out, as counts. Never the text or the ids of what was left out.
  heldout: number;
  personalData: number;
  // Cases whose `expected` is a placeholder a person must fill in.
  placeholders: number;
  // Cases whose conversation had tool calls: tool results aren't part of a scenario's input.
  usedTools: number;
}

const MAX_INPUT = 4000;
export const PLACEHOLDER = "TODO: describe what a good answer does. No check text was recorded for this failure.";

const quoted = (words: string[]) => words.map((w) => `"${w}"`).join(", ");

// What a good reply does, in a sentence, for the rule a reply broke.
function describe(check: CaseCheck): string {
  switch (check.kind) {
    case "reply_includes": return `The reply mentions one of: ${quoted(check.any_of)}`;
    case "reply_excludes": return `The reply does not say any of: ${quoted(check.any_of)}`;
    case "calls_tool": return `The agent calls the ${check.tool} tool`;
    case "avoids_tool": return `The agent does not call the ${check.tool} tool`;
    case "tool_requires": return `The agent calls ${check.after} before ${check.tool}`;
  }
}

// The pack's own one-sentence description of the check when it has one, else a sentence made from the rule itself.
function expectedFor(c: PackCase, pack: Pack, turn: number, checkIds: string[]): string {
  const parts = checkIds.flatMap((id) => {
    const catalog = pack.check_catalog[id];
    if (typeof catalog === "string" && catalog.trim()) return [catalog.trim().replace(/\.$/, "")];
    const rule = c.checks.find((k) => k.id === id && k.turn === turn);
    return rule ? [describe(rule)] : [];
  });
  return parts.length ? [...new Set(parts)].join("; ") : PLACEHOLDER;
}

// The conversation up to and including the customer's message that the failing turn answered. Earlier turns are
// kept as a transcript so the case still makes sense; the oldest go first if it is too long.
function inputFor(c: PackCase, turn: number): { text: string; usedTools: boolean } | null {
  const userAt = c.messages.flatMap((m, i) => (m.role === "user" ? [i] : []));
  const last = userAt[turn - 1];
  if (last === undefined) return null;
  const before = c.messages.slice(0, last + 1);
  const usedTools = before.some((m) => m.role === "tool" || (m.role === "assistant" && (m.tool_calls?.length ?? 0) > 0));
  const lines = before.flatMap((m) =>
    m.role === "user" ? [`Customer: ${m.text.trim()}`] : m.role === "assistant" && m.text.trim() ? [`Agent: ${m.text.trim()}`] : []);
  if (lines.length === 1) return { text: lines[0].slice("Customer: ".length), usedTools };
  while (lines.length > 1 && lines.join("\n").length > MAX_INPUT) lines.shift();
  return { text: lines.join("\n"), usedTools };
}

const safeId = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "case";

// One candidate per assistant turn where the baseline prompt broke a check (primary or guard) in a discovery case.
// Held-out cases are never used: what a held-out conversation says must not reach a file the writer will read.
export function failureCases(pack: Pack, replay: { id: Sha256; value: ReplayReport }): CasesResult {
  const failures = eligibleFailures([replay]).filter((f) => f.arm === "baseline");
  const byTurn = new Map<string, { case_id: string; turn: number; checks: string[] }>();
  const heldoutTurns = new Set<string>();
  for (const f of failures) {
    const key = JSON.stringify([f.case_id, f.turn]);
    if (f.split === "heldout") { heldoutTurns.add(key); continue; }
    const entry = byTurn.get(key) ?? { case_id: f.case_id, turn: f.turn, checks: [] };
    if (!entry.checks.includes(f.check_id)) entry.checks.push(f.check_id);
    byTurn.set(key, entry);
  }
  const out: CasesResult = { cases: [], heldout: heldoutTurns.size, personalData: 0, placeholders: 0, usedTools: 0 };
  const byId = new Map(pack.cases.map((c) => [c.id, c]));
  for (const t of [...byTurn.values()].sort((a, b) => (a.case_id < b.case_id ? -1 : a.case_id > b.case_id ? 1 : a.turn - b.turn))) {
    const c = byId.get(t.case_id);
    // A heldout case in the pack is never used, whatever the replay says its split was.
    if (!c || c.split === "heldout") { out.heldout++; continue; }
    const built = inputFor(c, t.turn);
    if (built === null) continue;
    const input = built.text;
    const expected = expectedFor(c, pack, t.turn, t.checks);
    // The pack was checked for personal data when it was imported. This is the same check on what is written, as a
    // backstop: a case that trips it is left out rather than written with the text in it.
    if (personalDataKinds(input).length > 0 || personalDataKinds(expected).length > 0) { out.personalData++; continue; }
    if (expected === PLACEHOLDER) out.placeholders++;
    if (built.usedTools) out.usedTools++;
    out.cases.push({ id: `pilot-${safeId(c.id)}-t${t.turn}`, input, expected, split: "train" });
  }
  return out;
}

export const renderCases = (cases: CandidateCase[]): string => cases.map((c) => JSON.stringify({ id: c.id, input: c.input, expected: c.expected, split: "train" })).join("\n") + (cases.length ? "\n" : "");

// `pilot cases --replay <id> [--out <file>]`
export async function cases(store: PilotStore, flags: Flags, deps: PilotDeps): Promise<number> {
  frozen(store);
  const replayArg = flags.replay;
  if (typeof replayArg !== "string" || !replayArg.trim()) throw new PilotError("usage", "--replay is required: the replay id `replay` printed (or that `promote --list` shows).");
  const id = store.resolve("replay", replayArg.trim());
  const replay = store.stored<ReplayReport>("replay", id);
  const pack = store.stored<Pack>("pack", replay.value.pack_id);
  const outFlag = flags.out;
  if (outFlag !== undefined && (typeof outFlag !== "string" || !outFlag.trim())) throw new PilotError("usage", "--out needs a file name.");
  const result = failureCases(pack.value, replay);
  const n = result.cases.length;
  deps.say(`Replay ${shortId(id)}: ${n} candidate test case${n === 1 ? "" : "s"} from the current prompt's failures on discovery cases.`);
  if (result.heldout) deps.say(`Left out ${result.heldout} failure${result.heldout === 1 ? "" : "s"} on held-out cases: those conversations stay held out.`);
  if (result.personalData) deps.say(`Left out ${result.personalData} case${result.personalData === 1 ? "" : "s"} that look like they hold personal data or a secret. Redact them in the pack and export it again.`);
  if (n === 0) {
    deps.say("Nothing was written. The current prompt failed no check on a discovery case in this replay.");
    return 0;
  }
  const text = renderCases(result.cases);
  let path: string;
  if (typeof outFlag === "string") {
    path = resolve(outFlag);
    // Whatever --out names is created, never added to or replaced, so a team's own scenarios file can't be damaged.
    if (existsSync(path)) throw new PilotError("conflict", `${printable(outFlag, 200)} already exists. Name a new file with --out, then copy the lines you want into your scenarios file yourself.`);
    mkdirSync(dirname(path), { recursive: true });
    try { writeFileSync(path, text, { flag: "wx", mode: 0o600 }); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new PilotError("conflict", `${printable(outFlag, 200)} already exists. Name a new file with --out.`);
      throw e;
    }
  } else {
    // Not in reports/: a report never holds conversation text, and these lines are conversation text.
    path = join(store.dir, "cases", `cases-${shortId(id)}.jsonl`);
    writeAtomic(path, text);
  }
  deps.say(`Wrote ${path}`);
  if (result.placeholders) deps.say(`${result.placeholders} case${result.placeholders === 1 ? " has" : "s have"} an \`expected\` that starts with TODO: write what a good answer does before you use it.`);
  if (result.usedTools) deps.say(`${result.usedTools} conversation${result.usedTools === 1 ? "" : "s"} used tools. Tool results aren't in a case's input, so check the case still makes sense.`);
  deps.say(`Every case is split "train". Read each one, then copy the ones you want into the team's scenarios file (\`.synthe/scenarios.jsonl\`) yourself: this command never changes it.`);
  deps.say(`These are the customer's redacted conversations, approved for: ${printable(pack.value.source.approved_uses.join(", "), 120)}. The scenarios file is committed to the repo and read by Synthe's models, so confirm that use is covered before you copy a case in.`);
  return 0;
}
