// S02 checks this statement from swarm/milestones.json: "result.json has cost {calls, input_tokens, output_tokens,
// usd} that matches the calls and the token usage the provider reported, usd is null without model.prices, and
// budget.max_usd stops the run before a call that would pass it, with a plain stop reason."
//
// How the check decides: a fake Messages API on 127.0.0.1 answers each model call and reports random token counts.
// The check adds what the fake reported and compares that with cost in result.json.
// - proposer "model" with model.prices, 6 rounds, one reply malformed: calls and tokens are the fake's totals, and
//   usd is the tokens times the prices. A failed call still counts, because the provider reported its usage.
// - the same with no model.prices: usd is null.
// - an outside proposer and a command measure: every number in cost is 0.
// - an outside proposer and compare "model": cost counts the judge's calls.
// - budget.max_usd: each call has the same cost c, and max_usd is between 6.5 c and 9.5 c. Without the limit the
//   run would make 8 more calls. The run must stop with usd at or below max_usd, after at least one call, and
//   the stop reason must speak of the cost. With a max_usd that the run cannot reach, the round limit ends the
//   run and the reason is a different one.
// - `problem check` refuses budget.max_usd when model.prices is not set, and names the field.
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import {
  assertMessagesOnly, attempt, judgedFixture, knobFixture, memo, near, plainReason, randInt, rankJudge, readResult,
  runCli, startFakeMessages, tag, tail, type FakeCall, type FakeMessages, type FakeReply, type Knob, type Ran, type Usage,
} from "./helpers-s.ts";

const fakes: FakeMessages[] = [];
after(async () => { for (const f of fakes) await f.close(); });
const fake = async (reply: (call: FakeCall) => FakeReply) => { const f = await startFakeMessages(reply); fakes.push(f); return f; };
const key = () => `sk-ant-check-${tag(16)}`;
interface Prices { input_per_mtok: number; output_per_mtok: number }
const usdOf = (u: Usage, p: Prices) => (u.input_tokens * p.input_per_mtok + u.output_tokens * p.output_per_mtok) / 1e6;

// A fake model that always has one more real gain. It decides from the request: step k is the next step when the
// history in the request holds the summaries of steps 1 to k-1. `malformedAt` makes that call's reply not JSON.
function climber(level: number, t: string, usage: () => Usage, malformedAt = 0): (call: FakeCall) => FakeReply {
  const summary = (k: number) => `step ${k} of ${t}: raise the knob`;
  return (call) => {
    if (call.n === malformedAt) return { text: `I think a higher level is better. ${t}`, usage: usage() };
    let k = 1;
    while (call.text.includes(summary(k))) k++;
    return { text: JSON.stringify({ proposals: [{ summary: summary(k), edits: [{ path: "knob.txt", search: `level=${level + k - 1}`, replace: `level=${level + k}` }] }] }), usage: usage() };
  };
}

async function climb(label: string, o: { rounds: number; prices?: Prices; maxUsd?: number; usage: () => Usage; malformedAt?: number }) {
  const t = tag(), level = randInt(10, 40);
  const api = await fake(climber(level, t, o.usage, o.malformedAt));
  const f = knobFixture({
    label, level,
    problem: {
      proposer: "model", model: { provider: "anthropic", model: `claude-check-${t}`, ...(o.prices ? { prices: o.prices } : {}) },
      budget: { max_rounds: o.rounds, ...(o.maxUsd !== undefined ? { max_usd: o.maxUsd } : {}) },
    },
  });
  const r = await runCli(["solve", f.problemFile, "--out", f.out], { cwd: f.repo.dir, home: f.repo.home, env: { SYNTHE_ANTHROPIC_KEY: key(), SYNTHE_ANTHROPIC_BASE_URL: api.url }, timeoutMs: 150_000 });
  return { f, r, api, level };
}

const randomUsage = (): Usage => ({ input_tokens: randInt(500, 5000), output_tokens: randInt(50, 800) });
const randomPrices = (): Prices => ({ input_per_mtok: randInt(10, 90) / 10, output_per_mtok: randInt(100, 300) / 10 });

// For the max_usd runs: every call has the same small usage, and input tokens make almost all of the cost.
const flat = { usage: { input_tokens: randInt(120, 220), output_tokens: randInt(40, 90) }, prices: { input_per_mtok: randInt(30, 60), output_per_mtok: randInt(5, 15) / 100 } };
const callUsd = usdOf(flat.usage, flat.prices);
const fits = randInt(6, 9); // calls that fit in max_usd
const maxUsd = Number(((fits + 0.5) * callUsd).toFixed(9));

const runs = {
  priced: memo(async () => { const prices = randomPrices(); return { prices, ...(await climb("s02-priced", { rounds: 6, prices, usage: randomUsage, malformedAt: 3 })) }; }),
  unpriced: memo(() => climb("s02-unpriced", { rounds: 3, usage: randomUsage })),
  capped: memo(() => climb("s02-capped", { rounds: fits + 8, prices: flat.prices, maxUsd, usage: () => flat.usage })),
  roomy: memo(() => climb("s02-roomy", { rounds: 4, prices: flat.prices, maxUsd: Number((1000 * callUsd).toFixed(6)), usage: () => flat.usage })),
  judged: memo(async () => {
    const t = tag(), prices = randomPrices();
    const [good, bad] = [`wa${tag(5)}`, `wb${tag(5)}`];
    const judge = rankJudge([good, bad]);
    const api = await fake((call) => ({ ...judge(call), usage: randomUsage() }));
    const summary = `use the word ${good} ${t}`;
    const f = judgedFixture({
      label: "s02-judged", word: bad, proposals: [{ summary, edits: [{ path: "style.txt", search: bad, replace: good }] }],
      problem: { model: { provider: "anthropic", model: `claude-check-${t}`, prices } },
    });
    const r = await runCli(["solve", f.problemFile, "--out", f.out], { cwd: f.repo.dir, home: f.repo.home, env: { SYNTHE_ANTHROPIC_KEY: key(), SYNTHE_ANTHROPIC_BASE_URL: api.url }, timeoutMs: 150_000 });
    return { f, r, api, prices, summary };
  }),
  noModel: memo(async () => {
    const t = tag(), level = randInt(10, 40);
    const summary = `raise the knob ${t}`;
    const f = knobFixture({ label: "s02-nomodel", level, proposals: [{ summary, edits: [{ path: "knob.txt", search: `level=${level}`, replace: `level=${level + 2}` }] }] });
    const r = await runCli(["solve", f.problemFile, "--out", f.out], { cwd: f.repo.dir, home: f.repo.home });
    return { f, r, summary };
  }),
};

// result.json of a run that ended normally, with a cost that matches what the fake reported.
function costOf(x: { f: { out: string }; r: Ran; api: FakeMessages }, prices?: Prices) {
  assert.equal(x.r.code, 0, `solve exited ${x.r.code}:\n${tail(x.r.out)}`);
  assertMessagesOnly(x.api);
  const result = readResult(x.f.out, x.r);
  const cost = result.cost;
  assert.ok(cost && typeof cost === "object", `result.json has a cost object: ${JSON.stringify(result).slice(0, 300)}`);
  const total = x.api.total();
  assert.equal(cost.calls, x.api.calls.length, "cost.calls is the number of calls the provider answered");
  assert.equal(cost.input_tokens, total.input_tokens, "cost.input_tokens is the sum the provider reported");
  assert.equal(cost.output_tokens, total.output_tokens, "cost.output_tokens is the sum the provider reported");
  if (prices) near(cost.usd, usdOf(total, prices), "cost.usd is the tokens times model.prices");
  else assert.equal(cost.usd, null, "cost.usd is null when model.prices is not set");
  return { result, cost };
}

describe("S02 cost in result.json and budget.max_usd", { concurrency: true }, () => {
  test("cost matches the calls and the usage that the provider reported, a failed call included", async () => {
    const x = await runs.priced();
    const { result } = costOf(x, x.prices);
    assert.ok(x.api.calls.length >= 6, `6 rounds with a model call in each (got ${x.api.calls.length} calls)`);
    const kept = result.attempts.filter((a: any) => a.kept).length;
    assert.ok(kept >= 5, `each well-formed reply held a real gain, so at least 5 changes are kept (got ${kept})`);
    near(result.final, x.level + kept, "each kept change adds 1, so the final score");
  });

  test("usd is null without model.prices", async () => {
    const x = await runs.unpriced();
    const { cost } = costOf(x);
    assert.ok(cost.calls >= 3, `3 rounds with a model call in each (got ${cost.calls} calls)`);
  });

  test("with no model call, every number in cost is 0", async () => {
    const x = await runs.noModel();
    assert.equal(x.r.code, 0, `solve exited ${x.r.code}:\n${tail(x.r.out)}`);
    const result = readResult(x.f.out, x.r);
    assert.equal(attempt(result, x.summary).kept, true);
    assert.ok(result.cost && typeof result.cost === "object", "result.json has a cost object");
    for (const k of ["calls", "input_tokens", "output_tokens", "usd"]) assert.equal(result.cost[k], 0, `cost.${k} is 0`);
  });

  test("cost counts the calls of compare \"model\"", async () => {
    const x = await runs.judged();
    const { result, cost } = costOf(x, x.prices);
    assert.ok(cost.calls >= 2 * x.f.cases, `each case is asked in both orders (${cost.calls} calls for ${x.f.cases} cases)`);
    assert.equal(attempt(result, x.summary).kept, true, "the judge prefers the better word, so the change is kept");
  });

  test("budget.max_usd stops the run before a call that would pass it", async () => {
    const x = await runs.capped();
    const { result, cost } = costOf(x, flat.prices);
    assert.ok(cost.usd <= maxUsd + 1e-9, `the cost stays at or below max_usd ${maxUsd}: each call cost ${callUsd}, and the run spent ${cost.usd} in ${cost.calls} calls`);
    assert.ok(cost.calls >= 1, `max_usd ${maxUsd} has room for ${fits} calls of ${callUsd}, so the run makes at least one`);
    assert.equal(result.attempts.length, cost.calls, "each model call is one round");
    assert.match(plainReason(result.stopped, "the stop reason"), /\$|usd|dollar|cost|spen[dt]|budget|money/i, "the stop reason speaks of the cost");
  });

  test("a max_usd that the run does not reach changes nothing", async () => {
    const x = await runs.roomy();
    const { result, cost } = costOf(x, flat.prices);
    assert.ok(cost.calls >= 4, `the round limit of 4 ends the run, not the cost (got ${cost.calls} calls)`);
    assert.equal(result.attempts.length, 4, "the run has its 4 rounds");
    assert.match(plainReason(result.stopped, "the stop reason"), /round/i, "the stop reason speaks of rounds");
    assert.notEqual(result.stopped, readResult((await runs.capped()).f.out).stopped, "the cost limit and the round limit give different reasons");
  });

  test("problem check refuses budget.max_usd without model.prices", async () => {
    const check = async (prices: boolean): Promise<{ f: Knob; r: Ran }> => {
      const f = knobFixture({
        label: "s02-check", level: 5,
        problem: { proposer: "model", model: { provider: "anthropic", model: `claude-check-${tag()}`, ...(prices ? { prices: randomPrices() } : {}) }, budget: { max_rounds: 3, max_usd: randInt(1, 9) / 10 } },
      });
      return { f, r: await runCli(["problem", "check", f.problemFile], { cwd: f.repo.dir, home: f.repo.home }) };
    };
    const [bad, good] = await Promise.all([check(false), check(true)]);
    assert.equal(good.r.code, 0, `max_usd with model.prices is valid:\n${tail(good.r.out)}`);
    assert.equal(bad.r.code, 1, `max_usd without model.prices is refused with exit 1:\n${tail(bad.r.out)}`);
    assert.ok(bad.r.out.split("\n").some((l) => l.includes("max_usd")), `one line names budget.max_usd:\n${tail(bad.r.out)}`);
  });
});
