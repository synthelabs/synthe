import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ACTION, init, type Io } from "../src/cli/init.ts";
import { upgrade } from "../src/cli/upgrade.ts";
import { parseGoal, parseScenarios } from "../src/core/goal.ts";
import { agentOptions, AgentSetupError } from "../src/cli/agent.ts";
import { AGENT_NEXT, DRAFT_FILE } from "../src/cli/init.ts";
import { CreditError, type Ask } from "../src/model/client.ts";
import { setKey } from "../src/cli/key.ts";

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
    ask: async (q) => Object.entries({ "automatically?": "y", "Real message": "", "Use these checks": "y", ...answers }).find(([k]) => q.includes(k))?.[1] ?? "Answer returns correctly",
    askSecret: async () => "sk-ant-test-team-key",
    template: () => readFileSync("templates/synthe.yml", "utf8"),
    sleep: async () => {},
    model: () => ({ ask: async () => ({ text: scenarioReply, costUsd: 0.01 }) }),
    proxy: () => { throw new Error("Unexpected proxy call in an own-key setup"); },
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
  assert.equal(secret.stdin, "sk-ant-test-team-key");
  assert.ok(!secret.args.join(" ").includes("sk-ant"));
  assert.ok(ran.some((r) => r.args.includes("run")));
  assert.ok(said.join().includes("synthe stop"));
  assert.match(said.join("\n"), /GitHub accepted the first dispatch/);
});

test("upgrade changes only the workflow, keeps the backup minute, and is idempotent", () => {
  const dir = repoDir(PROMPT);
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  const workflow = join(dir, ".github/workflows/synthe.yml");
  writeFileSync(workflow, '# old\non:\n  schedule:\n    - cron: "6-59/10 * * * *"\njobs:\n  write:\n    uses: synthelabs/synthe@v1\n');
  writeFileSync(join(dir, "synthe.json"), '{"merge_rule":{"mode":"propose"}}\n');
  mkdirSync(join(dir, ".synthe"));
  writeFileSync(join(dir, ".synthe/scenarios.jsonl"), "case\n");
  const before = ["prompt.md", "synthe.json", ".synthe/scenarios.jsonl"].map((f) => readFileSync(join(dir, f), "utf8"));
  const template = readFileSync("templates/synthe.yml", "utf8");
  assert.match(upgrade(dir, template), /Updated .*kept backup minute 6/);
  assert.match(readFileSync(workflow, "utf8"), /cron: "6 \* \* \* \*"/);
  assert.match(readFileSync(workflow, "utf8"), /actions: write/);
  assert.match(readFileSync(workflow, "utf8"), /id-token: write/);
  assert.match(readFileSync(workflow, "utf8"), /if: \$\{\{ !cancelled\(\) && needs.write.result/);
  assert.match(upgrade(dir, template), /already up to date\. No files changed/);
  assert.deepEqual(["prompt.md", "synthe.json", ".synthe/scenarios.jsonl"].map((f) => readFileSync(join(dir, f), "utf8")), before);
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
  assert.match(text, /up to 12 rounds and \$3 of your key's credit/);
  assert.match(text, /A 12-round session usually takes about half an hour/);
  assert.match(text, /Automatic merging: on\. Changes go into o\/r as soon as they win\./);
  assert.match(text, /During Crimson Hacks \(until November 8\), Synthe shares this run with the Synthe team so we can improve it: your prompt, your test cases/);
  assert.match(text, /You can keep editing your prompt: Synthe always starts from the latest version on o\/r/);
  assert.equal(parseGoal(readFileSync(join(dir, "synthe.json"), "utf8")).merge_rule.mode, "auto");
});

test("the credential comes first, and no clear merge answer means review mode", async () => {
  const dir = repoDir(PROMPT);
  const { io, said } = fakeIo(dir, [], { "automatically?": "maybe" });
  const order: string[] = [];
  const ask = io.ask, secret = io.askSecret;
  io.ask = async (q) => { order.push(q.includes("automatically") ? "merge" : "goal"); return ask(q); };
  io.askSecret = async (q) => { order.push("key"); return secret(q); };
  await init(io, dir);
  assert.deepEqual(order.filter((x, i) => order.indexOf(x) === i), ["key", "goal", "merge"]);
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

test("init announces full sharing before writing synthe.json during Crimson Hacks", async () => {
    const dir = repoDir(PROMPT);
    const { io, ran, said } = fakeIo(dir);
    const questions: string[] = [];
    const ask = io.ask;
    io.ask = async (question) => { questions.push(question); return ask(question); };
    const say = io.say;
    io.say = (message) => { if (message.startsWith("During Crimson Hacks")) assert.equal(existsSync(join(dir, "synthe.json")), false); say(message); };
    assert.equal(await init(io, dir, () => new Date("2026-11-08T23:58:59Z")), true);
    assert.equal(parseGoal(readFileSync(join(dir, "synthe.json"), "utf8")).share, "full");
    assert.ok(!questions.some((q) => /share how this run goes|type 1, 2 or 3/i.test(q)));
    assert.match(said.join("\n"), /During Crimson Hacks[\s\S]*set DO_NOT_TRACK=1 on setup \(including --confirm\), or choose --share none in agent mode/);
    assert.ok(!ran.some((r) => r.args[0] === "issue" && r.args[1] === "create"));
});

test("init defaults to detail at and after the cutoff", async () => {
  const dir = repoDir(PROMPT);
  const { io, said } = fakeIo(dir);
  assert.equal(await init(io, dir, () => new Date("2026-11-08T23:59:00Z")), true);
  assert.equal(parseGoal(readFileSync(join(dir, "synthe.json"), "utf8")).share, "detail");
  assert.match(said.join("\n"), /Never your whole prompt, your test-case file or your code[\s\S]*including --confirm/);
});

test("init respects DO_NOT_TRACK and SYNTHE_TELEMETRY opt-outs", async () => {
  for (const env of [{ DO_NOT_TRACK: "1" }, { DO_NOT_TRACK: "true" }, { SYNTHE_TELEMETRY: "0" }, { SYNTHE_TELEMETRY: "false" }]) {
    const dir = repoDir(PROMPT);
    const { io, said } = fakeIo(dir);
    assert.equal(await init(io, dir, () => new Date(), undefined, env), true);
    assert.equal(parseGoal(readFileSync(join(dir, "synthe.json"), "utf8")).share, "none");
    assert.ok(said.includes("Sharing with Synthe: off (DO_NOT_TRACK, SYNTHE_TELEMETRY or --share none)."));
    assert.ok(!said.some((line) => line.startsWith("Synthe shares how this run goes")));
  }
});

test("a pasted key is never drawn on screen", async () => {
  const { PassThrough } = await import("node:stream");
  const { askSecret } = await import("../src/cli/secret.ts");
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return input; } });
  let shown = "";
  const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
  output.on("data", (d) => { shown += d; });
  const answer = askSecret("Paste your Synthe key: ", input, output);
  input.write("sk-ant-visible-secret\r");
  assert.equal(await answer, "sk-ant-visible-secret");
  assert.ok(shown.includes("Paste your Synthe key"));
  assert.ok(!shown.includes("visible-secret"), `key was shown: ${JSON.stringify(shown)}`);
});

test("test cases still work when the model writes a few more or fewer than asked", async () => {
  const { generateScenarios } = await import("../src/cli/init.ts");
  const reply = (n: number) => JSON.stringify({ guardrails: ["Never lie"], policy: "", scenarios: Array.from({ length: n }, (_, i) => ({ input: `q${i}`, expected: `a${i}` })) });
  const split = async (n: number) => {
    const { rows } = await generateScenarios({ async ask() { return { text: reply(n), costUsd: 0.01 }; } }, "x", "p");
    return [rows.filter((r) => r.split === "train").length, rows.filter((r) => r.split === "holdout").length];
  };
  assert.deepEqual(await split(34), [20, 10]);
  assert.deepEqual(await split(29), [19, 10]);
  assert.deepEqual(await split(24), [16, 8]);
});

test("too few test cases asks once more, then says plainly that nothing changed", async () => {
  const { generateScenarios } = await import("../src/cli/init.ts");
  const reply = (n: number) => JSON.stringify({ guardrails: ["Never lie"], policy: "", scenarios: Array.from({ length: n }, (_, i) => ({ input: `q${i}`, expected: `a${i}` })) });
  let calls = 0;
  const { rows } = await generateScenarios({ async ask() { return { text: reply(calls++ === 0 ? 5 : 30), costUsd: 0.01 }; } }, "x", "p");
  assert.equal(rows.length, 30);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(generateScenarios({ async ask() { calls++; return { text: null, costUsd: 0.01 }; } }, "x", "p"), /Nothing in your repo was changed/);
  assert.equal(calls, 2);
});

test("a key already in ANTHROPIC_API_KEY is only used when the team presses Enter", async () => {
  const dir = repoDir(PROMPT);
  const { io, ran, said } = fakeIo(dir);
  const asked: string[] = [];
  io.askSecret = async (q) => { asked.push(q); return ""; };
  assert.equal(await init(io, dir, undefined, "sk-ant-their-own-key"), true);
  assert.match(asked[0], /Paste your Crimson Hacks event code/);
  assert.match(said.join("\n"), /press Enter to use the key already in ANTHROPIC_API_KEY/);
  assert.equal(ran.find((r) => r.args[0] === "secret")!.stdin, "sk-ant-their-own-key");
  assert.match(said.join("\n"), /Using the key in ANTHROPIC_API_KEY/);

  const pastedDir = repoDir(PROMPT);
  const pasted = fakeIo(pastedDir);
  assert.equal(await init(pasted.io, pastedDir, undefined, "sk-ant-their-own-key"), true);
  assert.equal(pasted.ran.find((r) => r.args[0] === "secret")!.stdin, "sk-ant-test-team-key");
});

test("an empty credential is asked again, and three misses set nothing up", async () => {
  const dir = repoDir(PROMPT);
  const { io, ran, said } = fakeIo(dir);
  io.askSecret = async () => "";
  assert.equal(await init(io, dir, undefined, ""), false);
  assert.equal(said.filter((t) => /Paste your event code or key/.test(t)).length, 3);
  assert.match(said.join("\n"), /Nothing in your repo was changed/);
  assert.ok(!ran.some((r) => r.args[0] === "secret" || r.args[0] === "push"));
  assert.equal(existsSync(join(dir, "synthe.json")), false);
});

test("a prompt too long stops setup after only the cheap credential test", async () => {
  const dir = repoDir("You help hikers. ".repeat(1300));
  const { io, ran, said } = fakeIo(dir);
  let calls = 0;
  io.model = () => ({ async ask() { calls++; return { text: scenarioReply, costUsd: 0.01 }; } });
  assert.equal(await init(io, dir), false);
  assert.match(said.join("\n"), /Your prompt is 22,100 characters, and Synthe works on prompts up to 20,000/);
  assert.equal(calls, 1);
  assert.ok(!ran.some((r) => r.args[0] === "secret"));
});

test("on a branch other than the default, init stops before spending and says which branch to use", async () => {
  const dir = repoDir(PROMPT);
  const { io, ran, said } = fakeIo(dir);
  const run = io.run;
  io.run = async (cmd, args, stdin) => (args[0] === "rev-parse" ? "my-feature\n" : run(cmd, args, stdin));
  let calls = 0;
  io.model = () => ({ async ask() { calls++; return { text: scenarioReply, costUsd: 0.01 }; } });
  assert.equal(await init(io, dir), false);
  assert.match(said.join("\n"), /You're on the branch my-feature\. Synthe adds itself to o\/r[\s\S]*git checkout o\/r/);
  assert.equal(calls, 0);
  assert.ok(!ran.some((r) => r.args[0] === "secret"));
});

test("a protected default branch gets Synthe's files as a pull request, and nothing starts until it's merged", async () => {
  const dir = repoDir(PROMPT);
  const { io, ran, said } = fakeIo(dir);
  const run = io.run;
  io.run = async (cmd, args, stdin) => {
    if (cmd === "git" && args.join(" ") === "push") { ran.push({ cmd, args }); throw new Error("remote: error: GH006: Protected branch update failed"); }
    if (args[0] === "pr") { ran.push({ cmd, args }); return "https://github.com/o/r/pull/7\n"; }
    return run(cmd, args, stdin);
  };
  assert.equal(await init(io, dir), true);
  assert.ok(ran.some((r) => r.cmd === "git" && r.args.join(" ") === "push --force origin HEAD:refs/heads/synthe/setup"));
  const pr = ran.find((r) => r.args[0] === "pr")!;
  assert.deepEqual(pr.args.slice(0, 9), ["pr", "create", "--repo", "o/r", "--base", "o/r", "--head", "synthe/setup", "--title"]);
  assert.ok(!ran.some((r) => r.args.includes("workflow")), "the workflow isn't on the default branch yet");
  assert.ok(ran.some((r) => r.cmd === "git" && r.args.join(" ") === "reset --keep HEAD~1"), "so git pull after the merge isn't divergent");
  const text = said.join("\n");
  assert.match(text, /only takes changes through pull requests, so Synthe opened one with its files: https:\/\/github\.com\/o\/r\/pull\/7/);
  assert.match(text, /Set up, waiting for you to merge https:\/\/github\.com\/o\/r\/pull\/7/);
  assert.doesNotMatch(text, /Synthe is running|committed and pushed/);
});

test("when Actions is turned off, init says so instead of promising a first round", async () => {
  const dir = repoDir(PROMPT);
  const { io, said } = fakeIo(dir, ["workflow run"]);
  const run = io.run;
  io.run = async (cmd, args, stdin) => (args.includes("repos/o/r/actions/permissions") ? "false\n" : run(cmd, args, stdin));
  assert.equal(await init(io, dir), true);
  assert.match(said.join("\n"), /GitHub Actions is turned off for this repo, so Synthe can't run yet\. Turn it on at https:\/\/github\.com\/o\/r\/settings\/actions/);
  assert.doesNotMatch(said.join("\n"), /starts within the hour/);
});

const briefReply = JSON.stringify({
  guardrails: ["Never lie"], policy: "", brief: "Order-help bot for a pizza shop.",
  checks: ["Asks for the order number first", "Stays under three sentences", "Offers a remake before a refund"],
  scenarios: Array.from({ length: 30 }, (_, i) => ({ input: `q${i}`, expected: `a${i}` })),
});

test("init reads the README and the code that uses the prompt, says so, and never sends a key in them", async () => {
  const dir = repoDir(PROMPT);
  writeFileSync(join(dir, "README.md"), "# Pizza bot\nAnswers order questions for Pip's Pizza.");
  writeFileSync(join(dir, "agent.py"), 'SYSTEM = open("prompt.md").read()\nKEY = "sk-ant-api03-abcdefghijklmnop"\n');
  execFileSync("git", ["add", "README.md", "agent.py"], { cwd: dir });
  const { io, said } = fakeIo(dir);
  const asked: string[] = [];
  io.model = () => ({ async ask(a) { asked.push(a.user); return { text: briefReply, costUsd: 0.01 }; } });
  assert.equal(await init(io, dir), true);
  assert.match(said.join("\n"), /Reading your prompt and README\.md and agent\.py/);
  assert.match(asked[1], /<repo>[\s\S]*Answers order questions for Pip's Pizza[\s\S]*SYSTEM = open/);
  assert.ok(!asked[1].includes("abcdefghijklmnop") && asked[1].includes("[secret removed]"));
});

test("init shows the brief and proposed checks, and saves them when the team says yes", async () => {
  const dir = repoDir(PROMPT);
  const { io, said } = fakeIo(dir);
  io.model = () => ({ async ask() { return { text: briefReply, costUsd: 0.01 }; } });
  assert.equal(await init(io, dir), true);
  const text = said.join("\n");
  assert.match(text, /What Synthe understands your agent is for: Order-help bot for a pizza shop\./);
  assert.match(text, /the reply that passes more of them wins:\n  1\. Asks for the order number first\n  2\. Stays under three sentences\n  3\. Offers a remake before a refund/);
  const goal = parseGoal(readFileSync(join(dir, "synthe.json"), "utf8"));
  assert.equal(goal.brief, "Order-help bot for a pizza shop.");
  assert.deepEqual(goal.checks, ["Asks for the order number first", "Stays under three sentences", "Offers a remake before a refund"]);
});

test("a team can replace the proposed checks with its own", async () => {
  const dir = repoDir(PROMPT);
  const typed = ["Mentions the trail's difficulty", ""];
  const { io } = fakeIo(dir, [], { "Use these checks": "n" });
  const ask = io.ask;
  io.ask = async (q) => (q.startsWith("Check ") ? typed.shift() ?? "" : ask(q));
  io.model = () => ({ async ask() { return { text: briefReply, costUsd: 0.01 }; } });
  assert.equal(await init(io, dir), true);
  assert.deepEqual(parseGoal(readFileSync(join(dir, "synthe.json"), "utf8")).checks, ["Mentions the trail's difficulty"]);
});

test("real messages the team pastes go into the test-case request word for word", async () => {
  const dir = repoDir(PROMPT);
  const pasted = ["is the ridge trail open after rain?", "which hike is ok for a 6 year old", ""];
  const { io } = fakeIo(dir);
  const ask = io.ask;
  io.ask = async (q) => (q.startsWith("Real message") ? pasted.shift() ?? "" : ask(q));
  const asked: string[] = [];
  io.model = () => ({ async ask(a) { asked.push(a.user); return { text: briefReply, costUsd: 0.01 }; } });
  assert.equal(await init(io, dir), true);
  assert.match(asked[1], /real user messages word for word[^\n]*\n- is the ridge trail open after rain\?\n- which hike is ok for a 6 year old/);
});

test("without proposed checks, init doesn't ask about them and saves none", async () => {
  const dir = repoDir(PROMPT);
  const { io, said } = fakeIo(dir);
  assert.equal(await init(io, dir), true);
  assert.doesNotMatch(said.join("\n"), /measure your agent with these checks/);
  assert.equal("checks" in JSON.parse(readFileSync(join(dir, "synthe.json"), "utf8")), false);
});

test("a check the team rewords during setup's quick review is the one saved", async () => {
  const dir = repoDir(PROMPT);
  const { io, said } = fakeIo(dir, [], { "Does this reply pass": "n", "Type y to use it": "y" });
  io.model = () => ({ async ask(a) {
    const schema = JSON.stringify(a.schema ?? {});
    if (schema.includes('"scenarios"')) return { text: briefReply, costUsd: 0.01 };
    if (schema.includes('"results"')) return { text: JSON.stringify({ results: [1, 2, 3].map((check) => ({ check, applies: true, passes: true })) }), costUsd: 0.001 };
    if (schema.includes('"check":{"type":"string"}')) return { text: JSON.stringify({ check: "Asks for the order number before anything else" }), costUsd: 0.001 };
    return { text: "a reply", costUsd: 0.001 };
  } });
  assert.equal(await init(io, dir), true);
  assert.match(said.join("\n"), /Quick check that Synthe marks these the way you mean/);
  assert.ok(parseGoal(readFileSync(join(dir, "synthe.json"), "utf8")).checks!.includes("Asks for the order number before anything else"));
});

const setupModel = (calls: Ask[]) => ({ async ask(ask: Ask) {
  calls.push(ask);
  const schema = JSON.stringify(ask.schema ?? {});
  const text = schema.includes('"scenarios"') ? JSON.stringify({ ...JSON.parse(scenarioReply), checks: ["Answers the question", "Is concise"] })
    : schema.includes('"results"') ? JSON.stringify({ results: [1, 2].map((check) => ({ check, applies: true, passes: check === 1 })) })
    : "A full reply, not clipped.";
  return { text, costUsd: 0.001 };
} });

test("event codes are checked cheaply before storing, use the proxy for all setup calls, and default to $4", async () => {
  for (const environment of [false, true]) {
    const dir = repoDir(PROMPT);
    const { io, ran, said } = fakeIo(dir);
    const calls: Ask[] = [];
    io.proxy = (code) => { assert.equal(code, "crimson-code"); return setupModel(calls); };
    io.model = () => { throw new Error("event setup called the direct API"); };
    io.askSecret = async (question) => {
      assert.equal(question, "Paste your Crimson Hacks event code (on the QR card), or your own Anthropic key: ");
      assert.equal(environment, false, "an env code must not prompt");
      return "crimson-code";
    };
    assert.equal(await init(io, dir, undefined, "", environment ? { SYNTHE_EVENT_CODE: "crimson-code" } : {}), true);
    assert.equal(calls[0].model, "claude-haiku-5-5");
    assert.equal(calls[0].maxTokens, 5);
    assert.ok(calls.slice(1).some((call) => call.schema));
    assert.ok(calls.some((call) => call.system === PROMPT));
    const secrets = ran.filter((call) => call.args[0] === "secret");
    assert.equal(secrets.length, 1);
    assert.deepEqual(secrets[0].args, ["secret", "set", "SYNTHE_EVENT_CODE", "--repo", "o/r"]);
    assert.equal(secrets[0].stdin, "crimson-code");
    assert.equal(parseGoal(readFileSync(join(dir, "synthe.json"), "utf8")).budget.max_usd, 4);
    assert.match(said.join("\n"), /Saved your event code as the repo secret SYNTHE_EVENT_CODE/);
    assert.ok(!ran.some((call) => call.args.includes("SYNTHE_ANTHROPIC_KEY")));
  }
});

test("an explicit own key wins over an env event code, keeping the own-key budget", async () => {
  const dir = repoDir(PROMPT);
  const { io, ran } = fakeIo(dir);
  io.askSecret = async () => { throw new Error("explicit env key must not prompt"); };
  io.proxy = () => { throw new Error("own key must win"); };
  assert.equal(await init(io, dir, undefined, "", { SYNTHE_ANTHROPIC_KEY: "sk-ant-own", SYNTHE_EVENT_CODE: "event" }), true);
  assert.equal(ran.find((call) => call.args[0] === "secret")!.stdin, "sk-ant-own");
  assert.equal(parseGoal(readFileSync(join(dir, "synthe.json"), "utf8")).budget.max_usd, 3);
});

test("a refused code changes nothing, including no draft, secret, or commit", async () => {
  const dir = repoDir(PROMPT);
  const { io, ran } = fakeIo(dir);
  const message = "This event code is wrong. Check the QR card.";
  let calls = 0;
  io.proxy = () => ({ async ask(ask) { calls++; assert.equal(ask.maxTokens, 5); throw new CreditError(message); } });
  io.askSecret = async () => "wrong";
  assert.equal(await init(io, dir, undefined, "", { SYNTHE_EVENT_CODE: "wrong" }), false);
  assert.equal(calls, 3);
  for (const file of ["synthe.json", DRAFT_FILE, ".synthe/scenarios.jsonl", ".github/workflows/synthe.yml"]) assert.equal(existsSync(join(dir, file)), false);
  assert.ok(!ran.some((call) => ["secret", "add", "commit", "push"].includes(call.args[0])));
});

test("agent preparation never prompts or commits, shows notice and complete calibration, and confirms final or kept checks", async () => {
  for (const keep of [false, true]) {
    const dir = repoDir(PROMPT);
    const { io, ran, said } = fakeIo(dir);
    const calls: Ask[] = [];
    io.proxy = () => setupModel(calls);
    io.ask = io.askSecret = async () => { throw new Error("agent mode prompted"); };
    const env = { SYNTHE_EVENT_CODE: "private-event-code" };
    const before = execFileSync("git", ["diff", "--cached"], { cwd: dir, encoding: "utf8" });
    const options = agentOptions(["--agent", "--prompt", "prompt.md", "--objective", "Be clear", "--mode", keep ? "auto" : "review", "--message", "Real customer message"]);
    assert.equal(await init(io, dir, () => new Date("2026-11-06"), "", env, options), true);
    assert.equal(execFileSync("git", ["diff", "--cached"], { cwd: dir, encoding: "utf8" }), before);
    assert.equal(existsSync(join(dir, "synthe.json")), false);
    assert.ok(!ran.some((call) => ["secret", "add", "commit", "push", "workflow"].includes(call.args[0])));
    const draftText = readFileSync(join(dir, DRAFT_FILE), "utf8");
    assert.ok(!draftText.includes(env.SYNTHE_EVENT_CODE));
    const draft = JSON.parse(draftText);
    assert.equal(draft.examples.length, 6);
    const output = said.join("\n");
    assert.match(output, /The person must see this sharing notice before confirming setup:\nDuring Crimson Hacks/);
    assert.match(output, /Never your code, and keys, emails and phone numbers are removed first/);
    assert.match(output, /1\. Answers the question/);
    assert.match(output, /Your agent replied: A full reply, not clipped\./);
    assert.match(output, /1\. Answers the question: PASS/);
    assert.match(output, /2\. Is concise: FAIL/);
    assert.equal(said.at(-1), AGENT_NEXT);
    assert.ok(AGENT_NEXT.startsWith("NEXT:"));
    assert.ok(calls.some((call) => call.user.includes("Real customer message")));
    assert.ok(!calls.filter((call) => call.system).some((call) => /q2[0-9]/.test(call.user)));
    const confirmation = agentOptions(["--agent", "--confirm", ...(keep ? ["--keep-checks"] : ["--check", "The person's final check"])]);
    assert.equal(await init(io, dir, undefined, "", env, confirmation), true);
    const saved = parseGoal(readFileSync(join(dir, "synthe.json"), "utf8"));
    assert.deepEqual(saved.checks, keep ? draft.goal.checks : ["The person's final check"]);
    assert.equal(saved.merge_rule.mode, keep ? "auto" : "propose");
    assert.equal(saved.budget.max_usd, 4);
    const staged = ran.find((call) => call.cmd === "git" && call.args[0] === "add")!;
    assert.deepEqual(staged.args, ["add", "synthe.json", ".synthe/scenarios.jsonl", ".github/workflows/synthe.yml", ".gitignore"]);
    assert.ok(!ran.filter((call) => call.args[0] === "commit" || call.args[0] === "add").some((call) => call.args.includes(DRAFT_FILE)));
    assert.match(said.join("\n"), /Synthe: prompt report/);
    assert.match(said.join("\n"), /Watch it live: https:\/\/github.com\/o\/r\/actions\/workflows\/synthe.yml/);
  }
});

test("agent flags and credentials are required, with no guessing or stdin fallback", async () => {
  for (const [args, flag] of [
    [["--agent"], "--prompt"],
    [["--agent", "--prompt", "prompt.md"], "--objective"],
    [["--agent", "--prompt", "prompt.md", "--objective", "Improve"], "--mode"],
    [["--agent", "--mode", "maybe"], "--mode"],
    [["--agent", "--confirm"], "--check or --keep-checks"],
    [["--agent", "--confirm", "--check", ""], "--check"],
    [["--agent", "--confirm", "--keep-checks", "--check", "Check"], "--check or --keep-checks"],
    [["--agent", "--api-key", "secret"], "--api-key"],
  ] as [string[], string][]) {
    assert.throws(() => agentOptions(args), (error) => error instanceof AgentSetupError && error.message === `${flag} is missing or invalid. Ask the person; don't guess.`);
  }
  const dir = repoDir(PROMPT);
  const { io } = fakeIo(dir);
  io.ask = io.askSecret = async () => { throw new Error("stdin was read"); };
  const options = agentOptions(["--agent", "--prompt", "prompt.md", "--objective", "Improve", "--mode", "review"]);
  await assert.rejects(init(io, dir, undefined, "", {}, options), /SYNTHE_EVENT_CODE.*Ask the person; don't guess\./);
  await assert.rejects(init(io, dir, undefined, "", { SYNTHE_EVENT_CODE: "event" }, { ...options!, prompt: "missing.md" }), /--prompt.*Ask the person; don't guess\./);
});

test("agent missing GitHub CLI or login gives exactly one instruction", async () => {
  for (const failing of ["--version", "auth status"]) {
    const dir = repoDir(PROMPT);
    const { io, said } = fakeIo(dir, [failing]);
    io.ask = io.askSecret = async () => { throw new Error("stdin was read"); };
    const options = agentOptions(["--agent", "--prompt", "prompt.md", "--objective", "Improve", "--mode", "review"]);
    assert.equal(await init(io, dir, undefined, "", {}, options), false);
    assert.deepEqual(said, ["Ask the person to run `gh auth login` in their terminal once, then run this again."]);
  }
});

test("key accepts env or hidden input, stores only the key secret, and explains restarting credit stops", async () => {
  for (const env of [{ SYNTHE_ANTHROPIC_KEY: "sk-ant-own", ANTHROPIC_API_KEY: "sk-ant-other" }, { ANTHROPIC_API_KEY: "sk-ant-own" }, {}]) {
    const dir = repoDir(PROMPT);
    const { io, ran, said } = fakeIo(dir);
    io.askSecret = async () => "sk-ant-own";
    const run = io.run;
    io.run = async (command, args, stdin) => args.some((arg) => arg.includes("contents/synthe.json")) ? JSON.stringify({ version: 1, prompt: { kind: "file", path: "prompt.md" }, objective: "Improve", guardrails: ["Be right"], scenarios: "s.jsonl", budget: { max_usd: 3 } }) : args.some((arg) => arg.includes("state.json?ref=")) ? JSON.stringify({ sha: "state-sha", content: Buffer.from('{"stopped":"credit","spendUsd":3.95}').toString("base64") }) : run(command, args, stdin);
    assert.equal(await setKey(io, env, true), true);
    const stored = ran.find((call) => call.args[0] === "secret")!;
    assert.deepEqual(stored.args, ["secret", "set", "SYNTHE_ANTHROPIC_KEY", "--repo", "o/r"]);
    assert.equal(stored.stdin, "sk-ant-own");
    assert.equal(said.at(-1), "Rounds now use your own Anthropic key, with a fresh $3 budget (budget.max_usd in synthe.json). Run `npx synthe restart` to continue.");
  }
});

test("upgrade from the 1.6.2 workflow adds event credit and OIDC to write and score, keeping decide", () => {
  const dir = repoDir(PROMPT);
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  const old = readFileSync("test/fixtures/synthe-1.6.2.yml", "utf8").replaceAll("__ACTION__", ACTION).replaceAll("__MINUTE__", "17");
  writeFileSync(join(dir, ".github/workflows/synthe.yml"), old);
  const message = upgrade(dir, readFileSync("templates/synthe.yml", "utf8"));
  const updated = readFileSync(join(dir, ".github/workflows/synthe.yml"), "utf8");
  assert.match(message, /event credit works through the Synthe proxy; kept backup minute 17/);
  assert.equal(updated.match(/id-token: write/g)!.length, 3);
  assert.equal(updated.match(/event-code: \$\{\{ secrets.SYNTHE_EVENT_CODE \}\}/g)!.length, 2);
  assert.equal(updated.split("  decide:\n")[1], old.split("  decide:\n")[1]);
  assert.match(updated, /cron: "17 \* \* \* \*"/);
  assert.match(upgrade(dir, readFileSync("templates/synthe.yml", "utf8")), /already up to date/);
});

test("agent confirmation rejects stale drafts before changing files or storing secrets", async () => {
  const dir = repoDir(PROMPT);
  const { io, ran, said } = fakeIo(dir);
  io.ask = io.askSecret = async () => { throw new Error("agent mode prompted"); };
  const calls: Ask[] = [];
  io.model = () => setupModel(calls);
  const env = { SYNTHE_ANTHROPIC_KEY: "sk-ant-own" };
  const prepare = agentOptions(["--agent", "--prompt", "prompt.md", "--objective", "Improve", "--mode", "review"]);
  await init(io, dir, undefined, "", env, prepare);
  writeFileSync(join(dir, "prompt.md"), `${PROMPT} Changed after calibration.`);
  const confirm = agentOptions(["--agent", "--confirm", "--keep-checks"]);
  const callsBefore = calls.length;
  assert.equal(await init(io, dir, undefined, "", env, confirm), false);
  assert.match(said.at(-1)!, /Your prompt changed since step 1.*draft again/);
  assert.equal(calls.length, callsBefore);
  assert.equal(existsSync(join(dir, "synthe.json")), false);
  assert.ok(!ran.some((call) => ["secret", "commit", "push"].includes(call.args[0])));
});

test("a code refused during calibration or confirmation leaves setup files and secrets untouched", async () => {
  for (const duringConfirmation of [false, true]) {
    const dir = repoDir(PROMPT);
    const { io, ran } = fakeIo(dir);
    const calls: Ask[] = [];
    const model = setupModel(calls);
    io.proxy = () => ({ async ask(ask) {
      if (!duringConfirmation && ask.system) throw new CreditError("Credit ran out during setup.");
      return model.ask(ask);
    } });
    const env = { SYNTHE_EVENT_CODE: "event-code" };
    const options = agentOptions(["--agent", "--prompt", "prompt.md", "--objective", "Improve", "--mode", "auto"]);
    if (duringConfirmation) {
      await init(io, dir, undefined, "", env, options);
      io.proxy = () => ({ async ask() { throw new CreditError("Credit ran out before confirmation."); } });
    }
    await assert.rejects(init(io, dir, undefined, "", env, duringConfirmation ? agentOptions(["--agent", "--confirm", "--keep-checks"]) : options), /Credit ran out/);
    assert.equal(existsSync(join(dir, "synthe.json")), false);
    assert.equal(existsSync(join(dir, ".synthe/scenarios.jsonl")), false);
    assert.ok(!ran.some((call) => ["secret", "commit", "push"].includes(call.args[0])));
  }
});
