// P13: `solve` stops on max_rounds, on max_calls, on an empty proposal list, and after 3 rounds in a row that keep
// nothing, and result.json gives the stop reason in plain words.
// How the check decides: four solve runs, each built so that only one stop rule can end it.
// - max_rounds 2, and a proposer that always has a new real gain: exactly 2 rounds run.
// - max_calls 2 with proposer "model": a fake OpenAI-compatible server on 127.0.0.1 answers. Rounds and the
//   3-round rule cannot end the run first, so it must stop after at most 2 model calls.
// - a gain, then an empty list: the proposer is asked twice.
// - gain, loss, loss, gain, loss, loss, loss: the run stops after the 7th round, because "in a row" starts again
//   after each kept change. The proposer still has a gain to offer.
// Each `stopped` must be plain words that fit its rule, and the four reasons must differ.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, describe, test } from "node:test";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { knobFixture, memo, randInt, readLog, readResult, runCli, solve, tag, type Fixture, type Proposal } from "./helpers-a.ts";

const plain = (s: unknown) => {
  assert.equal(typeof s, "string", "result.json has a stopped string");
  assert.match(s as string, /[a-z]{3,}\s+\S+\s+\S+/i, `the stop reason is plain words: ${JSON.stringify(s)}`);
  return s as string;
};

// A proposer that always offers one more real gain, read from the current knob.txt.
const climber = (log: string) => `const fs = require("fs");
let raw = ""; process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), raw }) + "\\n");
  const knob = JSON.parse(raw).files.find((f) => f.path.endsWith("knob.txt")).text;
  const v = Number(knob.match(/level=(\\d+)/)[1]);
  process.stdout.write(JSON.stringify({ proposals: [{ summary: "raise the level to " + (v + 1), edits: [{ path: "knob.txt", search: "level=" + v, replace: "level=" + (v + 1) }] }] }));
});
`;

const servers: { close(): void; closeAllConnections(): void }[] = [];
after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } });

const runs = {
  rounds: memo(async () => {
    const f = knobFixture({ label: "p13-rounds", level: randInt(10, 40), proposerSource: climber, problem: { budget: { max_rounds: 2 } } });
    return { f, r: await solve(f) };
  }),
  calls: memo(async () => {
    const level = randInt(10, 40), t = tag();
    let calls = 0;
    const content = JSON.stringify({ proposals: [{ summary: `raise the level ${t}`, edits: [{ path: "knob.txt", search: `level=${level}`, replace: `level=${level + 5}` }] }] });
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (req.method === "POST" && /chat\/completions/.test(req.url ?? "")) {
          calls++;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            id: `chatcmpl-${t}-${calls}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: "fake-model",
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 50, completion_tokens: 50, total_tokens: 100 },
          }));
        } else { res.writeHead(404); res.end(); }
      });
    });
    servers.push(server);
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as AddressInfo).port;
    const f = knobFixture({
      label: "p13-calls", level,
      problem: { proposer: "model", model: { base_url: `http://127.0.0.1:${port}/v1`, model: "fake-model" }, budget: { max_calls: 2, max_rounds: 6 } },
    });
    const r = await runCli(["solve", f.problemFile, "--out", f.out], {
      cwd: f.repo.dir, home: f.repo.home, env: { SYNTHE_API_KEY: `sk-local-fake-${t}` },
    });
    return { f, r, calls: () => calls };
  }),
  empty: memo(async () => {
    const level = randInt(10, 40), t = tag();
    const G = { summary: `raise the level ${t}`, edits: [{ path: "knob.txt", search: `level=${level}`, replace: `level=${level + 3}` }] };
    const f = knobFixture({ label: "p13-empty", level, proposals: [G] });
    return { f, r: await solve(f) };
  }),
  streak: memo(async () => {
    const level = randInt(10, 40), t = tag();
    const gain = (n: number, from: number, to: number): Proposal => ({ summary: `gain ${n} ${t}`, edits: [{ path: "knob.txt", search: `level=${from}\n`, replace: `level=${to}\n` }] });
    const loss = (n: number): Proposal => ({ summary: `loss ${n} ${t}`, edits: [{ path: "other.txt", search: "penalty=0", replace: `penalty=${n}` }] });
    const list = [gain(1, level, level + 2), loss(1), loss(2), gain(2, level + 2, level + 4), loss(3), loss(4), loss(5), gain(3, level + 4, level + 6)];
    const f = knobFixture({ label: "p13-streak", level, proposals: list });
    return { f, r: await solve(f) };
  }),
};

const stopped = async (k: keyof typeof runs) => {
  const { f, r } = await runs[k]() as { f: Fixture; r: { code: number | null; out: string } };
  assert.equal(r.code, 0, r.out);
  return { f, result: readResult(f.out) };
};

describe("P13 budget and stop rules", { concurrency: true }, () => {
  test("stops on max_rounds", async () => {
    const { f, result } = await stopped("rounds");
    assert.equal(readLog(f.log).length, 2, "the proposer is asked exactly max_rounds times");
    assert.equal(result.attempts.length, 2);
    assert.ok(result.attempts.every((a: any) => a.kept), "every round kept a gain, so no other rule applies");
    assert.match(plain(result.stopped), /round/i, "the reason speaks of rounds");
  });

  test("stops on max_calls", async () => {
    const { result } = await stopped("calls");
    const n = (await runs.calls()).calls();
    assert.ok(n >= 1, "the model proposer called the fake endpoint");
    assert.ok(n <= 2, `at most max_calls model calls (got ${n})`);
    assert.ok(result.attempts.length <= 2);
    assert.match(plain(result.stopped), /call/i, "the reason speaks of model calls");
  });

  test("stops on an empty proposal list", async () => {
    const { f, result } = await stopped("empty");
    assert.equal(readLog(f.log).length, 2, "the proposer is not asked again after an empty list");
    assert.equal(result.attempts.length, 1);
    assert.match(plain(result.stopped), /propos|nothing more/i, "the reason says the proposer had nothing more");
  });

  test("stops after 3 rounds in a row that keep nothing", async () => {
    const { f, result } = await stopped("streak");
    assert.equal(result.attempts.length, 7, `7 rounds: the streak starts again after each kept change\n${JSON.stringify(result.attempts.map((a: any) => [a.summary, a.kept]))}`);
    assert.deepEqual(result.attempts.map((a: any) => a.kept), [true, false, false, true, false, false, false]);
    assert.equal(readLog(f.log).length, 7, "the proposer is not asked an 8th time");
    assert.match(plain(result.stopped), /\b(3|three)\b/i, "the reason gives the 3 rounds");
  });

  test("the four stop reasons differ", async () => {
    const reasons = await Promise.all((["rounds", "calls", "empty", "streak"] as const).map(async (k) => (await stopped(k)).result.stopped));
    assert.equal(new Set(reasons).size, 4, `four different reasons: ${JSON.stringify(reasons)}`);
  });
});
