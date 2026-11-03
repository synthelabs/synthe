import assert from "node:assert/strict";
import { test } from "node:test";
import { runScore, explainScores, AGENT_MAX_TOKENS } from "../src/loop/score.ts";
import { anthropicModel, askJson, type Ask, type Model } from "../src/model/client.ts";
import { goal, scenarios } from "./helpers.ts";

// A model whose agent replies are cut off at the limit, recording every call.
function cutOffModel(over: { judge?: string | null } = {}): Model & { seen: Ask[] } {
  const seen: Ask[] = [];
  return {
    seen,
    async ask(a) {
      seen.push(a);
      if (a.schema) {
        const text = over.judge !== undefined ? over.judge : JSON.stringify({ better: "A", a_guardrail_ok: true, b_guardrail_ok: true });
        return { text, costUsd: 0.001 };
      }
      return { text: a.system === "Improved." ? "a long reply that stops mid-sen" : "a long answer that stops mid-sen", costUsd: 0.001, truncated: true };
    },
  };
}

const candidates = [{ id: "c1", text: "Improved." }];

test("a cut-off agent reply is scored, not unknown", async () => {
  const { scores } = await runScore(goal(), "Old", candidates, scenarios, cutOffModel());
  assert.ok(scores.candidates[0].train.every((r) => r.score !== null));
  assert.ok(scores.baselineTrain.every((r) => r.score !== null));
});

test("a cut-off judge reply is still unknown", async () => {
  const { scores } = await runScore(goal(), "Old", candidates, scenarios, cutOffModel({ judge: null }));
  assert.ok(scores.candidates[0].train.every((r) => r.score === null));
});

test("agent replies use the 2000-token limit and may be cut off; judge and checker calls may not", async () => {
  assert.equal(AGENT_MAX_TOKENS, 2000);
  const m = cutOffModel();
  await runScore(goal(), "Old", candidates, scenarios, m);
  const agent = m.seen.filter((a) => !a.schema);
  const json = m.seen.filter((a) => a.schema);
  assert.ok(agent.length > 0 && json.length > 0);
  assert.ok(agent.every((a) => a.maxTokens === 2000 && a.allowCutOff === true));
  assert.ok(json.every((a) => !a.allowCutOff));
});

test("the judge is told about cut-off replies, and the log counts them", async () => {
  const m = cutOffModel();
  const { scores } = await runScore(goal(), "Old", candidates, scenarios, m);
  assert.ok(m.seen.filter((a) => a.schema).every((a) => a.user.includes("hit the agent's length limit")));
  assert.ok(scores.cutOff && scores.cutOff > 0);
  assert.ok(explainScores(scores, scenarios).some((l) => l.includes(`${scores.cutOff} agent replies hit the 2000-token limit`)));
});

test("nothing about cut-offs is said when no reply was cut off", async () => {
  const m: Model & { seen: Ask[] } = { seen: [], async ask(a) { this.seen.push(a); return { text: a.schema ? JSON.stringify({ better: "tie", a_guardrail_ok: true, b_guardrail_ok: true }) : "short", costUsd: 0.001 }; } };
  const { scores } = await runScore(goal(), "Old", candidates, scenarios, m);
  assert.equal(scores.cutOff, undefined);
  assert.ok(m.seen.filter((a) => a.schema).every((a) => !a.user.includes("length limit")));
  assert.ok(!explainScores(scores, scenarios).some((l) => l.includes("token limit")));
});

// The real client against a stubbed API reply, so no network or key is used.
async function viaClient<T>(stop_reason: string, text: string, run: (m: Model) => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", stop_reason, stop_sequence: null,
    content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 20 },
  }), { status: 200, headers: { "content-type": "application/json" } });
  try { return await run(anthropicModel("sk-ant-test")); } finally { globalThis.fetch = real; }
}
const ask: Ask = { model: "claude-haiku-5-5", user: "hi", maxTokens: 50 };

test("client: a max_tokens reply is returned only when the caller allows it", async () => {
  const allowed = await viaClient("max_tokens", "cut off he", (m) => m.ask({ ...ask, allowCutOff: true }));
  assert.equal(allowed.text, "cut off he");
  assert.equal(allowed.truncated, true);
  const normal = await viaClient("max_tokens", "cut off he", (m) => m.ask(ask));
  assert.equal(normal.text, null);
  const done = await viaClient("end_turn", "all done", (m) => m.ask({ ...ask, allowCutOff: true }));
  assert.equal(done.text, "all done");
  assert.equal(done.truncated, undefined);
});

test("client: a cut-off JSON reply is unknown", async () => {
  const out = await viaClient("max_tokens", '{"better": "A", "a_guard', (m) => askJson(m, { ...ask, schema: { type: "object" } }));
  assert.equal(out.value, null);
});
