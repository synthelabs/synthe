import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, DRAFT_FILE, AGENT_NEXT, RAW, type Io } from "../src/cli/init.ts";
import { agentOptions } from "../src/cli/agent.ts";
import { setKey } from "../src/cli/key.ts";
import { restartState } from "../src/cli/restart.ts";
import { newState, stopReason, type State } from "../src/core/state.ts";
import { oidcToken, SHARE_NOTICE_VERSION } from "../src/core/share.ts";
import { anthropicModel, modelProblem, type Ask } from "../src/model/client.ts";
import { failureOf } from "../src/loop/failure.ts";
import { renderReport } from "../src/loop/report.ts";
import { runDecide } from "../src/loop/decide.ts";
import { goal, MemoryRepo } from "./helpers.ts";

const prepare = agentOptions(["--agent", "--prompt", "prompt.md", "--objective", "Be helpful", "--mode", "review"]);
const confirmation = agentOptions(["--agent", "--confirm", "--keep-checks"]);
const scenarios = JSON.stringify({ guardrails: ["Never lie"], policy: "", checks: [], scenarios: Array.from({ length: 80 }, (_, index) => ({ input: `question ${index}`, expected: "A useful reply" })) });
const cheap = { model: "claude-haiku-5-5", user: "Say OK.", maxTokens: 5 };

function setup(context: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "synthe-review-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "prompt.md"), "You help hikers pick safe trails.");
  const said: string[] = [];
  const ran: { command: string; args: string[]; stdin?: string }[] = [];
  const calls: { key: string; ask: Ask }[] = [];
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
    model: (key) => ({ ask: async (ask) => { calls.push({ key, ask }); return { text: ask.schema ? scenarios : "OK", costUsd: 0.001 }; } }),
    template: () => "uses: __ACTION__\ncron: __MINUTE__",
    sleep: async () => {},
  };
  return { root, io, said, ran, calls };
}

test("review: explicit Synthe own key wins everywhere; app fallback discloses its account", async (context) => {
  for (const agent of [false, true]) {
    for (const explicit of [false, true]) {
      const { root, io, said, ran, calls } = setup(context);
      const env = explicit ? { SYNTHE_ANTHROPIC_KEY: "sk-ant-own" } : {};
      if (agent && !explicit) {
        await assert.rejects(init(io, root, undefined, "sk-ant-app", env, prepare), /agent setup never uses ANTHROPIC_API_KEY/);
        assert.equal(calls.length, 0);
        assert.equal(existsSync(join(root, DRAFT_FILE)), false);
        assert.equal(ran.some((call) => call.args[0] === "secret"), false);
        continue;
      }
      assert.equal(await init(io, root, undefined, "sk-ant-app", env, agent ? prepare : undefined), true);
      assert.ok(calls.length > 0 && calls.every((call) => call.key === (explicit ? "sk-ant-own" : "sk-ant-app")));
      assert.ok(said.includes(`Credential: your own key from ${explicit ? "SYNTHE_ANTHROPIC_KEY" : "ANTHROPIC_API_KEY"}, $3 budget on your Anthropic account.`));
      assert.doesNotMatch(said.join("\n"), /not a credit allowance|caps/);
      if (agent) {
        assert.doesNotMatch(said.join("\n"), /Optional: paste up to 5 messages|Press Enter/);
        assert.match(AGENT_NEXT, /Tell the person which credential and budget/);
        assert.doesNotMatch(AGENT_NEXT, /share none|--share|DO_NOT_TRACK|choose/i);
        assert.equal(await init(io, root, undefined, "sk-ant-app", env, confirmation), true);
      }
      assert.equal(JSON.parse(readFileSync(join(root, "synthe.json"), "utf8")).budget.max_usd, 3);
      assert.equal(ran.find((call) => call.args[0] === "secret")!.stdin, explicit ? "sk-ant-own" : "sk-ant-app");
    }
  }
});

test("review: confirmation shares respect opt-outs, explicit choice, and draft default", async (context) => {
  for (const [env, share, expected] of [
    [{ DO_NOT_TRACK: "1" }, "detail", "none"], [{ DO_NOT_TRACK: "TRUE" }, undefined, "none"],
    [{ SYNTHE_TELEMETRY: "0" }, "numbers", "none"], [{ SYNTHE_TELEMETRY: "false" }, undefined, "none"],
    [{}, "none", "none"], [{}, "numbers", "numbers"], [{}, "detail", "detail"], [{}, undefined, "detail"],
  ] as const) {
    const { root, io, ran } = setup(context);
    assert.equal(await init(io, root, () => new Date("2026-11-06"), "sk-ant-own", { SYNTHE_ANTHROPIC_KEY: "sk-ant-own" }, prepare), true);
    const options = agentOptions(["--agent", "--confirm", "--keep-checks", ...(share ? ["--share", share] : [])]);
    assert.equal(await init(io, root, undefined, "sk-ant-own", { ...env, SYNTHE_ANTHROPIC_KEY: "sk-ant-own" }, options), true);
    assert.equal(JSON.parse(readFileSync(join(root, "synthe.json"), "utf8")).share, expected);
    assert.equal(JSON.parse(readFileSync(join(root, "synthe.json"), "utf8")).share_notice, expected === "none" ? undefined : SHARE_NOTICE_VERSION);
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
  assert.equal(saved.share_notice, SHARE_NOTICE_VERSION);
});

test("review: confirmation never falls back to the app key", async (context) => {
  const { root, io, calls, ran } = setup(context);
  await init(io, root, undefined, "sk-ant-app", { SYNTHE_ANTHROPIC_KEY: "sk-ant-own" }, prepare);
  const before = readFileSync(join(root, DRAFT_FILE), "utf8");
  const count = calls.length;
  await assert.rejects(init(io, root, undefined, "sk-ant-app", {}, confirmation), /agent setup never uses ANTHROPIC_API_KEY/);
  assert.equal(calls.length, count);
  assert.equal(readFileSync(join(root, DRAFT_FILE), "utf8"), before);
  assert.equal(ran.some((call) => call.args[0] === "secret"), false);
});

test("review: interactive setup never sends another provider's key", async (context) => {
  const { root, io, calls, said } = setup(context);
  const answers = ["sk-proj-private", "sk-ant-own"];
  io.askSecret = async () => answers.shift()!;
  assert.equal(await init(io, root, undefined, "", {}), true);
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => call.key === "sk-ant-own"));
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

test("review: interactive bad keys retry before asking any setup questions", async (context) => {
  const { root, io, said, calls } = setup(context);
  const ask = io.ask;
  let attempts = 0;
  io.askSecret = async () => ++attempts === 1 ? "sk-ant-mistyped" : "sk-ant-own";
  const model = io.model;
  io.model = (key) => key === "sk-ant-mistyped" ? { ask: async (request) => { assert.deepEqual(request, cheap); throw { status: 401, message: "invalid x-api-key" }; } } : model(key);
  io.ask = async (question) => { assert.equal(attempts, 2); return ask(question); };
  assert.equal(await init(io, root, undefined, "", {}), true);
  assert.ok(said.includes("Your Anthropic key was rejected. Run `npx synthe key` to replace it."));
  assert.ok(calls.length > 0 && calls.every((call) => call.key === "sk-ant-own"));
  const failed = setup(context);
  failed.io.ask = async () => { throw new Error("Setup questions must wait"); };
  failed.io.askSecret = async () => "sk-ant-wrong";
  let failures = 0;
  failed.io.model = () => ({ ask: async () => { failures++; throw { status: 401, message: "invalid x-api-key" }; } });
  assert.equal(await init(failed.io, failed.root, undefined, "", {}), false);
  assert.equal(failures, 3);
  assert.match(failed.said.at(-1)!, /^Nothing in your repo was changed/);
  assert.equal(failed.ran.some((call) => call.args[0] === "secret"), false);
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
  for (const env of [{}, { SYNTHE_ANTHROPIC_KEY: "not-an-anthropic-key" }, { ANTHROPIC_API_KEY: "sk-ant-app" }]) {
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

// Older versions stopped a run with stopped: "credit". Such state files must still render and restart.
test("review: an older credit stop still reports the own-key next step, and restart clears it", () => {
  const failed = { round: 2, at: "2026-11-06T23:00:00Z", outcome: "failed" as const, failure: "credit" as const, reasons: ["Credit exhausted."], costUsd: null, plain: "Credit exhausted." };
  const state: State = { ...newState(), round: 2, spendUsd: 1.2, stopped: "credit", rounds: [{ round: 1, at: "2026-11-06T22:00:00Z", outcome: "skipped", reasons: [], costUsd: 0.6 }, failed as unknown as State["rounds"][number]] };
  const report = renderReport(goal(), state);
  assert.match(report, /Stopped: model credit needs attention/);
  assert.match(report, /To use your own Anthropic key, run `npx synthe key`, then `npx synthe restart`/);
  assert.match(report, /delete the `SYNTHE_ANTHROPIC_KEY` secret in your repo's settings/);
  const next = restartState(goal(), state);
  assert.ok("state" in next, JSON.stringify(next));
  assert.equal(next.state.stopped, null);
  assert.equal(next.state.stalls, 0);
  assert.equal(next.note, "It had stopped when its model credit ran out.");
  const noRecord: State = { ...newState(), stopped: "credit" };
  assert.match(renderReport(goal(), noRecord), /Run `npx synthe key`, then `npx synthe restart`/);
});

test("review: Anthropic key failures direct people to synthe key", () => {
  for (const error of [{ status: 401 }, { status: 403 }, { message: "credit balance is too low" }, { message: "spend limit reached" }]) {
    assert.match(modelProblem(error)!, /Run `npx synthe key`/);
    assert.doesNotMatch(modelProblem(error)!, /gh secret set/);
    assert.equal(failureOf("write", error).kind, "key");
  }
});

test("review: OIDC JWT is cached until sixty seconds before expiry, scoped to audience", async () => {
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  let requests = 0;
  const fetcher = (async () => new Response(JSON.stringify({ value: `header.${Buffer.from(JSON.stringify({ exp: (now + 300_000) / 1000 })).toString("base64url")}.signature-${++requests}` }))) as typeof fetch;
  const env = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "github-token" };
  try {
    const first = await oidcToken("synthe-share", env, fetcher);
    assert.equal(await oidcToken("synthe-share", env, fetcher), first);
    now += 239_000;
    assert.equal(await oidcToken("synthe-share", env, fetcher), first);
    now += 1_000;
    assert.notEqual(await oidcToken("synthe-share", env, fetcher), first);
    await oidcToken("another-audience", env, fetcher);
    assert.equal(requests, 3);
    await assert.rejects(oidcToken("synthe-share", {}, fetcher), /npx synthe upgrade/);
  } finally { Date.now = originalNow; }
});

test("review: an own key's 401 is not retried and points at synthe key; a 500 is retried four times", async (context) => {
  let status = 401;
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    request.resume();
    response.writeHead(status, { "content-type": "application/json", "retry-after-ms": "1" });
    response.end(JSON.stringify({ type: "error", error: { type: status === 401 ? "authentication_error" : "api_error", message: "refused" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const previous = { ...process.env };
  context.after(() => { process.env = previous; });
  process.env.SYNTHE_ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.ANTHROPIC_LOG = "off";
  await assert.rejects(anthropicModel("sk-ant-own").ask(cheap), (error) => {
    assert.equal(modelProblem(error), "Your Anthropic key was rejected. Run `npx synthe key` to replace it.");
    assert.equal(failureOf("write", error).kind, "key");
    return true;
  });
  assert.equal(requests, 1);
  status = 500;
  requests = 0;
  await assert.rejects(anthropicModel("sk-ant-own").ask(cheap), (error) => {
    assert.equal(failureOf("write", error).kind, "busy");
    return true;
  });
  assert.equal(requests, 5);
});
