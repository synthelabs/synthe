// S01 checks this statement from swarm/milestones.json: "With model.provider \"anthropic\", the model proposer and
// compare \"model\" send Messages API requests to SYNTHE_ANTHROPIC_BASE_URL with the key from SYNTHE_ANTHROPIC_KEY
// (or an sk-ant- SYNTHE_API_KEY), parse the replies into proposals and verdicts, turn a malformed reply into a
// failed attempt with a reason, and never show the key."
//
// How the check decides: a fake Messages API listens on 127.0.0.1, and SYNTHE_ANTHROPIC_BASE_URL points to it. Like
// the real API, the fake refuses a request that is not a POST to /v1/messages with the key (in x-api-key, or as a
// bearer token in authorization), an anthropic-version header, and a body with model, max_tokens and messages.
// Five solve runs:
// - proposer, key in SYNTHE_ANTHROPIC_KEY: the reply holds { "proposals": [...] }, the object an outside proposer
//   prints. The request must hold the goal and the artifact's text, and the proposal must be kept.
// - proposer, no model.provider, key in SYNTHE_API_KEY with the sk-ant- prefix: the default provider is "anthropic".
// - proposer, a reply that is not JSON: solve exits 0 with a failed attempt that has a reason.
// - compare "model": the fake judge ranks three random words. A change to a worse word is refused and a change to a
//   better word is kept. The judge takes the output named "a" to come before the output named "b" in the request.
// - compare "model", a reply that is not a verdict: nothing is kept and the attempt has a reason.
// In every run the key must be in no output, in no request outside the key headers, in no file that Synthe or
// a problem command wrote (the measure, run and proposer commands store their environment), and in no commit.
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import {
  assertMessagesOnly, assertNoKey, attempt, judgedFixture, knobFixture, memo, plainReason, randInt, rankJudge, readResult,
  runCli, showFile, startFakeMessages, tag, tail, tempDir, type FakeCall, type FakeMessages, type FakeReply, type Proposal,
} from "./helpers-s.ts";

const fakes: FakeMessages[] = [];
after(async () => { for (const f of fakes) await f.close(); });
const fake = async (reply: (call: FakeCall) => FakeReply, key: string) => { const f = await startFakeMessages(reply, { key }); fakes.push(f); return f; };
const newKey = () => `sk-ant-check-${tag(16)}`;

// Source for a problem command: it stores its environment in `side`, where the key check reads every file.
const storeEnv = (side: string) => `require("fs").writeFileSync(${JSON.stringify(side)} + "/env-" + process.pid + ".json", JSON.stringify(process.env));`;

// One solve run with the model proposer. `reply` gets the gain the model must propose.
async function proposerRun(label: string, o: { provider: boolean; keyIn: "SYNTHE_ANTHROPIC_KEY" | "SYNTHE_API_KEY"; malformed?: boolean }) {
  const key = newKey(), t = tag(), side = tempDir(`${label}-side`);
  const level = randInt(10, 40), step = randInt(2, 9);
  const summary = `raise the knob by ${step} ${t}`, model = `claude-check-${t}`, goalWord = `goal-${tag(4)}`;
  const gain: Proposal = { summary, edits: [{ path: "knob.txt", search: `level=${level}`, replace: `level=${level + step}` }] };
  const api = await fake((call) => ({
    text: o.malformed ? `Sure! I would raise the level a little, and maybe tidy the notes. ${t}`
      // The history in a later request holds the summary: then the model has nothing more.
      : JSON.stringify({ proposals: call.text.includes(summary) ? [] : [gain] }),
  }), key);
  const f = knobFixture({
    label, level, measureExtra: storeEnv(side),
    problem: {
      goal: `Raise the score (${goalWord}).`, proposer: "model",
      model: { ...(o.provider ? { provider: "anthropic" } : {}), model },
      budget: { max_rounds: o.malformed ? 2 : 3, max_calls: 8 },
    },
  });
  const r = await runCli(["solve", f.problemFile, "--out", f.out], { cwd: f.repo.dir, home: f.repo.home, env: { [o.keyIn]: key, SYNTHE_ANTHROPIC_BASE_URL: api.url } });
  return { f, r, api, key, side, level, step, summary, model, goalWord, t };
}

// One solve run with a judged measure and compare "model". The words go from best to worst; style.txt starts with
// the middle one.
async function judgeRun(label: string, malformed: boolean) {
  const key = newKey(), t = tag(), side = tempDir(`${label}-side`);
  const [best, mid, worst] = [`wa${tag(5)}`, `wb${tag(5)}`, `wc${tag(5)}`];
  const worse: Proposal = { summary: `use the word ${worst} ${t}`, edits: [{ path: "style.txt", search: mid, replace: worst }] };
  const better: Proposal = { summary: `use the word ${best} ${t}`, edits: [{ path: "style.txt", search: mid, replace: best }] };
  const judge = rankJudge([best, mid, worst]);
  const api = await fake((call) => (malformed ? { text: `Both replies look fine to me. ${t}` } : judge(call)), key);
  const f = judgedFixture({
    label, word: mid, proposals: malformed ? [better] : [worse, better], runExtra: storeEnv(side),
    problem: { model: { provider: "anthropic", model: `claude-check-${t}` }, budget: { max_rounds: 2 } },
  });
  const r = await runCli(["solve", f.problemFile, "--out", f.out], { cwd: f.repo.dir, home: f.repo.home, env: { SYNTHE_ANTHROPIC_KEY: key, SYNTHE_ANTHROPIC_BASE_URL: api.url }, timeoutMs: 150_000 });
  return { f, r, api, key, side, best, mid, worst, worse, better };
}

const runs = {
  proposer: memo(() => proposerRun("s01-proposer", { provider: true, keyIn: "SYNTHE_ANTHROPIC_KEY" })),
  apiKey: memo(() => proposerRun("s01-apikey", { provider: false, keyIn: "SYNTHE_API_KEY" })),
  malformed: memo(() => proposerRun("s01-malformed", { provider: true, keyIn: "SYNTHE_ANTHROPIC_KEY", malformed: true })),
  judge: memo(() => judgeRun("s01-judge", false)),
  badJudge: memo(() => judgeRun("s01-badjudge", true)),
};

type Run = Awaited<ReturnType<typeof proposerRun>> | Awaited<ReturnType<typeof judgeRun>>;
function common(x: Run) {
  assert.equal(x.r.code, 0, `solve exited ${x.r.code}:\n${tail(x.r.out)}`);
  assert.ok(x.api.calls.length + x.api.refused.length >= 1, `Synthe sent no request to SYNTHE_ANTHROPIC_BASE_URL:\n${tail(x.r.out)}`);
  assertMessagesOnly(x.api);
  assertNoKey(x.key, { outputs: [x.r.stdout, x.r.stderr], fake: x.api, dirs: [x.f.repo.base, x.side], repo: x.f.repo.dir });
  return readResult(x.f.out, x.r);
}

describe("S01 Anthropic proposer and judge", { concurrency: true }, () => {
  test("the model proposer asks the Messages API with SYNTHE_ANTHROPIC_KEY, and its proposal is kept", async () => {
    const x = await runs.proposer();
    const result = common(x);
    const first = x.api.calls[0];
    assert.equal(first.body.model, x.model, "the request names model.model");
    assert.ok(first.text.includes(x.goalWord), "the request holds the problem's goal");
    assert.ok(first.text.includes(`level=${x.level}`) && first.text.includes(`notes ${x.f.name.split("-").pop()}`), "the request holds the artifact's text");
    const a = attempt(result, x.summary);
    assert.equal(a.kept, true, `the model's proposal raises the score, so it is kept: ${JSON.stringify(a)}`);
    assert.match(showFile(x.f.repo.dir, result.branch, "knob.txt"), new RegExp(`^level=${x.level + x.step}$`, "m"), "the branch holds the model's edit");
    assert.ok(x.api.calls.length >= 2, "after a kept change Synthe asks the model again");
  });

  test("with no model.provider and no base_url, an sk-ant- SYNTHE_API_KEY goes to the Messages API", async () => {
    const x = await runs.apiKey();
    const result = common(x);
    assert.equal(attempt(result, x.summary).kept, true, "the model's proposal is kept");
  });

  test("a model reply that is not JSON becomes a failed attempt with a reason", async () => {
    const x = await runs.malformed();
    const result = common(x);
    assert.ok(x.api.calls.length >= 1, "Synthe asked the model");
    assert.ok(result.attempts.length >= 1, "the malformed reply is an attempt in result.json");
    for (const a of result.attempts) {
      assert.equal(a.kept, false, "nothing is kept from a reply that holds no proposal");
      plainReason(a.reason, "the reason of the failed attempt");
    }
    assert.equal(result.branch ?? null, null, "a run that kept nothing names no branch");
  });

  test("compare \"model\" asks the Messages API, and its verdicts decide what is kept", async () => {
    const x = await runs.judge();
    const result = common(x);
    assert.ok(x.api.calls.length >= 2 * x.f.cases, `each case is asked in both orders (${x.api.calls.length} calls for ${x.f.cases} cases)`);
    const lost = attempt(result, x.worse.summary), won = attempt(result, x.better.summary);
    assert.equal(lost.kept, false, `the judge prefers the kept word in each case, so the worse word is refused: ${JSON.stringify(lost)}`);
    plainReason(lost.reason, "the reason of the refused change");
    assert.equal(won.kept, true, `the judge prefers the better word in each case and in both orders, so it is kept: ${JSON.stringify(won)}`);
    assert.equal(showFile(x.f.repo.dir, result.branch, "style.txt").trim(), x.best, "the branch holds the better word");
  });

  test("a judge reply that is not a verdict becomes a failed attempt with a reason", async () => {
    const x = await runs.badJudge();
    const result = common(x);
    assert.ok(x.api.calls.length >= 1, "Synthe asked the model judge");
    const a = attempt(result, x.better.summary);
    assert.equal(a.kept, false, "a change is not kept without a verdict");
    plainReason(a.reason, "the reason of the failed attempt");
  });
});
