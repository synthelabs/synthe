import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { baseUrlProblem, DEFAULTS, parseGoal, type OtherProvider } from "../src/core/goal.ts";
import { askJson, configuredModel, modelProblem, providerModel, type Ask, type Model } from "../src/model/client.ts";
import { openAiCompatibleModel, ProviderError, retryAfterMs } from "../src/model/openai-compatible.ts";
import { failureOf } from "../src/loop/failure.ts";
import { localCredential } from "../src/cli/local-credential.ts";
import { loopCredential } from "../src/cli/improve.ts";
import { buildGoal, init, modelsInCode, RAW, type Io } from "../src/cli/init.ts";
import { agentOptions } from "../src/cli/agent.ts";
import { setKey } from "../src/cli/key.ts";
import { migrate } from "../src/cli/migrate.ts";

// A stand-in for an OpenAI-compatible chat completions API. Each test queues the replies it wants.
type Reply = { status?: number; headers?: Record<string, string>; body: unknown };
interface Seen { url: string; headers: IncomingHttpHeaders; body: any }
const fake = { queue: [] as Reply[], seen: [] as Seen[] };
const other = { seen: [] as Seen[] };
const serve = (into: Seen[], answer: () => Reply) => createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    into.push({ url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    const r = answer();
    res.statusCode = r.status ?? 200;
    for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(r.body));
  });
});
const ok = (content: string | null, extra: Record<string, unknown> = {}, usage: Record<string, unknown> = { prompt_tokens: 1000, completion_tokens: 500 }): Reply =>
  ({ body: { choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content, ...extra } }], usage } });
const server = serve(fake.seen, () => fake.queue.shift() ?? ok("default"));
const elsewhere = serve(other.seen, () => ok("from the wrong server"));
const url = (s: Server) => `http://127.0.0.1:${(s.address() as { port: number }).port}`;
before(async () => { await Promise.all([server, elsewhere].map((s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r)))); });
after(() => { server.close(); elsewhere.close(); });

const reset = () => { fake.queue.length = 0; fake.seen.length = 0; other.seen.length = 0; };
const waits: number[] = [];
const model = (prices?: OtherProvider["prices"]) => openAiCompatibleModel({ baseUrl: `${url(server)}/v1/`, apiKey: "test-key", prices, sleep: async (ms) => { waits.push(ms); } });
const ask: Ask = { model: "m-1", system: "You are a bot.", user: "Hi", maxTokens: 100 };
const SCHEMA = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false };

test("a plain call posts to {base_url}/chat/completions with the system message, max_tokens and the key in a header", async () => {
  reset();
  fake.queue.push(ok("Hello."));
  const r = await model().ask(ask);
  assert.equal(r.text, "Hello.");
  assert.equal(r.stopReason, "stop");
  assert.deepEqual(r.usage, { input: 1000, output: 500 });
  const [seen] = fake.seen;
  assert.equal(seen.url, "/v1/chat/completions");
  assert.equal(seen.headers.authorization, "Bearer test-key");
  assert.deepEqual(seen.body.messages, [{ role: "system", content: "You are a bot." }, { role: "user", content: "Hi" }]);
  assert.equal(seen.body.max_tokens, 100);
  assert.equal(seen.body.model, "m-1");
  assert.equal(seen.body.response_format, undefined);
});

test("a JSON schema is sent as a strict json_schema response format, and the reply parses", async () => {
  reset();
  fake.queue.push(ok('{"answer":"yes"}'));
  const { value } = await askJson<{ answer: string }>(model(), { ...ask, schema: SCHEMA });
  assert.deepEqual(value, { answer: "yes" });
  assert.deepEqual(fake.seen[0].body.response_format, { type: "json_schema", json_schema: { name: "reply", schema: SCHEMA, strict: true } });
});

test("a server that rejects the JSON schema gets one retry with the schema in the message, and later calls skip it", async () => {
  reset();
  fake.queue.push({ status: 400, body: { error: { message: "Invalid parameter: response_format" } } }, ok('```json\n{"answer":"yes"}\n```'), ok('{"answer":"again"}'));
  const m = model();
  assert.deepEqual((await askJson<{ answer: string }>(m, { ...ask, schema: SCHEMA })).value, { answer: "yes" });
  assert.equal(fake.seen.length, 2);
  assert.equal(fake.seen[1].body.response_format, undefined);
  assert.match(fake.seen[1].body.messages.at(-1).content, /^Hi\n\nReply with only a JSON object that matches this JSON schema/);
  assert.ok(fake.seen[1].body.messages.at(-1).content.includes(JSON.stringify(SCHEMA)));
  assert.deepEqual((await askJson<{ answer: string }>(m, { ...ask, schema: SCHEMA })).value, { answer: "again" });
  assert.equal(fake.seen.length, 3);
  assert.equal(fake.seen[2].body.response_format, undefined);
  // A second refusal isn't retried again: it is a real error.
  reset();
  fake.queue.push({ status: 400, body: { error: { message: "nope" } } }, { status: 400, body: { error: { message: "still nope" } } });
  await assert.rejects(model().ask({ ...ask, schema: SCHEMA }), (e: unknown) => e instanceof ProviderError && e.status === 400 && /still nope/.test(e.message));
  assert.equal(fake.seen.length, 2);
});

test("a server that wants max_completion_tokens gets it on one retry", async () => {
  reset();
  fake.queue.push({ status: 400, body: { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } } }, ok("Hello."), ok("Again."));
  const m = model();
  assert.equal((await m.ask(ask)).text, "Hello.");
  assert.equal(fake.seen[1].body.max_completion_tokens, 100);
  assert.equal(fake.seen[1].body.max_tokens, undefined);
  await m.ask(ask);
  assert.equal(fake.seen[2].body.max_completion_tokens, 100);
});

test("a reply cut off at the limit is null unless the caller allows a cut-off, as on the Anthropic path", async () => {
  reset();
  const cut = (): Reply => ({ body: { choices: [{ finish_reason: "length", message: { content: "Half a rep" } }], usage: { prompt_tokens: 10, completion_tokens: 100 } } });
  fake.queue.push(cut(), cut());
  const strict = await model().ask(ask);
  assert.equal(strict.text, null);
  assert.equal(strict.stopReason, "length");
  const allowed = await model().ask({ ...ask, allowCutOff: true });
  assert.equal(allowed.text, "Half a rep");
  assert.equal(allowed.truncated, true);
});

test("a refusal or empty content is no reply", async () => {
  reset();
  fake.queue.push(ok(null, { refusal: "I can't help with that." }), ok(null), ok(""), ok("x", { refusal: "No." }));
  for (let i = 0; i < 4; i++) assert.equal((await model().ask(ask)).text, null);
  // Unparseable JSON is null too, through askJson as on the Anthropic path.
  fake.queue.push(ok("Sure! Here you go."));
  assert.equal((await askJson(model(), { ...ask, schema: SCHEMA })).value, null);
});

test("429 and 5xx are retried with backoff, honouring retry-after; a rejected key is not retried", async () => {
  reset();
  waits.length = 0;
  fake.queue.push({ status: 429, headers: { "retry-after": "3" }, body: { error: { message: "Rate limit" } } }, { status: 503, body: { error: { message: "Overloaded" } } }, ok("Finally."));
  assert.equal((await model().ask(ask)).text, "Finally.");
  assert.equal(fake.seen.length, 3);
  assert.equal(waits[0], 3000);
  assert.ok(waits[1] > 0 && waits[1] <= 1000);
  assert.equal(retryAfterMs(new Headers({ "retry-after-ms": "250" })), 250);
  assert.equal(retryAfterMs(new Headers({ "retry-after": new Date(Date.parse("2026-01-01T00:00:10Z")).toUTCString() }), Date.parse("2026-01-01T00:00:00Z")), 10_000);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "86400" })), 60_000);
  // Four retries, then the busy error, with a plain next step naming the host.
  reset();
  for (let i = 0; i < 5; i++) fake.queue.push({ status: 429, body: { error: { message: "Rate limit" } } });
  const busy = await model().ask(ask).catch((e) => e);
  assert.equal(fake.seen.length, 5);
  assert.ok(busy instanceof ProviderError);
  const host = new URL(url(server)).host;
  assert.equal(modelProblem(busy), `${host} is busy or rate-limiting this key right now. Wait a few minutes and try again.`);
  assert.equal(failureOf("score", busy).kind, "busy");
  reset();
  fake.queue.push({ status: 401, body: { error: { message: "Incorrect API key provided: test-key" } } });
  const denied = await model().ask(ask).catch((e) => e);
  assert.equal(fake.seen.length, 1);
  assert.equal(modelProblem(denied), `Your key for ${host} was rejected. Run \`npx synthe key\` to replace it.`);
  assert.equal(failureOf("write", denied).kind, "key");
  assert.ok(!String(denied.message).includes("test-key"), "the key is never repeated in an error");
  // Out of credit comes as a 429 from some providers; waiting won't help, so it isn't retried.
  reset();
  fake.queue.push({ status: 429, body: { error: { message: "You exceeded your current quota", type: "insufficient_quota" } } });
  const quota = await model().ask(ask).catch((e) => e);
  assert.equal(fake.seen.length, 1);
  assert.match(modelProblem(quota)!, /has no credit left or has reached its spending limit/);
  assert.equal(failureOf("write", quota).kind, "key");
});

test("errors name the host and a next step, never Anthropic", async () => {
  reset();
  fake.queue.push({ status: 404, body: { error: { message: "The model `m-1` does not exist" } } });
  const missing = await model().ask(ask).catch((e) => e);
  assert.match(modelProblem(missing)!, /doesn't have the model m-1.*Check "models" and "provider" in synthe\.json/);
  assert.equal(failureOf("write", missing).kind, "other");
  const down = await openAiCompatibleModel({ baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", sleep: async () => {} }).ask(ask).catch((e) => e);
  assert.equal(modelProblem(down), "Couldn't reach the model server at 127.0.0.1:9. Start it (for example `ollama serve`), or fix provider.base_url in synthe.json, and try again.");
  for (const e of [missing, down]) assert.doesNotMatch(modelProblem(e)!, /Anthropic/);
});

test("cost comes from the team's prices, else the provider's usage.cost, else it is unknown", async () => {
  reset();
  fake.queue.push(ok("a"), ok("b", {}, { prompt_tokens: 1000, completion_tokens: 500, cost: 0.0123 }), ok("c"), ok("d", {}, { prompt_tokens: 1000, completion_tokens: 500, cost: 0.0123 }));
  const priced = model({ "m-1": { input: 0.4, output: 1.6 } });
  assert.equal((await priced.ask(ask)).costUsd, (1000 * 0.4 + 500 * 1.6) / 1e6);
  assert.equal((await model().ask(ask)).costUsd, 0.0123);
  assert.equal((await model().ask(ask)).costUsd, null);
  // The team's price wins over the provider's own figure.
  assert.equal((await priced.ask(ask)).costUsd, (1000 * 0.4 + 500 * 1.6) / 1e6);
});

test("the key goes only to the configured base URL; OPENAI_BASE_URL and other keys in the environment are ignored", async () => {
  reset();
  const saved = { ...process.env };
  Object.assign(process.env, { OPENAI_BASE_URL: `${url(elsewhere)}/v1`, OPENAI_API_BASE: `${url(elsewhere)}/v1`, OPENAI_API_KEY: "app-key", SYNTHE_ANTHROPIC_BASE_URL: `${url(elsewhere)}` });
  try {
    const provider: OtherProvider = { kind: "openai-compatible", base_url: `${url(server)}/v1` };
    fake.queue.push(ok("one"), ok("two"));
    assert.equal((await providerModel(provider, "team-key").ask(ask)).text, "one");
    assert.equal((await configuredModel("team-key", "event-code", true, undefined, provider).ask(ask)).text, "two");
  } finally { process.env = saved; }
  assert.equal(other.seen.length, 0);
  assert.equal(fake.seen.length, 2);
  for (const s of fake.seen) {
    assert.equal(s.headers.authorization, "Bearer team-key");
    assert.ok(!s.url.includes("team-key") && !s.url.includes("app-key"));
  }
  // No key: event credit doesn't cover another provider, so nothing is sent anywhere.
  assert.throws(() => configuredModel(undefined, "event-code", true, undefined, { kind: "openai-compatible", base_url: `${url(server)}/v1` }), /no key for it is set.*SYNTHE_API_KEY/);
  assert.equal(fake.seen.length, 2);
});

test("old goal files parse exactly as before, with no provider, and still use the Anthropic path", async () => {
  const old = readFileSync("examples/support-bot/synthe.json", "utf8");
  const goal = parseGoal(old);
  assert.equal("provider" in goal, false);
  assert.deepEqual(goal, { ...JSON.parse(old), guardrails: JSON.parse(old).guardrails, models: DEFAULTS.models, merge_rule: DEFAULTS.merge_rule });
  assert.equal("provider" in buildGoal({ kind: "file", path: "p.md" }, "o", []), false);
  // The Anthropic path, through its loopback override, exactly as before.
  reset();
  const saved = process.env.SYNTHE_ANTHROPIC_BASE_URL;
  process.env.SYNTHE_ANTHROPIC_BASE_URL = url(elsewhere);
  const anthropicSeen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    anthropicSeen.push(input instanceof Request ? input.url : String(input));
    return new Response(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text: "OK" }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    assert.equal((await configuredModel("sk-ant-x", undefined, false, undefined, goal.provider).ask({ model: "claude-haiku-5-5", user: "hi", maxTokens: 5 })).text, "OK");
    assert.equal((await providerModel(goal.provider, "sk-ant-x").ask({ model: "claude-haiku-5-5", user: "hi", maxTokens: 5 })).text, "OK");
  } finally {
    globalThis.fetch = real;
    if (saved === undefined) delete process.env.SYNTHE_ANTHROPIC_BASE_URL; else process.env.SYNTHE_ANTHROPIC_BASE_URL = saved;
  }
  assert.deepEqual(anthropicSeen, [`${url(elsewhere)}/v1/messages`, `${url(elsewhere)}/v1/messages`]);
});

test("parseGoal validates the provider: https, or http only on this machine, and every model named", () => {
  const base = JSON.parse(readFileSync("examples/support-bot/synthe.json", "utf8"));
  const models = { writer: "w", runner: "r", judge: "j", checker: "c" };
  const goal = (provider: unknown, m: unknown = models) => JSON.stringify({ ...base, models: m, provider });
  assert.deepEqual(parseGoal(goal({ kind: "openai-compatible", base_url: "https://api.openai.com/v1", prices: { r: { input: 0.4, output: 1.6 } } })).provider,
    { kind: "openai-compatible", base_url: "https://api.openai.com/v1", prices: { r: { input: 0.4, output: 1.6 } } });
  for (const local of ["http://localhost:11434/v1", "http://127.0.0.1:8000/v1", "http://[::1]:1234/v1"]) assert.equal(baseUrlProblem(local), null);
  assert.equal(parseGoal(goal({ kind: "anthropic" })).provider?.kind, "anthropic");
  for (const [provider, why] of [
    [{ kind: "openai-compatible" }, /base_url is required/],
    [{ kind: "openai-compatible", base_url: "http://api.example.com/v1" }, /must use https/],
    [{ kind: "openai-compatible", base_url: "http://127.0.0.1.attacker.example/v1" }, /must use https/],
    [{ kind: "openai-compatible", base_url: "https://user:pass@api.example.com/v1" }, /user name or password/],
    [{ kind: "openai-compatible", base_url: "https://api.example.com/v1?key=x" }, /query string/],
    [{ kind: "openai-compatible", base_url: "ftp://api.example.com" }, /must start with https/],
    [{ kind: "openai-compatible", base_url: "not a url" }, /isn't a URL/],
    [{ kind: "anthropic", base_url: "https://gateway.example.com" }, /only for an openai-compatible provider/],
    [{ kind: "anthropic", prices: {} }, /already knows Anthropic's prices/],
    [{ kind: "gemini" }, /provider.kind must be anthropic or openai-compatible/],
    [{ kind: "openai-compatible", base_url: "https://x.example/v1", prices: { r: { input: -1, output: 1 } } }, /provider.prices.r needs/],
  ] as const) assert.throws(() => parseGoal(goal(provider)), why);
  assert.throws(() => parseGoal(goal({ kind: "openai-compatible", base_url: "https://x.example/v1" }, { runner: "r" })), /needs every model named in "models": writer, judge, checker are missing/);
});

test("local commands and improve take another provider's key only from SYNTHE_API_KEY", () => {
  const provider: OtherProvider = { kind: "openai-compatible", base_url: "https://api.example.com/v1", prices: { w: { input: 1, output: 2 } } };
  const apps = { OPENAI_API_KEY: "app", ANTHROPIC_API_KEY: "sk-ant-app", SYNTHE_ANTHROPIC_KEY: "sk-ant-own", SYNTHE_EVENT_CODE: "event" };
  assert.equal(localCredential(apps, provider), null);
  assert.deepEqual(localCredential({ ...apps, SYNTHE_API_KEY: "mine" }, provider), { key: "mine", line: "Credential: your own key from SYNTHE_API_KEY, sent to api.example.com and charged to that account." });
  // An Anthropic goal is unchanged, and also takes SYNTHE_API_KEY.
  assert.equal(localCredential(apps)?.key, "sk-ant-own");
  assert.equal(localCredential({ ...apps, SYNTHE_API_KEY: "sk-ant-generic" })?.key, "sk-ant-generic");
  const loop = loopCredential(apps, { provider, model: "w" });
  assert.ok("problem" in loop && /set SYNTHE_API_KEY/.test(loop.problem));
  const chosen = loopCredential({ ...apps, SYNTHE_API_KEY: "mine" }, { provider, model: "w" });
  assert.ok("credential" in chosen && chosen.credential.key === "mine" && chosen.credential.model === "w");
  const unpriced = loopCredential({ SYNTHE_API_KEY: "mine" }, { provider: { ...provider, prices: {} }, model: "w" });
  assert.ok("problem" in unpriced && /no price for w in provider\.prices/.test(unpriced.problem));
});

test("modelsInCode finds the model names an agent's code passes to its API", () => {
  assert.deepEqual(modelsInCode('const r = await client.chat.completions.create({ model: "gpt-4.1-mini", messages });\nmodel: "gpt-4.1-mini"'), ["gpt-4.1-mini"]);
  assert.deepEqual(modelsInCode("llm = ChatOpenAI(model_name='gpt-4o', temperature=0)\nother = Client(model=\"gemini-2.5-flash\")"), ["gpt-4o", "gemini-2.5-flash"]);
  assert.deepEqual(modelsInCode('{"model": "llama3.1:8b"}'), ["llama3.1:8b"]);
  assert.deepEqual(modelsInCode("const model = pickModel(); // no literal"), []);
});

// Setup with another provider, through the real init code and a fake model and gh.
const PROMPT = "You are a very helpful assistant for hikers needing trail advice.";
const scenarioReply = JSON.stringify({ guardrails: ["Never lie"], policy: "", brief: "", checks: [], scenarios: Array.from({ length: 80 }, (_, i) => ({ input: `q${i}`, expected: `a${i}` })) });
function setupRepo(code = 'import { readFileSync } from "node:fs";\nconst system = readFileSync("prompt.md", "utf8");\nawait client.chat.completions.create({ model: "gpt-4.1-mini", messages: [{ role: "system", content: system }] });\n') {
  const dir = mkdtempSync(join(tmpdir(), "synthe-provider-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "prompt.md"), PROMPT);
  writeFileSync(join(dir, "agent.ts"), code);
  execFileSync("git", ["add", "prompt.md", "agent.ts"], { cwd: dir });
  return dir;
}
function setupIo(dir: string, answers: Record<string, string>) {
  const ran: { cmd: string; args: string[]; stdin?: string }[] = [];
  const said: string[] = [], asked: string[] = [], calls: { provider: OtherProvider; key: string; model: string }[] = [];
  const io: Io = {
    say: (t) => said.push(t),
    ask: async (q) => { asked.push(q); return Object.entries({ "automatically?": "y", "Real message": "", "What should your agent": "Give correct trail advice", ...answers }).find(([k]) => q.includes(k))?.[1] ?? ""; },
    askSecret: async () => { throw new Error("no key should be asked for"); },
    template: () => readFileSync("templates/synthe.yml", "utf8"),
    sleep: async () => {},
    model: () => { throw new Error("an Anthropic call in an OpenAI-compatible setup"); },
    proxy: () => { throw new Error("a proxy call in an OpenAI-compatible setup"); },
    other: (provider, key): Model => ({ ask: async (a) => { calls.push({ provider, key, model: a.model }); return { text: scenarioReply, costUsd: 0.01 }; } }),
    async run(cmd, args, stdin) {
      ran.push({ cmd, args, stdin });
      if (args.includes(RAW)) return readFileSync(join(dir, decodeURIComponent(args.at(-1)!.split("/contents/")[1].split("?")[0])), "utf8");
      if (cmd === "git" && args[0] !== "ls-files") return "";
      if (cmd === "git") return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
      return "o/r\n";
    },
  };
  return { io, ran, said, asked, calls };
}

test("init with --base-url proposes the runner from the agent's code, asks for prices, and saves SYNTHE_API_KEY", async () => {
  const dir = setupRepo();
  const { io, ran, said, asked, calls } = setupIo(dir, { "Price of gpt-4.1-mini per million input": "0.40", "Price of gpt-4.1-mini per million output": "$1.60" });
  const env = { SYNTHE_API_KEY: "provider-key", OPENAI_API_KEY: "app-key", ANTHROPIC_API_KEY: "sk-ant-app" };
  assert.equal(await init(io, dir, undefined, "sk-ant-app", env, undefined, "https://api.example.com/v1"), true);
  assert.ok(asked.includes("Press Enter to use gpt-4.1-mini as your agent's model, or type the model it uses: "));
  assert.ok(said.some((s) => s.includes("Your agent's code names the model gpt-4.1-mini (agent.ts)")));
  assert.ok(said.some((s) => /needs what api\.example\.com charges for each model; it can't look up/.test(s)));
  const goal = parseGoal(readFileSync(join(dir, "synthe.json"), "utf8"));
  assert.deepEqual(goal.provider, { kind: "openai-compatible", base_url: "https://api.example.com/v1", prices: { "gpt-4.1-mini": { input: 0.4, output: 1.6 } } });
  assert.deepEqual(goal.models, { writer: "gpt-4.1-mini", runner: "gpt-4.1-mini", judge: "gpt-4.1-mini", checker: "gpt-4.1-mini" });
  // Writer and judge are the same model, so setup says why a separate judge is safer.
  assert.ok(said.some((s) => s.startsWith("Your writer and judge are both gpt-4.1-mini.")));
  // Every model call, the cheap key check first, went to the provider with the team's key.
  assert.ok(calls.length > 1 && calls.every((c) => c.key === "provider-key" && c.provider.base_url === "https://api.example.com/v1" && c.model === "gpt-4.1-mini"));
  const secrets = ran.filter((r) => r.args[0] === "secret");
  assert.deepEqual(secrets.map((s) => s.args), [["secret", "set", "SYNTHE_API_KEY", "--repo", "o/r"]]);
  assert.equal(secrets[0].stdin, "provider-key");
  assert.ok(!ran.some((r) => r.args.join(" ").includes("provider-key")), "the key is never in argv");
  assert.ok(said.some((s) => s.includes("Credential: your own key from SYNTHE_API_KEY, $3 budget on your account with api.example.com.")));
  assert.ok(said.some((s) => s.includes("Your account with api.example.com must have enough credit.")));
  for (const f of ["synthe.json", ".github/workflows/synthe.yml"]) assert.ok(!readFileSync(join(dir, f), "utf8").includes("provider-key"));
});

test("init lets the team pick other models for the writer and judge, and stops with nothing written when a price is missing", async () => {
  const dir = setupRepo();
  const { io, asked } = setupIo(dir, {
    "Press Enter to use gpt-4.1-mini": "my-agent-model", "writes Synthe's prompt edits": "big-model", "judges replies": "judge-model",
    "Price of my-agent-model per million input": "1", "Price of my-agent-model per million output": "2",
    "Price of big-model per million input": "3", "Price of big-model per million output": "4",
    "Price of judge-model per million input": "5", "Price of judge-model per million output": "6",
  });
  assert.equal(await init(io, dir, undefined, "", { SYNTHE_API_KEY: "k" }, undefined, "http://localhost:11434/v1"), true);
  const goal = parseGoal(readFileSync(join(dir, "synthe.json"), "utf8"));
  assert.deepEqual(goal.models, { writer: "big-model", runner: "my-agent-model", judge: "judge-model", checker: "judge-model" });
  assert.deepEqual(Object.keys(goal.provider!.kind === "openai-compatible" ? goal.provider!.prices! : {}), ["my-agent-model", "big-model", "judge-model"]);
  assert.equal(asked.filter((q) => q.startsWith("Price of")).length, 6);

  const unpriced = setupRepo("const x = 1;\n");
  const second = setupIo(unpriced, { "Which model does your agent use": "m", "Price of m per million input": "free" });
  assert.equal(await init(second.io, unpriced, undefined, "", { SYNTHE_API_KEY: "k" }, undefined, "https://api.example.com/v1"), false);
  assert.ok(second.asked.some((q) => q.startsWith("Which model does your agent use on api.example.com?")));
  assert.ok(second.said.some((s) => s.includes("Synthe needs a price for each model. Nothing in your repo was changed")));
  assert.equal(existsSync(join(unpriced, "synthe.json")), false);
  assert.equal(second.calls.length, 0, "no model call before the prices are known");
  assert.equal(second.ran.some((r) => r.args[0] === "secret"), false);
});

test("init refuses an unsafe --base-url, and a pasted non-Anthropic key is only used with a base URL the person types", async () => {
  const dir = setupRepo();
  const refused = setupIo(dir, {});
  assert.equal(await init(refused.io, dir, undefined, "", { SYNTHE_API_KEY: "k" }, undefined, "http://api.example.com/v1"), false);
  assert.match(refused.said.at(-1)!, /--base-url must use https.*Nothing changed/);
  assert.equal(refused.calls.length, 0);

  const pasted = setupIo(dir, { "Type that API's base URL": "https://api.example.com/v1", "Price of gpt-4.1-mini per million": "1" });
  pasted.io.askSecret = async () => "sk-proj-typed";
  assert.equal(await init(pasted.io, dir, undefined, "", {}), true);
  assert.match(pasted.said.join("\n"), /another provider's key.*Nothing was sent/);
  assert.ok(pasted.calls.length > 0 && pasted.calls.every((c) => c.key === "sk-proj-typed" && c.provider.base_url === "https://api.example.com/v1"));
  assert.equal(parseGoal(readFileSync(join(dir, "synthe.json"), "utf8")).provider?.kind, "openai-compatible");

  // SYNTHE_API_KEY holding another provider's key, without --base-url, is never taken for an event code.
  const dir2 = setupRepo();
  const envOnly = setupIo(dir2, {});
  envOnly.io.askSecret = async () => "";
  assert.equal(await init(envOnly.io, dir2, undefined, "", { SYNTHE_API_KEY: "gsk_groq_key" }), false);
  assert.ok(envOnly.said.some((s) => s.startsWith("SYNTHE_API_KEY isn't an Anthropic key, so Synthe didn't use it.")));
  assert.equal(envOnly.calls.length, 0);
});

test("agent setup with another provider takes --base-url, --model and --price, then confirms with SYNTHE_API_KEY", async () => {
  const dir = setupRepo();
  const { io, ran, calls } = setupIo(dir, {});
  const env = { SYNTHE_API_KEY: "provider-key" };
  const prepare = agentOptions(["--agent", "--prompt", "prompt.md", "--objective", "Be right", "--mode", "auto", "--base-url", "https://api.example.com/v1", "--model", "gpt-4.1-mini", "--price", "0.40/1.60"]);
  assert.equal(await init(io, dir, undefined, "", env, prepare), true);
  assert.equal(ran.some((r) => r.args[0] === "secret"), false);
  assert.equal(await init(io, dir, undefined, "", env, agentOptions(["--agent", "--confirm", "--keep-checks"])), true);
  const goal = parseGoal(readFileSync(join(dir, "synthe.json"), "utf8"));
  assert.deepEqual(goal.provider, { kind: "openai-compatible", base_url: "https://api.example.com/v1", prices: { "gpt-4.1-mini": { input: 0.4, output: 1.6 } } });
  assert.deepEqual(ran.filter((r) => r.args[0] === "secret").map((r) => [r.args[2], r.stdin]), [["SYNTHE_API_KEY", "provider-key"]]);
  assert.ok(calls.every((c) => c.key === "provider-key"));
  // Without --model, the agent is told what the code names instead of guessing.
  const dir2 = setupRepo();
  await assert.rejects(init(setupIo(dir2, {}).io, dir2, undefined, "", env, agentOptions(["--agent", "--prompt", "prompt.md", "--objective", "Be right", "--mode", "auto", "--base-url", "https://api.example.com/v1", "--price", "1/2"])),
    /--model \(the model the agent uses on api\.example\.com; its code names gpt-4\.1-mini in agent\.ts\) is missing or invalid/);
  assert.throws(() => agentOptions(["--agent", "--prompt", "p", "--objective", "o", "--mode", "auto", "--model", "m"]), /--base-url/);
});

test("key saves another provider's key as SYNTHE_API_KEY after a cheap call on the runner, reading no app key", async () => {
  const provider: OtherProvider = { kind: "openai-compatible", base_url: "https://api.example.com/v1", prices: { r: { input: 1, output: 2 } } };
  const remote = JSON.stringify({ version: 1, prompt: { kind: "file", path: "prompt.md" }, objective: "Improve", guardrails: [], scenarios: "s.jsonl", budget: { max_usd: 3 }, models: { writer: "w", runner: "r", judge: "j", checker: "c" }, provider });
  const ran: { args: string[]; stdin?: string }[] = [], said: string[] = [], calls: { key: string; model: string }[] = [];
  const io = {
    say: (t: string) => said.push(t),
    askSecret: async () => "typed-key",
    other: (_p: OtherProvider, key: string): Model => ({ ask: async (a) => { calls.push({ key, model: a.model }); return { text: "OK", costUsd: 0 }; } }),
    model: () => { throw new Error("no Anthropic call"); },
    async run(_cmd: string, args: string[], stdin?: string) {
      ran.push({ args, stdin });
      if (args.some((a) => a.includes("contents/synthe.json"))) return remote;
      if (args.some((a) => a.includes("state.json?ref="))) throw new Error("HTTP 404: Not Found");
      return "o/r\n";
    },
  };
  assert.equal(await setKey(io, { OPENAI_API_KEY: "app", ANTHROPIC_API_KEY: "sk-ant-app" }, true, provider), true);
  assert.deepEqual(calls, [{ key: "typed-key", model: "r" }]);
  const secret = ran.find((r) => r.args[0] === "secret")!;
  assert.deepEqual(secret.args, ["secret", "set", "SYNTHE_API_KEY", "--repo", "o/r"]);
  assert.equal(secret.stdin, "typed-key");
  assert.equal(said.at(-1), "Rounds now use your own key for api.example.com, with a fresh $3 budget (budget.max_usd in synthe.json).");
  // Not in a terminal and no SYNTHE_API_KEY: nothing is read or saved.
  ran.length = 0;
  assert.equal(await setKey(io, { OPENAI_API_KEY: "app" }, false, provider), false);
  assert.equal(ran.length, 0);
});

test("migrate on another provider reads SYNTHE_API_KEY and prices the dry run from synthe.json", async () => {
  const dir = mkdtempSync(join(tmpdir(), "synthe-migrate-provider-"));
  writeFileSync(join(dir, "prompt.md"), PROMPT);
  writeFileSync(join(dir, "s.jsonl"), [...Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, input: "q", expected: "a", split: "train" })), { id: "h", input: "q", expected: "a", split: "holdout" }].map((r) => JSON.stringify(r)).join("\n"));
  const provider = { kind: "openai-compatible", base_url: "https://api.example.com/v1", prices: { small: { input: 1, output: 2 }, big: { input: 10, output: 20 } } };
  writeFileSync(join(dir, "synthe.json"), JSON.stringify({ version: 1, prompt: { kind: "file", path: "prompt.md" }, objective: "o", guardrails: [], scenarios: "s.jsonl", budget: { max_usd: 3 }, models: { writer: "small", runner: "small", judge: "small", checker: "small" }, provider }));
  const said: string[] = [];
  assert.equal(await migrate(["--to", "big", "--dry-run"], { cwd: dir, say: (t) => said.push(t) }), 0);
  assert.match(said.join("\n"), /Before: \$0\.\d+ {2}After: \$0\.\d+ {2}Change: \+900%/);
  said.length = 0;
  assert.equal(await migrate(["--to", "big"], { cwd: dir, say: (t) => said.push(t), anthropicKey: "sk-ant-own" }), 1);
  assert.match(said.join("\n"), /needs your own key for api\.example\.com:\n {2}SYNTHE_API_KEY=your-key/);
});
