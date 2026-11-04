import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GOAL_FILE, parseGoal, parseScenarios, type Goal } from "./goal.ts";
import { judgeRound, type CandidateScore, type RoundScores, type ScoreRow, type Verdict } from "./merge-rule.ts";
import { sha256 } from "./safety.ts";

export const EVIDENCE_DIR = ".synthe/evidence";
export const evidencePath = (round: number) => `${EVIDENCE_DIR}/round-${round}.json`;

export interface ScenarioScore {
  id: string;
  baselineScore: number | null;
  candidateScore: number | null;
  checkFailed?: number;
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
  modelIds: { writer: string; runner: string; judge: string; checker: string };
  scenarioScores: ScenarioScore[];
  checksBefore: number | null;
  checksAfter: number | null;
  guardsBefore: number | null;
  guardsAfter: number | null;
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
    modelIds: { ...p.goal.models },
    scenarioScores,
    checksBefore: p.checks?.before ?? null,
    checksAfter: p.checks?.after ?? null,
    guardsBefore: guardRate(base, guards),
    guardsAfter: guardRate(after, guards),
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
  const v: Verdict = judgeRound(scores, goal, replaced);
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
  if (typeof r?.round !== "number" || typeof r.sha256 !== "string" || !Array.isArray(r.scenarioScores) || !Array.isArray(r.verdictReasons)) {
    return { ok: false, reason: `${filePath} isn't a Synthe evidence file` };
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

  // 3. The prompt at that commit needs git history, which this command doesn't read.
  const notes = ["Note: prompt commit check requires a git checkout"];

  // 4. The recorded scores still give the recorded verdict.
  const goalPath = join(repoRoot, GOAL_FILE);
  let goal: Goal;
  let splits: Map<string, "train" | "holdout">;
  try {
    goal = parseGoal(readFileSync(goalPath, "utf8"));
    splits = new Map(parseScenarios(readFileSync(join(repoRoot, goal.scenarios), "utf8")).map((s) => [s.id, s.split]));
  } catch (e) {
    return { ok: false, reason: `couldn't read the goal and test cases in ${repoRoot} to recheck the verdict: ${(e as Error).message}` };
  }
  const problem = recomputeProblem(r, goal, splits);
  if (problem) return { ok: false, reason: problem };
  return { ok: true, notes };
}
