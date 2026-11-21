// S04 checks this statement from swarm/milestones.json: "`measure draft` writes cases.jsonl, rubric.md and compare.js
// from good/bad examples, checks the judge both ways round against the person's labels, prints the agreement, and
// exits 2 with the disagreeing examples named when agreement is below 80%."
//
// How the check decides: 10 random examples go to `measure draft --examples <file> --out <dir>`. A fake Messages API
// on 127.0.0.1 plays the model. A request that does not hold the rubric gets a rubric with a random token. A request
// that holds the rubric token is a question to the judge: the fake finds the example by its good and bad texts, and
// takes the text that the request names "a" to come before the text it names "b". For some examples, picked at
// random, the fake prefers the bad text in both orders. For the others it prefers the good text in both orders.
// - 1 of 10 against the person (`--model <id>`): exit 0. The output has `agreement 9/10` (or 18/20, when each
//   question counts). cases.jsonl has one case for each example. rubric.md holds the model's rubric. Each example
//   is asked in both orders. compare.js, run as a compare command, answers a new question with the model's verdict,
//   and its request holds the rubric.
// - 2 of 10 against (`--problem <file>`): 80% is not below 80%, so exit 0.
// - 3 of 10 against (`--problem <file>`): exit 2. The output has the agreement and names each of the 3 examples:
//   by its case id, by its input, or by its line number. The three files stay.
// - a judge that names "a" in each question, whatever a is (`--model <id>`): it follows the position, so it agrees
//   with the person in one order only. That is 0/10 (or 10/20), and exit 2.
// The key must be in no output and in no file that the command wrote.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  assertMessagesOnly, assertNoKey, firstOf, freeText, knobFixture, memo, runCli, sample, start, startFakeMessages, tag, tail,
  tempDir, verdictText, type FakeMessages,
} from "./helpers-s.ts";

const N = 10;
const fakes: FakeMessages[] = [];
after(async () => { for (const f of fakes) await f.close(); });

const count = (text: string, part: string) => text.split(part).length - 1;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function draft(label: string, against: number, modelFrom: "--model" | "--problem", alwaysA = false) {
  const t = tag(), key = `sk-ant-check-${tag(16)}`, model = `claude-check-${t}`;
  const work = tempDir(label), home = join(work, "home"), out = join(work, "drafted");
  const examples = Array.from({ length: N }, () => ({ input: `question ${tag(4)}`, good: `a reply with ${tag(5)}`, bad: `a reply with ${tag(5)}` }));
  const wrong = new Set(sample(examples.map((_, i) => i), against)); // the examples where the judge is against the person
  const token = `rubric-${tag(6)}`;
  const rubric = `# Rubric ${token}\n\nPrefer the reply that answers the question (${token}).\n`;
  const orders = examples.map(() => new Set<string>());
  const questions: number[] = []; // the example of each question to the judge, in order
  const api = await startFakeMessages((call) => {
    if (!call.text.includes(token)) return { text: freeText(call, rubric) };
    // The example of this question: the one whose good and bad texts occur most in the request.
    const hits = examples.map((e) => (call.text.includes(e.good) && call.text.includes(e.bad) ? count(call.text, e.good) + count(call.text, e.bad) : 0));
    const i = hits.indexOf(Math.max(...hits));
    if (hits[i] === 0) return { text: verdictText(call, "tie") };
    const goodIsA = firstOf(call.text, examples[i].good, examples[i].bad) === "x";
    orders[i].add(goodIsA ? "good first" : "bad first");
    questions.push(i);
    return { text: verdictText(call, alwaysA || goodIsA !== wrong.has(i) ? "a" : "b") };
  }, { key });
  fakes.push(api);
  const file = join(work, "examples.jsonl");
  writeFileSync(file, examples.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const env = { SYNTHE_ANTHROPIC_KEY: key, SYNTHE_ANTHROPIC_BASE_URL: api.url };
  let from: string[], cwd = work;
  if (modelFrom === "--model") from = ["--model", model];
  else {
    const f = knobFixture({ label: `${label}-problem`, level: 5, problem: { proposer: "model", model: { provider: "anthropic", model } } });
    from = ["--problem", join(f.repo.dir, f.problemFile)];
    cwd = f.repo.dir;
  }
  const r = await runCli(["measure", "draft", "--examples", file, "--out", out, ...from], { cwd, home, env, timeoutMs: 150_000 });
  return { r, api, key, work, home, out, env, examples, wrong, token, orders, questions, model };
}

const runs = {
  agree: memo(() => draft("s04-agree", 1, "--model")),
  edge: memo(() => draft("s04-edge", 2, "--problem")),
  disagree: memo(() => draft("s04-disagree", 3, "--problem")),
  biased: memo(() => draft("s04-biased", N, "--model", true)),
};
type Draft = Awaited<ReturnType<typeof draft>>;

// The cases that the command wrote, one for each example and in the order of the examples.
function casesOf(x: Draft): { id: string; input: unknown }[] {
  const path = join(x.out, "cases.jsonl");
  assert.ok(existsSync(path), `measure draft wrote no cases.jsonl:\n${tail(x.r.out)}`);
  const cases = readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  assert.equal(cases.length, N, "cases.jsonl has one case for each example");
  for (const c of cases) assert.ok(c.id !== undefined && c.id !== null && String(c.id) !== "", `each case has an id: ${JSON.stringify(c)}`);
  assert.equal(new Set(cases.map((c) => String(c.id))).size, N, "the case ids are all different");
  return x.examples.map((e) => {
    const c = cases.find((k) => k.input === e.input);
    assert.ok(c, `cases.jsonl has a case with the input ${JSON.stringify(e.input)}`);
    return { id: String(c.id), input: c.input };
  });
}

// What every run must show: the three files, the rubric from the model, both orders, the agreement, no key.
function common(x: Draft, exit: number) {
  assert.equal(x.r.code, exit, `measure draft with ${x.wrong.size} of ${N} examples against the person exits ${exit}; it exited ${x.r.code}:\n${tail(x.r.out)}`);
  assertMessagesOnly(x.api);
  const cases = casesOf(x);
  for (const f of ["rubric.md", "compare.js"]) assert.ok(existsSync(join(x.out, f)), `measure draft wrote ${f}`);
  assert.ok(readFileSync(join(x.out, "rubric.md"), "utf8").includes(x.token), "rubric.md holds the rubric that the model gave");
  x.orders.forEach((o, i) => assert.equal(o.size, 2, `example ${i + 1} is asked both ways round (got: ${[...o].join(", ") || "no question"})`));
  const said = x.r.out.match(/agreement\D{0,20}?(\d+)\s*\/\s*(\d+)/i);
  assert.ok(said, `the output has the agreement as a fraction, such as "agreement 9/10":\n${tail(x.r.out)}`);
  const [num, den] = [Number(said[1]), Number(said[2])];
  assert.ok(den === N || den === 2 * N, `the agreement is out of ${N} examples (or ${2 * N} questions): ${said[0]}`);
  assert.equal(num, (N - x.wrong.size) * (den / N), `the judge agrees with the person on ${N - x.wrong.size} of ${N} examples: ${said[0]}`);
  assertNoKey(x.key, { outputs: [x.r.stdout, x.r.stderr], fake: x.api, dirs: [x.work] });
  return { cases, fraction: said[0] };
}

describe("S04 measure draft", { concurrency: true }, () => {
  test("a judge that follows the position does not agree with the person", async () => {
    // `wrong` holds each example, so the agreement must be 0 of 10 examples. When each question counts, the judge
    // is right in one order of each example: 10 of 20.
    const x = await runs.biased();
    assert.equal(x.r.code, 2, `a judge that names "a" each time agrees in one order only, so measure draft exits 2; it exited ${x.r.code}:\n${tail(x.r.out)}`);
    const said = x.r.out.match(/agreement\D{0,20}?(\d+)\s*\/\s*(\d+)/i);
    assert.ok(said, `the output has the agreement as a fraction:\n${tail(x.r.out)}`);
    assert.ok(`${said[1]}/${said[2]}` === `0/${N}` || `${said[1]}/${said[2]}` === `${N}/${2 * N}`, `the agreement is 0/${N} (or ${N}/${2 * N}, when each question counts): ${said[0]}`);
    assertMessagesOnly(x.api);
  });

  test("writes the three files, asks both ways round and prints the agreement", async () => {
    common(await runs.agree(), 0);
  });

  test("compare.js is a compare command that asks the model with the rubric", async () => {
    const x = await runs.agree();
    const { cases } = common(x, 0);
    const i = x.examples.findIndex((_, k) => !x.wrong.has(k));
    const ask = async (a: string, b: string) => {
      const n = x.api.calls.length;
      const r = await start(process.execPath, ["compare.js"], { cwd: x.out, home: x.home, env: x.env, input: JSON.stringify({ case: cases[i], a, b }) + "\n" }).done;
      assert.equal(r.code, 0, `node compare.js exited ${r.code}:\n${tail(r.out)}`);
      assert.ok(x.api.calls.length > n, "compare.js asked the model");
      assert.ok(x.api.calls.slice(n).every((c) => c.text.includes(x.token)), "the request of compare.js holds the rubric");
      assert.ok(x.api.calls.slice(n).every((c) => c.body.model === x.model), "the request of compare.js names the model");
      assert.ok(!r.out.includes(x.key), "the key is in the output of compare.js");
      const lines = r.stdout.trim().split("\n");
      return JSON.parse(lines[lines.length - 1]).winner;
    };
    const { good, bad } = x.examples[i];
    assert.equal(await ask(good, bad), "a", "the model prefers the good reply, which is a");
    assert.equal(await ask(bad, good), "b", "the model prefers the good reply, which is b");
    assertMessagesOnly(x.api);
  });

  test("agreement of exactly 80% is not below 80%", async () => {
    common(await runs.edge(), 0);
  });

  test("below 80% it exits 2, names the examples where the judge disagreed, and the files stay", async () => {
    const x = await runs.disagree();
    const { cases, fraction } = common(x, 2);
    const rest = x.r.out.replace(fraction, "");
    for (const i of x.wrong) {
      const named = new RegExp(`(^|[^A-Za-z0-9])${escape(cases[i].id)}([^A-Za-z0-9]|$)`, "m").test(rest)
        || rest.includes(x.examples[i].input)
        || new RegExp(`\\b(example|line|case)\\s*#?${i + 1}\\b`, "i").test(rest);
      assert.ok(named, `the output names example ${i + 1} (case id ${cases[i].id}, input ${JSON.stringify(x.examples[i].input)}), where the judge disagreed:\n${tail(x.r.out)}`);
    }
  });
});
