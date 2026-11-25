import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Problem } from "./types.ts";

// Record and replay of model calls (R01, GOAL-2.md stage 2b). `solve --record <dir>` saves every model call to
// <dir>/calls.jsonl; `solve --replay <dir>` answers every call from that file, with no network and no key.
//
// Both work one level below the model clients, as the `fetch` they send with. So a line holds the request body and
// the reply body exactly as they went over the wire, for both providers, and a replayed reply goes through the same
// parsing as a live one: the usage the provider reported, and so the cost, come out the same.
//
// A line never holds a header: the API key travels only in a header, and the recorder never reads the headers.

export type ProviderKind = "anthropic" | "openai-compatible";
export type Fetch = typeof fetch;

export const RECORDING_FILE = "calls.jsonl";

// A replayed call whose key is not in the recording. It is a failed call, not a crash: the proposer and the judge
// turn it into a failed attempt or a failed question, and the cost meter does not count it (it was never sent).
export class ReplayMiss extends Error {
  readonly noRetry = true;
  constructor() { super("This model call is not in the recording."); }
}

// The ReplayMiss inside an error, if any: an SDK can wrap the error its fetch threw.
export function replayMissIn(error: unknown): ReplayMiss | null {
  for (let e = error, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if (e instanceof ReplayMiss) return e;
  }
  return null;
}

// JSON with object keys in a fixed order, so the key of a call does not depend on the order fields were written in.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// The key of a call: a hash of the provider kind, the model and the request body.
export function callKey(provider: ProviderKind, request: unknown): string {
  const model = (request as { model?: unknown } | null)?.model;
  return createHash("sha256").update(`${provider}\n${String(model ?? "")}\n${canonical(request)}`).digest("hex");
}

export interface RecordedCall { key: string; provider: ProviderKind; model: string; request: unknown; reply: unknown; usage: unknown }

const bodyText = (init: RequestInit | undefined): string => (typeof init?.body === "string" ? init.body : "");
const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return text; } };

export interface Recording {
  mode: "record" | "replay";
  dir: string;
  // The fetch for one provider's client.
  fetchFor(provider: ProviderKind): Fetch;
}

// Saves each answered call as one line. A call the provider refused (not 2xx) is not saved: its retry, if any, is.
export function recorder(dir: string, base: Fetch = fetch): Recording {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, RECORDING_FILE);
  writeFileSync(file, "");
  return {
    mode: "record",
    dir,
    fetchFor: (provider) => async (input, init) => {
      const response = await base(input, init);
      if (!response.ok) return response;
      const text = await response.text();
      const request = parse(bodyText(init));
      const reply = parse(text);
      const line: RecordedCall = {
        key: callKey(provider, request),
        provider,
        model: String((request as { model?: unknown } | null)?.model ?? ""),
        request,
        reply,
        usage: (reply as { usage?: unknown } | null)?.usage ?? null,
      };
      appendFileSync(file, JSON.stringify(line) + "\n");
      // The body is read, so the client gets a new response with the same text. The text is already decoded.
      const headers = new Headers(response.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      return new Response(text, { status: response.status, statusText: response.statusText, headers });
    },
  };
}

// The setup problem with a folder given to --replay, or null when it holds a recording.
export function replayProblem(dir: string): string | null {
  return existsSync(join(dir, RECORDING_FILE)) ? null
    : `--replay needs a folder with a recording, and ${join(dir, RECORDING_FILE)} does not exist. Make one with solve --record <dir>.`;
}

// Answers each call from the recording. It never calls the network. The same request twice gets the recorded replies
// in order, and the last one again after that.
export function replayer(dir: string): Recording {
  const byKey = new Map<string, unknown[]>();
  const used = new Map<string, number>();
  const lines = readFileSync(join(dir, RECORDING_FILE), "utf8").split("\n").filter((l) => l.trim());
  for (const line of lines) {
    let call: Partial<RecordedCall>;
    try { call = JSON.parse(line) as Partial<RecordedCall>; } catch { continue; }
    if (typeof call.key !== "string") continue;
    const list = byKey.get(call.key) ?? [];
    list.push(call.reply);
    byKey.set(call.key, list);
  }
  return {
    mode: "replay",
    dir,
    fetchFor: (provider) => async (_input, init) => {
      const key = callKey(provider, parse(bodyText(init)));
      const replies = byKey.get(key);
      if (!replies?.length) throw new ReplayMiss();
      const i = used.get(key) ?? 0;
      used.set(key, i + 1);
      const reply = replies[Math.min(i, replies.length - 1)];
      return new Response(typeof reply === "string" ? reply : JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
}

// The recording of one run, set by `solve` before the run, like the cost meter (cost.ts): one for each problem object,
// so the proposer and the judge of one run share it.
const recordings = new WeakMap<Problem, Recording>();
export function useRecording(problem: Problem, recording: Recording): void { recordings.set(problem, recording); }
export function recordingFor(problem: Problem): Recording | undefined { return recordings.get(problem); }
