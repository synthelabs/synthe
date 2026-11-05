import type { Goal } from "./goal.ts";
import { sha256 } from "./safety.ts";

export interface CandidateMemory { scope: string; fingerprint: string }
export const MAX_CANDIDATE_MEMORY = 1000;
const HASH = /^[a-f0-9]{64}$/;

export function validateCandidateMemory(value: unknown): CandidateMemory[] {
  if (!Array.isArray(value) || value.length > MAX_CANDIDATE_MEMORY || value.some((entry) =>
    !entry || Object.keys(entry).sort().join(",") !== "fingerprint,scope" ||
    typeof entry.scope !== "string" || !HASH.test(entry.scope) ||
    typeof entry.fingerprint !== "string" || !HASH.test(entry.fingerprint))) {
    throw new Error("Candidate history is corrupt. Restore it or remove it explicitly before trying again.");
  }
  return value;
}

export const candidateScope = (goal: Goal, prompt: string): string => sha256(JSON.stringify([goal, prompt]));
export const candidateFingerprint = (text: string): string => sha256(text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "");

export function rememberCandidates(history: CandidateMemory[], scope: string, texts: string[]): CandidateMemory[] {
  const unique = new Map(validateCandidateMemory(history).map((entry) => [`${entry.scope}:${entry.fingerprint}`, entry]));
  for (const text of texts) {
    const fingerprint = candidateFingerprint(text);
    unique.set(`${scope}:${fingerprint}`, { scope, fingerprint });
  }
  return [...unique.values()].slice(-MAX_CANDIDATE_MEMORY);
}
