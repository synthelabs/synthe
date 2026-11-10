import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, DRAFT_FILE, AGENT_NEXT, RAW, type Io } from "../src/cli/init.ts";
import { agentOptions } from "../src/cli/agent.ts";
import { setKey } from "../src/cli/key.ts";
import { restartState } from "../src/cli/restart.ts";
import { newState, stopReason, type State } from "../src/core/state.ts";
import { oidcToken, PROXY_AUTH_MESSAGE } from "../src/core/share.ts";
import { anthropicModel, CreditError, modelProblem, ProxyError, proxyModel, type Ask } from "../src/model/client.ts";
import { failureOf } from "../src/loop/failure.ts";
import { renderReport } from "../src/loop/report.ts";
import { runDecide } from "../src/loop/decide.ts";
import { goal, MemoryRepo } from "./helpers.ts";

const prepare = agentOptions(["--agent", "--prompt", "prompt.md", "--objective", "Be helpful", "--mode", "review"]);
const confirmation = agentOptions(["--agent", "--confirm", "--keep-checks"]);
const scenarios = JSON.stringify({ guardrails: ["Never lie"], policy: "", checks: [], scenarios: Array.from({ length: 80 }, (_, index) => ({ input: `question ${index}`, expected: "A useful reply" })) });
const cheap = { model: "claude-haiku-5-5", user: "Say OK.", maxTokens: 5 };
const TEAM = "crim-abcd-efgh-jkmn-pqrs";
const teamPrompt = (question: string) => question.startsWith("Paste your team code");

function setup(context: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "synthe-review-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "prompt.md"), "You help hikers pick safe trails.");
  const said: string[] = [];
  const ran: { command: string; args: string[]; stdin?: string }[] = [];
  const calls: { key: string; proxy: boolean; ask: Ask }[] = [];
  const io: Io = {
    say: (message) => said.push(message),
    ask: async (question) => question.includes("automatically") ? "n" : question.startsWith("Real message") ? "" : "Be helpful",
    askSecret: async () => "",
    run: async (command, args, stdin) => {
      if (args.includes(RAW)) return readFileSync(join(root, decodeURIComponent(args.at(-1)!.split("/contents/")[1].split("?")[0])), "utf8");
      ran.push({ command, args, stdin });
      if (command === "git") return args[0] === "ls-files" ? "prompt.md" : args[0] === "rev-parse" ? "main" : "";
      if (args.includes("nameWithOwner")) return "team/repo";
      if (args.includes("defaultBranchRef")) return "main";
      return "";
    },
    model: (key) => ({ ask: async (ask) => { calls.push({ key, proxy: false, ask }); return { text: ask.schema ? scenarios : "OK", costUsd: 0.001 }; } }),
    proxy: (key) => ({ ask: async (ask) => { calls.push({ key, proxy: true, ask }); return { text: ask.schema ? scenarios : "OK", costUsd: 0.001 }; } }),
    template: () => "uses: __ACTION__\ncron: __MINUTE__",
    sleep: async () => {},
  };
  return { root, io, said, ran, calls };
}

test("review: event credential beats the app key in interactive and both agent steps", async (context) => {
  for (const agent of [false, true]) {
    const { root, io, said, ran, calls } = setup(context);
    io.model = () => { throw new Error("The student's app key must not be charged"); };
    io.askSecret = async () => { throw new Error("Explicit event code must not prompt"); };
    const env = { SYNTHE_EVENT_CODE: "crimson", SYNTHE_TEAM_CODE: TEAM };
    assert.equal(await init(io, root, undefined, "sk-ant-app", env, agent ? prepare : undefined), true);
    assert.ok(calls.every((call) => call.proxy && call.key === "crimson"));
    assert.match(said.join("\n"), /Credential: Crimson Hacks event code, \$4 local run budget \(not a credit allowance\)/);
    assert.match(said.join("\n"), /organizer-configured caps and shared availability; it can stop sooner/);
    assert.doesNotMatch(said.join("\n"), /\$4 of event credit|gets \$4/);
    if (!agent) assert.match(said.join("\n"), /This is not a credit allowance\. Organizer-configured caps and shared event availability can stop it sooner/);
    assert.doesNotMatch(said.join("\n"), agent ? /Optional: paste up to 5 messages|Press Enter/ : /never matches/);
    if (agent) {
      assert.match(AGENT_NEXT, /Tell the person which credential and budget/);
      assert.doesNotMatch(AGENT_NEXT, /share none|--share|DO_NOT_TRACK|choose/i);
      assert.equal(await init(io, root, undefined, "sk-ant-app", env, confirmation), true);
    }
    assert.equal(ran.find((call) => call.args[0] === "secret")!.stdin, "crimson");
    assert.equal(ran.find((call) => call.args[2] === "SYNTHE_TEAM_CODE")!.stdin, TEAM);
    assert.equal(JSON.parse(readFileSync(join(root, "synthe.json"), "utf8")).budget.max_usd, 4);
  }
});

test("review: explicit Synthe own key wins everywhere; app fallback discloses its account", async (context) => {
  for (const agent of [false, true]) {
    for (const explicit of [false, true]) {
      const { root, io, said, ran, calls } = setup(context);
      const env = explicit ? { SYNTHE_ANTHROPIC_KEY: "sk-ant-own", SYNTHE_EVENT_CODE: "crimson" } : {};
      if (agent && !explicit) {
        await assert.rejects(init(io, root, undefined, "sk-ant-app", env, prepare), /agent setup never uses ANTHROPIC_API_KEY/);
        assert.equal(calls.length, 0);
        assert.equal(existsSync(join(root, DRAFT_FILE)), false);
        assert.equal(ran.some((call) => call.args[0] === "secret"), false);
        continue;
      }
      assert.equal(await init(io, root, undefined, "sk-ant-app", env, agent ? prepare : undefined), true);
      assert.equal(calls[0].key, explicit ? "sk-ant-own" : "sk-ant-app");
      assert.ok(calls.every((call) => !call.proxy));
      assert.ok(said.includes(`Credential: your own key from ${explicit ? "SYNTHE_ANTHROPIC_KEY" : "ANTHROPIC_API_KEY"}, $3 budget on your Anthropic account.`));
      if (agent) assert.equal(await init(io, root, undefined, "sk-ant-app", env, confirmation), true);
      assert.equal(ran.find((call) => call.args[0] === "secret")!.stdin, explicit ? "sk-ant-own" : "sk-ant-app");
    }
  }
});

test("review: confirmation shares respect opt-outs, explicit choice, and draft default", async (context) => {
  for (const [env, share, expected] of [
    [{ DO_NOT_TRACK: "1" }, "detail", "none"], [{ DO_NOT_TRACK: "TRUE" }, undefined, "none"],
    [{ SYNTHE_TELEMETRY: "0" }, "numbers", "none"], [{ SYNTHE_TELEMETRY: "false" }, undefined, "none"],
    [{}, "none", "none"], [{}, "numbers", "numbers"], [{}, "detail", "detail"], [{}, undefined, "full"],
  ] as const) {
    const { root, io, ran } = setup(context);
    assert.equal(await init(io, root, () => new Date("2026-11-06"), "sk-ant-own", { SYNTHE_ANTHROPIC_KEY: "sk-ant-own" }, prepare), true);
    const options = agentOptions(["--agent", "--confirm", "--keep-checks", ...(share ? ["--share", share] : [])]);
    assert.equal(await init(io, root, undefined, "sk-ant-own", { ...env, SYNTHE_ANTHROPIC_KEY: "sk-ant-own" }, options), true);
    assert.equal(JSON.parse(readFileSync(join(root, "synthe.json"), "utf8")).share, expected);
    assert.equal(JSON.parse(readFileSync(join(root, "synthe.json"), "utf8")).share_notice, expected === "none" ? undefined : "crimson-2026-11-v1");
    assert.equal(existsSync(join(root, DRAFT_FILE)), false);
    assert.match(readFileSync(join(root, ".gitignore"), "utf8"), /^\/\.synthe\/setup-draft.json\n$/);
    assert.ok(!ran.find((call) => call.args[0] === "add")!.args.includes(".gitignore"));
    assert.ok(!ran.find((call) => call.args[0] === "commit")!.args.includes(".gitignore"));
    assert.ok(!ran.find((call) => call.args[0] === "add")!.args.includes(DRAFT_FILE));
  }
  assert.throws(() => agentOptions(["--agent", "--confirm", "--keep-checks", "--share", "full"]), /--share/);
  // The notice version follows the level chosen at confirmation, including turning sharing back on.
  const { root, io } = setup(context);
  assert.equal(await init(io, root, () => new Date("2026-11-06"), "sk-ant-own", { SYNTHE_ANTHROPIC_KEY: "sk-ant-own" }, agentOptions(["--agent", "--prompt", "prompt.md", "--objective", "Be helpful", "--mode", "review", "--share", "none"])), true);
  assert.equal(JSON.parse(readFileSync(join(root, DRAFT_FILE), "utf8")).goal.share_notice, undefined);
  assert.equal(await init(io, root, undefined, "sk-ant-own", { SYNTHE_ANTHROPIC_KEY: "sk-ant-own" }, agentOptions(["--agent", "--confirm", "--keep-checks", "--share", "detail"])), true);
  const saved = JSON.parse(readFileSync(join(root, "synthe.json"), "utf8"));
  assert.equal(saved.share, "detail");
  assert.equal(saved.share_notice, "crimson-2026-11-v1");
});

test("review: confirmation refuses a changed credential type without changing the draft", async (context) => {
  const { root, io, ran } = setup(context);
  await init(io, root, undefined, "", { SYNTHE_EVENT_CODE: "crimson", SYNTHE_TEAM_CODE: TEAM }, prepare);
  const before = readFileSync(join(root, DRAFT_FILE), "utf8");
  await assert.rejects(init(io, root, undefined, "sk-ant-app", { SYNTHE_ANTHROPIC_KEY: "sk-ant-app" }, confirmation), /same credential type as step 1/);
  assert.equal(readFileSync(join(root, DRAFT_FILE), "utf8"), before);
  assert.equal(ran.some((call) => call.args[0] === "secret"), false);
});

test("review: confirmation never falls back to the app key", async (context) => {
  const { root, io, calls, ran } = setup(context);
  await init(io, root, undefined, "sk-ant-app", { SYNTHE_EVENT_CODE: "crimson", SYNTHE_TEAM_CODE: TEAM }, prepare);
  const before = readFileSync(join(root, DRAFT_FILE), "utf8");
  const count = calls.length;
  await assert.rejects(init(io, root, undefined, "sk-ant-app", {}, confirmation), /agent setup never uses ANTHROPIC_API_KEY/);
  assert.equal(calls.length, count);
  assert.equal(readFileSync(join(root, DRAFT_FILE), "utf8"), before);
  assert.equal(ran.some((call) => call.args[0] === "secret"), false);
});

test("review: interactive setup never sends another provider's key", async (context) => {
  const { root, io, calls, said } = setup(context);
  const answers = ["sk-proj-private", "crimson"];
  io.askSecret = async (question) => teamPrompt(question) ? TEAM : answers.shift()!;
  assert.equal(await init(io, root, undefined, "", {}), true);
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => call.key === "crimson" && call.proxy));
  assert.match(said.join("\n"), /another provider's key.*Nothing was sent/);
});

test("review: confirming twice or drafting an installed default branch refuses in one line", async (context) => {
  const { root, io, said, ran } = setup(context);
  await init(io, root, undefined, "sk-ant-own", { SYNTHE_ANTHROPIC_KEY: "sk-ant-own" }, prepare);
  await init(io, root, undefined, "sk-ant-own", { SYNTHE_ANTHROPIC_KEY: "sk-ant-own" }, confirmation);
  assert.equal(existsSync(join(root, DRAFT_FILE)), false);
  const pushed = io.run;
  io.run = async (command, args, stdin) => args.includes(".path") ? args.some((arg) => arg.includes("contents/synthe.json")) ? "synthe.json" : ".github/workflows/synthe.yml" : pushed(command, args, stdin);
  for (const options of [confirmation, prepare, undefined]) {
    const before = ran.filter((call) => call.args[0] === "secret").length;
    assert.equal(await init(io, root, undefined, "sk-ant-own", {}, options), false);
    assert.equal(said.at(-1), "Synthe is already set up on the default branch. Use `npx synthe restart` to continue; don't run init again.");
    assert.equal(ran.filter((call) => call.args[0] === "secret").length, before);
  }
  const remote = setup(context);
  const run = remote.io.run;
  remote.io.run = async (command, args, stdin) => args.includes(".path") ? args.some((arg) => arg.includes("contents/synthe.json")) ? "synthe.json" : ".github/workflows/synthe.yml" : run(command, args, stdin);
  assert.equal(await init(remote.io, remote.root, undefined, "sk-ant-own", {}, prepare), false);
  assert.equal(existsSync(join(remote.root, DRAFT_FILE)), false);
});

test("review: interactive bad codes retry before asking any setup questions", async (context) => {
  const { root, io, said, calls } = setup(context);
  const ask = io.ask;
  let attempts = 0;
  let teamAsks = 0;
  io.askSecret = async (question) => teamPrompt(question) ? (teamAsks++, TEAM) : ++attempts === 1 ? "mistyped" : "crimson";
  const proxy = io.proxy!;
  io.proxy = (key) => key === "mistyped" ? { ask: async (request) => { assert.deepEqual(request, cheap); throw new CreditError("That event code is wrong."); } } : proxy(key);
  io.ask = async (question) => { assert.equal(attempts, 2); return ask(question); };
  assert.equal(await init(io, root, undefined, "", {}), true);
  assert.ok(said.includes("That event code is wrong."));
  assert.equal(teamAsks, 1, "a typed team code is reused when only the event code was wrong");
  assert.ok(calls.every((call) => call.key === "crimson"));
  const failed = setup(context);
  failed.io.ask = async () => { throw new Error("Setup questions must wait"); };
  failed.io.askSecret = async (question) => teamPrompt(question) ? TEAM : "wrong";
  let failures = 0;
  failed.io.proxy = () => ({ ask: async () => { failures++; throw new CreditError("Wrong code"); } });
  assert.equal(await init(failed.io, failed.root, undefined, "", {}), false);
  assert.equal(failures, 3);
  assert.match(failed.said.at(-1)!, /^Nothing in your repo was changed/);
  assert.equal(failed.ran.some((call) => call.args[0] === "secret"), false);
});

test("review: team codes are checked for shape before any call, and a refused team code is asked again", async (context) => {
  const { root, io, said, ran } = setup(context);
  const typed = ["crim-1234", "crim-zzzz-zzzz-zzzz-zzzz", TEAM];
  let events = 0;
  io.askSecret = async (question) => teamPrompt(question) ? typed.shift()! : (events++, "crimson");
  const proxy = io.proxy!;
  const refusal = "The Synthe proxy refused this request: That team code isn't recognised. Check the card from the Synthe table.";
  const tried: (string | undefined)[] = [];
  io.proxy = (key, team) => { tried.push(team); return team === "crim-zzzz-zzzz-zzzz-zzzz" ? { ask: async () => { throw new ProxyError(403, refusal); } } : proxy(key, team); };
  assert.equal(await init(io, root, undefined, "", {}), true);
  assert.ok(said.includes("That doesn't look like a team code. It looks like crim-xxxx-xxxx-xxxx-xxxx."));
  assert.ok(said.includes(refusal));
  assert.ok(!tried.includes("crim-1234"), "a malformed team code is never sent");
  assert.equal(typed.length, 0);
  assert.equal(events, 2);
  assert.equal(ran.find((call) => call.args[2] === "SYNTHE_TEAM_CODE")!.stdin, TEAM);
  const env = setup(context);
  env.io.askSecret = async (question) => teamPrompt(question) ? TEAM : "crimson";
  const envProxy = env.io.proxy!;
  env.io.proxy = (key, team) => team === "crim-zzzz-zzzz-zzzz-zzzz" ? { ask: async () => { throw new ProxyError(403, refusal); } } : envProxy(key, team);
  assert.equal(await init(env.io, env.root, undefined, "", { SYNTHE_EVENT_CODE: "crimson", SYNTHE_TEAM_CODE: "crim-zzzz-zzzz-zzzz-zzzz" }), true);
  assert.equal(env.ran.find((call) => call.args[2] === "SYNTHE_TEAM_CODE")!.stdin, TEAM, "a refused env team code is replaced by the typed one");
});

function keyIo(state: State, maxUsd = 4) {
  const said: string[] = [];
  const ran: string[][] = [];
  const calls: Ask[] = [];
  let saved = state;
  const io: Io = {
    say: (message) => said.push(message), ask: async () => "", askSecret: async () => "sk-ant-own",
    model: () => ({ ask: async (request) => { calls.push(request); return { text: "OK", costUsd: 0.001 }; } }),
    template: () => "", sleep: async () => {},
    run: async (_command, args) => {
      ran.push(args);
      if (args[0] === "repo") return "team/repo";
      if (args.some((arg) => arg.includes("contents/synthe.json"))) return JSON.stringify(goal({ budget: { max_usd: maxUsd } }));
      if (args.some((arg) => arg.includes("state.json?ref="))) return JSON.stringify({ sha: "old-state", content: Buffer.from(JSON.stringify(saved)).toString("base64") });
      if (args.includes("PUT")) {
        assert.ok(args.includes("branch=synthe/state"));
        assert.ok(args.includes("sha=old-state"));
        saved = JSON.parse(Buffer.from(args.find((arg) => arg.startsWith("content="))!.slice(8), "base64").toString("utf8"));
      }
      return "";
    },
  };
  return { io, said, ran, calls, saved: () => saved };
}

test("review: a confirmation that failed after writing local files can run again", async (context) => {
  const { root, io, ran } = setup(context);
  await init(io, root, undefined, "sk-ant-own", { SYNTHE_ANTHROPIC_KEY: "sk-ant-own" }, prepare);
  const run = io.run;
  io.run = async (command, args, stdin) => { if (args[0] === "secret") throw new Error("HTTP 403: Resource not accessible"); return run(command, args, stdin); };
  await assert.rejects(init(io, root, undefined, "sk-ant-own", { SYNTHE_ANTHROPIC_KEY: "sk-ant-own" }, confirmation), /403/);
  assert.ok(existsSync(join(root, "synthe.json")));
  io.run = run;
  assert.notEqual(await init(io, root, undefined, "sk-ant-own", { SYNTHE_ANTHROPIC_KEY: "sk-ant-own" }, confirmation), false);
  assert.ok(ran.some((call) => call.args[0] === "secret"));
});

test("review: key switches at current spend, restart grants fresh budget, then stops correctly", async () => {
  for (const stopped of ["credit", "budget of $4 is used"]) {
    const state = { ...newState(), stopped, spendUsd: stopped === "credit" ? 3.95 : 4 };
    const fake = keyIo(state);
    fake.io.askSecret = async () => "";
    assert.equal(await setKey(fake.io, { ANTHROPIC_API_KEY: "sk-ant-own" }, true), true);
    assert.deepEqual(fake.calls, [cheap]);
    assert.ok(fake.said.includes("Using the key in ANTHROPIC_API_KEY."));
    assert.equal(fake.saved().ownKeyFromUsd, state.spendUsd);
    assert.equal(fake.said.at(-1), "Rounds now use your own Anthropic key, with a fresh $4 budget (budget.max_usd in synthe.json). Run `npx synthe restart` to continue.");
    const next = restartState(goal({ budget: { max_usd: 4 } }), fake.saved());
    assert.ok("state" in next);
    assert.equal(stopReason(next.state, 12, 3, 4), null);
    next.state.spendUsd = state.spendUsd + 3.99;
    assert.equal(stopReason(next.state, 12, 3, 4), null);
    next.state.spendUsd = state.spendUsd + 4;
    assert.equal(stopReason(next.state, 12, 3, 4), "budget of $4 is used");
    next.state.stopped = "budget of $4 is used";
    assert.ok("why" in restartState(goal({ budget: { max_usd: 4 } }), next.state));
    assert.ok("state" in restartState(goal({ budget: { max_usd: 5 } }), next.state));
    assert.match(renderReport(goal(), next.state), /Raise budget.max_usd.*npx synthe restart/);
    assert.doesNotMatch(renderReport(goal(), next.state), /npx synthe key/);
    assert.doesNotMatch((restartState(goal({ budget: { max_usd: 4 } }), next.state) as { why: string }).why, /npx synthe key/);
  }
  const running = keyIo(newState(), 3);
  await setKey(running.io, { SYNTHE_ANTHROPIC_KEY: "sk-ant-own" });
  assert.equal(running.said.at(-1), "Rounds now use your own Anthropic key, with a fresh $3 budget (budget.max_usd in synthe.json).");
  assert.ok("state" in restartState(goal({ budget: { max_usd: 5 } }), { ...newState(), spendUsd: 4, stopped: "budget of $4 is used" }));
});

test("review: a second key keeps the first switch's budget, so replacing keys can't reset spending", async () => {
  const stopped = { ...newState(), stopped: "budget of $4 is used", spendUsd: 8, ownKeyFromUsd: 4 };
  const fake = keyIo(stopped);
  assert.equal(await setKey(fake.io, { SYNTHE_ANTHROPIC_KEY: "sk-ant-new" }), true);
  assert.equal(fake.saved().ownKeyFromUsd, 4);
  assert.equal(fake.ran.some((args) => args.includes("PUT")), false);
  assert.equal(fake.said.at(-1), "Rounds now use this Anthropic key. The budget is unchanged: $4 from when you first ran `npx synthe key` (budget.max_usd in synthe.json). To keep going, raise budget.max_usd in synthe.json and push it, then run `npx synthe restart`.");
  assert.ok("why" in restartState(goal({ budget: { max_usd: 4 } }), fake.saved()));
});

test("review: key closed stdin and non-Anthropic keys fail without reading or saving", async () => {
  for (const env of [{}, { SYNTHE_ANTHROPIC_KEY: "event-code" }, { ANTHROPIC_API_KEY: "sk-ant-app" }]) {
    const fake = keyIo(newState());
    fake.io.askSecret = async () => { throw new Error("Closed stdin must never prompt"); };
    assert.equal(await setKey(fake.io, env, false), false);
    assert.equal(fake.ran.length, 0);
    assert.equal(fake.calls.length, 0);
    assert.equal(fake.said.at(-1), "SYNTHE_ANTHROPIC_KEY" in env ? "That doesn't look like an Anthropic key: it must start with sk-ant-. Nothing changed." : "Ask the person to run `npx synthe key` in their own terminal.");
  }
});

test("review: key validates with five-token Haiku before any mutation; failure changes nothing", async () => {
  const fake = keyIo({ ...newState(), stopped: "credit", spendUsd: 3.95 });
  fake.io.model = () => ({ ask: async (request) => { assert.deepEqual(request, cheap); throw { status: 401, message: "invalid key" }; } });
  assert.equal(await setKey(fake.io, { SYNTHE_ANTHROPIC_KEY: "sk-ant-bad" }), false);
  assert.equal(fake.ran.length, 2);
  assert.ok(fake.ran.every((args) => args[0] === "repo" || args[0] === "api" && !args.includes("-X")));
  assert.equal(fake.saved().ownKeyFromUsd, undefined);
  assert.equal(fake.said.at(-1), "Your Anthropic key was rejected. Run `npx synthe key` to replace it. Nothing changed.");
});

test("review: key refuses missing default-branch setup before calling the model or changing secrets", async () => {
  const fake = keyIo(newState());
  const run = fake.io.run;
  fake.io.run = async (command, args, stdin) => {
    if (args.some((arg) => arg.includes("contents/synthe.json"))) throw new Error("HTTP 404: Not Found");
    return run(command, args, stdin);
  };
  assert.equal(await setKey(fake.io, { SYNTHE_ANTHROPIC_KEY: "sk-ant-own" }), false);
  assert.equal(fake.calls.length, 0);
  assert.ok(fake.ran.every((args) => args[0] === "repo"));
  assert.match(fake.said.at(-1)!, /Finish `npx synthe init` and merge its setup pull request/);
});

test("review: credit report always includes the own-key next step, even for a terse proxy message", async () => {
  const repo = new MemoryRepo("Old prompt.");
  await runDecide(goal(), repo, { candidates: null, scores: null, costUsd: null, error: failureOf("write", new CreditError("Credit exhausted.")) });
  assert.match(repo.issue, /To use your own Anthropic key, run `npx synthe key`, then `npx synthe restart`/);
  assert.match(repo.issue, /delete whichever of the `SYNTHE_ANTHROPIC_KEY`, `SYNTHE_EVENT_CODE` and `SYNTHE_TEAM_CODE` secrets your repo has/);
});

test("review: Anthropic key failures direct people to synthe key", () => {
  for (const error of [{ status: 401 }, { status: 403 }, { message: "credit balance is too low" }, { message: "spend limit reached" }]) {
    assert.match(modelProblem(error)!, /Run `npx synthe key`/);
    assert.doesNotMatch(modelProblem(error)!, /Synthe table|gh secret set/);
    assert.equal(failureOf("write", error).kind, "key");
  }
});

test("review: missing Action OIDC fails before GitHub/model calls with upgrade advice", (context) => {
  const { root } = setup(context);
  const env: NodeJS.ProcessEnv = { ...process.env, INPUT_STEP: "write", SYNTHE_EVENT_CODE: "crimson", GITHUB_REPOSITORY: "team/repo", GITHUB_API_URL: "http://127.0.0.1:9" };
  for (const name of ["ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN", "SYNTHE_ANTHROPIC_KEY", "INPUT_ANTHROPIC-API-KEY", "INPUT_EVENT-CODE"]) delete env[name];
  const result = spawnSync(process.execPath, [join(import.meta.dirname, "../src/action.ts")], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /The Synthe proxy couldn't verify this GitHub run/);
  assert.equal(JSON.parse(readFileSync(join(root, ".synthe-out/error.json"), "utf8")).message, PROXY_AUTH_MESSAGE);
});

test("review: OIDC JWT is cached until sixty seconds before expiry, scoped to audience", async () => {
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  let requests = 0;
  const fetcher = (async () => new Response(JSON.stringify({ value: `header.${Buffer.from(JSON.stringify({ exp: (now + 300_000) / 1000 })).toString("base64url")}.signature-${++requests}` }))) as typeof fetch;
  const env = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "github-token" };
  try {
    const first = await oidcToken("synthe-proxy", env, fetcher);
    assert.equal(await oidcToken("synthe-proxy", env, fetcher), first);
    now += 239_000;
    assert.equal(await oidcToken("synthe-proxy", env, fetcher), first);
    now += 1_000;
    assert.notEqual(await oidcToken("synthe-proxy", env, fetcher), first);
    await oidcToken("synthe-share", env, fetcher);
    assert.equal(requests, 3);
    await assert.rejects(oidcToken("synthe-proxy", {}, fetcher), { message: PROXY_AUTH_MESSAGE });
  } finally { Date.now = originalNow; }
});

test("review: proxy 401/503/429 stay distinct, preserve advice, and proxy retries only twice", async (context) => {
  let status = 401;
  let proxyAuth: boolean | undefined = true;
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    request.resume();
    response.writeHead(status, { "content-type": "application/json", "retry-after-ms": "1", "x-should-retry": status === 500 ? "true" : "false" });
    response.end(JSON.stringify({ type: "error", error: { type: status === 401 ? proxyAuth === undefined ? undefined : proxyAuth ? "synthe_proxy_auth" : "authentication_error" : status === 429 ? "rate_limit_error" : "api_error", message: status === 503 ? "Credit is unavailable. Ask at the Synthe table." : "refused" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const previous = { ...process.env };
  context.after(() => { process.env = previous; });
  const config = mkdtempSync(join(tmpdir(), "synthe-review-config-"));
  context.after(() => rmSync(config, { recursive: true, force: true }));
  process.env.XDG_CONFIG_HOME = config;
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.SYNTHE_PROXY_URL = base;
  process.env.SYNTHE_ANTHROPIC_BASE_URL = base;
  process.env.ANTHROPIC_LOG = "debug";
  for (const [code, message, kind] of [[401, PROXY_AUTH_MESSAGE, "key"], [503, "Credit is unavailable. Ask at the Synthe table.", "busy"], [429, "Synthe's proxy is busy. Wait a few minutes and try again.", "busy"]] as const) {
    status = code;
    requests = 0;
    let failure;
    await assert.rejects(proxyModel("private-event-code").ask(cheap), (error) => {
      assert.equal(modelProblem(error), message);
      failure = failureOf("write", error);
      assert.equal(failure.kind, kind);
      return true;
    });
    assert.equal(requests, 1);
    const repo = new MemoryRepo("Old prompt.");
    const record = await runDecide(goal(), repo, { candidates: null, scores: null, costUsd: null, error: failure });
    assert.equal(record!.plain, message);
    assert.ok(repo.issue.includes(message));
    assert.doesNotMatch(repo.issue, /Anthropic's API was busy|gh secret set/);
    if (kind === "busy") assert.equal(repo.state.chainReady, true);
  }
  status = 401;
  for (const kind of [false, undefined]) {
    proxyAuth = kind;
    requests = 0;
    await assert.rejects(proxyModel("private-event-code").ask(cheap), (error) => {
      assert.ok(error instanceof CreditError);
      assert.equal(failureOf("write", error).kind, "credit");
      assert.match(error.message, /sponsored Anthropic key was rejected.*Synthe table/);
      assert.doesNotMatch(error.message, /synthe upgrade|workflow-upgrade|rotate/);
      return true;
    });
    assert.equal(requests, 1);
  }
  status = 500;
  requests = 0;
  await assert.rejects(proxyModel("private-event-code").ask(cheap));
  assert.equal(requests, 3);
  process.env.ANTHROPIC_LOG = "off";
  requests = 0;
  await assert.rejects(anthropicModel("sk-ant-own").ask(cheap));
  assert.equal(requests, 5);
});
