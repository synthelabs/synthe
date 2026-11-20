import { parseScenarios, type Goal, type Scenario } from "../core/goal.ts";
import { addedBreaks, type RoundScores } from "../core/merge-rule.ts";
import { candidateProblem, sha256 } from "../core/safety.ts";
import { candidateFingerprint } from "../core/candidate-history.ts";
import type { PoolEntry, RoundRecord } from "../core/state.ts";
// write.ts imports this file back for runWrite. Nothing here runs at load time, so the cycle is harmless; keep it
// that way (no top-level use of anything imported from write.ts).
import { applyEdits, clip, MAX_EDITS, type Candidate, type Edit } from "./write.ts";

// Population (prototype, off unless synthe.json sets "population": true). Synthe hill-climbs: one current prompt, a
// couple of new candidates a round, and a candidate that won some training cases without winning the round is thrown
// away, though it found something real about those cases. Prompt optimizers that keep a population instead (GEPA's
// Pareto set, the program databases in FunSearch and AlphaEvolve; ideas only, no code copied) keep every candidate
// that is best somewhere and combine them. Here: the decide step keeps up to POOL_SIZE such changes in state, and
// the write step builds one more candidate by applying, to the current prompt, the edits of the one or two pooled
// changes whose wins cover the most training cases. No model writes it: the edits are applied as they were.
//
// The merge candidate is only an extra option. It passes the same safety checks as a writer candidate, is dueled on
// the same training cases and is judged by the unchanged merge rule. It does add a comparison to the round, so one
// more candidate gets a chance to pass the gate by luck; run-level control of that is a separate piece of work. When
// compose is on too, compose sits out a round where the pool added a candidate (see runScore), so the two never add
// more than one comparison between them.

export const POOL_SIZE = 4;
export const POOL_ID = "combined";
// State is one JSON file read through GitHub's contents API, which stops returning content at 1 MB. An entry is two
// short edits, a one-line summary and a list of ids, so the whole pool stays in the tens of kilobytes at most. A
// change with longer edits is not pooled: an edit can't be shortened and still apply.
const MAX_ENTRY_CHARS = 2000;
const SUMMARY_KEPT = 200;
const MAX_WON = 200;

export interface PoolCandidate extends Candidate { combines: { round: number; summary: string }[] }
export interface PoolMerge { candidate: PoolCandidate | null; skipped?: string }

const isEdit = (e: unknown): e is Edit => typeof (e as Edit)?.find === "string" && typeof (e as Edit)?.replace === "string";
const poolable = (edits: unknown): edits is Edit[] =>
  Array.isArray(edits) && edits.length >= 1 && edits.length <= MAX_EDITS && edits.every(isEdit)
  && edits.reduce((n, e) => n + e.find.length + e.replace.length, 0) <= MAX_ENTRY_CHARS;

// The pool as saved, without anything that isn't shaped like an entry. State can be edited by hand and the pool
// only ever suggests a candidate, so a damaged entry is dropped instead of stopping the round.
export function validPool(value: unknown): PoolEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    const e = v as PoolEntry | null;
    if (!e || typeof e.id !== "string" || !Number.isSafeInteger(e.round) || e.round < 1 || typeof e.summary !== "string" || !poolable(e.edits)
      || !Array.isArray(e.wonOn) || e.wonOn.some((id) => typeof id !== "string") || typeof e.promptHash !== "string") return [];
    const wonOn = [...new Set(e.wonOn)].slice(0, MAX_WON);
    return wonOn.length ? [{ id: e.id, round: e.round, summary: e.summary.slice(0, SUMMARY_KEPT + 3), edits: e.edits.map(({ find, replace }) => ({ find, replace })), wonOn, promptHash: e.promptHash }] : [];
  });
}

const flat = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();

// One pooled change applied to a prompt, by the writer's own rules, or why it can't be. An edit that adds a
// paragraph at the end always "applies", so text the prompt already has is refused here: otherwise a change that
// was merged, or two entries that add the same rule, would put the same paragraph in twice.
function apply(text: string, entry: PoolEntry, goal: Goal): { text: string } | { problem: string } {
  const have = flat(text);
  if (entry.edits.some((e) => e.find === "" && have.includes(flat(e.replace)))) return { problem: "the prompt already has this text" };
  return applyEdits(text, entry.edits, `${goal.objective}\n${goal.policy ?? ""}`);
}

// The pool after a judged round. scores and candidates are this round's; promptAfter is the prompt as the round
// leaves it (the winner's text after a merge, the older prompt after an undo, else unchanged).
//
// wonOn means: training cases where the change beat the prompt of its day, and that no merged change has won since.
// Each case in it is one the current prompt lost to this change or has not been shown to fix, which is what the
// write step covers. Only training rows are read, and every id is checked against the scenario file's training
// split on each update, so a held-back id can never be stored, even from a tampered scores file.
export function updatePool(a: {
  pool: unknown; round: number; goal: Goal; candidates: Candidate[]; scores: RoundScores; scenarioText: string | null;
  promptAfter: string; outcome: RoundRecord["outcome"]; winnerId: string | null;
}): PoolEntry[] {
  let trainIds: Set<string>;
  // Without a readable scenario file the ids can't be checked, and an empty pool is always safe.
  try { trainIds = new Set(parseScenarios(a.scenarioText ?? "").filter((s) => s.split === "train").map((s) => s.id)); } catch { return []; }
  const even = new Map(a.scores.baselineTrain.map((r) => [r.id, r.score]));
  const winsOf = (id: string) => (a.scores.candidates.find((c) => c.id === id)?.train ?? []).filter((r) => {
    const current = even.get(r.id);
    return typeof r.score === "number" && typeof current === "number" && r.score > current;
  }).map((r) => r.id);

  let entries = validPool(a.pool);
  // After an undo the candidates' wins were against a prompt that is gone, so none are added.
  if (a.outcome !== "reverted") {
    for (const c of a.candidates) {
      // The winner is in the prompt now. The merge candidate is not pooled either: its parts already are, and as an
      // entry it would crowd them out and then only ever rebuild itself.
      if (c.id === a.winnerId || c.id === POOL_ID || !poolable(c.edits)) continue;
      const id = `r${a.round}-${c.id}`;
      const scored = a.scores.candidates.find((s) => s.id === c.id);
      // The merge rule's own test, on the training rows: a new guardrail break, or a row that couldn't be judged,
      // keeps a change out.
      if (!scored || entries.some((e) => e.id === id) || addedBreaks(scored.train, a.scores.baselineTrain) > 0) continue;
      const wonOn = winsOf(c.id);
      if (wonOn.length) entries.push({ id, round: a.round, summary: clip(c.summary ?? "A change to the prompt", SUMMARY_KEPT), edits: c.edits.map(({ find, replace }) => ({ find, replace })), wonOn, promptHash: a.scores.baselineHash });
    }
  }
  // A merged change's wins are fixed in the prompt now, so they stop counting for everyone else.
  const fixed = new Set(a.outcome === "merged" && a.winnerId ? winsOf(a.winnerId) : []);
  entries = entries.map((e) => ({ ...e, wonOn: e.wonOn.filter((id) => trainIds.has(id) && !fixed.has(id)).slice(0, MAX_WON) })).filter((e) => e.wonOn.length > 0);
  // Stale entries go before the Pareto step, so one that no longer applies can't push out one that still does.
  entries = entries.filter((e) => !("problem" in apply(a.promptAfter, e, a.goal)));
  // Pareto: an entry whose wins are all inside another's adds nothing a merge could use. Of two with the same
  // wins, the newer stays.
  entries.sort((x, y) => y.round - x.round);
  const within = (x: PoolEntry, y: PoolEntry) => x.wonOn.every((id) => y.wonOn.includes(id));
  entries = entries.filter((e, i) => !entries.some((d, j) => j !== i && within(e, d) && (!within(d, e) || j < i)));
  // Newest first here, so the cap drops the oldest. Saved oldest first.
  return entries.slice(0, POOL_SIZE).sort((x, y) => x.round - y.round);
}

// Added paragraphs land in the order they were applied, which is not a conflict, so order is ignored here.
const paragraphs = (t: string) => t.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).sort().join("\n\n");

// One or two pooled changes applied to the prompt. Two changes conflict unless applying them in either order works
// and gives the same prompt: that catches two edits to the same sentence, and an edit whose text the other removed.
function combine(prompt: string, picks: PoolEntry[], goal: Goal): { text: string } | { problem: string } {
  const [x, y] = picks;
  const first = apply(prompt, x, goal);
  if (!y || "problem" in first) return first;
  const both = apply(first.text, y, goal);
  const yFirst = apply(prompt, y, goal);
  const other = "problem" in yFirst ? yFirst : apply(yFirst.text, x, goal);
  if ("problem" in both || "problem" in other || paragraphs(both.text) !== paragraphs(other.text)) return { problem: "their edits conflict" };
  return both;
}

// The write step's extra candidate: the pooled changes that cover the most training cases, applied to the current
// prompt. The pool holds at most POOL_SIZE entries, so every single entry and every pair is looked at, best cover
// first (for two picks that is what a greedy set cover finds, or better), and the first one that applies cleanly,
// passes the safety checks and has not been tried before is used. tried holds the fingerprints already attempted for
// this goal and prompt, including this round's writer candidates; the new candidate's is added to it.
export function mergeFromPool(a: { goal: Goal; prompt: string; train: Scenario[]; pool: unknown; tried: Set<string> }): PoolMerge {
  const { goal, prompt } = a;
  const trainIds = new Set(a.train.map((s) => s.id));
  const saved = validPool(a.pool);
  if (saved.length === 0) return { candidate: null, skipped: "the pool is empty" };
  // A scenario that left the training split since the entry was saved no longer counts as cover.
  const live = saved.map((e) => ({ ...e, wonOn: e.wonOn.filter((id) => trainIds.has(id)) }))
    .filter((e) => e.wonOn.length > 0 && !("problem" in apply(prompt, e, goal)))
    .sort((x, y) => x.round - y.round);
  if (live.length === 0) return { candidate: null, skipped: "no pooled change still applies to the current prompt" };

  const now = sha256(prompt);
  // A single entry measured against this same prompt is the candidate that already lost; it only becomes a new
  // candidate once the prompt has changed under it.
  const options: PoolEntry[][] = [
    ...live.flatMap((x, i) => live.slice(i + 1).map((y) => [x, y])),
    ...live.filter((e) => e.promptHash !== now).map((e) => [e]),
  ];
  const cover = (o: PoolEntry[]) => new Set(o.flatMap((e) => e.wonOn)).size;
  const newest = (o: PoolEntry[]) => o.reduce((n, e) => n + e.round, 0) / o.length;
  options.sort((x, y) => cover(y) - cover(x) || x.length - y.length || newest(y) - newest(x));

  const refused: string[] = [];
  for (const picks of options) {
    const built = combine(prompt, picks, goal);
    const print = "text" in built ? candidateFingerprint(built.text) : "";
    const problem = "problem" in built ? built.problem
      : candidateProblem(built.text, goal.prompt)
        ?? (print === candidateFingerprint(prompt) ? "it changes only formatting or case" : a.tried.has(print) ? "it was already tried for this goal and prompt" : null);
    if (problem || !("text" in built)) { refused.push(`${picks.map((e) => e.id).join(" + ")}: ${problem}`); continue; }
    a.tried.add(print);
    const rounds = [...new Set(picks.map((e) => e.round))].sort((x, y) => x - y);
    const where = rounds.length === 1 ? `round ${rounds[0]}` : `rounds ${rounds.slice(0, -1).join(", ")} and ${rounds.at(-1)}`;
    const ideas = picks.map((e) => clip(e.summary.replace(/[.\s]+$/, ""), 100)).join("; ");
    // The rounds come first in the summary, so the report and the pull request, which both show it, always say
    // where a combined change came from, even when the rest is cut short.
    const summary = picks.length === 1
      ? `Brings back a change from ${where} that did better in ${picks[0].wonOn.length} test case${picks[0].wonOn.length === 1 ? "" : "s"} before the prompt changed: ${ideas}`
      : `Combines two changes from ${where} that each did better in different test cases: ${ideas}`;
    return {
      candidate: {
        id: POOL_ID, text: built.text, edits: picks.flatMap((e) => e.edits), summary: summary.slice(0, 300),
        title: picks.length === 1 ? `retry a fix from ${where}` : `combine fixes from ${where}`,
        combines: picks.map((e) => ({ round: e.round, summary: e.summary })),
      },
    };
  }
  return { candidate: null, skipped: refused.length ? `no new combination (${refused[0]})` : "nothing to combine yet" };
}

// The earlier rounds a winning merge candidate was built from, for the round's record. candidates.json is another
// job's output, so the shape is checked instead of trusted.
export function combinedRounds(c: Candidate | undefined): number[] | undefined {
  const from = (c as PoolCandidate | undefined)?.combines;
  if (c?.id !== POOL_ID || !Array.isArray(from)) return undefined;
  const rounds = [...new Set(from.map((f) => f?.round).filter((r) => Number.isSafeInteger(r) && r >= 1))].sort((x, y) => x - y);
  return rounds.length ? rounds : undefined;
}

// Plain lines for the Actions log.
export function explainPool(m: PoolMerge | undefined): string[] {
  if (!m) return [];
  if (!m.candidate) return [`pool: no merge candidate, ${m.skipped ?? "nothing to combine"}`];
  return [`pool: ${m.candidate.id} applies ${m.candidate.combines.map((f) => `"${clip(f.summary, 80)}" (round ${f.round})`).join(" and ")}`];
}
