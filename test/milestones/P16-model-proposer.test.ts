// P16 checks this statement from swarm/milestones.json: "With proposer \"model\" and an OpenAI-compatible provider,
// Synthe builds the proposer request from the same stdin object, parses the reply into proposals, and turns a
// malformed reply into a failed attempt with a reason."
//
// How it decides: a fake chat completions server listens on loopback, and the problem file's model.base_url points to
// it. SYNTHE_API_KEY holds a fake key. Run A: the first reply holds { "proposals": [...] }, the same object an outside
// proposer prints; later replies hold an empty list. Every request must be a POST to <base_url>/chat/completions with
// the key as a bearer token. Its text must hold the goal and the artifact's text, and the second request must hold
// the first attempt's summary (the history). The proposal must be kept. Run B: every reply is text that is not JSON.
// solve must still exit 0 with a failed attempt that has a reason. In both runs the key must appear in no request
// body, no output, and no file that Synthe wrote: the repository (with its git history), the out folder and home.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { attemptsOf, git, gitRepo, isolatedEnv, readJson, synthe, tail, tempDir, walkFiles } from "./helpers-c.ts";

interface Seen { method: string; url: string; auth: string; body: string }

async function fakeProvider(reply: (n: number) => string) {
  const seen: Seen[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method ?? "", url: req.url ?? "", auth: String(req.headers.authorization ?? ""), body });
    const content = reply(seen.length);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: `chatcmpl-${seen.length}`, object: "chat.completion", created: 1700000000, model: "fake",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  return { seen, port, close: () => new Promise<void>((done) => server.close(() => done())) };
}

// The text a model sees: every string in the request body, joined.
function textOf(body: string): string {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") Object.values(v).forEach(visit);
  };
  try { visit(JSON.parse(body)); } catch { out.push(body); }
  return out.join("\n");
}

function setup(port: number, tag: string, rounds: number) {
  const work = tempDir(`p16-${tag}`);
  const repo = join(work, "repo");
  const goalWord = `goal-${randomBytes(4).toString("hex")}`;
  const artifactWord = `line-${randomBytes(4).toString("hex")}`;
  const problem = {
    version: 1, name: `model-${tag}`,
    goal: `Raise the number of lines in notes.txt that start with ok (${goalWord}).`,
    artifact: ["notes.txt"], protect: ["count.cjs"],
    measure: { command: "node count.cjs", direction: "higher", unit: "lines", runs: 1 },
    proposer: "model",
    model: { base_url: `http://127.0.0.1:${port}/v1`, model: `fake-model-${tag}` },
    budget: { max_rounds: rounds, max_calls: 8 },
  };
  gitRepo(repo, {
    "problem.json": JSON.stringify(problem, null, 2) + "\n",
    "notes.txt": `ok first\n${artifactWord}\nthird\n`,
    "count.cjs": "const fs = require(\"fs\");\nconst lines = fs.readFileSync(__dirname + \"/notes.txt\", \"utf8\").split(\"\\n\");\nconsole.log(lines.filter((l) => l.startsWith(\"ok\")).length);\n",
  });
  return { work, repo, out: join(work, "out"), home: join(work, "home"), goalWord, artifactWord };
}

function assertNoKey(key: string, where: { work: string; repo: string; outputs: string; seen: Seen[] }) {
  assert.ok(!where.outputs.includes(key), "the key appears in Synthe's output");
  for (const s of where.seen) assert.ok(!s.body.includes(key), "the key appears in a request body; it may go only in the authorization header");
  for (const f of walkFiles(where.work)) {
    assert.ok(!readFileSync(f).includes(key), `the key appears in a written file: ${f}`);
  }
  const history = git(where.repo, "log", "--all", "-p", "--format=%B");
  assert.ok(!history.includes(key), "the key appears in the repository's git history");
}

test("P16: a well-formed model reply becomes a kept proposal, and the request carries the stdin object", { timeout: 60_000 }, async () => {
  const key = `sk-fake-${randomBytes(12).toString("hex")}`;
  const summary = `mark line two as ok ${randomBytes(3).toString("hex")}`;
  let artifactWord = "";
  const provider = await fakeProvider((n) => JSON.stringify(n === 1
    ? { proposals: [{ summary, edits: [{ path: "notes.txt", search: artifactWord, replace: `ok ${artifactWord}` }] }] }
    : { proposals: [] }));
  try {
    const s = setup(provider.port, "a", 3);
    artifactWord = s.artifactWord;
    const r = await synthe(["solve", join(s.repo, "problem.json"), "--out", s.out], { cwd: s.repo, env: isolatedEnv(s.home, { SYNTHE_API_KEY: key }), timeoutMs: 50_000 });
    const output = r.stdout + r.stderr;
    assert.equal(r.code, 0, `solve exited ${r.code}:\n${tail(output)}`);
    assert.ok(provider.seen.length >= 1, "Synthe sent no request to the model's base_url");
    for (const q of provider.seen) {
      assert.equal(q.method, "POST", "a request to the provider is not a POST");
      assert.equal(q.url, "/v1/chat/completions", `a request went to ${q.url}, not to <base_url>/chat/completions`);
      assert.equal(q.auth, `Bearer ${key}`, "a request does not carry SYNTHE_API_KEY as its bearer token");
    }
    const first = textOf(provider.seen[0].body);
    assert.ok(first.includes(s.goalWord), "the request does not hold the problem's goal");
    assert.ok(first.includes(s.artifactWord) && first.includes("ok first"), "the request does not hold the artifact's text");
    assert.ok(provider.seen.length >= 2, "after a kept change Synthe must ask the model again; it stopped after one request");
    assert.ok(textOf(provider.seen[1].body).includes(summary), "the second request does not hold the history with the first attempt's summary");

    const attempts = attemptsOf(readJson(join(s.out, "result.json")));
    assert.ok(Array.isArray(attempts), `no attempts: ${attempts}\n${tail(output)}`);
    const a = attempts.find((x) => x.summary === summary);
    assert.ok(a, `result.json has no attempt with the model's summary: ${JSON.stringify(attempts)}`);
    assert.equal(a.kept, true, `the model's proposal raised the count but was not kept: ${JSON.stringify(a)}`);
    assertNoKey(key, { work: s.work, repo: s.repo, outputs: output, seen: provider.seen });
  } finally {
    await provider.close();
  }
});

test("P16: a malformed model reply becomes a failed attempt with a reason, not a crash", { timeout: 60_000 }, async () => {
  const key = `sk-fake-${randomBytes(12).toString("hex")}`;
  const provider = await fakeProvider(() => "Sure! I would add a line that starts with ok, and maybe tidy the rest.");
  try {
    const s = setup(provider.port, "b", 2);
    const r = await synthe(["solve", join(s.repo, "problem.json"), "--out", s.out], { cwd: s.repo, env: isolatedEnv(s.home, { SYNTHE_API_KEY: key }), timeoutMs: 50_000 });
    const output = r.stdout + r.stderr;
    assert.equal(r.code, 0, `solve must end normally after a malformed reply; it exited ${r.code}:\n${tail(output)}`);
    assert.ok(provider.seen.length >= 1, "Synthe sent no request to the model's base_url");
    const attempts = attemptsOf(readJson(join(s.out, "result.json")));
    assert.ok(Array.isArray(attempts), `no attempts: ${attempts}\n${tail(output)}`);
    assert.ok(attempts.every((x) => x.kept !== true), "an attempt was kept from a reply that holds no proposals");
    const failed = attempts.find((x) => x.kept === false && typeof x.reason === "string" && x.reason.trim().length > 0);
    assert.ok(failed, `result.json has no failed attempt with a reason for the malformed reply: ${JSON.stringify(attempts)}`);
    assertNoKey(key, { work: s.work, repo: s.repo, outputs: output, seen: provider.seen });
  } finally {
    await provider.close();
  }
});
