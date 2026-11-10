import assert from "node:assert/strict";
import { test } from "node:test";
import { ANTHROPIC_API_URL, anthropicModel, ownKeyBaseUrl, type Ask } from "../src/model/client.ts";

// Claude Code (and other tools) export ANTHROPIC_BASE_URL and sometimes ANTHROPIC_AUTH_TOKEN in the person's shell.
// The SDK follows both by default, so a team running Synthe from such a terminal would send its own key to that
// gateway. An own key must only ever reach Anthropic.

const ask: Ask = { model: "claude-haiku-5-5", user: "hi", maxTokens: 5 };

async function capture(env: Record<string, string | undefined>): Promise<{ url: string; headers: Headers }[]> {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  const seen: { url: string; headers: Headers }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: input instanceof Request ? input.url : String(input), headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)) });
    return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text: "OK" }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try { await anthropicModel("sk-ant-test").ask(ask); } finally { globalThis.fetch = real; process.env = saved; }
  return seen;
}

test("an own key goes to Anthropic even when the shell points ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN elsewhere", async () => {
  const seen = await capture({ ANTHROPIC_BASE_URL: "https://gateway.example.com", ANTHROPIC_AUTH_TOKEN: "gateway-token", SYNTHE_ANTHROPIC_BASE_URL: undefined });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].url.startsWith(`${ANTHROPIC_API_URL}/v1/messages`), seen[0].url);
  // This SDK sends an API key as a bearer header; the gateway token must not replace or join it.
  assert.equal(seen[0].headers.get("authorization"), "Bearer sk-ant-test");
  assert.ok(![...seen[0].headers.values()].some((v) => v.includes("gateway-token")));
});

test("a loopback SYNTHE_ANTHROPIC_BASE_URL reaches a local fake; nothing else moves the key", async () => {
  const local = await capture({ SYNTHE_ANTHROPIC_BASE_URL: "http://127.0.0.1:9", ANTHROPIC_BASE_URL: undefined, ANTHROPIC_AUTH_TOKEN: undefined });
  assert.ok(local[0].url.startsWith("http://127.0.0.1:9/v1/messages"), local[0].url);
  assert.equal(ownKeyBaseUrl({}), ANTHROPIC_API_URL);
  assert.equal(ownKeyBaseUrl({ SYNTHE_ANTHROPIC_BASE_URL: " " }), ANTHROPIC_API_URL);
  assert.equal(ownKeyBaseUrl({ SYNTHE_ANTHROPIC_BASE_URL: "http://localhost:4010" }), "http://localhost:4010");
  assert.equal(ownKeyBaseUrl({ SYNTHE_ANTHROPIC_BASE_URL: "http://[::1]:4010" }), "http://[::1]:4010");
  assert.equal(ownKeyBaseUrl({ SYNTHE_ANTHROPIC_BASE_URL: "https://gateway.example.com" }), ANTHROPIC_API_URL);
  assert.equal(ownKeyBaseUrl({ SYNTHE_ANTHROPIC_BASE_URL: "http://127.0.0.1.attacker.example" }), ANTHROPIC_API_URL);
  assert.equal(ownKeyBaseUrl({ SYNTHE_ANTHROPIC_BASE_URL: "file://127.0.0.1/x" }), ANTHROPIC_API_URL);
  assert.equal(ownKeyBaseUrl({ SYNTHE_ANTHROPIC_BASE_URL: "not a url" }), ANTHROPIC_API_URL);
  assert.equal(ownKeyBaseUrl({ ANTHROPIC_BASE_URL: "https://gateway.example.com" }), ANTHROPIC_API_URL);
});
