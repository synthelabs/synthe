import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ACTION, REGISTRY, init, type Io } from "../src/cli/init.ts";
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

const fakeIo = (dir: string, failing: string[] = [], answers: Record<string, string> = {}) => {
  const ran: { cmd: string; args: string[]; stdin?: string }[] = [];
  const said: string[] = [];
  const io: Io = {
    say: (t) => said.push(t),
    ask: async (q) => Object.entries({ "automatically?": "y", "Share this run": "y", ...answers }).find(([k]) => q.includes(k))?.[1] ?? "Answer returns correctly",
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

test("when GitHub isn't ready, init says exactly what to fix and changes nothing", async () => {
  for (const [failing, says] of [
    [["repo view", "--version"], /Install it from https:\/\/cli\.github\.com/],
    [["repo view", "auth status"], /run `gh auth login`/],
    [["repo view"], /inside your project's folder, after pushing it to GitHub/],
  ] as const) {
    const dir = repoDir(PROMPT);
    const { io, said } = fakeIo(dir, [...failing]);
    assert.equal(await init(io, dir), false);
    assert.match(said.join("\n"), says);
    assert.equal(existsSync(join(dir, "synthe.json")), false);
  }
});

test("init shows what it inferred and what happens next, in plain words", async () => {
  const dir = repoDir(PROMPT);
  const { io, said } = fakeIo(dir);
  await init(io, dir, () => new Date(2026, 10, 6, 23, 0));
  const text = said.join("\n");
  assert.match(text, /Synthe will improve your agent's system prompt overnight, in o\/r\. It tests new versions .* puts the clear winners into o\/r, or into pull requests/);
  assert.match(text, /it can merge it into o\/r by itself, overnight\. If o\/r deploys your app, each change goes live/);
  assert.match(text, /writing 30 test cases: 20 Synthe learns from and 10 it keeps hidden to check its changes/);
  assert.match(text, /Rules it must never break:\n    - Never lie/);
  assert.match(text, /Your business policy, copied from your prompt \(1 line\), starting: "Returns within 30 days of delivery\."/);
  assert.match(text, /Added to o\/r \(committed and pushed\): synthe\.json, \.synthe\/scenarios\.jsonl and \.github\/workflows\/synthe\.yml\. Saved your key as the repo secret SYNTHE_ANTHROPIC_KEY\./);
  assert.match(text, /at most 12 rounds, using at most \$3 of your key's credit/);
  assert.match(text, /The last possible change is around 11:00 AM [A-Z]{2,5}[+\-\d:]*\. .*run: npx synthe stop/);
  assert.match(text, /Automatic merging: on\. Changes go into o\/r as soon as they win\./);
  assert.match(text, /Sharing progress with Synthe: on\./);
  assert.match(text, /You can keep editing your prompt: Synthe always starts from the latest version on o\/r/);
  assert.equal(parseGoal(readFileSync(join(dir, "synthe.json"), "utf8")).merge_rule.mode, "auto");
});

test("the merge question comes before the key, and no clear answer means review mode", async () => {
  const dir = repoDir(PROMPT);
  const { io, said } = fakeIo(dir, [], { "automatically?": "maybe" });
  const order: string[] = [];
  const ask = io.ask, secret = io.askSecret;
  io.ask = async (q) => { order.push(q.includes("automatically") ? "merge" : "goal"); return ask(q); };
  io.askSecret = async (q) => { order.push("key"); return secret(q); };
  await init(io, dir);
  assert.deepEqual(order.filter((x, i) => order.indexOf(x) === i), ["goal", "merge", "key"]);
  assert.equal(order.filter((x) => x === "merge").length, 3);
  assert.match(said.join("\n"), /Please type y or n\.[\s\S]*No clear answer, so Synthe will open pull requests for you to review[\s\S]*Review mode: on\./);
  assert.equal(parseGoal(readFileSync(join(dir, "synthe.json"), "utf8")).merge_rule.mode, "propose");
});

test("answering n to automatic merges sets review mode", async () => {
  const dir = repoDir(PROMPT);
  const { io, said } = fakeIo(dir, [], { "automatically?": "n" });
  await init(io, dir);
  assert.equal(parseGoal(readFileSync(join(dir, "synthe.json"), "utf8")).merge_rule.mode, "propose");
  assert.match(said.join("\n"), /opens a pull request for you to merge or close/);
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

test("sharing progress is asked, and on yes sends only the repo name, setup times and mode", async () => {
  const dir = repoDir(PROMPT);
  const { io, ran } = fakeIo(dir);
  let t = 0;
  await init(io, dir, () => new Date(Date.UTC(2026, 10, 6, 23, 0, t++ * 90)));
  const sent = ran.find((r) => r.args.includes("issue") && r.args.includes("create"))!;
  assert.deepEqual(sent.args.slice(0, 7), ["issue", "create", "--repo", REGISTRY, "--title", "run: o/r", "--body-file"]);
  const entry = JSON.parse(sent.stdin!);
  assert.deepEqual(Object.keys(entry).sort(), ["finishedAt", "mode", "repo", "startedAt", "version"]);
  assert.equal(entry.startedAt, "2026-11-06T23:00:00.000Z");
  assert.ok(!sent.stdin!.includes(PROMPT) && !sent.stdin!.includes("sk-test"));
});

test("sharing needs a clear yes: no answer means off", async () => {
  const dir = repoDir(PROMPT);
  const { io, ran, said } = fakeIo(dir, [], { "Share this run": "" });
  await init(io, dir);
  assert.ok(!ran.some((r) => r.args.includes("issue")));
  assert.match(said.join("\n"), /Sharing progress with Synthe: off\./);
});

test("saying no to sharing sends nothing, and a failed share never blocks setup", async () => {
  const noDir = repoDir(PROMPT);
  const no = fakeIo(noDir, [], { "Share this run": "n" });
  assert.equal(await init(no.io, noDir), true);
  assert.ok(!no.ran.some((r) => r.args.includes("issue")));
  const brokenDir = repoDir(PROMPT);
  const broken = fakeIo(brokenDir, ["issue create"]);
  assert.equal(await init(broken.io, brokenDir), true);
});
