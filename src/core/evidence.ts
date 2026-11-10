import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { GOAL_FILE, parseGoal, parseScenarios, type Goal } from "./goal.ts";
import { checkRate, judgeRound, type CandidateScore, type RoundScores, type ScoreRow, type Verdict } from "./merge-rule.ts";
import { findPrompts } from "./prompt.ts";
import { sha256 } from "./safety.ts";

export const EVIDENCE_DIR = ".synthe/evidence";
export const evidencePath = (round: number) => `${EVIDENCE_DIR}/round-${round}.json`;

export interface ScenarioScore {
  id: string;
  baselineScore: number | null;
  candidateScore: number | null;
  checkFailed?: number;
  // The candidate's applicable-check count and the baseline's failed/applicable counts, so the record's
  // checksBefore/checksAfter can be recomputed at verify time instead of trusted.
  checkApplicable?: number;
  baselineCheckFailed?: number;
  baselineCheckApplicable?: number;
  guardFailed?: number;
  // Not in the first schema: whether the current prompt broke a guardrail here. Without it the merge rule's "never
  // add a break" test can't be rerun. Absent means unknown, as a null violation does everywhere else.
  baselineGuardFailed?: number;
}

// Hashes and ids only. No prompt text, no replies, no scenario text.
export interface EvidenceRecord {
  round: number;
  promptHashBefore: string;
  promptHashAfter: string;
  // merge: landed. propose: a merge held for a person. revert: the last merge put back. skip: nothing changed.
  verdict: "merge" | "skip" | "revert" | "propose";
  verdictReasons: string[];
  // The candidate whose scores are in scenarioScores. Null when there was none, and for a revert.
  candidateId: string | null;
  // The commit the round was tested at, so verify can read the prompt there and check it against
  // promptHashBefore. Null in records written before this was kept.
  commit: string | null;
  // The merge mode the round ran in. In review ("propose") mode Synthe never merges by itself, so a
  // record claiming a merge under that mode contradicts itself. Absent in older records.
  mergeMode?: "auto" | "propose";
  // The held-back sign-test limit the round ran with. Absent in records written before the check existed, which
  // are rechecked under the rule they ran with: no held-back sign test (a limit of 1).
  holdoutMaxP?: number;
  modelIds: { writer: string; runner: string; judge: string; checker: string };
  scenarioScores: ScenarioScore[];
  checksBefore: number | null;
  checksAfter: number | null;
  guardsBefore: number | null;
  guardsAfter: number | null;
  // The frozen attack set's results, when the repo has one: how many attacks ran, which ones the current
  // prompt failed, and which ones the recorded candidate failed. A null list means that side's result was
  // unknown, which blocks a merge. Verify needs these to re-run the merge rule faithfully: without them an
  // attack-blocked verdict recomputes as a merge and a genuine record looks tampered with. Absent when the
  // repo has no attacks file, and in records written before this was kept.
  attacks?: { total: number; baselineFailed: string[] | null; candidateFailed: string[] | null };
  costUsd: number | null;
  prevEvidenceHash: string | null;
  sha256: string;
}

// Sorted keys at every depth, so the same record always hashes the same however its fields were ordered.
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

export const canonicalJson = (value: unknown) => JSON.stringify(sortKeys(value));

// The record's own hash field is empty while hashing: a hash can't contain itself.
export const hashEvidence = (record: EvidenceRecord) => sha256(canonicalJson({ ...record, sha256: "" }));

export const evidenceFile = (record: EvidenceRecord) => `${JSON.stringify(record, null, 2)}\n`;

const pct = (n: number, of: number) => Math.round((100 * n) / of);
// The share of rows with no guardrail break, or null when there are no guardrails, no rows, or a row couldn't be checked.
const guardRate = (rows: ScoreRow[], guards: number) => (guards === 0 || rows.length === 0 || rows.some((r) => r.violation === null) ? null : pct(rows.filter((r) => r.violation === false).length, rows.length));
const flag = (violation: boolean | null | undefined) => (typeof violation === "boolean" ? { n: violation ? 1 : 0 } : null);

export interface EvidenceParams {
  round: number;
  goal: Goal;
  promptBefore: string;
  promptAfter: string;
  verdict: EvidenceRecord["verdict"];
  verdictReasons: string[];
  scores: RoundScores;
  // The candidate whose rows go in the record: the winner, or for a skip the one that came closest.
  candidateId: string | null;
  // The prompt the last merge replaced, for a revert: its head-to-head rows stand in for the candidate's.
  prior?: ScoreRow[];
  checks?: { before: number; after: number };
  costUsd: number | null;
  prevEvidenceHash: string | null;
  commit?: string | null;
}

export function buildEvidence(p: EvidenceParams): EvidenceRecord {
  const { scores } = p;
  const cand = p.candidateId === null ? undefined : scores.candidates.find((c) => c.id === p.candidateId);
  const own = new Map<string, ScoreRow>([...(cand?.train ?? []), ...(cand?.holdout ?? [])].map((r) => [r.id, r]));
  const prior = new Map((p.prior ?? []).map((r) => [r.id, r]));
  const base = [...scores.baselineTrain, ...scores.baselineHoldout];
  const scenarioScores: ScenarioScore[] = base.map((b) => {
    const c = own.get(b.id) ?? prior.get(b.id);
    const guard = flag(c?.violation);
    const baseGuard = flag(b.violation);
    return {
      id: b.id,
      baselineScore: b.score,
      candidateScore: c?.score ?? null,
      ...(typeof c?.failed === "number" ? { checkFailed: c.failed } : {}),
      ...(typeof c?.applicable === "number" ? { checkApplicable: c.applicable } : {}),
      ...(typeof b.failed === "number" ? { baselineCheckFailed: b.failed } : {}),
      ...(typeof b.applicable === "number" ? { baselineCheckApplicable: b.applicable } : {}),
      ...(guard ? { guardFailed: guard.n } : {}),
      ...(baseGuard ? { baselineGuardFailed: baseGuard.n } : {}),
    };
  });
  const after = cand ? [...cand.train, ...(cand.holdout ?? [])] : [];
  const guards = p.goal.guardrails.length;
  const record: EvidenceRecord = {
    round: p.round,
    promptHashBefore: sha256(p.promptBefore),
    promptHashAfter: sha256(p.promptAfter),
    verdict: p.verdict,
    verdictReasons: p.verdictReasons,
    candidateId: p.candidateId,
    commit: p.commit ?? null,
    mergeMode: p.goal.merge_rule.mode,
    holdoutMaxP: p.goal.merge_rule.holdout_max_p,
    modelIds: { ...p.goal.models },
    scenarioScores,
    checksBefore: p.checks?.before ?? null,
    checksAfter: p.checks?.after ?? null,
    guardsBefore: guardRate(base, guards),
    guardsAfter: guardRate(after, guards),
    ...(scores.attacks ? { attacks: { total: scores.attacks.total, baselineFailed: scores.attacks.baselineFailed, candidateFailed: cand?.attackFailed ?? null } } : {}),
    costUsd: p.costUsd,
    prevEvidenceHash: p.prevEvidenceHash,
    sha256: "",
  };
  record.sha256 = hashEvidence(record);
  return record;
}

export type VerifyResult = { ok: true; notes: string[] } | { ok: false; reason: string };

const roundOf = (name: string) => /^round-(\d+)\.json$/.exec(name)?.[1];

// Rebuilds the merge rule's inputs from the record and asks it again. A flipped verdict is caught here even when
// the person who edited a score also fixed the hash.
export function recomputeProblem(r: EvidenceRecord, goal: Goal, splits: Map<string, "train" | "holdout">): string | null {
  const missing = r.scenarioScores.find((s) => !splits.has(s.id));
  if (missing) return `scenario ${missing.id} isn't in ${goal.scenarios}, so the verdict can't be rechecked`;
  // The record must hold a row for every scenario: dropping rows and fixing the hash must not pass.
  const present = new Set(r.scenarioScores.map((s) => s.id));
  const dropped = [...splits.keys()].find((id) => !present.has(id));
  if (dropped) return `the record has no scores for scenario ${dropped}, so it is incomplete and the verdict can't be rechecked`;
  if (r.holdoutMaxP !== undefined && !(typeof r.holdoutMaxP === "number" && r.holdoutMaxP > 0 && r.holdoutMaxP <= 1)) return "the record's held-back limit (holdoutMaxP) is not a number above 0 and at most 1";
  if (r.mergeMode === "propose" && r.verdict === "merge") return "the record says the round ran in review mode, where Synthe never merges by itself, but the verdict says it merged";
  const rowOf = (s: ScenarioScore, score: number | null, guard: number | undefined): ScoreRow => ({ id: s.id, score, violation: guard === undefined ? null : guard > 0 });
  const side = (split: "train" | "holdout", pick: (s: ScenarioScore) => ScoreRow) => r.scenarioScores.filter((s) => splits.get(s.id) === split).map(pick);
  const base = (s: ScenarioScore) => rowOf(s, s.baselineScore, s.baselineGuardFailed);
  const cand = (s: ScenarioScore) => rowOf(s, s.candidateScore, s.guardFailed);
  const scores: RoundScores = { baselineHash: r.promptHashBefore, baselineTrain: side("train", base), baselineHoldout: side("holdout", base), candidates: [] };
  let replaced: ScoreRow[] | null = null;
  if (r.verdict === "revert") {
    replaced = r.scenarioScores.map((s) => rowOf(s, s.candidateScore, undefined));
  } else if (r.candidateId !== null) {
    const holdout = side("holdout", cand);
    const c: CandidateScore = { id: r.candidateId, train: side("train", cand), ...(holdout.some((h) => h.score !== null) ? { holdout } : {}) };
    scores.candidates = [c];
  }
  // The recorded attack results go back into the rebuilt scores, so the merge rule's attack gate re-runs
  // exactly as it ran live. The attack inputs themselves are not stored; the gate needs only the failures.
  if (r.attacks) {
    scores.attacks = { total: r.attacks.total, baselineFailed: r.attacks.baselineFailed, inputs: {} };
    if (scores.candidates.length) scores.candidates[0].attackFailed = r.attacks.candidateFailed;
  }
  // The stored guard and check rates are recomputed from the per-row counts, not trusted: an edit to the
  // headline numbers (with the hash fixed) is caught here, the same way a flipped verdict is.
  const guardRows = (pick: (s: ScenarioScore) => ScoreRow) => [...side("train", pick), ...side("holdout", pick)];
  const guards = goal.guardrails.length;
  if (guardRate(guardRows(base), guards) !== r.guardsBefore) return "the recorded guardsBefore doesn't match the recorded per-scenario guard results";
  const expectedGuardsAfter = r.verdict === "revert" ? null : guardRate(scores.candidates.length ? guardRows(cand) : [], guards);
  if (expectedGuardsAfter !== r.guardsAfter) return "the recorded guardsAfter doesn't match the recorded per-scenario guard results";
  if (r.checksBefore !== null || r.checksAfter !== null) {
    const rateOf = (rows: ScoreRow[], label: string) => {
      if (rows.some((row) => typeof row.failed !== "number" || typeof row.applicable !== "number")) throw new Error(`the record doesn't store the per-scenario check counts needed to recheck its ${label}`);
      return checkRate(rows);
    };
    try {
      // The merge rule rates the baseline over the train rows plus the holdout rows the candidate was
      // scored on, so the recheck uses those same rows.
      const holdIds = new Set((scores.candidates[0]?.holdout ?? []).map((h) => h.id));
      const baseCheck = (s: ScenarioScore): ScoreRow => ({ id: s.id, score: s.baselineScore, violation: null, failed: s.baselineCheckFailed, applicable: s.baselineCheckApplicable });
      const candCheck = (s: ScenarioScore): ScoreRow => ({ id: s.id, score: s.candidateScore, violation: null, failed: s.checkFailed, applicable: s.checkApplicable });
      const before = rateOf([...side("train", baseCheck), ...side("holdout", baseCheck).filter((row) => holdIds.has(row.id))], "checksBefore");
      if (before !== r.checksBefore) return "the recorded checksBefore doesn't match the recorded per-scenario check results";
      const after = rateOf(scores.candidates.length ? [...side("train", candCheck), ...side("holdout", candCheck).filter((row) => holdIds.has(row.id))] : [], "checksAfter");
      if (r.verdict !== "revert" && after !== r.checksAfter) return "the recorded checksAfter doesn't match the recorded per-scenario check results";
    } catch (e) {
      return (e as Error).message;
    }
  }
  // Recheck under the held-back limit the round ran with; a record from before the check ran with none.
  const ranWith: Goal = { ...goal, merge_rule: { ...goal.merge_rule, holdout_max_p: r.holdoutMaxP ?? 1 } };
  const v: Verdict = judgeRound(scores, ranWith, replaced);
  const want = r.verdict === "propose" ? "merge" : r.verdict;
  if (v.action !== want) return `the stored verdict is ${r.verdict}, but the recorded scores give ${v.action}`;
  // A skip's reasons name every candidate and the record keeps only one, so only a landed change is compared word for word.
  if (r.verdict !== "skip" && JSON.stringify(v.reasons) !== JSON.stringify(r.verdictReasons)) return "the recorded reasons don't match what the recorded scores give";
  return null;
}

export function verifyEvidence(filePath: string, repoRoot: string): VerifyResult {
  let r: EvidenceRecord;
  try {
    r = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (e) {
    return { ok: false, reason: `couldn't read ${filePath} as evidence: ${(e as Error).message}` };
  }
  if (typeof r?.round !== "number" || typeof r.sha256 !== "string" || !Array.isArray(r.scenarioScores) || !Array.isArray(r.verdictReasons)
    || r.scenarioScores.some((s) => s === null || typeof s !== "object" || typeof s.id !== "string")
    || r.verdictReasons.some((x) => typeof x !== "string")) {
    return { ok: false, reason: `${filePath} isn't a Synthe evidence file` };
  }
  if (r.attacks !== undefined && (r.attacks === null || typeof r.attacks !== "object" || typeof r.attacks.total !== "number"
    || ![r.attacks.baselineFailed, r.attacks.candidateFailed].every((list) => list === null || (Array.isArray(list) && list.every((x) => typeof x === "string"))))) {
    return { ok: false, reason: `${filePath} isn't a Synthe evidence file` };
  }
  const named = roundOf(basename(filePath));
  if (named !== undefined && Number(named) !== r.round) {
    return { ok: false, reason: `the file is named round-${named}.json but the record inside says round ${r.round}` };
  }

  // 1. The file is what was written.
  if (hashEvidence(r) !== r.sha256) return { ok: false, reason: "the file's contents don't match its hash, so it was edited after it was written" };

  // 2. It follows the record before it. That is the nearest earlier file: rounds that failed leave none.
  const dir = dirname(filePath);
  const earlier = (existsSync(dir) ? readdirSync(dir) : []).flatMap((f) => (roundOf(f) !== undefined && Number(roundOf(f)) < r.round ? [Number(roundOf(f))] : []));
  const prevRound = earlier.length ? Math.max(...earlier) : null;
  if (prevRound === null) {
    if (r.prevEvidenceHash !== null) return { ok: false, reason: `it follows another record, but no earlier round-N.json is next to it in ${dir}` };
  } else {
    let prev: EvidenceRecord;
    try {
      prev = JSON.parse(readFileSync(join(dir, `round-${prevRound}.json`), "utf8"));
    } catch {
      return { ok: false, reason: `round-${prevRound}.json can't be read` };
    }
    if (r.prevEvidenceHash === null) return { ok: false, reason: `round-${prevRound}.json exists, but this record says it follows nothing` };
    if (hashEvidence(prev) !== r.prevEvidenceHash) return { ok: false, reason: `the chain is broken: this record follows a different round-${prevRound}.json than the one next to it` };
  }

  // 3. The goal and test cases, needed for the prompt check and the verdict recheck.
  const goalPath = join(repoRoot, GOAL_FILE);
  let goal: Goal;
  let splits: Map<string, "train" | "holdout">;
  try {
    goal = parseGoal(readFileSync(goalPath, "utf8"));
    splits = new Map(parseScenarios(readFileSync(join(repoRoot, goal.scenarios), "utf8")).map((s) => [s.id, s.split]));
  } catch (e) {
    return { ok: false, reason: `couldn't read the goal and test cases in ${repoRoot} to recheck the verdict: ${(e as Error).message}` };
  }

  // 4. The prompt at the commit the round was tested at matches the record's before-hash. Records that
  // name no full commit id (written before the commit was kept, or by a test double) can't be checked
  // this way; that is noted, not passed over silently.
  const notes: string[] = [];
  if (typeof r.commit === "string" && /^[0-9a-f]{40}$/.test(r.commit)) {
    let atCommit: string;
    try {
      atCommit = execFileSync("git", ["-C", repoRoot, "show", `${r.commit}:${goal.prompt.path}`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return { ok: false, reason: `couldn't read ${goal.prompt.path} at the recorded commit ${r.commit.slice(0, 12)} in this checkout, so the prompt this record is about can't be checked` };
    }
    const prompts = goal.prompt.kind === "file" ? [atCommit] : findPrompts([{ path: goal.prompt.path, text: atCommit }]).flatMap((f) => (f.location.kind === "inline" ? [f.location.initial] : []));
    if (!prompts.some((t) => sha256(t) === r.promptHashBefore)) {
      return { ok: false, reason: "the prompt at the recorded commit doesn't match the record's promptHashBefore, so the record isn't about the change it claims" };
    }
  } else {
    notes.push("Note: the prompt at the recorded commit wasn't checked: this record names no full commit id");
  }

  // 5. The recorded scores still give the recorded verdict.
  const problem = recomputeProblem(r, goal, splits);
  if (problem) return { ok: false, reason: problem };
  return { ok: true, notes };
}
