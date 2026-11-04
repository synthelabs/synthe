import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

// Runs the real bundled action as separate processes, as GitHub would, against stand-ins for both APIs.
const bundle = resolve("dist/action.mjs");
const files = new Map<string, string>();
const issues: string[] = [];
const merges: { sha: string }[] = [];
const models: Record<string, number> = {};
const bodies: any[] = [];
let denyKey = false;
let dispatches = 0;
let dispatchStatus = 204;
let failStateWrite = false;

const github = createServer((req, res) => {
  // Synthe only calls /repos/...; other local tools sometimes probe new ports with a bare GET /.
  if (!req.url?.startsWith("/repos/")) { res.statusCode = 404; return res.end(); }
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : undefined;
    const url = new URL(req.url!, "http://x");
    const path = url.pathname.replace("/repos/o/r", "");
    const send = (code: number, v?: unknown) => { res.statusCode = code; res.end(v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v)); };
    if (path === "") return send(200, { default_branch: "main" });
    if (path === "/actions/workflows/synthe.yml/dispatches") { dispatches++; return send(dispatchStatus, dispatchStatus === 204 ? undefined : { message: "Resource not accessible by integration" }); }
    if (path.startsWith("/git/ref/heads/")) {
      const b = decodeURIComponent(path.slice(15));
      return [...files.keys()].some((k) => k.startsWith(`${b}:`)) ? send(200, { object: { sha: `${b}-head` } }) : send(404, {});
    }
    if (path === "/git/refs") {
      const b = body.ref.slice(11);
      for (const [k, v] of [...files]) if (k.startsWith("main:")) files.set(`${b}:${k.slice(5)}`, v);
      return send(201, {});
    }
    if (path.startsWith("/git/refs/heads/")) return send(204);
    if (path.startsWith("/contents/")) {
      const name = decodeURI(path.slice(10));
      const key = `${req.method === "PUT" ? body.branch : url.searchParams.get("ref")!.replace(/-head$/, "")}:${name}`;
      if (req.method === "PUT") { if (failStateWrite && key === "synthe/state:state.json") return send(403, { message: "blocked" }); files.set(key, Buffer.from(body.content, "base64").toString()); return send(200, { commit: { sha: `sha-${files.size}` } }); }
      if (!files.has(key)) return send(404, {});
      return req.headers.accept?.includes("raw") ? send(200, files.get(key)) : send(200, { sha: "blob" });
    }
    if (path === "/pulls" && req.method === "GET") return send(200, pulls);
    if (path === "/pulls") { files.set("pr:head", body.head); return send(201, { number: 1 }); }
    if (path === "/pulls/1/merge") {
      merges.push({ sha: body.sha });
      const branch = files.get("pr:head")!;
      files.set("main:prompt.md", files.get(`${branch}:prompt.md`)!);
      return send(200, {});
    }
    if (path === "/issues" || path.startsWith("/issues/")) { issues.push(body.body); return send(path === "/issues" ? 201 : 200, { number: 3 }); }
    send(404, {});
  });
});

const anthropic = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    // Only the SDK's POSTs are Anthropic calls. Other local tools sometimes probe new ports with a bare GET.
    if (req.method !== "POST") { res.statusCode = 404; return res.end(); }
    if (denyKey) { res.statusCode = 401; res.setHeader("content-type", "application/json"); return res.end('{"type":"error","error":{"type":"authentication_error","message":"bad key"}}'); }
    const b = JSON.parse(raw);
    bodies.push(b);
    models[b.model] = (models[b.model] ?? 0) + 1;
    const schema = JSON.stringify(b.output_config?.format?.schema ?? "");
    const user = b.messages[0].content;
    let text: string;
    if (schema.includes("guardrail_ok")) {
      const good = (tag: string) => new RegExp(`<${tag}>\\n[^<]*policy-aware`).test(user);
      const a = good("reply_a"), b = good("reply_b");
      text = JSON.stringify({ better: a === b ? "tie" : a ? "A" : "B", a_guardrail_ok: true, b_guardrail_ok: true });
    }
    else if (schema.includes("edits")) {
      const current = /<prompt>\n([\s\S]*?)\n<\/prompt>/.exec(user)![1];
      text = JSON.stringify({ edits: [{ find: current, replace: "You are careful and use the store policy." }], summary: "Uses the store policy." });
    }
    else text = b.system?.includes("careful") ? "A policy-aware answer." : "A vague answer.";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: b.model, stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text }], usage: { input_tokens: 1000, output_tokens: 200 } }));
  });
});

const port = (s: any) => s.address().port;
let dir: string;

const step = (name: string, outputs = join(dir, "out.txt"), event = "workflow_dispatch") => new Promise<{ code: number; log: string }>((done) => {
  const child = spawn("node", [bundle], {
    cwd: dir,
    env: {
      GITHUB_EVENT_NAME: event,
      GITHUB_EVENT_PATH: join(dir, "event.json"),
      PATH: process.env.PATH, GITHUB_REPOSITORY: "o/r", GITHUB_API_URL: `http://127.0.0.1:${port(github)}`, GITHUB_OUTPUT: outputs,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port(anthropic)}`, INPUT_STEP: name, "INPUT_GITHUB-TOKEN": "tok",
      // The decide job must work with no model key at all.
      "INPUT_ANTHROPIC-API-KEY": name === "decide" ? "" : "key",
    },
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  child.on("close", (code) => done({ code: code ?? 1, log }));
});

// What GitHub says about Synthe's own pull requests when the write step checks on a proposal.
let pulls: { number: number; state: string; merged_at: string | null }[] = [];
const reset = () => {
  pulls = [{ number: 1, state: "open", merged_at: null }];
  dir = mkdtempSync(join(tmpdir(), "synthe-e2e-"));
  cpSync("examples/support-bot", dir, { recursive: true });
  files.clear();
  merges.length = 0;
  issues.length = 0;
  dispatches = 0;
  dispatchStatus = 204;
  failStateWrite = false;
  files.set("main:prompt.md", readFileSync(join(dir, "prompt.md"), "utf8"));
  files.set("main:synthe.json", readFileSync(join(dir, "synthe.json"), "utf8"));
};

before(async () => {
  execFileSync("npm", ["run", "-s", "build"]);
  await Promise.all([github, anthropic].map((s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r))));
});
after(() => { github.close(); anthropic.close(); });

test("one full round merges the winner using the real bundle", async () => {
  reset();
  let decidedLog = "";
  for (const s of ["write", "score", "decide"]) {
    const r = await step(s);
    assert.equal(r.code, 0, r.log);
    if (s === "decide") decidedLog = r.log;
  }
  assert.doesNotMatch(decidedLog, /Sharing skipped|Shared round/);
  assert.match(readFileSync(join(dir, "out.txt"), "utf8"), /go=true/);
  assert.equal(merges.length, 1, files.get("synthe/state:state.json") ?? "no state");
  assert.equal(files.get("main:prompt.md"), "You are careful and use the store policy.");
  const state = JSON.parse(files.get("synthe/state:state.json")!);
  assert.equal(state.rounds[0].outcome, "merged");
  assert.equal(dispatches, 1);
  assert.equal(state.chainReady, true);
  assert.ok(state.spendUsd > 0);
  assert.match(issues.at(-1) ?? "", /## Your prompt is getting better: 1 change merged so far/);
  assert.match(issues.at(-1) ?? "", /\| 1 \| Merged \(#1\) \|/);
  assert.equal(models["claude-sonnet-5-5"], 2);
});

test("requests carry valid model settings", () => {
  assert.ok(bodies.filter((b) => b.model.startsWith("claude-haiku")).every((b) => b.thinking?.type === "disabled"));
  assert.ok(bodies.filter((b) => b.model.startsWith("claude-sonnet")).every((b) => b.thinking === undefined));
  assert.ok(bodies.every((b) => b.output_config.effort === "low"));
});

test("a stopped run says so and doesn't call the model", async () => {
  reset();
  files.set("synthe/state:state.json", JSON.stringify({ round: 12, stopped: "reached 12 rounds", rounds: [] }));
  const before = bodies.length;
  writeFileSync(join(dir, "out.txt"), "");
  const r = await step("write");
  assert.equal(r.code, 0);
  assert.match(readFileSync(join(dir, "out.txt"), "utf8"), /go=false/);
  assert.equal(bodies.length, before);
  assert.equal(dispatches, 0);
});

test("a stopped run with a crashed decide still lets decide clean up and report", async () => {
  reset();
  files.set("synthe/state:state.json", JSON.stringify({ round: 3, stalls: 3, spendUsd: 0.2, stopped: null, pending: { round: 3, at: "t", costUsd: 0.07 }, rounds: [] }));
  writeFileSync(join(dir, "out.txt"), "");
  const before = bodies.length;
  assert.equal((await step("write")).code, 0);
  assert.match(readFileSync(join(dir, "out.txt"), "utf8"), /go=recover/);
  assert.equal(bodies.length, before); // nothing scored, nothing spent
  const d = await step("decide");
  assert.equal(d.code, 0, d.log);
  const state = JSON.parse(files.get("synthe/state:state.json")!);
  assert.equal(state.pending, null);
  assert.equal(state.rounds[0].outcome, "failed");
  assert.match(state.stopped, /no winner/);
  assert.match(issues.at(-1) ?? "", /finished|stopped/);
});

test("while a proposal waits for review, the write step makes no model calls and decide only checks the pull request", async () => {
  reset();
  files.set("synthe/state:state.json", JSON.stringify({ round: 1, stalls: 0, spendUsd: 0.1, stopped: null, pending: null, rounds: [{ round: 1, at: "t", outcome: "proposed", pr: 1, reasons: [], costUsd: 0.1 }], proposal: { pr: 1, round: 1, branch: "synthe/round-1", kind: "merge", text: "New", priorPrompt: "Old", propose: true } }));
  writeFileSync(join(dir, "out.txt"), "");
  const before = bodies.length;
  assert.equal((await step("write")).code, 0);
  assert.match(readFileSync(join(dir, "out.txt"), "utf8"), /go=check/);
  assert.equal(bodies.length, before);
  assert.equal((await step("decide")).code, 0);
  assert.equal(dispatches, 0);
});

test("a round that cannot record state cannot chain", async () => {
  reset();
  for (const s of ["write", "score"]) assert.equal((await step(s)).code, 0);
  failStateWrite = true;
  assert.notEqual((await step("decide")).code, 0);
  assert.equal(dispatches, 0);
});

test("the last allowed round never dispatches another", async () => {
  reset();
  const configured = JSON.parse(readFileSync(join(dir, "synthe.json"), "utf8"));
  configured.merge_rule = { ...(configured.merge_rule ?? {}), max_rounds: 1 };
  const text = JSON.stringify(configured);
  files.set("main:synthe.json", text);
  writeFileSync(join(dir, "synthe.json"), text);
  for (const s of ["write", "score", "decide"]) assert.equal((await step(s)).code, 0);
  assert.equal(JSON.parse(files.get("synthe/state:state.json")!).round, 1);
  assert.equal(dispatches, 0);
});

test("a proposal opened in a run's last round is still checked after the run stops", async () => {
  reset();
  files.set("synthe/state:state.json", JSON.stringify({ round: 12, stalls: 0, spendUsd: 0.1, stopped: "reached 12 rounds", pending: null, rounds: [], proposal: { pr: 1, round: 12, branch: "synthe/round-12", kind: "merge", text: "New", priorPrompt: "Old", propose: true } }));
  writeFileSync(join(dir, "out.txt"), "");
  assert.equal((await step("write")).code, 0);
  assert.match(readFileSync(join(dir, "out.txt"), "utf8"), /go=check/);
});

test("a revoked key fails the job, and decide records the failed round", async () => {
  reset();
  denyKey = true;
  const w = await step("write");
  denyKey = false;
  assert.notEqual(w.code, 0);
  const d = await step("decide");
  assert.equal(d.code, 0, d.log);
  assert.equal(merges.length, 0);
  assert.equal(JSON.parse(files.get("synthe/state:state.json")!).rounds[0].outcome, "failed");
  assert.equal(dispatches, 0);
});

test("a key never appears in logs or state", async () => {
  reset();
  let all = "";
  for (const s of ["write", "score", "decide"]) all += (await step(s)).log;
  assert.ok(!all.includes("INPUT_"));
  assert.ok(!(files.get("synthe/state:state.json") ?? "").includes("key"));
});

test("a proposal the team already merged is settled in the same run, so no hour is lost waiting", async () => {
  reset();
  pulls = [{ number: 1, state: "closed", merged_at: "2026-11-06T23:30:00Z" }];
  files.set("synthe/state:state.json", JSON.stringify({ round: 1, stalls: 0, spendUsd: 0.1, stopped: null, pending: null, rounds: [{ round: 1, at: "t", outcome: "proposed", pr: 1, reasons: [], costUsd: 0.1 }], proposal: { pr: 1, round: 1, branch: "synthe/round-1", kind: "merge", text: "New", priorPrompt: "Old", propose: true } }));
  writeFileSync(join(dir, "out.txt"), "");
  const before = bodies.length;
  assert.equal((await step("write")).code, 0);
  assert.match(readFileSync(join(dir, "out.txt"), "utf8"), /go=true/);
  assert.ok(bodies.length > before, "the round was written, not skipped");
});

test("a scheduled wake-up soon after the last round exits without model calls; setup and restart don't wait", async () => {
  reset();
  const recent = new Date(Date.now() - 20 * 60_000).toISOString();
  files.set("synthe/state:state.json", JSON.stringify({ round: 1, stalls: 0, spendUsd: 0.05, stopped: null, pending: null, proposal: null, rounds: [{ round: 1, at: recent, outcome: "skipped", reasons: [], costUsd: 0.05 }] }));
  writeFileSync(join(dir, "out.txt"), "");
  const before = bodies.length;
  const woke = await step("write", join(dir, "out.txt"), "schedule");
  assert.equal(woke.code, 0);
  assert.match(readFileSync(join(dir, "out.txt"), "utf8"), /go=false/);
  assert.match(woke.log, /Last round was 20 minutes ago/);
  assert.equal(bodies.length, before, "no model calls");

  writeFileSync(join(dir, "out.txt"), "");
  assert.equal((await step("write", join(dir, "out.txt"), "workflow_dispatch")).code, 0);
  assert.match(readFileSync(join(dir, "out.txt"), "utf8"), /go=true/, "a manual run starts a round at once");

  files.set("synthe/state:state.json", JSON.stringify({ round: 1, stalls: 0, spendUsd: 0.05, stopped: null, pending: null, proposal: null, rounds: [{ round: 1, at: new Date(Date.now() - 55 * 60_000).toISOString(), outcome: "skipped", reasons: [], costUsd: 0.05 }] }));
  writeFileSync(join(dir, "out.txt"), "");
  assert.equal((await step("write", join(dir, "out.txt"), "schedule")).code, 0);
  assert.match(readFileSync(join(dir, "out.txt"), "utf8"), /go=true/, "an hour on, a wake-up runs a round");
});

test("an older workflow's denied dispatch leaves a successful round for the schedule and explains upgrade", async () => {
  reset();
  dispatchStatus = 403;
  for (const s of ["write", "score"]) assert.equal((await step(s)).code, 0);
  const decided = await step("decide");
  assert.equal(decided.code, 0, decided.log);
  assert.match(decided.log, /refused to start the next round \(403\).*npx synthe upgrade.*npx synthe restart/);
  assert.equal(JSON.parse(files.get("synthe/state:state.json")!).chainReady, false);
});

test("a backup that replaces a pending chain can start the next round", async () => {
  reset();
  files.set("synthe/state:state.json", JSON.stringify({ round: 1, chainReady: true, rounds: [{ round: 1, at: new Date().toISOString(), outcome: "skipped", reasons: [], costUsd: 0.05 }] }));
  writeFileSync(join(dir, "out.txt"), "");
  assert.equal((await step("write", join(dir, "out.txt"), "schedule")).code, 0);
  assert.match(readFileSync(join(dir, "out.txt"), "utf8"), /go=true/);
});

test("a backup replacing a proposal-close run can resume review immediately", async () => {
  reset();
  pulls = [{ number: 1, state: "closed", merged_at: null }];
  files.set("synthe/state:state.json", JSON.stringify({ round: 1, proposal: { pr: 1, round: 1, branch: "synthe/round-1", kind: "merge", text: "New", priorPrompt: "Old" }, rounds: [{ round: 1, at: new Date().toISOString(), outcome: "proposed", pr: 1, reasons: [], costUsd: 0.1 }] }));
  writeFileSync(join(dir, "out.txt"), "");
  assert.equal((await step("write", join(dir, "out.txt"), "schedule")).code, 0);
  assert.match(readFileSync(join(dir, "out.txt"), "utf8"), /go=true/);
});

test("a closed PR starts a round only for the current same-repo Synthe proposal", async () => {
  reset();
  pulls = [{ number: 1, state: "closed", merged_at: null }];
  files.set("synthe/state:state.json", JSON.stringify({ round: 1, proposal: { pr: 1, round: 1, branch: "synthe/round-1", kind: "merge", text: "New", priorPrompt: "Old" }, rounds: [{ round: 1, at: "t", outcome: "proposed", pr: 1, reasons: [], costUsd: 0.1 }] }));
  const event = (owner: string, branch = "synthe/round-1", number = 1) => ({ action: "closed", pull_request: { number, head: { ref: branch, repo: { full_name: owner } } } });
  for (const payload of [event("fork/r"), event("o/r", "feature"), event("o/r", "synthe/round-2"), event("o/r", "synthe/round-1", 2)]) {
    writeFileSync(join(dir, "event.json"), JSON.stringify(payload));
    writeFileSync(join(dir, "out.txt"), "");
    const before = bodies.length;
    assert.equal((await step("write", join(dir, "out.txt"), "pull_request")).code, 0);
    assert.match(readFileSync(join(dir, "out.txt"), "utf8"), /go=false/);
    assert.equal(bodies.length, before);
  }
  writeFileSync(join(dir, "event.json"), JSON.stringify(event("o/r")));
  writeFileSync(join(dir, "out.txt"), "");
  assert.equal((await step("write", join(dir, "out.txt"), "pull_request")).code, 0);
  assert.match(readFileSync(join(dir, "out.txt"), "utf8"), /go=true/);
});

test("a stale same-repo proposal close replacing a pending chain remains a round starter", async () => {
  reset();
  files.set("synthe/state:state.json", JSON.stringify({ round: 2, chainReady: true, rounds: [{ round: 2, at: new Date().toISOString(), outcome: "skipped", reasons: [], costUsd: 0.1 }] }));
  writeFileSync(join(dir, "event.json"), JSON.stringify({ action: "closed", pull_request: { number: 1, head: { ref: "synthe/round-1", repo: { full_name: "o/r" } } } }));
  writeFileSync(join(dir, "out.txt"), "");
  assert.equal((await step("write", join(dir, "out.txt"), "pull_request")).code, 0);
  assert.match(readFileSync(join(dir, "out.txt"), "utf8"), /go=true/);
});

test("a prefixed same-repo PR replacement cannot silently consume the queued chain", async () => {
  reset();
  files.set("synthe/state:state.json", JSON.stringify({ round: 2, chainReady: true, rounds: [{ round: 2, at: new Date().toISOString(), outcome: "skipped", reasons: [], costUsd: 0.1 }] }));
  writeFileSync(join(dir, "event.json"), JSON.stringify({ action: "closed", pull_request: { number: 1, head: { ref: "synthe/round-test", repo: { full_name: "o/r" } } } }));
  writeFileSync(join(dir, "out.txt"), "");
  assert.equal((await step("write", join(dir, "out.txt"), "pull_request")).code, 0);
  assert.match(readFileSync(join(dir, "out.txt"), "utf8"), /go=true/);
});

test("merging Synthe's setup pull request starts round 1; closing it, a fork's, or a later one doesn't", async () => {
  const setup = (merged: boolean, owner = "o/r") => ({ action: "closed", pull_request: { number: 9, merged, head: { ref: "synthe/setup", repo: { full_name: owner } } } });
  const go = async (payload: unknown) => {
    writeFileSync(join(dir, "event.json"), JSON.stringify(payload));
    writeFileSync(join(dir, "out.txt"), "");
    assert.equal((await step("write", join(dir, "out.txt"), "pull_request")).code, 0);
    return /go=true/.test(readFileSync(join(dir, "out.txt"), "utf8"));
  };
  reset();
  assert.equal(await go(setup(false)), false, "closed without merging");
  assert.equal(await go(setup(true, "fork/r")), false, "a fork's branch of the same name");
  assert.equal(await go(setup(true)), true, "merged: the first round starts");
  files.set("synthe/state:state.json", JSON.stringify({ round: 2, rounds: [{ round: 2, at: "2026-11-03T00:00:00Z", outcome: "skipped", reasons: [], costUsd: 0.1 }] }));
  assert.equal(await go(setup(true)), false, "a setup branch merged again later doesn't start an extra round");
});
