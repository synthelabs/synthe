import { CreditError, ProxyError, modelProblem } from "../model/client.ts";
import { PROXY_AUTH_MESSAGE } from "../core/share.ts";
import { ProviderError } from "../model/openai-compatible.ts";

// Why a write or score step failed, saved for the decide step so its report gives the right advice.
// busy: Anthropic was overloaded, rate-limited or unreachable, so the hourly backup will retry.
// key: the key was rejected or is out of credit or allowance, so a person has to replace it.
export type FailureKind = "busy" | "key" | "credit" | "other";
export interface Failure { step: string; kind: FailureKind; message: string }

export function failureOf(step: string, e: unknown): Failure {
  if (e instanceof Error && e.message === PROXY_AUTH_MESSAGE) return { step, kind: "key", message: e.message };
  if (e instanceof CreditError) return { step, kind: "credit", message: e.message };
  if (e instanceof ProxyError) return { step, kind: e.status === 401 || e.status === 403 ? "key" : "busy", message: e.message };
  // Another provider's refusal: only a key, credit or permission problem needs a person; a wrong model name or URL
  // isn't "busy" either, since the hourly backup would only fail the same way.
  if (e instanceof ProviderError) {
    const kind: FailureKind = e.credit || e.status === 401 || e.status === 402 || e.status === 403 ? "key" : e.status === null || e.status === 408 || e.status === 429 || e.status >= 500 ? "busy" : "other";
    return { step, kind, message: modelProblem(e)! };
  }
  const plain = modelProblem(e);
  if (plain !== null) return { step, kind: /\bkey\b/i.test(plain) ? "key" : "busy", message: plain };
  const raw = e instanceof Error ? e.message : String(e);
  return { step, kind: "other", message: raw.trim().split("\n")[0].slice(0, 300) };
}
