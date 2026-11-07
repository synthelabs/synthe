import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { improve, improveOptions, type ImproveIo } from "../src/cli/improve.ts";
import { improveFile, parseImproveConfig, type ImproveConfig } from "../src/improve/config.ts";
import { shellExec } from "../src/improve/exec.ts";
import { removeScratchCheckouts, runLoop } from "../src/improve/loop.ts";
import { CreditError, type Ask, type Model } from "../src/model/client.ts";

// The improve loop on a small signup app shaped like synthelabs/builder-signup-demo: real git, a local bare
// "origin", the real metric and test commands through shellExec, a scripted model and a recording `gh`.
const EMAILS = ["ann@example.com", "bob@test.com", "cy@site.com", "Dana@example.com", "eve.smith@example.com", "fay@mail.example.org",
  "gus+tag@example.com", "hal@example.io", "ivy_2@example.com", "jo@example.co.uk", "kim@EXAMPLE.COM", "lee-ann@example.net"];
const STRICT = "module.exports = (email) => /^[a-z]+@[a-z]+\\.com$/.test(email);\n";

function signupApp(o: { identity?: boolean; claudeMd?: boolean } = {}) {
  const work = mkdtempSync(join(tmpdir(), "synthe-loop-"));
  const dir = join(work, "app");
  const envDump = join(work, "metric-env.json");
  // No global or system git config, so the test sees exactly the identity it sets up.
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv }).trim();
  const write = (path: string, text: string) => { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), text); };
  mkdirSync(dir);
  git("init", "-q", "-b", "main");
  if (o.identity !== false) { git("config", "user.email", "t@example.com"); git("config", "user.name", "t"); }
  write("package.json", JSON.stringify({ name: "signup", version: "1.0.0", scripts: { test: "node --test test/validate.test.js" } }));
  write("validate.js", STRICT);
  write("metrics/valid-signups.json", JSON.stringify(EMAILS));
  write("metrics/score.js", `const fs = require("fs");
fs.writeFileSync(${JSON.stringify(envDump)}, JSON.stringify(Object.keys(process.env).filter((k) => k.startsWith("SYNTHE_") || k === "ANTHROPIC_API_KEY")));
const valid = require("../validate.js");
console.log(require("./valid-signups.json").filter(valid).length);
`);
  write("test/validate.test.js", `const test = require("node:test");\nconst assert = require("node:assert");\nconst valid = require("../validate.js");\ntest("rejects what is not an email", () => { assert.equal(valid("not-an-email"), false); assert.equal(valid("a@b"), false); });\ntest("accepts a plain address", () => { assert.equal(valid("ann@example.com"), true); });\n`);
  if (o.claudeMd) write("CLAUDE.md", "# Signup\n\nRun npm test before pushing.\n");
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "Signup app");
  execFileSync("git", ["init", "-q", "--bare", join(work, "origin.git")]);
  git("remote", "add", "origin", join(work, "origin.git"));
  git("push", "-q", "-u", "origin", "main");
  return { work, dir, git, gitEnv, envDump };
}

type Script = { pick?: string[]; propose?: unknown; error?: Error; cost?: number | null };

// One script entry per round. The pick call is recognised by its schema (it asks for "paths").
function scriptedModel(rounds: Script[]) {
  const asks: Ask[] = [];
  let round = -1;
  const model: Model = {
    async ask(a) {
      asks.push(a);
      const picking = Boolean((a.schema as any)?.properties?.paths);
      if (picking) round++;
      const s = rounds[round] ?? { propose: { summary: "nothing more", edits: [] } };
      if (s.error && !picking) throw s.error;
      const cost = s.cost === undefined ? 0.005 : s.cost === null ? null : s.cost / 2;
      return { text: JSON.stringify(picking ? { paths: s.pick ?? ["validate.js"], why: "the validator decides who can sign up" } : s.propose), costUsd: cost };
    },
  };
  return { model, asks };
}

const SHORTCUT = { summary: "accept any address that contains an @", edits: [{ path: "validate.js", search: "/^[a-z]+@[a-z]+\\.com$/.test(email)", replace: "email.includes(\"@\")" }] };
const RIGHT = { summary: "email check accepts dots, plus signs and subdomains", edits: [{ path: "validate.js", search: "/^[a-z]+@[a-z]+\\.com$/", replace: "/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/" }] };
// Only matches the code as round 2 left it, so it proves round 3 starts from the kept win.
const NOOP_ON_KEPT = { summary: "name the email pattern", edits: [{ path: "validate.js", search: "module.exports = (email) => /^[^\\s@]+@", replace: "// One signup email: something@something.tld, no spaces.\nmodule.exports = (email) => /^[^\\s@]+@" }] };

function loopIo(app: ReturnType<typeof signupApp>, model: Model, env: Record<string, string> = { SYNTHE_EVENT_CODE: "event", SYNTHE_TEAM_CODE: "crim-abcd-efgh-jkmn-pqrs" }) {
  const said: string[] = [];
  const gh: { args: string[]; stdin?: string }[] = [];
  const io: ImproveIo = {
    say: (t) => said.push(t),
    ask: async () => "",
    exec: shellExec,
    env,
    makeModel: () => model,
    async run(cmd, args, stdin) {
      if (cmd === "git") return execFileSync("git", args, { cwd: app.dir, encoding: "utf8", input: stdin, env: app.gitEnv, stdio: ["pipe", "pipe", "pipe"] });
      gh.push({ args, stdin });
      const line = args.join(" ");
      if (line === "--version") return "gh version 2.60.0\n";
      if (line.startsWith("repo view")) return JSON.stringify({ nameWithOwner: "o/r", defaultBranchRef: { name: "main" } });
      if (line.startsWith("pr create")) return "https://github.com/o/r/pull/7\n";
      return "";
    },
  };
  return { io, said, gh };
}

const AGENT = ["--agent", "--goal", "Let normal emails sign up", "--metric", "custom", "--command", "node metrics/score.js", "--label", "valid signups", "--direction", "higher", "--guard", "npm test"];

test("the loop keeps the measured win, refuses the shortcut and the no-op, builds on the win and opens one pull request", async (t) => {
  const app = signupApp({ claudeMd: true });
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  // Present in Synthe's own environment; the metric must never see them.
  Object.assign(process.env, { SYNTHE_EVENT_CODE: "event", SYNTHE_TEAM_CODE: "crim-abcd-efgh-jkmn-pqrs", ANTHROPIC_API_KEY: "sk-ant-app-key-0000" });
  const { model, asks } = scriptedModel([{ propose: SHORTCUT }, { propose: RIGHT }, { propose: NOOP_ON_KEPT }]);
  const { io, said, gh } = loopIo(app, model);
  const start = app.git("rev-parse", "HEAD");

  assert.equal(await improve(io, app.dir, improveOptions([...AGENT, "--mode", "review", "--rounds", "3"])), true, said.join("\n"));
  const out = said.join("\n");
  assert.equal(said.filter((l) => l.startsWith("Credential:")).length, 1);
  assert.ok(out.includes("Credential: Crimson Hacks event credit, with your team code from SYNTHE_TEAM_CODE."));
  assert.ok(!out.includes("crim-abcd") && !out.includes("sk-ant-app"), "no code or key is ever printed");
  assert.ok(out.includes("Current code: 3 valid signups (runs: 3, 3, 3)"), out);
  assert.ok(out.includes("Round 1: not kept (the regression check did not pass). Cost $0.01, total $0.01."), out);
  assert.ok(out.includes("Round 2: 3 → 12 valid signups, kept (email check accepts dots, plus signs and subdomains). Cost $0.01, total $0.02."), out);
  assert.ok(out.includes("Round 3: not kept (not better: 12 → 12 valid signups). Cost $0.01, total $0.03."), out);
  assert.ok(out.includes("Stopped after 3 rounds (--rounds 3)."));
  assert.ok(out.includes("Pull request: https://github.com/o/r/pull/7"));
  assert.ok(out.includes("Review it there and merge it to keep the changes."));
  assert.equal(said.at(-1)?.startsWith("NEXT: Show the person every round line"), true);

  // Round 2 was told why round 1 failed; round 3 saw the code as round 2 left it.
  const proposes = asks.filter((a) => !(a.schema as any)?.properties?.paths);
  assert.ok(proposes[1].user.includes(`Round 1 (validate.js): "accept any address that contains an @" -> 12 valid signups; not kept: the regression check did not pass`), proposes[1].user);
  assert.ok(proposes[2].user.includes("/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/"));
  assert.ok(asks.every((a) => ["claude-sonnet-5-5", "claude-haiku-5-5"].includes(a.model) && a.maxTokens <= 16000));

  // The metric ran without Synthe's codes, the app's key or a GitHub token in its environment.
  assert.deepEqual(JSON.parse(readFileSync(app.envDump, "utf8")), []);

  // One pull request: the kept change, then one commit that only writes lessons.
  const prs = gh.filter((c) => c.args[0] === "pr");
  assert.deepEqual(prs.map((c) => c.args.slice(0, 2).join(" ")), ["pr create"]);
  const create = prs[0];
  assert.deepEqual(create.args.slice(0, 10), ["pr", "create", "--base", "main", "--head", "synthe/improve-1", "--title", "Synthe: valid signups 3 → 12", "--body-file", "-"]);
  const body = create.stdin!;
  assert.ok(body.includes("| Round | Change | Value | Result | Cost |"));
  assert.ok(body.includes("| 1 | accept any address that contains an @ | 12 | not kept: the regression check did not pass | $0.01 |"), body);
  assert.ok(body.includes("| 2 | email check accepts dots, plus signs and subdomains | 12 | **kept** | $0.01 |"));
  assert.ok(body.includes("| 3 | name the email pattern | 12 | not kept: not better: 12 → 12 valid signups | $0.01 |"));
  assert.ok(body.includes("## The last commit only adds lessons") && body.includes("## Undo") && body.includes("## How it was measured"));
  const branch = app.git("rev-parse", "synthe/improve-1");
  assert.equal(app.git("ls-remote", "origin", "synthe/improve-1").split("\t")[0], branch);
  assert.deepEqual(app.git("diff-tree", "--no-commit-id", "--name-only", "-r", branch).split("\n").sort(), [".synthe/improve-lessons.md", "CLAUDE.md"]);
  assert.equal(app.git("rev-parse", `${branch}~2`), start);
  assert.deepEqual(app.git("diff", "--name-only", `${start}..${branch}~1`).split("\n"), ["validate.js"]);
  const claudeMd = app.git("show", `${branch}:CLAUDE.md`);
  assert.ok(claudeMd.startsWith("# Signup\n\nRun npm test before pushing.\n") && claudeMd.includes("<!-- synthe:lessons:start -->") && claudeMd.includes("Round 2 kept"));
  assert.equal(app.git("show", `${branch}:.synthe/improve-lessons.md`).split("\n").filter((l) => l.startsWith("- Round")).length, 3);

  // The team's checkout is untouched; the local lesson log is inside .git; no temp checkout is left behind.
  assert.equal(app.git("status", "--porcelain"), "");
  assert.equal(app.git("rev-parse", "HEAD"), start);
  assert.equal(readFileSync(join(app.dir, "validate.js"), "utf8"), STRICT);
  assert.equal(readFileSync(join(app.dir, ".git/.synthe/improve-lessons.md"), "utf8").split("\n").filter((l) => l.startsWith("- Round")).length, 3);
  assert.equal(app.git("worktree", "list").split("\n").length, 1);
  assert.equal(parseImproveConfig(readFileSync(improveFile(join(app.dir, ".git")), "utf8")).baseline.median, 3);
});

test("a credit stop mid-run keeps the earlier win, opens and merges the pull request in auto mode, with Synthe's identity when git has none", async () => {
  const app = signupApp({ identity: false });
  const credit = new CreditError("Event credit is used up for your team. Ask at the Synthe table.");
  const { model } = scriptedModel([{ propose: RIGHT }, { error: credit }]);
  const { io, said, gh } = loopIo(app, model);
  assert.equal(await improve(io, app.dir, improveOptions([...AGENT, "--mode", "auto"])), true, said.join("\n"));
  const out = said.join("\n");
  assert.ok(out.includes("Round 1: 3 → 12 valid signups, kept"), out);
  assert.ok(out.includes("Stopped in round 2: Event credit is used up for your team. Ask at the Synthe table."), out);
  assert.ok(out.includes("Merged into main. Run git pull."));
  assert.deepEqual(gh.filter((c) => c.args[0] === "pr").map((c) => c.args.slice(0, 2).join(" ")), ["pr create", "pr merge"]);
  assert.ok(gh.find((c) => c.args[1] === "merge")!.args.includes("--squash"));
  assert.equal(app.git("log", "-1", "--format=%an <%ae>", "synthe/improve-1~1"), "Synthe <synthe@users.noreply.github.com>");
  // No CLAUDE.md or AGENTS.md and no --lessons: the lessons commit writes only the lessons file.
  assert.deepEqual(app.git("diff-tree", "--no-commit-id", "--name-only", "-r", "synthe/improve-1").split("\n"), [".synthe/improve-lessons.md"]);
});

test("no wins: a shortcut, a protected edit and a non-unique search stop the run after 3 misses, with no push and no pull request", async () => {
  const app = signupApp();
  const tests = { summary: "loosen the test", edits: [{ path: "test/validate.test.js", search: "a@b", replace: "a@b.co" }] };
  const twice = { summary: "tidy the export", edits: [{ path: "validate.js", search: "e", replace: "E" }] };
  const { model } = scriptedModel([{ propose: SHORTCUT }, { propose: tests }, { propose: twice }, { propose: RIGHT }]);
  const { io, said, gh } = loopIo(app, model);
  assert.equal(await improve(io, app.dir, improveOptions([...AGENT, "--mode", "auto"])), false);
  const out = said.join("\n");
  assert.ok(out.includes("Round 2: not kept (edit refused: test/validate.test.js is a test file; Synthe measures with the tests as they are.)"), out);
  assert.match(out, /Round 3: not kept \(edit refused: the search text for validate\.js appears \d+ times; it must appear once\)/);
  assert.ok(out.includes("Stopped after 3 rounds in a row without a win."));
  assert.ok(out.includes("No change beat the current code (3 valid signups), so nothing was pushed and no pull request was opened."));
  assert.ok(out.includes("What was tried:\n- Round 1: accept any address that contains an @. Not kept: the regression check did not pass."));
  assert.ok(out.includes("Lessons from these rounds are saved in .git/.synthe/improve-lessons.md"));
  assert.equal(said.at(-1)?.startsWith("NEXT: Show the person what was tried"), true);
  assert.equal(gh.filter((c) => c.args[0] === "pr").length, 0);
  assert.equal(app.git("ls-remote", "--heads", "origin"), `${app.git("rev-parse", "main")}\trefs/heads/main`);
  assert.equal(app.git("branch", "--list", "synthe/*"), "");
  assert.equal(app.git("status", "--porcelain"), "");
  assert.equal(app.git("worktree", "list").split("\n").length, 1);
});

function baselined(app: ReturnType<typeof signupApp>): ImproveConfig {
  return {
    version: 1, goal: "Let normal emails sign up", guard: { command: null }, protect: [], mode: "review",
    metric: { preset: "custom", label: "valid signups", unit: "units", command: "node metrics/score.js", direction: "higher", runs: 1 },
    baseline: { commit: app.git("rev-parse", "HEAD"), median: 3, runs: [3], at: "" },
  };
}

const loopCtx = (app: ReturnType<typeof signupApp>, model: Model, budgetUsd: number, rounds = 6) => {
  const said: string[] = [];
  const io = { say: (t: string) => said.push(t), exec: shellExec, run: async (cmd: string, args: string[], stdin?: string) => execFileSync(cmd, args, { cwd: app.dir, encoding: "utf8", input: stdin, env: app.gitEnv, stdio: ["pipe", "pipe", "pipe"] }) };
  return { said, run: () => runLoop(io, { top: app.dir, gitDir: join(app.dir, ".git"), config: baselined(app), model, rounds, budgetUsd }) };
};

test("the loop stops before a round that could pass the budget, estimating from the most expensive round so far", async () => {
  const app = signupApp();
  const none = { summary: "no honest change", edits: [] };
  const { model } = scriptedModel([{ propose: RIGHT, cost: 0.3 }, { propose: none, cost: 0.6 }, { propose: none, cost: 0.1 }]);
  const { said, run } = loopCtx(app, model, 1.2);
  const result = await run();
  assert.equal(result.rounds.length, 2);
  assert.equal(result.stopped, "Stopped before round 3: another round could cost about $0.60, and $0.90 of the $1.20 budget (--budget) is spent.");
  assert.equal(result.rounds[0].kept, true);
  assert.equal(result.rounds[1].why, "no change proposed");
  assert.ok(said.includes("Round 2: not kept (no change proposed). Cost $0.60, total $0.90."));
});

test("an unknown round cost counts as over budget", async () => {
  const app = signupApp();
  const { model } = scriptedModel([{ propose: { summary: "nothing", edits: [] }, cost: null }, { propose: RIGHT }]);
  const { said, run } = loopCtx(app, model, 1.5);
  const result = await run();
  assert.equal(result.rounds.length, 1);
  assert.equal(result.costKnown, false);
  assert.equal(result.stopped, "Stopped: round 1 cost an unknown amount, so Synthe can't keep the run within the $1.50 budget.");
  assert.ok(said.includes("Round 1: not kept (no change proposed). Cost unknown."));
});

test("a proxy or API error in the first round stops cleanly with nothing kept and no checkout left", async () => {
  const app = signupApp();
  const { model } = scriptedModel([{ error: Object.assign(new Error("Overloaded"), { status: 529 }) }]);
  const { run } = loopCtx(app, model, 1.5);
  const result = await run();
  assert.equal(result.rounds.length, 0);
  assert.equal(result.best.median, 3);
  assert.equal(result.stopped, "Stopped in round 1: Anthropic's API is busy right now. Wait a few minutes and try again.");
  assert.equal(result.spentUsd, 0.005);
  assert.equal(app.git("worktree", "list").split("\n").length, 1);
});

test("Ctrl-C cleanup removes every temp checkout Synthe made and leaves the person's own worktrees", () => {
  const app = signupApp();
  const ours = mkdtempSync(join(tmpdir(), "synthe-improve-"));
  const theirs = join(app.work, "feature");
  app.git("worktree", "add", "--detach", "-q", ours, "HEAD");
  app.git("worktree", "add", "--detach", "-q", theirs, "HEAD");
  assert.equal(app.git("worktree", "list").split("\n").length, 3);
  removeScratchCheckouts(app.dir);
  assert.equal(existsSync(ours), false);
  assert.equal(existsSync(theirs), true);
  assert.equal(app.git("worktree", "list").split("\n").length, 2);
});
