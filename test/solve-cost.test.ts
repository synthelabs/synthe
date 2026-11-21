import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Model } from "../src/model/client.ts";
import { BudgetError, CostMeter } from "../src/solve/cost.ts";
import { validateProblem } from "../src/solve/problem.ts";

// S02: cost in result.json and budget.max_usd. Loopback fakes only, no real model call.

const fake = (usage?: { input: number; output: number }): Model => ({ ask: async () => ({ text: "{}", costUsd: null, stopReason: "stop", ...(usage ? { usage } : {}) }) });
const ask = { model: "m", user: "u", maxTokens: 10 };

test("the meter sums calls and tokens, and prices them per million tokens", async () => {
  const m = new CostMeter({ input_per_mtok: 3, output_per_mtok: 15 }, null);
  const model = m.wrap(fake({ input: 1000, output: 200 }));
  await model.ask(ask);
  await model.ask(ask);
  assert.deepEqual(m.summary(), { calls: 2, input_tokens: 2000, output_tokens: 400, usd: 0.012 });
});

test("usd is null without prices once a call is made, and every number is 0 with no call", async () => {
  const m = new CostMeter(undefined, null);
  assert.deepEqual(m.summary(), { calls: 0, input_tokens: 0, output_tokens: 0, usd: 0 });
  await m.wrap(fake({ input: 5, output: 1 })).ask(ask);
  assert.deepEqual(m.summary(), { calls: 1, input_tokens: 5, output_tokens: 1, usd: null });
});

test("max_usd refuses the call that would pass it, before it is sent", async () => {
  // Each call costs 0.006: 1000 input at 3/M plus 200 output at 15/M.
  const m = new CostMeter({ input_per_mtok: 3, output_per_mtok: 15 }, 0.02);
  let sent = 0;
  const model = m.wrap({ ask: async () => { sent++; return { text: "{}", costUsd: null, stopReason: "stop", usage: { input: 1000, output: 200 } }; } });
  for (let i = 0; i < 3; i++) await model.ask(ask);
  assert.equal(m.stopReason(), "Reached the cost limit: $0.0180 spent, and the next model call could take it above $0.0200.");
  await assert.rejects(model.ask(ask), BudgetError);
  assert.equal(sent, 3);
  assert.equal(m.summary().calls, 3);
});

test("a call that fails after it was sent still counts", async () => {
  const m = new CostMeter(undefined, null);
  await assert.rejects(m.wrap({ ask: async () => { throw new Error("500"); } }).ask(ask));
  assert.equal(m.summary().calls, 1);
});

test("problem check refuses max_usd without model.prices, and accepts it with them", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "synthe-cost-check-")));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const base = { version: 1, name: "c", goal: "g", artifact: ["x"], measure: { command: "echo 1", direction: "higher" } };
  const without = validateProblem({ ...base, budget: { max_usd: 5 }, model: { model: "claude-x" } }, join(dir, "p.json"));
  assert.ok(!without.ok && without.problems.some((l) => /^budget\.max_usd: needs model\.prices/.test(l)), JSON.stringify(without));
  const bad = validateProblem({ ...base, budget: { max_usd: -1 }, model: { model: "claude-x", prices: { input_per_mtok: 3, output_per_mtok: 15 } } }, join(dir, "p.json"));
  assert.ok(!bad.ok && bad.problems.some((l) => /^budget\.max_usd:/.test(l)));
  const ok = validateProblem({ ...base, budget: { max_usd: 5 }, model: { model: "claude-x", prices: { input_per_mtok: 3, output_per_mtok: 15 } } }, join(dir, "p.json"));
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(ok.problem.budget.max_usd, 5);
});

// End to end through the CLI, with a fake OpenAI-compatible server that reports usage.
let served = 0;
const server: Server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    served++;
    const content = JSON.stringify({ proposals: [{ summary: `add line ${served}`, edits: [{ path: "list.txt", search: "end\n", replace: `line${served}\nend\n` }] }] });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 200 } }));
  });
});
let base = "";
before(async () => { await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`; });
after(() => server.close());

async function solveWith(model: Record<string, unknown>, budget: Record<string, unknown>) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "synthe-cost-e2e-")));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
  mkdirSync(join(dir, "measure"));
  writeFileSync(join(dir, "list.txt"), "end\n");
  writeFileSync(join(dir, "measure/count.sh"), "#!/bin/sh\necho \"lines: $(grep -c . list.txt)\"\n");
  writeFileSync(join(dir, "p.json"), JSON.stringify({
    version: 1, name: "cost", goal: "Make the list longer.", artifact: ["list.txt"], protect: ["measure/**"],
    measure: { command: "sh measure/count.sh", direction: "higher", runs: 1 }, proposer: "model",
    model: { base_url: base, model: "fake", ...model }, budget,
  }));
  git("add", "."); git("commit", "-qm", "init");
  const env: NodeJS.ProcessEnv = { ...process.env, SYNTHE_API_KEY: "sk-cost-test" };
  const out = join(dir, ".out");
  served = 0;
  const code = await new Promise<number | null>((done) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, "..", "src", "cli", "main.ts"), "solve", join(dir, "p.json"), "--out", out], { cwd: dir, env, stdio: "ignore" });
    child.on("close", done);
  });
  assert.equal(code, 0);
  return { result: JSON.parse(readFileSync(join(out, "result.json"), "utf8")), report: readFileSync(join(out, "report.md"), "utf8"), served };
}

test("result.json reports the calls and tokens the provider reported, priced with model.prices", async () => {
  const { result, report, served: n } = await solveWith({ prices: { input_per_mtok: 3, output_per_mtok: 15 } }, { max_rounds: 3 });
  assert.equal(n, 3);
  assert.deepEqual(result.cost, { calls: 3, input_tokens: 3000, output_tokens: 600, usd: 0.018 });
  assert.match(report, /Model calls: 3/);
});

test("without model.prices, usd is null", async () => {
  const { result } = await solveWith({}, { max_rounds: 2 });
  assert.deepEqual(result.cost, { calls: 2, input_tokens: 2000, output_tokens: 400, usd: null });
});

test("budget.max_usd stops the run before a call that would pass it, with a plain reason", async () => {
  // 0.006 per call: after 3 calls 0.018 is spent, and a 4th could reach 0.024, above 0.02.
  const { result, served: n } = await solveWith({ prices: { input_per_mtok: 3, output_per_mtok: 15 } }, { max_rounds: 6, max_usd: 0.02 });
  assert.equal(n, 3);
  assert.equal(result.cost.calls, 3);
  assert.ok(result.cost.usd <= 0.02);
  assert.match(result.stopped, /cost limit/);
});
