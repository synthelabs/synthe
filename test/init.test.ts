import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ACTION, init, type Io } from "../src/cli/init.ts";
import { parseGoal, parseScenarios } from "../src/core/goal.ts";

const repoDir = (prompt: string) => {
  const dir = mkdtempSync(join(tmpdir(), "synthe-init-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "prompt.md"), prompt);
  execFileSync("git", ["add", "prompt.md"], { cwd: dir });
  return dir;
};

const scenarioReply = JSON.stringify({
  guardrails: ["Never lie"],
  policy: "Returns within 30 days of delivery.",
  scenarios: Array.from({ length: 30 }, (_, i) => ({ input: `q${i}`, expected: `a${i}` })),
});

const fakeIo = (dir: string, failing: string[] = []) => {
  const ran: { cmd: string; args: string[]; stdin?: string }[] = [];
  const said: string[] = [];
  const io: Io = {
    say: (t) => said.push(t),
    ask: async () => "Answer returns correctly",
    askSecret: async () => "sk-test-team-key",
    template: () => readFileSync("templates/synthe.yml", "utf8"),
    model: () => ({ ask: async () => ({ text: scenarioReply, costUsd: 0.01 }) }),
    async run(cmd, args, stdin) {
      ran.push({ cmd, args, stdin });
      if (failing.some((f) => args.join(" ").includes(f))) throw new Error("no");
      if (cmd === "git" && args[0] !== "ls-files") return "";
      if (cmd === "git") return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
      return "o/r\n";
    },
  };
  return { io, ran, said };
};

const PROMPT = "You are a very helpful assistant for hikers needing trail advice.";

test("init sets up everything and starts the first run", async () => {
  const dir = repoDir(PROMPT);
  const { io, ran, said } = fakeIo(dir);
  assert.equal(await init(io, dir), true);
  const goal = parseGoal(readFileSync(join(dir, "synthe.json"), "utf8"));
  assert.deepEqual(goal.prompt, { kind: "file", path: "prompt.md" });
  const rows = parseScenarios(readFileSync(join(dir, ".synthe/scenarios.jsonl"), "utf8"));
  assert.equal(rows.filter((r) => r.split === "train").length, 20);
  assert.equal(rows.filter((r) => r.split === "holdout").length, 10);
  const workflow = readFileSync(join(dir, ".github/workflows/synthe.yml"), "utf8");
  assert.ok(workflow.includes(ACTION) && !workflow.includes("__ACTION__"));
  const secret = ran.find((r) => r.args[0] === "secret")!;
  assert.equal(secret.stdin, "sk-test-team-key");
  assert.ok(!secret.args.join(" ").includes("sk-test"));
  assert.ok(ran.some((r) => r.args.includes("run")));
  assert.ok(said.join().includes("synthe stop"));
});

test("the key is never written into a file", async () => {
  const dir = repoDir(PROMPT);
  await init(fakeIo(dir).io, dir);
  for (const f of ["synthe.json", ".synthe/scenarios.jsonl", ".github/workflows/synthe.yml"]) {
    assert.ok(!readFileSync(join(dir, f), "utf8").includes("sk-test"));
  }
});

test("without gh it explains what to do and changes nothing", async () => {
  const dir = repoDir(PROMPT);
  const { io, said } = fakeIo(dir, ["repo view"]);
  assert.equal(await init(io, dir), false);
  assert.match(said.join(), /cli\.github\.com/);
  assert.equal(existsSync(join(dir, "synthe.json")), false);
});

test("a blocked Actions setting gives the settings link and still finishes", async () => {
  const dir = repoDir(PROMPT);
  const { io, said } = fakeIo(dir, ["actions/permissions"]);
  assert.equal(await init(io, dir), true);
  assert.match(said.join(), /settings\/actions/);
});

test("init copies the prompt's business rules into the goal file as its policy", async () => {
  const { generateScenarios, buildGoal } = await import("../src/cli/init.ts");
  const model = { async ask() { return { text: scenarioReply, costUsd: 0.01 }; } };
  const { policy, guardrails } = await generateScenarios(model, "Answer returns correctly", "You handle returns.");
  assert.equal(policy, "Returns within 30 days of delivery.");
  const g = buildGoal({ kind: "file", path: "p.md" }, "x", guardrails, policy);
  assert.equal(g.policy, "Returns within 30 days of delivery.");
  assert.equal("policy" in buildGoal({ kind: "file", path: "p.md" }, "x", guardrails, ""), false);
});
