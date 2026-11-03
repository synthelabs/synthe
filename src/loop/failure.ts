import { modelProblem } from "../model/client.ts";

// Why a write or score step failed, saved for the decide step so its report gives the right advice.
// busy: Anthropic was overloaded, rate-limited or unreachable, so the next hourly run will likely work.
// key: the key was rejected or is out of credit or allowance, so a person has to replace it.
export type FailureKind = "busy" | "key" | "other";
export interface Failure { step: string; kind: FailureKind; message: string }

export function failureOf(step: string, e: unknown): Failure {
  const plain = modelProblem(e);
  if (plain !== null) return { step, kind: /\bkey\b/i.test(plain) ? "key" : "busy", message: plain };
  const raw = e instanceof Error ? e.message : String(e);
  return { step, kind: "other", message: raw.trim().split("\n")[0].slice(0, 300) };
}
