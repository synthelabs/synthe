import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImproveConfig, Measurement } from "./config.ts";
import type { NotKept, Verdict } from "./verdict.ts";

// The decision `submit` made, kept so that another tool can check it later without measuring again.
// Another tool may read this file without importing anything from src/, so it repeats VERDICT_FORMAT and the
// path rule in verdictFile. Keep both stable: a change breaks every reader.
export const VERDICT_FORMAT = "synthe-improve-verdict/v1";

export type PublicationStatus = "not_attempted" | "pending" | "failed" | "pr_opened" | "merged";
// No error text here: a push error can hold a remote URL with a credential in it.
export interface Publication { status: PublicationStatus; step?: "push" | "pr" | "merge"; url?: string }

export interface VerdictRecord {
  format: typeof VERDICT_FORMAT;
  base: string;
  candidate: string;
  metric: ImproveConfig["metric"];
  guard: { command: string | null };
  baseline: { median: number; runs: number[] };
  measured: { median: number; runs: number[] };
  guard_passed: boolean | null;
  verdict: "keep" | "reject";
  reason: NotKept | null;
  why: string;
  delta: number;
  noise: number;
  decided_at: string;
  publication: Publication;
}

// Inside .git, next to synthe-improve.json and for the same reason: never tracked, never dirty, and the candidate
// commit can't carry an edited copy. One file for each candidate, named by its full hash.
export const verdictFile = (gitDir: string, candidate: string) => join(gitDir, "synthe-verdicts", `${candidate}.json`);

// A full hash only: anything else in the file name could point outside the folder.
const FULL_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function buildVerdictRecord(a: { config: ImproveConfig; baseline: Measurement; candidate: string; measured: Measurement; guardPassed: boolean | null; verdict: Verdict }): VerdictRecord {
  const { config, baseline, measured, verdict: v } = a;
  return {
    format: VERDICT_FORMAT,
    // The commit the baseline was really measured on: after a remeasure, the new merge base.
    base: baseline.commit,
    candidate: a.candidate,
    // By name: an unknown key in synthe-improve.json must not travel into the record.
    metric: { preset: config.metric.preset, label: config.metric.label, unit: config.metric.unit, command: config.metric.command, direction: config.metric.direction, runs: config.metric.runs },
    guard: { command: config.guard.command },
    baseline: { median: baseline.median, runs: [...baseline.runs] },
    measured: { median: measured.median, runs: [...measured.runs] },
    guard_passed: a.guardPassed,
    verdict: v.win ? "keep" : "reject",
    reason: v.win ? null : v.reason ?? null,
    why: v.why,
    delta: v.delta,
    noise: v.noise,
    decided_at: new Date().toISOString(),
    // A win is published next; a rejection never is.
    publication: { status: v.win ? "pending" : "not_attempted" },
  };
}

// Temp file in the same folder, then rename: a reader sees the old record or the new one, never half of one.
export function writeVerdictRecord(gitDir: string, record: VerdictRecord): void {
  if (!FULL_HASH.test(record.candidate)) throw new Error(`the candidate ${record.candidate} is not a full commit hash`);
  const file = verdictFile(gitDir, record.candidate);
  mkdirSync(join(gitDir, "synthe-verdicts"), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
    renameSync(temp, file);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
}

// The verdict fields never change after the first write; only what happened to the pull request does.
export function updatePublication(gitDir: string, candidate: string, publication: Publication): void {
  const record = JSON.parse(readFileSync(verdictFile(gitDir, candidate), "utf8")) as VerdictRecord;
  if (record?.format !== VERDICT_FORMAT || record.candidate !== candidate) throw new Error(`the verdict record for ${candidate.slice(0, 7)} is for another commit`);
  writeVerdictRecord(gitDir, { ...record, publication });
}
