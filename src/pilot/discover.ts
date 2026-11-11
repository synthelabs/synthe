// Recurring failures from discovery cases, the proposer's context, and candidates. Lane: replay and failure discovery.
import { candidateProblem } from "../core/safety.ts";
import { PilotError } from "./errors.ts";
import { promptId } from "./ids.ts";
import { discoveryCases, turnCount } from "./pack.ts";
import type { ArmRun, Candidate, FailureFinding, Pack, ProposerContext, Sha256 } from "./types.ts";

const MAX_EXAMPLES = 8;

// Checks the baseline fails in at least min_recurring_cases discovery cases, most frequent first.
export function discoverFailures(input: { pack: Pack; baseline: ArmRun; min_recurring_cases: number }): FailureFinding[] {
  const { pack, baseline } = input;
  const min = Math.max(1, input.min_recurring_cases);
  const split = new Map(pack.cases.map((c) => [c.id, c.split]));
  // The arm must be a replay of this pack: every discovery case present, nothing unknown, and no case moved
  // between splits (a held-out case relabelled as discovery would otherwise reach the proposer).
  for (const run of baseline.cases) {
    if (split.get(run.case_id) !== run.split) throw new PilotError("conflict", "The baseline replay does not match the pack's cases. Replay the baseline on this pack again.");
  }
  const have = new Set(baseline.cases.map((c) => c.case_id));
  if (discoveryCases(pack).some((c) => !have.has(c.id))) throw new PilotError("conflict", "The baseline replay is missing discovery cases from the pack. Replay the baseline on this pack again.");

  const failing = new Map<string, { case_id: string; turn: number }[]>();
  const discovery = new Set(discoveryCases(pack).map((c) => c.id));
  // Pack order, so the lists are stable.
  const runs = new Map(baseline.cases.map((c) => [c.case_id, c]));
  for (const pc of pack.cases) {
    if (!discovery.has(pc.id)) continue;
    for (const t of runs.get(pc.id)?.turns ?? []) {
      for (const r of t.checks) {
        if (r.role === "primary" && r.pass === false) {
          const list = failing.get(r.id) ?? [];
          list.push({ case_id: pc.id, turn: t.turn });
          failing.set(r.id, list);
        }
      }
    }
  }

  const findings: FailureFinding[] = [];
  for (const [check_id, list] of failing) {
    const distinct = new Set(list.map((x) => x.case_id)).size;
    if (distinct < min) continue;
    findings.push({
      version: 1, pack_id: baseline.pack_id, baseline_prompt_id: baseline.prompt_id, check_id,
      description: pack.check_catalog[check_id] ?? "",
      failing: list,
      discovery_cases_with_check: discoveryCases(pack).filter((c) => c.checks.some((k) => k.id === check_id)).length,
    });
  }
  const count = (f: FailureFinding): number => new Set(f.failing.map((x) => x.case_id)).size;
  return findings.sort((a, b) => count(b) - count(a) || (a.check_id < b.check_id ? -1 : a.check_id > b.check_id ? 1 : 0));
}

// Everything a proposer is given. Built from discovery cases only; throws PilotError holdout_leak otherwise.
export function proposerContext(input: { pack: Pack; baseline_prompt: string; finding: FailureFinding; attempt: number; feedback: string[]; max_changed_lines: number }): ProposerContext {
  const { pack, finding } = input;
  const allowed = new Map(discoveryCases(pack).map((c) => [c.id, c]));
  // Every entry is checked, not just the ones that fit under the cap.
  for (const f of finding.failing) {
    if (!allowed.has(f.case_id)) throw new PilotError("holdout_leak", "The finding names a case that is not a discovery case of this pack. Nothing was sent to the proposer. Rebuild the finding from the baseline replay.");
  }
  const examples = finding.failing.slice(0, MAX_EXAMPLES).map((f) => {
    const c = allowed.get(f.case_id)!;
    if (!Number.isInteger(f.turn) || f.turn < 1 || f.turn > turnCount(c)) throw new PilotError("conflict", `The finding names turn ${f.turn} of case ${f.case_id}, which has ${turnCount(c)} turns.`);
    let seen = 0;
    let end = c.messages.length;
    for (const [i, m] of c.messages.entries()) {
      if (m.role === "user" && ++seen === f.turn) { end = i + 1; break; }
    }
    return { case_id: f.case_id, turn: f.turn, messages: c.messages.slice(0, end) };
  });
  return { baseline_prompt: input.baseline_prompt, finding, examples, attempt: input.attempt, feedback: input.feedback, max_changed_lines: input.max_changed_lines };
}

// Beyond this many line pairs the diff is not worked out exactly: everything counts as changed, which can only
// make a candidate look wider than it is, never narrower.
const MAX_DIFF_CELLS = 25_000_000;

// Lines added plus lines removed between two prompt texts.
export function changedLines(before: string, after: string): number {
  const a = before.split("\n");
  const b = after.split("\n");
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let hiA = a.length;
  let hiB = b.length;
  while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) { hiA--; hiB--; }
  const x = a.slice(lo, hiA);
  const y = b.slice(lo, hiB);
  if (x.length === 0 || y.length === 0) return x.length + y.length;
  if (x.length * y.length > MAX_DIFF_CELLS) return x.length + y.length;
  let prev = new Array<number>(y.length + 1).fill(0);
  let cur = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    [prev, cur] = [cur, prev];
  }
  const common = prev[y.length];
  return x.length - common + (y.length - common);
}

// Validates a proposed or human-written prompt as a narrow change. Throws PilotError: invalid_candidate, candidate_not_narrow.
export function makeCandidate(input: {
  pilot_id: string; baseline_prompt: string; prompt: string; origin: "proposer" | "human"; author: string; rationale: string;
  finding_id: Sha256 | null; target_check_id: string | null; max_changed_lines: number;
}): Candidate {
  const invalid = (why: string): never => { throw new PilotError("invalid_candidate", `The candidate was refused: ${why}.`); };
  if (typeof input.author !== "string" || input.author.trim() === "") invalid("it has no author");
  if (typeof input.rationale !== "string" || input.rationale.trim() === "") invalid("it has no rationale");
  const problem = candidateProblem(input.prompt, { kind: "file", path: "prompt.md" });
  if (problem) invalid(problem);
  if (input.prompt === input.baseline_prompt) invalid("it is identical to the current prompt");
  const changed = changedLines(input.baseline_prompt, input.prompt);
  if (changed > input.max_changed_lines) throw new PilotError("candidate_not_narrow", `The candidate changes ${changed} lines; the limit is ${input.max_changed_lines}. Make a smaller change.`);
  return {
    version: 1, pilot_id: input.pilot_id, baseline_prompt_id: promptId(input.baseline_prompt), prompt_id: promptId(input.prompt),
    origin: input.origin, author: input.author, rationale: input.rationale, finding_id: input.finding_id, target_check_id: input.target_check_id, changed_lines: changed,
  };
}

export function renderFindings(findings: FailureFinding[], pack: Pack): string {
  if (findings.length === 0) return "No check failed in enough discovery cases to count as a recurring failure.\n";
  const out: string[] = ["# Recurring failures on discovery cases", ""];
  for (const f of findings) {
    const cases = new Set(f.failing.map((x) => x.case_id)).size;
    out.push(`## ${f.check_id}`, "", pack.check_catalog[f.check_id] ?? f.description, "");
    out.push(`- Fails in ${cases} of ${f.discovery_cases_with_check} discovery cases that test it`);
    out.push(`- Failing: ${f.failing.map((x) => `${x.case_id} (turn ${x.turn})`).join(", ")}`, "");
  }
  return out.join("\n");
}
