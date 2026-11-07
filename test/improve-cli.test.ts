import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentSetupError } from "../src/cli/agent.ts";
import { IMPROVE_LIST_NEXT, IMPROVE_NEXT, improve, improveOptions, type ImproveIo } from "../src/cli/improve.ts";
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
    const ok = command === "npm test" ? f.guardOk ?? true : true;
    return { ok, stdout: command === "npm test" ? `ℹ pass ${f.metric ?? "3"}\n` : `> banner\n${f.metric ?? "7"}\n`, stderr: "", ms: 5, timedOut: false };
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
  const ok = await improve(io, dir, improveOptions(["--agent", "--goal", "Make search faster", "--metric", "custom", "--command", "node bench.js", "--label", "search time", "--unit", "ms", "--direction", "lower", "--mode", "review", "--guard", "none"]));
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
  assert.equal(await improve(io, dir, improveOptions(["--agent", "--goal", "g", "--metric", "test-pass", "--mode", "auto", "--protect", "data/seed.json"])), true);
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
  assert.equal(await improve(io, dir, improveOptions(["--agent", "--goal", "g", "--metric", "custom", "--command", "node bench.js", "--label", "l", "--direction", "higher", "--mode", "auto", "--guard", "npm test"])), false);
  assert.match(said.join("\n"), /The regression check \(npm test\) fails on the current code\. Fix it, or pick another check with --guard/);
  assert.ok(!existsSync(improveFile(join(dir, ".git"))));
});

test("improve stops when the metric prints no number, before writing", async () => {
  const dir = repo();
  const { io, said } = fakeIo(dir, { metric: "n/a" });
  assert.equal(await improve(io, dir, improveOptions(["--agent", "--goal", "g", "--metric", "custom", "--command", "node bench.js", "--label", "l", "--direction", "higher", "--mode", "auto"])), false);
  assert.deepEqual(said.slice(-2), ["The metric command printed no number.", "Fix the command, then run npx synthe improve again. Nothing was written."]);
  assert.ok(!existsSync(improveFile(join(dir, ".git"))));
});

test("improve refuses a preset the repo cannot run", async () => {
  const dir = repo();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
  git(dir, "commit", "-qam", "no scripts");
  const { io, said } = fakeIo(dir);
  assert.equal(await improve(io, dir, improveOptions(["--agent", "--goal", "g", "--metric", "bundle-size", "--mode", "auto"])), false);
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
  assert.equal(await improve(io, dir, improveOptions([])), true);
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
  assert.equal(await improve(auto.io, second, improveOptions([])), true);
  assert.deepEqual([configAt(second).mode, configAt(second).guard.command, configAt(second).metric.preset], ["auto", null, "test-pass"]);
});
