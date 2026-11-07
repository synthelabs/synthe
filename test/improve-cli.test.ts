import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentSetupError } from "../src/cli/agent.ts";
import { IMPROVE_LIST_NEXT, IMPROVE_NEXT, improve, improveOptions, loopCredential, pullRequestBase, type ImproveIo } from "../src/cli/improve.ts";
import { improveFile, parseImproveConfig } from "../src/improve/config.ts";
import type { Exec } from "../src/improve/exec.ts";

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "synthe-improve-cli-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test", build: "vite build" } }));
  writeFileSync(join(dir, "bench.js"), "console.log(7)");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  return dir;
}

interface Fake { metric?: string; guardOk?: boolean; failing?: string[]; dirty?: boolean; answers?: Record<string, string> }

function fakeIo(dir: string, f: Fake = {}) {
  const said: string[] = [];
  const asked: string[] = [];
  const execCalls: string[] = [];
  const exec: Exec = async (_cwd, command) => {
    if (command.startsWith("git worktree")) return { ok: true, stdout: "", stderr: "", ms: 1, timedOut: false };
    execCalls.push(command);
    const tests = command === "npm test" || command.includes("pytest");
    const ok = command === "npm test" ? f.guardOk ?? true : true;
    return { ok, stdout: tests ? `ℹ pass ${f.metric ?? "3"}\n` : `> banner\n${f.metric ?? "7"}\n`, stderr: "", ms: 5, timedOut: false };
  };
  const io: ImproveIo = {
    say: (t) => said.push(t),
    ask: async (q) => {
      asked.push(q);
      return Object.entries(f.answers ?? {}).find(([k]) => q.includes(k))?.[1] ?? "";
    },
    exec,
    async run(cmd, args) {
      const line = args.join(" ");
      if ((f.failing ?? []).some((x) => line.includes(x))) throw new Error(`${cmd} ${line} failed`);
      if (cmd === "git" && f.dirty && args[0] === "status") return " M bench.js\n";
      if (cmd === "git") return git(dir, ...args);
      if (line === "--version") return "gh version 2.60.0\n";
      if (line.startsWith("repo view")) return JSON.stringify({ nameWithOwner: "o/r", defaultBranchRef: { name: "main" } });
      return "";
    },
  };
  return { io, said, asked, execCalls };
}

const configAt = (dir: string) => parseImproveConfig(readFileSync(improveFile(join(dir, ".git")), "utf8"));

test("improve --agent measures, saves the config under .git and prints the task card and NEXT line", async () => {
  const dir = repo();
  const { io, said, execCalls } = fakeIo(dir, { metric: "7" });
  const ok = await improve(io, dir, improveOptions(["--handoff", "--agent", "--goal", "Make search faster", "--metric", "custom", "--command", "node bench.js", "--label", "search time", "--unit", "ms", "--direction", "lower", "--mode", "review", "--guard", "none"]));
  assert.equal(ok, true);
  const cfg = configAt(dir);
  assert.deepEqual(cfg.baseline.runs, [7, 7, 7]);
  assert.equal(cfg.baseline.commit, git(dir, "rev-parse", "HEAD").trim());
  assert.equal(cfg.mode, "review");
  assert.equal(cfg.guard.command, null);
  assert.deepEqual(execCalls, ["node bench.js", "node bench.js", "node bench.js"]);
  assert.equal(git(dir, "status", "--porcelain"), "");   // nothing written to the tree
  const out = said.join("\n");
  assert.ok(out.includes("Metric: search time, lower is better. Current code: 7 ms (3 runs: 7, 7, 7)."));
  assert.ok(out.includes("Regression check: none."));
  assert.ok(out.includes("git checkout -b synthe/improve-1"));
  assert.ok(out.includes("Mode: review (a pull request waits for you)."));
  assert.equal(said.at(-1), IMPROVE_NEXT);
});

test("improve numbers the branch after the improve branches that already exist", async () => {
  const dir = repo();
  git(dir, "branch", "synthe/improve-1");
  git(dir, "branch", "synthe/improve-2");
  const { io, said } = fakeIo(dir);
  assert.equal(await improve(io, dir, improveOptions(["--handoff", "--agent", "--goal", "g", "--metric", "test-pass", "--mode", "auto", "--protect", "data/seed.json"])), true);
  const out = said.join("\n");
  assert.ok(out.includes("git checkout -b synthe/improve-3"));
  assert.ok(out.includes(".synthe/, and: data/seed.json."));
  assert.ok(out.includes("Current code: 3 tests (1 run: 3)."));
  assert.ok(out.includes("Mode: auto (a winning change merges into the default branch by itself)."));
  assert.deepEqual(configAt(dir).protect, ["data/seed.json"]);
});

test("improve lists every problem at once and writes nothing", async () => {
  const dir = repo();
  const { io, said, execCalls } = fakeIo(dir, { failing: ["auth status"], dirty: true });
  assert.equal(await improve(io, dir, improveOptions(["--list"])), false);
  const out = said.join("\n");
  assert.match(out, /gh auth login/);
  assert.match(out, /Commit your changes first/);
  assert.equal(execCalls.length, 0);
  assert.ok(!existsSync(improveFile(join(dir, ".git"))));
  const noRepo = fakeIo(dir, { failing: ["nameWithOwner"] });
  assert.equal(await improve(noRepo.io, dir, improveOptions(["--list"])), false);
  assert.match(noRepo.said.join("\n"), /GitHub can't find this repo/);
});

test("improve stops when the guard fails on the current code, before writing", async () => {
  const dir = repo();
  const { io, said } = fakeIo(dir, { metric: "3", guardOk: false });
  assert.equal(await improve(io, dir, improveOptions(["--handoff", "--agent", "--goal", "g", "--metric", "custom", "--command", "node bench.js", "--label", "l", "--direction", "higher", "--mode", "auto", "--guard", "npm test"])), false);
  assert.match(said.join("\n"), /The regression check \(npm test\) fails on the current code\. Fix it, or pick another check with --guard/);
  assert.ok(!existsSync(improveFile(join(dir, ".git"))));
});

test("improve stops when the metric prints no number, before writing", async () => {
  const dir = repo();
  const { io, said } = fakeIo(dir, { metric: "n/a" });
  assert.equal(await improve(io, dir, improveOptions(["--handoff", "--agent", "--goal", "g", "--metric", "custom", "--command", "node bench.js", "--label", "l", "--direction", "higher", "--mode", "auto"])), false);
  assert.deepEqual(said.slice(-2), ["The metric command printed no number.", "Fix the command, then run npx synthe improve again. Nothing was written."]);
  assert.ok(!existsSync(improveFile(join(dir, ".git"))));
});

test("improve refuses a preset the repo cannot run", async () => {
  const dir = repo();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
  git(dir, "commit", "-qam", "no scripts");
  const { io, said } = fakeIo(dir);
  assert.equal(await improve(io, dir, improveOptions(["--handoff", "--agent", "--goal", "g", "--metric", "bundle-size", "--mode", "auto"])), false);
  assert.match(said.join("\n"), /can't measure bundle-size/);
});

test("improve --agent never guesses the goal, metric or mode", () => {
  for (const args of [
    ["--agent", "--metric", "custom", "--mode", "auto"],
    ["--agent", "--goal", "g", "--mode", "auto"],
    ["--agent", "--goal", "g", "--metric", "test-pass"],
    ["--agent", "--goal", "g", "--metric", "custom", "--mode", "auto"],
    ["--agent", "--goal", "g", "--metric", "custom", "--mode", "auto", "--command", "x", "--label", "y"],
    ["--agent", "--goal", "g", "--metric", "speed", "--mode", "auto"],
    ["--agent", "--goal", "g", "--goal", "h", "--metric", "test-pass", "--mode", "auto"],
    ["--agent", "--goal", "g", "--metric", "test-pass", "--mode", "fast"],
    ["--agent", "--goal", "g", "--metric", "test-pass", "--mode", "auto", "--protect", "../x"],
    ["--agent", "--goal", "g", "--metric", "test-pass", "--mode", "auto", "--yes"],
    ["--agent", "--goal", "--metric", "test-pass", "--mode", "auto"],
  ]) assert.throws(() => improveOptions(args), AgentSetupError, args.join(" "));
  assert.throws(() => improveOptions(["--agent", "--goal", "g"]), /^Error: --metric is missing or invalid\. Ask the person; don't guess\.$/);
  assert.equal(improveOptions(["--agent", "--list"]).list, true);
  assert.deepEqual(improveOptions(["--protect", "a", "--protect", "b/"]).protect, ["a", "b/"]);
});

test("improve --list prints the detected presets and measures nothing", async () => {
  const dir = repo();
  const { io, said, execCalls } = fakeIo(dir);
  assert.equal(await improve(io, dir, improveOptions(["--agent", "--list"])), true);
  assert.equal(execCalls.length, 0);
  assert.deepEqual(said, [
    "Metrics this repo can measure:",
    "1. test-pass: tests passing (higher is better; measures npm test)",
    "2. bundle-size: built JS and CSS, gzipped (lower is better; measures npm run build; regression check: npm test)",
    "3. build-time: build time (lower is better; measures npm run build; regression check: npm test)",
    "4. custom: a command of yours that prints one number (you say whether higher or lower is better)",
    IMPROVE_LIST_NEXT,
  ]);
  assert.ok(!existsSync(improveFile(join(dir, ".git"))));
});

test("interactive improve asks goal, metric number, guard, and auto y/n, defaulting to review", async () => {
  const dir = repo();
  const { io, asked, said } = fakeIo(dir, {
    metric: "7",
    answers: { "What should get better": "Faster search", "Type 1-4": "4", "prints the number": "node bench.js", "What does the number count": "search time", "Unit": "ms", "higher number better": "n" },
  });
  assert.equal(await improve(io, dir, improveOptions(["--handoff"])), true);
  const cfg = configAt(dir);
  assert.equal(cfg.mode, "review");
  assert.equal(cfg.guard.command, "npm test");   // Enter keeps the preset's default check
  assert.deepEqual(cfg.metric, { preset: "custom", label: "search time", unit: "ms", command: "node bench.js", direction: "lower", runs: 3 });
  assert.equal(cfg.goal, "Faster search");
  assert.ok(asked.some((q) => q.startsWith("Merge winning changes into main automatically? y/n")));
  assert.ok(asked.some((q) => q.includes("press Enter for npm test")));
  assert.ok(!said.includes(IMPROVE_NEXT));
  const second = repo();
  const auto = fakeIo(second, { answers: { "What should get better": "More tests", "Type 1-4": "1", "Regression check": "none", automatically: "y" } });
  assert.equal(await improve(auto.io, second, improveOptions(["--handoff"])), true);
  assert.deepEqual([configAt(second).mode, configAt(second).guard.command, configAt(second).metric.preset], ["auto", null, "test-pass"]);
});

test("improve runs the loop by default; --rounds, --budget and --lessons are checked, and belong to the loop only", () => {
  const plain = improveOptions([]);
  assert.deepEqual([plain.handoff, plain.rounds, plain.budgetUsd, plain.lessons], [false, 6, 1.5, undefined]);
  const set = improveOptions(["--rounds", "3", "--budget", "$0.75", "--lessons", "agents"]);
  assert.deepEqual([set.rounds, set.budgetUsd, set.lessons], [3, 0.75, "agents"]);
  assert.equal(improveOptions(["--handoff"]).handoff, true);
  for (const args of [["--rounds", "0"], ["--rounds", "21"], ["--rounds", "2.5"], ["--budget", "0.1"], ["--budget", "21"], ["--budget", "lots"], ["--lessons", "readme"],
    ["--handoff", "--rounds", "2"], ["--handoff", "--budget", "1"], ["--handoff", "--lessons", "none"], ["--handoff", "--handoff"]]) {
    assert.throws(() => improveOptions(args), AgentSetupError, args.join(" "));
  }
  assert.throws(() => improveOptions(["--agent", "--goal", "g", "--metric", "test-pass", "--mode", "auto", "--rounds", "50"]), /^Error: --rounds is missing or invalid\. Ask the person; don't guess\.$/);
});

test("the loop's credential comes only from Synthe's variables, is never printed, and ANTHROPIC_API_KEY is never used", () => {
  const own = loopCredential({ SYNTHE_ANTHROPIC_KEY: "sk-ant-own-1234", SYNTHE_EVENT_CODE: "event", SYNTHE_TEAM_CODE: "crim-abcd-efgh-jkmn-pqrs" });
  assert.deepEqual(own, { credential: { key: "sk-ant-own-1234", line: "Credential: your own key from SYNTHE_ANTHROPIC_KEY, charged to that Anthropic account." } });
  const event = loopCredential({ SYNTHE_EVENT_CODE: " event ", SYNTHE_TEAM_CODE: " CRIM-ABCD-EFGH-JKMN-PQRS ", ANTHROPIC_API_KEY: "sk-ant-app" });
  assert.deepEqual(event, { credential: { eventCode: "event", teamCode: "crim-abcd-efgh-jkmn-pqrs", line: "Credential: Crimson Hacks event credit, with your team code from SYNTHE_TEAM_CODE." } });
  assert.match((loopCredential({ SYNTHE_EVENT_CODE: "event" }) as { problem: string }).problem, /SYNTHE_TEAM_CODE isn't/);
  assert.match((loopCredential({ SYNTHE_EVENT_CODE: "event", SYNTHE_TEAM_CODE: "team-7" }) as { problem: string }).problem, /doesn't look like a team code/);
  const none = (loopCredential({ ANTHROPIC_API_KEY: "sk-ant-app-key" }) as { problem: string }).problem;
  assert.ok(none.includes("ANTHROPIC_API_KEY is not used") && none.includes("npx synthe improve --handoff") && !none.includes("sk-ant"));
});

test("loop preflight reports a missing credential with every other problem in one message, and says --handoff needs none", async () => {
  const dir = repo();
  const { io, said, execCalls } = fakeIo(dir, { failing: ["auth status"], dirty: true });
  assert.equal(await improve({ ...io, env: { ANTHROPIC_API_KEY: "sk-ant-app" } }, dir, improveOptions(["--agent", "--goal", "g", "--metric", "test-pass", "--mode", "auto"])), false);
  assert.equal(said[0], "Synthe can't start yet. Fix these, then run npx synthe improve again:");
  const out = said.join("\n");
  assert.match(out, /Commit your changes first/);
  assert.match(out, /gh auth login/);
  assert.match(out, /needs a credential.*--handoff to make the change with your own coding agent; that needs no credential/);
  assert.equal(execCalls.length, 0);
  assert.ok(!existsSync(improveFile(join(dir, ".git"))));
});

function pushedRepo() {
  const dir = repo();
  const origin = mkdtempSync(join(tmpdir(), "synthe-origin-"));
  git(origin, "init", "-q", "--bare");
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "-q", "-u", "origin", "main");
  const run: ImproveIo["run"] = async (cmd, args) => git(dir, ...args);
  const io = { ...fakeIo(dir).io, run };
  const head = () => git(dir, "rev-parse", "HEAD").trim();
  return { dir, io, head };
}

test("the pull request base is the pushed branch HEAD is on, else the default branch, and HEAD must match it on GitHub", async () => {
  const r = pushedRepo();
  assert.deepEqual(await pullRequestBase(r.io, "main", r.head()), { base: "main" });
  git(r.dir, "checkout", "-q", "-b", "feature");
  assert.deepEqual(await pullRequestBase(r.io, "main", r.head()), { base: "main" }, "a new branch with no commits of its own starts from main");
  writeFileSync(join(r.dir, "bench.js"), "console.log(8)");
  git(r.dir, "commit", "-qam", "local work");
  assert.match((await pullRequestBase(r.io, "main", r.head()) as { problem: string }).problem, /^feature isn't on GitHub, and your current commit isn't the same as main there\. Push your branch \(git push -u origin feature\)/);
  git(r.dir, "push", "-q", "-u", "origin", "feature");
  assert.deepEqual(await pullRequestBase(r.io, "main", r.head()), { base: "feature" });
  writeFileSync(join(r.dir, "bench.js"), "console.log(9)");
  git(r.dir, "commit", "-qam", "more local work");
  const ahead = (await pullRequestBase(r.io, "main", r.head()) as { problem: string }).problem;
  assert.ok(ahead.startsWith("feature has commits that aren't on GitHub yet. Push them first (git push)") && ahead.endsWith("opens its pull request against feature, so the two must match."), ahead);
  git(r.dir, "reset", "-q", "--hard", "HEAD~2");
  assert.match((await pullRequestBase(r.io, "main", r.head()) as { problem: string }).problem, /^feature on GitHub has commits this clone doesn't\. Run git pull/);
  git(r.dir, "remote", "remove", "origin");
  assert.match((await pullRequestBase(r.io, "main", r.head()) as { problem: string }).problem, /remote named origin/);
});

test("--metric pytest picks pytest when npm tests exist too; test-pass stays npm, and stands in for pytest only without an npm test script", async () => {
  const both = repo();
  writeFileSync(join(both, "pytest.ini"), "");
  git(both, "add", "."); git(both, "commit", "-qm", "py");
  const pick = async (dir: string, metric: string) => {
    const { io } = fakeIo(dir);
    assert.equal(await improve(io, dir, improveOptions(["--handoff", "--agent", "--goal", "g", "--metric", metric, "--mode", "review"])), true);
    return configAt(dir).metric;
  };
  assert.deepEqual([(await pick(both, "pytest")).preset, (await pick(both, "pytest")).command.includes("pytest")], ["pytest", true]);
  assert.deepEqual([(await pick(both, "test-pass")).preset, (await pick(both, "test-pass")).command], ["test-pass", "npm test"]);

  const pyOnly = mkdtempSync(join(tmpdir(), "synthe-improve-py-"));
  git(pyOnly, "init", "-q", "-b", "main");
  git(pyOnly, "config", "user.email", "t@example.com");
  git(pyOnly, "config", "user.name", "t");
  writeFileSync(join(pyOnly, "pytest.ini"), "");
  git(pyOnly, "add", "."); git(pyOnly, "commit", "-qm", "init");
  assert.equal((await pick(pyOnly, "pytest")).preset, "pytest");
  const alias = await pick(pyOnly, "test-pass");
  assert.equal(alias.preset, "pytest");
  assert.ok(alias.command.includes("pytest"));
});

test("prompt mode's files are saved as promptFiles, not as --protect entries, and show on the task card", async () => {
  const dir = repo();
  writeFileSync(join(dir, "synthe.json"), JSON.stringify({ version: 1, prompt: { kind: "file", path: "prompts/agent.md" }, objective: "o" }));
  git(dir, "add", "."); git(dir, "commit", "-qm", "goal");
  const { io, said } = fakeIo(dir);
  assert.equal(await improve(io, dir, improveOptions(["--handoff", "--agent", "--goal", "g", "--metric", "test-pass", "--mode", "review", "--protect", "data/seed.json"])), true);
  assert.deepEqual(configAt(dir).protect, ["data/seed.json"]);
  assert.deepEqual(configAt(dir).promptFiles, ["prompts/agent.md"]);
  assert.ok(said.join("\n").includes(".synthe/, and: data/seed.json, prompts/agent.md."));
});
