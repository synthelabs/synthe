import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { buildUser, modelProposer, parseProposals, type ProposerInput } from "../src/solve/model-proposer.ts";

// A loopback fake of an OpenAI-compatible chat completions server. No real model call.
interface Seen { url: string; headers: IncomingHttpHeaders; body: any }
let seen: Seen[] = [];
let answer: () => { status: number; body: unknown } = () => ({ status: 200, body: {} });
const server: Server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    seen.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(raw) });
    const a = answer();
    res.writeHead(a.status, { "content-type": "application/json" });
    res.end(JSON.stringify(a.body));
  });
});
let base = "";
before(async () => { await new Promise<void>((r) => server.listen(0, "127.0.0.1", r)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`; });
after(() => server.close());

const KEY = "sk-test-secret-123";
const reply = (content: string, finish = "stop") => () => ({ status: 200, body: { choices: [{ message: { content }, finish_reason: finish }] } });
const input: ProposerInput = {
  round: 2,
  goal: "Raise the score.",
  files: [{ path: "config.json", text: '{"rate": 1}' }],
  history: [{ round: 1, summary: "rate 0", kept: false, reason: "score fell" }],
  candidates: 1,
};
const make = () => modelProposer({ model: { base_url: base, model: "fake-1" }, env: { SYNTHE_API_KEY: KEY } });

test("the request carries the whole stdin object, the model id and the key, and only to base_url", async () => {
  seen = [];
  answer = reply(JSON.stringify({ proposals: [{ summary: "rate 2", edits: [{ path: "config.json", search: '"rate": 1', replace: '"rate": 2' }] }] }));
  const p = make();
  const r = await p.propose(input);
  assert.deepEqual(r, { ok: true, proposals: [{ summary: "rate 2", edits: [{ path: "config.json", search: '"rate": 1', replace: '"rate": 2' }] }] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "/v1/chat/completions");
  assert.equal(seen[0].headers.authorization, `Bearer ${KEY}`);
  assert.equal(seen[0].body.model, "fake-1");
  const user = seen[0].body.messages.find((m: any) => m.role === "user").content as string;
  assert.ok(user.includes(JSON.stringify(input, null, 2)), "the user message holds the stdin object");
  assert.equal(p.calls, 1);
});

test("an empty proposals list passes through: it means nothing more to try", async () => {
  answer = reply('{"proposals": []}');
  assert.deepEqual(await make().propose(input), { ok: true, proposals: [] });
});

test("a fenced or wrapped JSON reply is still read", async () => {
  answer = reply('Here you go:\n```json\n{"proposals": [{"summary": "s", "edits": [{"path": "a", "search": "x", "replace": "y"}]}]}\n```');
  const r = await make().propose(input);
  assert.ok(r.ok && r.proposals.length === 1);
});

test("malformed replies become failed attempts with a plain reason, not a crash", async () => {
  const cases: [string, RegExp][] = [
    ["I think you should raise the rate.", /not valid JSON/],
    ['{"ideas": []}', /no "proposals" list/],
    ['{"proposals": [{"edits": []}]}', /no "summary"/],
    ['{"proposals": [{"summary": "s", "edits": []}]}', /no "edits"/],
    ['{"proposals": [{"summary": "s", "edits": [{"path": "a", "search": 1}]}]}', /"path", "search" and "replace"/],
  ];
  for (const [content, why] of cases) {
    answer = reply(content);
    const r = await make().propose(input);
    assert.equal(r.ok, false, content);
    assert.match((r as { reason: string }).reason, why);
  }
});

test("a cut-off reply or a refused request is a failed attempt, and the key never shows in the reason", async () => {
  answer = reply('{"proposals": [', "length");
  const cut = await make().propose(input);
  assert.ok(!cut.ok && /cut off/.test(cut.reason));
  answer = () => ({ status: 401, body: { error: { message: `bad key ${KEY}` } } });
  const refused = await make().propose(input);
  assert.ok(!refused.ok);
  assert.match(refused.reason, /401/);
  assert.ok(!refused.reason.includes(KEY));
});

test("setup problems throw before any call", () => {
  assert.throws(() => modelProposer({ model: { base_url: base, model: "m" }, env: {} }), /SYNTHE_API_KEY/);
  assert.throws(() => modelProposer({ model: { base_url: "", model: "m" }, env: { SYNTHE_API_KEY: KEY } }), /base_url/);
  assert.throws(() => modelProposer({ model: { base_url: base, model: "" }, env: { SYNTHE_API_KEY: KEY } }), /model\.model/);
});

test("buildUser asks for several distinct ideas when candidates is more than 1", () => {
  assert.match(buildUser({ ...input, candidates: 3 }), /up to 3 proposals/);
  assert.match(buildUser(input), /1 proposal/);
  assert.ok(parseProposals('{"proposals": []}').ok);
});
