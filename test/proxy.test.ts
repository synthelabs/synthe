import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredModel, CreditError, eventModels, modelProblem, PROXY_URL, ProxyError, proxyModel } from "../src/model/client.ts";
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
  const config = mkdtempSync(join(tmpdir(), "synthe-proxy-config-"));
  context.after(() => rmSync(config, { recursive: true, force: true }));
  process.env.XDG_CONFIG_HOME = config;
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
  assert.equal(received[0].headers["x-synthe-install"], readFileSync(join(config, "synthe/install-id"), "utf8").trim());
  assert.equal(received[0].headers.authorization, undefined);
  process.env.XDG_CONFIG_HOME = join(config, "not-used-by-actions");
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
  assert.equal(existsSync(process.env.XDG_CONFIG_HOME), false);
  process.env.XDG_CONFIG_HOME = config;
  assert.equal(tokens, 2);
  for (const { body } of received) {
    assert.ok(body.max_tokens <= 16000);
    assert.ok(!body.stream && !body.tools);
  }
  await assert.rejects(local.ask({ ...ask, model: "claude-other" }), /your goal names claude-other/);
  await assert.rejects(local.ask({ ...ask, maxTokens: 16001 }), /at most 16000/);
  assert.throws(() => eventModels({ runner: "claude-other" }), /only supports/);
  assert.equal(PROXY_URL, "https://synthe-crimson.vercel.app/api/claude");
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

test("the team code rides on every proxy call, normalized, and a team refusal shows the server's words without retrying", async (context) => {
  const received: any[] = [];
  let refuse = false;
  const words = "That team code isn't recognised. Check the card from the Synthe table.";
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/oidc?")) return response.end(JSON.stringify({ value: "oidc" }));
    request.resume();
    request.on("end", () => {
      received.push(request.headers);
      response.setHeader("content-type", "application/json");
      if (refuse) { response.statusCode = 403; return response.end(JSON.stringify({ type: "error", error: { type: "synthe_proxy_auth", message: words } })); }
      response.end(JSON.stringify({ content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  context.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const previous = { ...process.env };
  context.after(() => { process.env = previous; });
  const config = mkdtempSync(join(tmpdir(), "synthe-team-config-"));
  context.after(() => rmSync(config, { recursive: true, force: true }));
  Object.assign(process.env, { XDG_CONFIG_HOME: config, SYNTHE_PROXY_URL: `${base}/api/claude`, ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/oidc?`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "github-token" });
  const ask = { model: "claude-haiku-5-5", user: "hi", maxTokens: 5 };
  await proxyModel("crimson", false, " CRIM-ABCD-EFGH-JKMN-PQRS ").ask(ask);
  await configuredModel(undefined, "crimson", true, "crim-abcd-efgh-jkmn-pqrs").ask(ask);
  await configuredModel(undefined, "crimson", true, "  ").ask(ask);
  await configuredModel("sk-ant-own", "crimson", true, "crim-abcd-efgh-jkmn-pqrs").ask(ask).catch(() => undefined);
  assert.equal(received[0]["x-synthe-team"], "crim-abcd-efgh-jkmn-pqrs");
  assert.match(received[0]["x-synthe-install"], /^[0-9a-f-]{36}$/);
  assert.equal(received[1]["x-synthe-team"], "crim-abcd-efgh-jkmn-pqrs");
  assert.equal(received[1].authorization, "Bearer oidc");
  assert.equal(received[1]["x-synthe-event"], "crimson");
  assert.equal(received[2]["x-synthe-team"], undefined);
  assert.equal(received.length, 3, "an own key never reaches the proxy");
  refuse = true;
  const before = received.length;
  const message = `The Synthe proxy refused this request: ${words}`;
  let failure;
  await assert.rejects(proxyModel("crimson", true, "crim-abcd-efgh-jkmn-pqrs").ask(ask), (error: unknown) => {
    assert.ok(error instanceof ProxyError);
    assert.equal(error.status, 403);
    assert.equal(modelProblem(error), message);
    failure = failureOf("write", error);
    assert.deepEqual(failure, { step: "write", kind: "key", message });
    return true;
  });
  assert.equal(received.length, before + 1, "a team refusal is never retried");
  const repo = new MemoryRepo("Old prompt.");
  const record = await runDecide(goal(), repo, { candidates: null, scores: null, costUsd: null, error: failure });
  assert.equal(record!.plain, message);
  assert.doesNotMatch(repo.issue, /replace your Anthropic key/);
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
