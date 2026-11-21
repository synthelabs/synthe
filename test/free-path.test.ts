import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseGoal, type Goal } from "../src/core/goal.ts";
import { CallLimitError, cleanStop, countCalls, QUOTA_MESSAGE } from "../src/core/calls.ts";
import { newState, stopReason } from "../src/core/state.ts";
import { runDecide } from "../src/loop/decide.ts";
import { restartState } from "../src/cli/restart.ts";
import { modelProblem, type Ask, type Model } from "../src/model/client.ts";
import { listModels, openAiCompatibleModel, ProviderError } from "../src/model/openai-compatible.ts";
import { FREE_MAX_CALLS, PRESETS } from "../src/model/presets.ts";
import { loopCredential } from "../src/cli/improve.ts";
import { init, RAW, type Io } from "../src/cli/init.ts";
import { agentOptions } from "../src/cli/agent.ts";
import { setKey } from "../src/cli/key.ts";
import { parseImproveConfig, type ImproveConfig } from "../src/improve/config.ts";
import { shellExec } from "../src/improve/exec.ts";
import { runLoop } from "../src/improve/loop.ts";
import { measureAt } from "../src/improve/worktree.ts";
import { goal as baseGoal, MemoryRepo } from "./helpers.ts";

// A stand-in for an OpenAI-compatible API that can hold replies, to see how many requests are in flight at once.
type Reply = { status?: number; body: unknown; holdMs?: number };
const fake = { queue: [] as Reply[], arrivals: [] as number[], realArrivals: [] as number[], inFlight: 0, maxInFlight: 0 };
let clock = 0;
const bodies: any[] = [];
const server: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    fake.arrivals.push(clock);
    bodies.push(raw ? JSON.parse(raw) : null);
    fake.realArrivals.push(performance.now());
    fake.inFlight++;
    fake.maxInFlight = Math.max(fake.maxInFlight, fake.inFlight);
    const r = fake.queue.shift() ?? { body: { choices: [{ finish_reason: "stop", message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } };
    setTimeout(() => {
      fake.inFlight--;
      res.statusCode = r.status ?? 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(r.body));
    }, r.holdMs ?? 0);
  });
});
before(async () => { await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); });
after(() => { server.close(); });
const baseUrl = () => `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
const reset = () => { bodies.length = 0; fake.queue.length = 0; fake.arrivals.length = 0; fake.realArrivals.length = 0; fake.inFlight = 0; fake.maxInFlight = 0; clock = 0; };
const ask: Ask = { model: "m", user: "hi", maxTokens: 10 };
// Retries wait on a fake clock, so backoff never slows the tests.
const paced = (rpm?: number) => openAiCompatibleModel({ baseUrl: baseUrl(), apiKey: "test-key", maxRequestsPerMinute: rpm, now: () => clock, sleep: async (ms) => { clock += ms; } });

test("with max_requests_per_minute, requests are spaced out and at most two are in flight", async () => {
  // Real time, at 600 a minute (100ms apart). Each reply takes 250ms, so without the limit three would be in flight.
  reset();
  const real = () => openAiCompatibleModel({ baseUrl: baseUrl(), apiKey: "test-key", maxRequestsPerMinute: 600 });
  for (let i = 0; i < 6; i++) fake.queue.push({ body: { choices: [{ finish_reason: "stop", message: { content: `r${i}` } }] }, holdMs: 250 });
  const m = real();
  const replies = await Promise.all(Array.from({ length: 6 }, () => m.ask(ask)));
  assert.deepEqual(replies.map((r) => r.text).sort(), ["r0", "r1", "r2", "r3", "r4", "r5"]);
  const at = fake.realArrivals;
  // Sends are 100ms apart; arrivals wobble by the local network (the first one also opens the connection).
  const shown = JSON.stringify(at.map((t) => Math.round(t - at[0])));
  for (let i = 1; i < 6; i++) assert.ok(at[i] - at[i - 1] >= 70, shown);
  assert.ok(at[5] - at[0] >= 480, shown);
  assert.equal(fake.maxInFlight, 2);
  // Unpaced, requests go out together.
  reset();
  for (let i = 0; i < 4; i++) fake.queue.push({ body: { choices: [{ finish_reason: "stop", message: { content: "x" } }] }, holdMs: 100 });
  const unpaced = paced();
  await Promise.all(Array.from({ length: 4 }, () => unpaced.ask(ask)));
  assert.equal(fake.maxInFlight, 4);
});

test("a used-up free limit is told apart from a brief rate limit and from paid credit running out", async () => {
  // A daily allowance: not retried, and a clean stop.
  reset();
  fake.queue.push({ status: 429, body: { error: { message: "Quota exceeded for metric: generate_content_free_tier_requests, limit per day" } } });
  const daily = await paced().ask(ask).catch((e) => e);
  assert.equal(fake.arrivals.length, 1);
  assert.ok(daily instanceof ProviderError && daily.exhausted && !daily.credit);
  assert.deepEqual(cleanStop("score", daily), { kind: "quota", step: "score", message: QUOTA_MESSAGE });
  assert.equal(modelProblem(daily), "Your provider's free limit is used up for now. Run the command again later.");
  // A brief limit clears on retry.
  reset();
  fake.queue.push({ status: 429, body: { error: { message: "Rate limit reached, requests per minute" } } }, { body: { choices: [{ finish_reason: "stop", message: { content: "ok" } }] } });
  assert.equal((await paced().ask(ask)).text, "ok");
  // A 429 still there after every retry is the free limit used up for now.
  reset();
  for (let i = 0; i < 5; i++) fake.queue.push({ status: 429, body: { error: { message: "Resource has been exhausted (e.g. check quota)." } } });
  const persistent = await paced().ask(ask).catch((e) => e);
  assert.equal(fake.arrivals.length, 5);
  assert.ok(persistent instanceof ProviderError && persistent.exhausted);
  // Paid credit gone is a person's job, not a pause.
  for (const r of [{ status: 429, body: { error: { message: "You exceeded your current quota", type: "insufficient_quota" } } }, { status: 402, body: { error: { message: "Payment required" } } }]) {
    reset();
    fake.queue.push(r);
    const credit = await paced().ask(ask).catch((e) => e);
    assert.equal(fake.arrivals.length, 1);
    assert.ok(credit instanceof ProviderError && credit.credit && !credit.exhausted);
    assert.equal(cleanStop("write", credit), null);
  }
});

test("countCalls refuses the call past the cap before anything is sent, and adds up what the calls cost", async () => {
  let sent = 0;
  const model: Model = { ask: async () => { sent++; return { text: "x", costUsd: 0.5 }; } };
  const counted = countCalls(model, 2, 10);
  await counted.model.ask(ask);
  await counted.model.ask(ask);
  await assert.rejects(counted.model.ask(ask), (e: unknown) => e instanceof CallLimitError && /the 10 model calls this run allows \(budget\.max_calls/.test((e as Error).message));
  assert.equal(sent, 2);
  assert.equal(counted.calls(), 2);
  assert.equal(counted.costUsd(), 1);
  assert.equal(cleanStop("write", new CallLimitError(10))?.kind, "limit");
  assert.equal(countCalls(model, Infinity).calls(), 0);
});

const other = (over: Record<string, unknown> = {}) => {
  const base = JSON.parse(readFileSync("examples/support-bot/synthe.json", "utf8"));
  return JSON.stringify({ ...base, models: { writer: "m", runner: "m", judge: "m", checker: "m" }, provider: { kind: "openai-compatible", base_url: "https://api.example.com/v1" }, ...over });
};

test("parseGoal never treats an unknown or zero price as safe: it needs budget.max_calls", () => {
  assert.throws(() => parseGoal(other()), /m has no price, or a price of 0, in provider\.prices.*Set budget\.max_calls/);
  assert.throws(() => parseGoal(other({ provider: { kind: "openai-compatible", base_url: "https://api.example.com/v1", prices: { m: { input: 0, output: 0 } } } })), /Set budget\.max_calls/);
  const free = parseGoal(other({ budget: { max_usd: 3, max_calls: 500 }, provider: { kind: "openai-compatible", base_url: "https://api.example.com/v1", prices: { m: { input: 0, output: 0 } }, max_requests_per_minute: 15 } }));
  assert.equal(free.budget.max_calls, 500);
  assert.equal(free.provider?.kind === "openai-compatible" && free.provider.max_requests_per_minute, 15);
  assert.equal(parseGoal(other({ provider: { kind: "openai-compatible", base_url: "https://api.example.com/v1", prices: { m: { input: 0.1, output: 0.2 } } } })).budget.max_calls, undefined);
  for (const bad of [0, -1, 1.5, "500"]) assert.throws(() => parseGoal(other({ budget: { max_usd: 3, max_calls: bad } })), /budget\.max_calls must be a whole number above 0/);
  assert.throws(() => parseGoal(other({ budget: { max_usd: 3, max_calls: 5 }, provider: { kind: "openai-compatible", base_url: "https://api.example.com/v1", max_requests_per_minute: 0 } })), /max_requests_per_minute must be a number above 0/);
  // Anthropic goals need no cap: Synthe knows those prices.
  assert.equal(parseGoal(readFileSync("examples/support-bot/synthe.json", "utf8")).budget.max_calls, undefined);
});

test("a used-up free limit pauses the run without counting a round or a stall; the next round clears it", async () => {
  const goal: Goal = baseGoal({ budget: { max_usd: 3, max_calls: 100 } });
  const repo = new MemoryRepo("Old prompt.");
  repo.state = { ...newState(), round: 2, stalls: 1, spendUsd: 0, calls: 40 };
  const paused = await runDecide(goal, repo, { candidates: null, scores: null, costUsd: 0, calls: 7, stopped: { kind: "quota", step: "score", message: QUOTA_MESSAGE } }, new Date("2026-11-20T10:00:00Z"));
  assert.equal(paused, null);
  assert.equal(repo.state.round, 2);
  assert.equal(repo.state.stalls, 1);
  assert.equal(repo.state.calls, 47);
  assert.deepEqual(repo.state.paused, { at: "2026-11-20T10:00:00.000Z", step: "score" });
  assert.equal(repo.state.stopped, null);
  assert.equal(repo.state.chainReady, false);
  assert.equal(repo.state.rounds.length, 0);
  assert.match(repo.issue, /free limit was used up during the last try \(2026-11-20 10:00 UTC\)\. That try didn't count as a round/);
  assert.doesNotMatch(repo.issue, /\d+ (requests|tokens) (per|a) (minute|day)/);
  // The next round, however it ends, counts its calls and clears the pause.
  await runDecide(goal, repo, { candidates: null, scores: null, costUsd: 0, calls: 3, error: null });
  assert.equal(repo.state.round, 3);
  assert.equal(repo.state.calls, 50);
  assert.equal(repo.state.paused, undefined);
});

test("reaching budget.max_calls stops the run cleanly, as a finished run that a higher cap can restart", async () => {
  const goal: Goal = baseGoal({ budget: { max_usd: 3, max_calls: 50 } });
  const repo = new MemoryRepo("Old prompt.");
  repo.state = { ...newState(), round: 1, calls: 45 };
  assert.equal(await runDecide(goal, repo, { candidates: null, scores: null, costUsd: 0.01, calls: 5, stopped: { kind: "limit", step: "score", message: new CallLimitError(50).message } }), null);
  assert.equal(repo.state.stopped, "call limit of 50 is used");
  assert.equal(repo.state.round, 1);
  assert.equal(repo.state.calls, 50);
  assert.match(repo.issue, /Synthe stopped because it made the 50 model calls the run allows \(budget\.max_calls\)/);
  assert.match(repo.issue, /raise budget\.max_calls in synthe\.json and push it, then run `npx synthe restart`/);
  assert.equal(stopReason({ ...newState(), calls: 50 }, 12, 3, 3, 50), "call limit of 50 is used");
  assert.equal(stopReason({ ...newState(), calls: 49 }, 12, 3, 3, 50), null);
  assert.equal(stopReason({ ...newState(), calls: 5000 }, 12, 3, 3), null);
  const refused = restartState(goal, repo.state);
  assert.ok("why" in refused && /made all 50 model calls this run allows\. To go on, raise budget\.max_calls/.test(refused.why));
  const raised = restartState(baseGoal({ budget: { max_usd: 3, max_calls: 80 } }), repo.state);
  assert.ok("state" in raised && raised.state.stopped === null);
});

test("improve stops cleanly at budget.max_calls and keeps what already won", async () => {
  const dir = mkdtempSync(join(tmpdir(), "synthe-free-improve-"));
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env: gitEnv }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
  writeFileSync(join(dir, "value.js"), "module.exports = 10;\n");
  writeFileSync(join(dir, "metric.js"), 'console.log(require("./value.js"));\n');
  git("add", "."); git("commit", "-qm", "app");
  const draft: ImproveConfig = {
    version: 1, goal: "Raise the number", guard: { command: null }, protect: [], mode: "review",
    metric: { preset: "custom", label: "score", unit: "points", command: "node metric.js", direction: "higher", runs: 1 },
    baseline: { commit: "x", median: 0, runs: [0], at: "" },
  };
  const measured = await measureAt(shellExec, dir, git("rev-parse", "HEAD"), draft);
  const config = parseImproveConfig(JSON.stringify({ ...draft, baseline: measured.measurement }));
  let round = -1;
  const scripted: Model = { async ask(a) {
    const picking = Boolean((a.schema as any)?.properties?.paths);
    if (picking) round++;
    return { text: JSON.stringify(picking ? { paths: ["value.js"], why: "the number" } : { summary: `raise to ${12 + round}`, edits: [{ path: "value.js", search: `module.exports = ${round === 0 ? 10 : 11 + round};`, replace: `module.exports = ${12 + round};` }] }), costUsd: 0 };
  } };
  const io = { say: () => {}, exec: shellExec, run: async (cmd: string, args: string[], stdin?: string) => execFileSync(cmd, args, { cwd: dir, encoding: "utf8", input: stdin, env: gitEnv, stdio: ["pipe", "pipe", "pipe"] }) };
  // Each round makes two calls (pick files, propose an edit), so a cap of 3 ends round 2 partway.
  const result = await runLoop(io, { top: dir, gitDir: join(dir, ".git"), config, model: countCalls(scripted, 3, 3).model, rounds: 5, budgetUsd: 1 });
  assert.match(result.stopped, /^Stopped in round 2: Synthe made the 3 model calls this run allows \(budget\.max_calls in synthe\.json\)/);
  assert.equal(result.rounds.filter((r) => r.kept).length, 1);
  assert.equal(result.best.median, 12);
  // improve takes the cap from synthe.json, and a free provider without one can't start.
  const provider = { kind: "openai-compatible" as const, base_url: "https://api.example.com/v1", prices: { m: { input: 0, output: 0 } } };
  const capped = loopCredential({ SYNTHE_API_KEY: "k" }, { provider, model: "m", maxCalls: 40 });
  assert.ok("credential" in capped && capped.credential.maxCalls === 40);
  const uncapped = loopCredential({ SYNTHE_API_KEY: "k" }, { provider, model: "m" });
  assert.ok("problem" in uncapped && /no budget\.max_calls/.test(uncapped.problem));
});

// Setup through the real init code, a fake model and a fake gh.
const PROMPT = "You are a very helpful assistant for hikers needing trail advice.";
const scenarioReply = JSON.stringify({ guardrails: ["Never lie"], policy: "", brief: "", checks: [], scenarios: Array.from({ length: 80 }, (_, i) => ({ input: `q${i}`, expected: `a${i}` })) });
function setupRepo() {
  const dir = mkdtempSync(join(tmpdir(), "synthe-free-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "prompt.md"), PROMPT);
  execFileSync("git", ["add", "prompt.md"], { cwd: dir });
  return dir;
}
function setupIo(dir: string, answers: Record<string, string>, secret = "free-key") {
  const ran: { args: string[]; stdin?: string }[] = [];
  const said: string[] = [], asked: string[] = [], calls: { base: string; key: string; model: string }[] = [], listed: { base: string; key: string }[] = [];
  const io: Io = {
    say: (t) => said.push(t),
    ask: async (q) => { asked.push(q); return Object.entries({ "automatically?": "y", "Real message": "", "What should your agent": "Give correct trail advice", ...answers }).find(([k]) => q.includes(k))?.[1] ?? ""; },
    askSecret: async () => secret,
    template: () => readFileSync("templates/synthe.yml", "utf8"),
    sleep: async () => {},
    model: () => { throw new Error("an Anthropic call on the free path"); },
    other: (provider, key): Model => ({ ask: async (a) => { calls.push({ base: provider.base_url, key, model: a.model }); return { text: scenarioReply, costUsd: 0 }; } }),
    // Every preset's suggested models, plus two of OpenRouter's: never a real network call from a test.
    listModels: async (base, key) => { listed.push({ base, key }); return { ok: true, models: LISTED }; },
    async run(cmd, args, stdin) {
      ran.push({ args, stdin });
      if (args.includes(RAW)) return readFileSync(join(dir, decodeURIComponent(args.at(-1)!.split("/contents/")[1].split("?")[0])), "utf8");
      if (cmd === "git" && args[0] !== "ls-files") return "";
      if (cmd === "git") return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
      return "o/r\n";
    },
  };
  return { io, ran, said, asked, calls, listed };
}
const LISTED = [
  ...new Set(PRESETS.flatMap((p) => (p.models ? Object.values(p.models) : []))),
].map((id) => ({ id, free: false })).concat([{ id: "vendor/paid-model", free: false }, { id: "z-ai/glm-5:free", free: true }, { id: "vendor/other:free", free: true }]);

test("init offers free providers to a team with no key, and a free-tier key gets no prices, a call cap and pacing", async () => {
  const dir = setupRepo();
  const gemini = PRESETS.find((p) => p.id === "gemini")!;
  const { io, ran, said, asked, calls } = setupIo(dir, { "Type a number, or press Enter": "1", "free tier": "y" });
  assert.equal(await init(io, dir, undefined, "", {}), true);
  assert.equal(asked[0], "Type a number, or press Enter for your own Anthropic key: ");
  assert.ok(said.some((s) => s.includes(`1. Google Gemini: get a free key at ${gemini.signup}`)));
  assert.ok(said.some((s) => s.includes("Free tiers have limits the provider sets; Synthe stops cleanly when they run out, and a paid key removes them.")));
  assert.ok(asked.includes("Is this key on Google Gemini's free tier? Type y, or n if it's a paid key: "));
  assert.equal(asked.some((q) => q.startsWith("Price of")), false);
  const goal = parseGoal(readFileSync(join(dir, "synthe.json"), "utf8"));
  assert.deepEqual(goal.models, gemini.models);
  assert.deepEqual(goal.provider, { kind: "openai-compatible", base_url: gemini.baseUrl, prices: { "gemini-4-hydrogen": { input: 0, output: 0 } }, max_requests_per_minute: gemini.maxRequestsPerMinute, reasoning_effort: "low" });
  assert.deepEqual(goal.budget, { max_usd: 3, max_calls: FREE_MAX_CALLS });
  assert.ok(said.some((s) => s.includes(`So Synthe stops a run after ${FREE_MAX_CALLS} model calls (budget.max_calls in synthe.json), enough for a few rounds, in case the key turns out to be on a paid plan.`)));
  assert.ok(calls.length > 1 && calls.every((c) => c.base === gemini.baseUrl && c.key === "free-key"));
  assert.deepEqual(ran.filter((r) => r.args[0] === "secret").map((r) => [r.args[2], r.stdin]), [["SYNTHE_API_KEY", "free-key"]]);
  // No free-tier limit is ever stated as a number.
  assert.doesNotMatch(said.join("\n"), /\d+\s*(requests|calls|tokens)\s*(per|a|each)\s*(minute|day|hour)/i);
});

test("a paid key from a preset gives real prices and no cap; Enter keeps the Anthropic path", async () => {
  const dir = setupRepo();
  const groq = PRESETS.find((p) => p.id === "groq")!;
  const answers: Record<string, string> = { "Type a number, or press Enter": "2", "free tier": "n" };
  for (const m of new Set(Object.values(groq.models!))) { answers[`Price of ${m} per million input`] = "0.5"; answers[`Price of ${m} per million output`] = "1"; }
  const paid = setupIo(dir, answers);
  assert.equal(await init(paid.io, dir, undefined, "", {}), true);
  const goal = parseGoal(readFileSync(join(dir, "synthe.json"), "utf8"));
  assert.equal(goal.budget.max_calls, undefined);
  assert.equal(goal.provider?.kind === "openai-compatible" && goal.provider.max_requests_per_minute, undefined);
  assert.deepEqual(goal.models, groq.models);
  // A team that already has a credential in its environment isn't shown the menu.
  const dir2 = setupRepo();
  const own = setupIo(dir2, {});
  own.io.model = () => ({ ask: async () => ({ text: scenarioReply, costUsd: 0.01 }) });
  assert.equal(await init(own.io, dir2, undefined, "", { SYNTHE_ANTHROPIC_KEY: "sk-ant-own" }), true);
  assert.equal(own.asked.some((q) => q.startsWith("Type a number")), false);
  assert.equal(parseGoal(readFileSync(join(dir2, "synthe.json"), "utf8")).provider, undefined);
});

test("agent setup takes --preset and --free, and no free-tier answer is guessed", async () => {
  const dir = setupRepo();
  const { io } = setupIo(dir, {});
  const env = { SYNTHE_API_KEY: "free-key" };
  assert.equal(await init(io, dir, undefined, "", env, agentOptions(["--agent", "--prompt", "prompt.md", "--objective", "Be right", "--mode", "auto", "--preset", "openrouter", "--free"])), true);
  assert.equal(await init(io, dir, undefined, "", env, agentOptions(["--agent", "--confirm", "--keep-checks"])), true);
  const goal = parseGoal(readFileSync(join(dir, "synthe.json"), "utf8"));
  assert.equal(goal.provider?.kind === "openai-compatible" && goal.provider.base_url, PRESETS.find((p) => p.id === "openrouter")!.baseUrl);
  assert.equal(goal.budget.max_calls, FREE_MAX_CALLS);
  const dir2 = setupRepo();
  await assert.rejects(init(setupIo(dir2, {}).io, dir2, undefined, "", env, agentOptions(["--agent", "--prompt", "prompt.md", "--objective", "Be right", "--mode", "auto", "--preset", "groq"])), /--price .* or --free for a free-tier key/);
  assert.throws(() => agentOptions(["--agent", "--prompt", "p", "--objective", "o", "--mode", "auto", "--preset", "nope"]), /--preset \(one of gemini, groq, openrouter\)/);
});

test("key offers the free providers too, rewrites synthe.json here and saves SYNTHE_API_KEY", async () => {
  const dir = setupRepo();
  const anthropicGoal = { version: 1, prompt: { kind: "file", path: "prompt.md" }, objective: "Improve", guardrails: [], scenarios: "s.jsonl", budget: { max_usd: 3 } };
  writeFileSync(join(dir, "synthe.json"), `${JSON.stringify(anthropicGoal, null, 2)}\n`);
  const { io, ran, said, calls } = setupIo(dir, { "Type a number, or press Enter": "2", "free tier": "y" });
  io.run = async (_cmd, args, stdin) => {
    ran.push({ args, stdin });
    if (args.some((a) => a.includes("contents/synthe.json"))) return JSON.stringify(anthropicGoal);
    if (args.some((a) => a.includes("state.json?ref="))) throw new Error("HTTP 404: Not Found");
    return "o/r\n";
  };
  assert.equal(await setKey(io, {}, true, undefined, dir), true);
  const groq = PRESETS.find((p) => p.id === "groq")!;
  const goal = parseGoal(readFileSync(join(dir, "synthe.json"), "utf8"));
  assert.equal(goal.provider?.kind === "openai-compatible" && goal.provider.base_url, groq.baseUrl);
  assert.equal(goal.budget.max_calls, FREE_MAX_CALLS);
  assert.deepEqual(calls, [{ base: groq.baseUrl, key: "free-key", model: groq.models!.runner }]);
  assert.deepEqual(ran.filter((r) => r.args[0] === "secret").map((r) => [r.args[2], r.stdin]), [["SYNTHE_API_KEY", "free-key"]]);
  assert.match(said.at(-1)!, /^Saved synthe\.json with Groq\. Rounds use it once you push it: git commit -m "Synthe: use Groq" synthe\.json && git push$/);
});

test("the Gemini preset sends reasoning_effort, so thinking can't spend a short call's tokens; other goals send none", async () => {
  reset();
  await openAiCompatibleModel({ baseUrl: baseUrl(), apiKey: "k", reasoningEffort: "low" }).ask(ask);
  await openAiCompatibleModel({ baseUrl: baseUrl(), apiKey: "k" }).ask(ask);
  assert.deepEqual(bodies.map((b) => b.reasoning_effort), ["low", undefined]);
  const gemini = PRESETS.find((p) => p.id === "gemini")!;
  assert.equal(gemini.reasoningEffort, "low");
  assert.equal(gemini.signup, "https://aistudio.google.com/app/apikey");
  assert.ok(Object.values(gemini.models!).every((m) => m === "gemini-4-hydrogen"));
  assert.equal(PRESETS.find((p) => p.id === "openrouter")!.models, null, "no hardcoded free model");
  assert.throws(() => parseGoal(other({ budget: { max_usd: 3, max_calls: 5 }, provider: { kind: "openai-compatible", base_url: "https://api.example.com/v1", reasoning_effort: "max" } })), /reasoning_effort must be one of none, minimal, low, medium, high/);
});

// A stand-in for a provider's GET /models, OpenRouter-shaped (pricing as strings) and Gemini-shaped ("models/" ids).
const listing = { status: 200, body: {} as unknown, seen: [] as { url: string; auth?: string }[] };
const models = createServer((req, res) => {
  listing.seen.push({ url: req.url!, auth: req.headers.authorization });
  res.statusCode = listing.status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(listing.body));
});
before(async () => { await new Promise<void>((r) => models.listen(0, "127.0.0.1", r)); });
after(() => { models.close(); });
const modelsUrl = () => `http://127.0.0.1:${(models.address() as { port: number }).port}/api/v1`;
const OPENROUTER_LIST = { data: [
  { id: "vendor/paid-model", pricing: { prompt: "0.000001", completion: "0.000002" } },
  { id: "z-ai/glm-5:free", pricing: { prompt: "0", completion: "0" } },
  { id: "vendor/half-free", pricing: { prompt: "0", completion: "0.000002" } },
  { id: "vendor/other:free", pricing: { prompt: 0, completion: 0 } },
  { id: "vendor/no-pricing" },
] };

test("listModels reads a provider's model list with the key in a header, marks the free ones, and tells a missing route apart", async () => {
  listing.status = 200; listing.body = OPENROUTER_LIST; listing.seen.length = 0;
  const list = await listModels(`${modelsUrl()}/`, "list-key");
  assert.deepEqual(list, { ok: true, models: [
    { id: "vendor/paid-model", free: false }, { id: "z-ai/glm-5:free", free: true }, { id: "vendor/half-free", free: false },
    { id: "vendor/other:free", free: true }, { id: "vendor/no-pricing", free: false },
  ] });
  assert.deepEqual(listing.seen, [{ url: "/api/v1/models", auth: "Bearer list-key" }]);
  listing.body = { object: "list", data: [{ id: "models/gemini-4-hydrogen", object: "model" }] };
  assert.deepEqual(await listModels(modelsUrl(), "k"), { ok: true, models: [{ id: "gemini-4-hydrogen", free: false }] });
  listing.status = 404; listing.body = { error: "not found" };
  assert.deepEqual(await listModels(modelsUrl(), "k"), { ok: false, missing: true, why: "it has no /models route" });
  listing.status = 401;
  assert.deepEqual(await listModels(modelsUrl(), "k"), { ok: false, missing: false, why: "it answered 401" });
  const down = await listModels("http://127.0.0.1:9/v1", "secret-key-123");
  assert.ok(!down.ok && !down.missing && !down.why.includes("secret-key-123"));
});

test("OpenRouter offers only the models its list prices at 0, the first as the default, through the real list call", async () => {
  listing.status = 200; listing.body = OPENROUTER_LIST; listing.seen.length = 0;
  const dir = setupRepo();
  const { io, said, asked, calls } = setupIo(dir, { "Type a number, or press Enter": "3", "free tier": "y" });
  io.listModels = (_base, key) => listModels(modelsUrl(), key);
  assert.equal(await init(io, dir, undefined, "", {}), true);
  assert.ok(said.includes("Free models on OpenRouter (free models) right now: z-ai/glm-5:free, vendor/other:free."));
  assert.ok(asked.includes("Press Enter to use z-ai/glm-5:free for every role, or type another model id: "));
  const goal = parseGoal(readFileSync(join(dir, "synthe.json"), "utf8"));
  assert.deepEqual(goal.models, { writer: "z-ai/glm-5:free", runner: "z-ai/glm-5:free", judge: "z-ai/glm-5:free", checker: "z-ai/glm-5:free" });
  assert.equal(goal.budget.max_calls, FREE_MAX_CALLS);
  assert.deepEqual(listing.seen.map((s) => s.auth), ["Bearer free-key"]);
  assert.ok(calls.every((c) => c.model === "z-ai/glm-5:free"));
  // A typed model must be in the list too.
  const dir2 = setupRepo();
  const typed = setupIo(dir2, { "Type a number, or press Enter": "3", "free tier": "y", "for every role, or type another": "vendor/other:free" });
  typed.io.listModels = (_base, key) => listModels(modelsUrl(), key);
  assert.equal(await init(typed.io, dir2, undefined, "", {}), true);
  assert.equal(parseGoal(readFileSync(join(dir2, "synthe.json"), "utf8")).models.runner, "vendor/other:free");
});

test("when the free list can't be read, OpenRouter asks for a model id; a provider with no /models route warns and goes on", async () => {
  listing.status = 500; listing.body = {};
  const dir = setupRepo();
  const failed = setupIo(dir, { "Type a number, or press Enter": "3", "free tier": "y", "Type the id of the model to use on OpenRouter": "some/model:free" });
  failed.io.listModels = (_base, key) => listModels(modelsUrl(), key);
  assert.equal(await init(failed.io, dir, undefined, "", {}), true);
  assert.ok(failed.said.includes("Synthe couldn't read OpenRouter (free models)'s model list (it answered 500), so it can't check the model names before saving them."));
  assert.equal(parseGoal(readFileSync(join(dir, "synthe.json"), "utf8")).models.runner, "some/model:free");
  listing.status = 404;
  const dir2 = setupRepo();
  const missing = setupIo(dir2, { "Type a number, or press Enter": "1", "free tier": "y" });
  missing.io.listModels = (_base, key) => listModels(modelsUrl(), key);
  assert.equal(await init(missing.io, dir2, undefined, "", {}), true);
  assert.ok(missing.said.some((s) => s.includes("model list (it has no /models route)")));
  assert.equal(parseGoal(readFileSync(join(dir2, "synthe.json"), "utf8")).models.runner, "gemini-4-hydrogen");
});

test("a preset model the provider doesn't list is never saved: setup names it, offers listed ones, and asks again", async () => {
  const gemini = PRESETS.find((p) => p.id === "gemini")!;
  const list = { ok: true as const, models: [{ id: "gemini-3.5-flash-lite", free: false }, { id: "gemini-4-pro", free: false }] };
  const dir = setupRepo();
  const fixed = setupIo(dir, { "Type a number, or press Enter": "1", "free tier": "y", "to use instead of gemini-4-hydrogen": "models/gemini-3.5-flash-lite" });
  fixed.io.listModels = async () => list;
  assert.equal(await init(fixed.io, dir, undefined, "", {}), true);
  assert.ok(fixed.said.includes("gemini-4-hydrogen isn't in Google Gemini's model list, so Synthe won't save it. Some it lists: gemini-3.5-flash-lite, gemini-4-pro."));
  const goal = parseGoal(readFileSync(join(dir, "synthe.json"), "utf8"));
  assert.deepEqual(goal.models, { writer: "gemini-3.5-flash-lite", runner: "gemini-3.5-flash-lite", judge: "gemini-3.5-flash-lite", checker: "gemini-3.5-flash-lite" });
  assert.ok(fixed.calls.every((c) => c.model === "gemini-3.5-flash-lite" && c.base === gemini.baseUrl));
  // Three unlisted answers: setup stops with nothing written and no model call.
  const dir2 = setupRepo();
  const stuck = setupIo(dir2, { "Type a number, or press Enter": "1", "free tier": "y", "to use instead of": "made-up-model" });
  stuck.io.listModels = async () => list;
  assert.equal(await init(stuck.io, dir2, undefined, "", {}), false);
  assert.equal(stuck.asked.filter((q) => q.includes("to use instead of")).length, 3);
  assert.equal(existsSync(join(dir2, "synthe.json")), false);
  assert.equal(stuck.calls.length, 0);
  assert.equal(stuck.ran.some((r) => r.args[0] === "secret"), false);
  // An agent is told which model is missing and what the provider lists, instead of guessing.
  const dir3 = setupRepo();
  const agentIo = setupIo(dir3, {});
  agentIo.io.listModels = async () => list;
  await assert.rejects(init(agentIo.io, dir3, undefined, "", { SYNTHE_API_KEY: "k" }, agentOptions(["--agent", "--prompt", "prompt.md", "--objective", "Be right", "--mode", "auto", "--preset", "gemini", "--free"])),
    /--model \(gemini-4-hydrogen isn't in Google Gemini's model list\. Some it lists: gemini-3\.5-flash-lite, gemini-4-pro\.\) is missing or invalid/);
});
