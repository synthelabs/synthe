import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { configuredModel, CreditError, eventModels, modelProblem, PROXY_URL, proxyModel } from "../src/model/client.ts";
import { failureOf } from "../src/loop/failure.ts";
import { runDecide } from "../src/loop/decide.ts";
import { headline } from "../src/loop/report.ts";
import { restartState } from "../src/cli/restart.ts";
import { goal, MemoryRepo } from "./helpers.ts";

test("proxy sends local install IDs, fresh Action OIDC, bounded requests, and own keys win", async (context) => {
  const received: { path: string; headers: any; body: any }[] = [];
  let tokens = 0;
  let refused = 0;
  const message = "Event credit is used up. Run `npx synthe key`.\nThen restart.";
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/oidc?") && request.method === "GET") {
      assert.equal(new URL(request.url, "http://local").searchParams.get("audience"), "synthe-proxy");
      assert.equal(request.headers.authorization, "bearer github-token");
      return response.end(JSON.stringify({ value: `oidc-${++tokens}` }));
    }
    if (request.method !== "POST" || !["/api/claude/v1/messages", "/v1/messages"].includes(request.url!)) { response.statusCode = 404; return response.end(); }
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      received.push({ path: request.url!, headers: request.headers, body: JSON.parse(raw) });
      response.setHeader("content-type", "application/json");
      if (refused) {
        response.statusCode = refused;
        response.setHeader("x-should-retry", "true");
        return response.end(JSON.stringify({ type: "error", error: { type: "synthe_credit", message } }));
      }
      response.end(JSON.stringify({ content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 } }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const previous = { ...process.env };
  context.after(() => { process.env = previous; });
  process.env.SYNTHE_PROXY_URL = `${base}/api/claude`;
  process.env.ANTHROPIC_BASE_URL = base;
  process.env.ACTIONS_ID_TOKEN_REQUEST_URL = `${base}/oidc?existing=1`;
  process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN = "github-token";
  const ask = { model: "claude-haiku-5-5", user: "hi", maxTokens: 5 };
  const local = proxyModel("crimson");
  const reply = await local.ask(ask);
  await proxyModel("crimson").ask(ask);
  assert.equal(reply.text, "OK");
  assert.ok(reply.costUsd! > 0);
  assert.equal(received[0].path, "/api/claude/v1/messages");
  assert.equal(received[0].headers["x-api-key"], "synthe-proxy");
  assert.equal(received[0].headers["x-synthe-event"], "crimson");
  assert.match(received[0].headers["x-synthe-install"], /^[0-9a-f-]{36}$/);
  assert.equal(received[0].headers["x-synthe-install"], received[1].headers["x-synthe-install"]);
  assert.equal(received[0].headers.authorization, undefined);
  const action = proxyModel("crimson", true);
  await action.ask(ask);
  await action.ask({ ...ask, model: "claude-sonnet-5-5", maxTokens: 16000 });
  assert.equal(received[2].headers.authorization, "Bearer oidc-1");
  assert.equal(received[3].headers.authorization, "Bearer oidc-2");
  assert.equal(received[2].headers["x-synthe-event"], "crimson");
  assert.equal(received[2].headers["x-synthe-install"], undefined);
  await configuredModel("sk-ant-own", "crimson", true).ask(ask);
  assert.equal(received[4].headers.authorization, "Bearer sk-ant-own");
  assert.equal(received[4].headers["x-synthe-event"], undefined);
  assert.equal(received[4].path, "/v1/messages");
  assert.equal(tokens, 2);
  for (const { body } of received) {
    assert.ok(body.max_tokens <= 16000);
    assert.ok(!body.stream && !body.tools);
  }
  await assert.rejects(local.ask({ ...ask, model: "claude-other" }), /your goal names claude-other/);
  await assert.rejects(local.ask({ ...ask, maxTokens: 16001 }), /at most 16000/);
  assert.throws(() => eventModels({ runner: "claude-other" }), /only supports/);
  assert.equal(PROXY_URL, "https://synthe-share.vercel.app/api/claude");
  for (const status of [402, 403]) {
    refused = status;
    const before = received.length;
    await assert.rejects(local.ask(ask), (error: unknown) => {
      assert.ok(error instanceof CreditError);
      assert.equal(modelProblem(error), message);
      assert.deepEqual(failureOf("write", error), { step: "write", kind: "credit", message });
      return true;
    });
    assert.equal(received.length, before + 1, "credit is never retried, even if the server requests retries");
  }
});

test("credit stops the chain persistently and reports the proxy message verbatim, then restart clears it", async () => {
  const repo = new MemoryRepo("Old prompt.");
  const message = "The event code is paused.\nUse your own key with `npx synthe key`.";
  const input = { candidates: null, scores: null, costUsd: null, error: failureOf("score", new CreditError(message)) };
  const record = await runDecide(goal(), repo, input);
  assert.equal(record!.failure, "credit");
  assert.equal(record!.plain, message);
  assert.equal(repo.state.stopped, "credit");
  assert.equal(repo.state.chainReady, false);
  assert.equal(repo.state.stalls, 0);
  assert.equal(headline(goal(), repo.state).summary, message);
  assert.ok(repo.issue.includes(message));
  assert.equal(await runDecide(goal(), repo, input), null);
  assert.equal(repo.state.round, 1);
  const restarted = restartState(goal(), repo.state);
  assert.ok("state" in restarted);
  assert.equal(restarted.state.stopped, null);
});
