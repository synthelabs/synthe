import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openAiCompatibleModel } from "../src/model/openai-compatible.ts";
import { CostMeter } from "../src/solve/cost.ts";
import { callKey, recorder, replayer, replayMissIn, replayProblem, ReplayMiss, RECORDING_FILE } from "../src/solve/recording.ts";

const dir = () => mkdtempSync(join(tmpdir(), "synthe-recording-"));

const chatReply = (text: string, prompt: number, completion: number) => ({
  choices: [{ message: { content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: prompt, completion_tokens: completion },
});

// A fetch that answers every request with `reply` and counts the requests.
function fakeFetch(reply: unknown) {
  const seen: RequestInit[] = [];
  const f = (async (_input: unknown, init?: RequestInit) => {
    seen.push(init ?? {});
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, seen };
}

test("the key of a call does not depend on the order of the body's fields, and does depend on the provider", () => {
  const a = callKey("anthropic", { model: "m", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
  const b = callKey("anthropic", { messages: [{ content: "hi", role: "user" }], max_tokens: 5, model: "m" });
  assert.equal(a, b);
  assert.notEqual(a, callKey("openai-compatible", { model: "m", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }));
  assert.notEqual(a, callKey("anthropic", { model: "m", max_tokens: 6, messages: [{ role: "user", content: "hi" }] }));
});

test("a recorded call replays with the same reply and usage, and sends no request", async () => {
  const d = dir();
  const fake = fakeFetch(chatReply("hello there", 123_457, 654_321));
  const rec = recorder(d, fake.f);
  const live = openAiCompatibleModel({ baseUrl: "http://127.0.0.1:9/v1", apiKey: "sk-secret-key-123", fetch: rec.fetchFor("openai-compatible") });
  const got = await live.ask({ model: "m1", user: "say hello", maxTokens: 10 });
  assert.equal(got.text, "hello there");
  assert.equal(fake.seen.length, 1);

  const file = readFileSync(join(d, RECORDING_FILE), "utf8");
  assert.equal(file.trim().split("\n").length, 1);
  assert.ok(!file.includes("sk-secret-key-123"), "the recording holds no key");
  assert.ok(!/authorization|content-type/i.test(file), "the recording holds no header");
  const line = JSON.parse(file);
  assert.deepEqual(line.usage, { prompt_tokens: 123_457, completion_tokens: 654_321 });
  assert.equal(line.request.messages[0].content, "say hello");

  const replay = openAiCompatibleModel({ baseUrl: "http://127.0.0.1:9/v1", apiKey: "unused", fetch: replayer(d).fetchFor("openai-compatible") });
  const again = await replay.ask({ model: "m1", user: "say hello", maxTokens: 10 });
  assert.deepEqual(again, got);
  assert.equal(fake.seen.length, 1, "the replay sent no request");
});

test("a call not in the recording throws ReplayMiss at once, with no retry, and costs nothing", async () => {
  const d = dir();
  recorder(d, fakeFetch(chatReply("x", 1, 1)).f);
  let sleeps = 0;
  const replay = openAiCompatibleModel({ baseUrl: "http://127.0.0.1:9/v1", apiKey: "unused", fetch: replayer(d).fetchFor("openai-compatible"), sleep: async () => { sleeps++; } });
  const meter = new CostMeter({ input_per_mtok: 1, output_per_mtok: 1 }, null);
  await assert.rejects(meter.wrap(replay).ask({ model: "m1", user: "never asked", maxTokens: 10 }), (e: unknown) => {
    assert.ok(e instanceof ReplayMiss);
    assert.match((e as Error).message, /not in the recording/);
    return true;
  });
  assert.equal(sleeps, 0, "a replay miss is not retried");
  assert.deepEqual(meter.summary(), { calls: 0, input_tokens: 0, output_tokens: 0, usd: 0 });
});

test("replayMissIn finds a miss wrapped as the cause of another error", () => {
  const miss = new ReplayMiss();
  assert.equal(replayMissIn(new Error("Connection error.", { cause: miss })), miss);
  assert.equal(replayMissIn(new Error("other")), null);
});

test("--replay of a folder with no calls.jsonl is a plain setup problem", () => {
  const d = dir();
  assert.match(replayProblem(d) ?? "", /calls\.jsonl/);
  recorder(d, fakeFetch({}).f);
  assert.ok(existsSync(join(d, RECORDING_FILE)));
  assert.equal(replayProblem(d), null);
});
