import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

// scripts/local-round.ts runs the three workflow steps from src/ against its own stand-in for GitHub. A stand-in for
// the model API (the same one e2e.test.ts uses) keeps this free: the writer always proposes a "careful" prompt, the
// agent answers well only with it, and the judge prefers the better answer.
const anthropic = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const b = JSON.parse(raw);
    const schema = JSON.stringify(b.output_config?.format?.schema ?? "");
    const user = b.messages[0].content;
    let text: string;
    if (schema.includes("guardrail_ok")) {
      const good = (tag: string) => new RegExp(`<${tag}>\\n[^<]*policy-aware`).test(user);
      const a = good("reply_a"), c = good("reply_b");
      text = JSON.stringify({ better: a === c ? "tie" : a ? "A" : "B", a_guardrail_ok: true, b_guardrail_ok: true });
    } else if (schema.includes("edits")) {
      const current = /<prompt>\n([\s\S]*?)\n<\/prompt>/.exec(user)![1];
      text = JSON.stringify({ edits: [{ find: current, replace: "You are careful and use the store policy." }], summary: "Uses the store policy." });
    } else text = b.system?.includes("careful") ? "A policy-aware answer." : "A vague answer.";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: b.model, stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text }], usage: { input_tokens: 1000, output_tokens: 200 } }));
  });
});

before(() => new Promise<void>((r) => anthropic.listen(0, "127.0.0.1", r)));
after(() => anthropic.close());

const local = (agent: string, workspace: string, ...extra: string[]) => new Promise<{ code: number; log: string }>((done) => {
  const child = spawn(process.execPath, [resolve("scripts/local-round.ts"), agent, "--workspace", workspace, ...extra], {
    env: { ...process.env, ANTHROPIC_API_KEY: "test", ANTHROPIC_BASE_URL: `http://127.0.0.1:${(anthropic.address() as any).port}` },
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  child.on("close", (code) => done({ code: code ?? 1, log }));
});

const runs = (workspace: string) => readFileSync(join(workspace, "runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("local rounds merge a winner into the stand-in repo and leave the agent folder untouched", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "synthe-local-"));
  const before = readFileSync("examples/support-bot/prompt.md", "utf8");
  const r = await local("examples/support-bot", workspace, "--rounds", "2");
  assert.equal(r.code, 0, r.log);
  assert.doesNotMatch(r.log, /no route/, r.log);
  const [first, second] = runs(workspace);
  assert.equal(first.outcome, "merged", r.log);
  assert.deepEqual(first.jobs, { write: 0, go: "true", score: 0, decide: 0 });
  // The writer offers the same prompt again, which is never a change, so the second round finds nothing.
  assert.equal(second.round, 2);
  assert.notEqual(second.outcome, "merged");
  assert.match(readFileSync(join(workspace, "view/prompt.md"), "utf8"), /careful/);
  assert.match(readFileSync(join(workspace, "view/report.md"), "utf8"), /Synthe/);
  assert.ok(existsSync(join(workspace, `view/pr-${first.pr}.md`)));
  assert.equal(readFileSync("examples/support-bot/prompt.md", "utf8"), before);
});

test("in review mode a proposal waits, and --review merge settles it like a person would", async () => {
  const agent = mkdtempSync(join(tmpdir(), "synthe-agent-"));
  cpSync("examples/support-bot", agent, { recursive: true });
  const goal = JSON.parse(readFileSync(join(agent, "synthe.json"), "utf8"));
  writeFileSync(join(agent, "synthe.json"), JSON.stringify({ ...goal, merge_rule: { ...goal.merge_rule, mode: "propose" } }));
  const workspace = mkdtempSync(join(tmpdir(), "synthe-local-"));

  let r = await local(agent, workspace, "--rounds", "2");
  assert.equal(r.code, 0, r.log);
  const [proposed, waiting] = runs(workspace);
  assert.equal(proposed.outcome, "proposed", r.log);
  assert.equal(waiting.outcome, "waiting for review");
  assert.doesNotMatch(readFileSync(join(workspace, "view/prompt.md"), "utf8"), /careful/);

  r = await local(agent, workspace, "--review", "merge");
  assert.equal(r.code, 0, r.log);
  assert.match(r.log, /Review: merged #/);
  assert.match(readFileSync(join(workspace, "view/prompt.md"), "utf8"), /careful/);
  const state = JSON.parse(readFileSync(join(workspace, "view/state.json"), "utf8"));
  assert.equal(state.rounds.find((x: any) => x.round === 1).outcome, "merged");
});
