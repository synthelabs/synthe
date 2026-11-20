import { createHash } from "node:crypto";

// Prompt caching. Within a round the runner gets the same system prompt for every test case,
// and the judge and checker get the same goal, guardrails and policy, so each request marks the end of its system
// prompt as a cache breakpoint and later requests read that prefix at a tenth of the input price or less.
//
// The breakpoint is put on the system block, not left to the API's top-level automatic caching: automatic caching
// puts it after the last block, which here is the per-case message, so every call would pay the cache-write premium
// on text no other call shares and nothing would be read back.
//
// Below the model's minimum (512 tokens on the current models, 1024 on Sonnet 4.5) the API silently doesn't cache
// and charges nothing extra, so every system prompt is marked.
export function cachedSystem(system: string | undefined) {
  return system === undefined ? undefined : [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }];
}

// A cache entry can only be read once the request that writes it has started answering, so requests sent together
// all pay full price. The first request for a system prompt therefore goes alone and the rest wait for it. Short
// prompts are sent at once, since they won't be cached and waiting would only add time.
export const WARM_MIN_CHARS = 2048; // about 512 tokens at four characters a token
const WARM_FOR_MS = 4 * 60_000; // a cache entry lives 5 minutes from its last read; after this, warm it again

export function firstAlone() {
  const first = new Map<string, { sent: Promise<unknown>; at: number }>();
  return async <T>(model: string, system: string | undefined, send: () => Promise<T>): Promise<T> => {
    if (system === undefined || system.length < WARM_MIN_CHARS) return send();
    const key = createHash("sha256").update(`${model}\n${system}`).digest("hex");
    const ahead = first.get(key);
    if (ahead && Date.now() - ahead.at < WARM_FOR_MS) {
      await ahead.sent.catch(() => undefined); // a failed first request just leaves the next one to write the cache
      return send();
    }
    const sent = send();
    first.set(key, { sent, at: Date.now() });
    return sent;
  };
}
