import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentArgs, agentEnv, agentFiles, agentProposer, agentPrompt, folderEdits, makeAgentFolder, summaryOf, type ProgramFn } from "../src/solve/agent.ts";
import { applyEdits, type EditRules } from "../src/solve/edits.ts";
import { checkProblem } from "../src/solve/problem.ts";
import { runProgram, type RunResult } from "../src/solve/run.ts";
import type { Problem, ProposerRequest } from "../src/solve/types.ts";

// The agent proposer (A01). Every agent here is a fake: a function, or a small node script. No real agent runs.

const temp = (label: string) => realpathSync(mkdtempSync(join(tmpdir(), `synthe-agent-test-${label}-`)));
const ok = (stdout = ""): RunResult => ({ ok: true, code: 0, stdout, stderr: "", timedOut: false });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function problemWith(proposer: Record<string, unknown>, extra: Record<string, unknown> = {}): Problem {
  const dir = temp("repo");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const file = join(dir, "problem.json");
  const check = checkProblem(JSON.stringify({ version: 1, name: "agent-unit", goal: "Raise the score.", artifact: ["src/**", "knob.txt"], protect: ["src/secret/**"], measure: { command: "node score.js", direction: "higher" }, proposer, ...extra }), file);
  assert.ok(check.ok, JSON.stringify(check));
  return check.problem;
}

const request = (over: Partial<ProposerRequest> = {}): ProposerRequest => ({
  round: 1, goal: "Raise the score.", files: [{ path: "knob.txt", text: "level=1\n" }, { path: "src/a.txt", text: "a\n" }], history: [], candidates: 1, ...over,
});

test("agentEnv removes every SYNTHE_* variable and keeps the person's own variables", () => {
  const env = agentEnv({ HOME: "/home/p", PATH: "/bin", ANTHROPIC_API_KEY: "own", SYNTHE_API_KEY: "k1", SYNTHE_ANTHROPIC_KEY: "k2", SYNTHE_SPLIT: "holdout", synthe_lower: "x", NODE_TEST_CONTEXT: "child" });
  assert.deepEqual(env, { HOME: "/home/p", PATH: "/bin", ANTHROPIC_API_KEY: "own" });
});

test("agentArgs gives `-p <prompt>` for claude and `exec <prompt>` for codex, with args before the prompt", () => {
  assert.deepEqual(agentArgs({ agent: "claude", args: ["--x", "two words"] }, "P"), ["--x", "two words", "-p", "P"]);
  assert.deepEqual(agentArgs({ agent: "codex", args: ["--y"] }, "P"), ["exec", "--y", "P"]);
});

test("agentPrompt holds the goal, the paths and the history, and no number of an attempt", () => {
  const rich = [{ round: 3, summary: "raise  the\nlevel", kept: false, reason: "It won on the train split only.", before: 4111222, after: 4333444, holdout: 4555666 }];
  const prompt = agentPrompt({ goal: "Raise the score.", files: request().files, history: rich }, ["knob.txt", "src/**"]);
  for (const part of ["Raise the score.", "- knob.txt", "- src/a.txt", "Round 3, not kept: raise the level", "It won on the train split only.", "src/**"]) assert.ok(prompt.includes(part), part);
  assert.match(prompt, /summary/i);
  assert.doesNotMatch(prompt, /4111222|4333444|4555666/);
});

test("agentPrompt shows only the most recent attempts of a long history", () => {
  const history = Array.from({ length: 100 }, (_, i) => ({ round: i + 1, summary: `idea-${i + 1}.`, kept: false, reason: "x".repeat(5000) }));
  const prompt = agentPrompt({ goal: "g", files: [], history }, ["a"]);
  assert.ok(prompt.includes("idea-100.") && !prompt.includes("idea-1."));
  assert.ok(prompt.length < 60_000, `the prompt fits in one argument (${prompt.length} characters)`);
});

test("summaryOf is the last non-empty stdout line, at most 200 characters, or \"agent change\"", () => {
  assert.equal(summaryOf("first\n\n  the last line  \n\n   \n"), "the last line");
  assert.equal(summaryOf(""), "agent change");
  assert.equal(summaryOf(" \n\t\n"), "agent change");
  assert.equal(summaryOf(`x\n${"w".repeat(300)}\n`), "w".repeat(200));
});

test("makeAgentFolder refuses a temporary folder that is inside a repository made by git init", () => {
  const repo = temp("inrepo");
  execFileSync("git", ["init", "-q", repo]);
  mkdirSync(join(repo, "tmp"));
  assert.throws(() => makeAgentFolder(join(repo, "tmp")), /The temporary folder .* is inside a git repository, so the agent could read that repository\. Set TMPDIR to a folder outside every repository\./);
  assert.deepEqual(readdirSync(join(repo, "tmp")), [], "the folder it made is removed");
  const good = makeAgentFolder();
  assert.deepEqual(readdirSync(good), []);
  rmSync(good, { recursive: true });
});

test("makeAgentFolder refuses a temporary folder under a .git file that points to a git directory", () => {
  const work = temp("worktree");
  writeFileSync(join(work, ".git"), "gitdir: /somewhere/else/.git/worktrees/work\n");
  mkdirSync(join(work, "tmp"));
  assert.throws(() => makeAgentFolder(join(work, "tmp")), /inside a git repository/);
  assert.deepEqual(readdirSync(join(work, "tmp")), [], "the folder it made is removed");
});

test("makeAgentFolder ignores an empty .git folder and a .git file that is not a pointer", () => {
  const base = temp("emptygit");
  mkdirSync(join(base, ".git"));
  mkdirSync(join(base, "tmp"));
  const dir = makeAgentFolder(join(base, "tmp"));
  assert.deepEqual(readdirSync(dir), []);
  rmSync(dir, { recursive: true });

  const other = temp("notpointer");
  writeFileSync(join(other, ".git"), "not a pointer\n");
  const dir2 = makeAgentFolder(other);
  assert.deepEqual(readdirSync(dir2), []);
  rmSync(dir2, { recursive: true });
});

test("folderEdits turns changed, added and removed files into whole-file edits, and refuses a link", () => {
  const dir = temp("diff");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "knob.txt"), "level=2\n");
  writeFileSync(join(dir, "src/new.txt"), "n\n");
  writeFileSync(join(dir, "same.txt"), "s\n");
  const before = [{ path: "knob.txt", text: "level=1\n" }, { path: "src/a.txt", text: "a\n" }, { path: "same.txt", text: "s\n" }];
  assert.deepEqual(folderEdits(dir, before), { edits: [
    { path: "knob.txt", search: "", replace: "level=2\n", write: true },
    { path: "src/a.txt", search: "", replace: "", remove: true },
    { path: "src/new.txt", search: "", replace: "n\n", write: true },
  ] });
  symlinkSync("/etc/hostname", join(dir, "link.txt"));
  const linked = folderEdits(dir, before);
  assert.ok("failed" in linked && /link\.txt.*not a plain file/.test(linked.failed), JSON.stringify(linked));
});

test("applyEdits writes and removes whole files, and one refused path refuses every edit", () => {
  const rules: EditRules = { artifact: ["src/**", "knob.txt"], protect: ["src/secret/**"], measurePaths: ["score.js"] };
  const dir = temp("apply");
  mkdirSync(join(dir, "src/secret"), { recursive: true });
  writeFileSync(join(dir, "knob.txt"), "level=1\n");
  writeFileSync(join(dir, "src/old.txt"), "old\n");
  writeFileSync(join(dir, "src/secret/key.txt"), "s\n");
  writeFileSync(join(dir, "score.js"), "//\n");
  const write = (path: string, replace: string) => ({ path, search: "", replace, write: true });
  const remove = (path: string) => ({ path, search: "", replace: "", remove: true });

  // Protect wins over artifact, the measure's file is refused, and a path outside artifact is refused: no file changes.
  for (const bad of [remove("src/secret/key.txt"), write("src/secret/key.txt", "x"), write("score.js", "x"), remove("score.js"), write("notes.md", "x"), write("../out.txt", "x"), write(".git/config", "x")]) {
    const r = applyEdits(dir, [write("knob.txt", "level=9\n"), remove("src/old.txt"), bad], rules);
    assert.equal(r.ok, false, bad.path);
    assert.equal(readFileSync(join(dir, "knob.txt"), "utf8"), "level=1\n");
    assert.ok(existsSync(join(dir, "src/old.txt")) && existsSync(join(dir, "src/secret/key.txt")) && !existsSync(join(dir, "notes.md")));
  }
  const missing = applyEdits(dir, [remove("src/none.txt")], rules);
  assert.ok(!missing.ok && /does not exist/.test(missing.reason));

  const r = applyEdits(dir, [write("knob.txt", "level=2\n"), write("src/deep/new.txt", "n\n"), remove("src/old.txt")], rules);
  assert.deepEqual(r, { ok: true, changed: ["knob.txt", "src/deep/new.txt", "src/old.txt"] });
  assert.equal(readFileSync(join(dir, "knob.txt"), "utf8"), "level=2\n");
  assert.equal(readFileSync(join(dir, "src/deep/new.txt"), "utf8"), "n\n");
  assert.ok(!existsSync(join(dir, "src/old.txt")));

  // A whole-file write never follows a link out of the folder.
  const outside = join(temp("outside"), "target.txt");
  writeFileSync(outside, "keep\n");
  symlinkSync(outside, join(dir, "src/link.txt"));
  assert.equal(applyEdits(dir, [write("src/link.txt", "x")], rules).ok, false);
  assert.equal(applyEdits(dir, [remove("src/link.txt")], rules).ok, false);
  assert.equal(readFileSync(outside, "utf8"), "keep\n");
});

test("agentProposer runs the agent in a new folder with only the request's files, and removes the folder", async () => {
  const problem = problemWith({ agent: "claude", args: ["--flag"] });
  const seen: { cwd: string; file: string; args: string[]; env: NodeJS.ProcessEnv; files: string[]; timeoutMs?: number }[] = [];
  const run: ProgramFn = async (cwd, file, args, env, o) => {
    seen.push({ cwd, file, args, env, files: readdirSync(cwd, { recursive: true }).map(String).sort(), timeoutMs: o.timeoutMs });
    writeFileSync(join(cwd, "knob.txt"), "level=2\n");
    rmSync(join(cwd, "src/a.txt"));
    return ok("thinking\nraised the level\n");
  };
  const { reply, calls } = await agentProposer(problem, { run, env: { PATH: "/bin", SYNTHE_API_KEY: "secret-key" } }).propose(request());
  assert.equal(calls, 0);
  assert.deepEqual(reply, { proposals: [{ summary: "raised the level", edits: [{ path: "knob.txt", search: "", replace: "level=2\n", write: true }, { path: "src/a.txt", search: "", replace: "", remove: true }] }] });
  const [s] = seen;
  assert.deepEqual(s.files, ["knob.txt", "src", "src/a.txt"]);
  assert.equal(s.file, "claude");
  assert.deepEqual(s.args.slice(0, 2), ["--flag", "-p"]);
  assert.deepEqual(s.env, { PATH: "/bin" });
  assert.equal(s.timeoutMs, 600_000);
  assert.ok(!s.cwd.startsWith(problem.dir) && !existsSync(s.cwd), "the folder is outside the repository and is gone after the run");
  assert.ok(!JSON.stringify(s).includes("secret-key"));
});

test("agentProposer turns no change, a non-zero exit, a time limit and a missing program into plain reasons", async () => {
  const problem = problemWith({ agent: "codex", timeout_s: 7 });
  const failedWith = async (result: RunResult) => {
    const { reply } = await agentProposer(problem, { run: async (cwd) => { if (result.code !== 0) writeFileSync(join(cwd, "knob.txt"), "level=50\n"); return result; } }).propose(request());
    assert.ok("failed" in reply, JSON.stringify(reply));
    return reply.failed;
  };
  assert.match(await failedWith(ok("I looked.\n")), /changed no file/);
  assert.match(await failedWith({ ok: false, code: 3, stdout: "", stderr: "fatal: no login\n", timedOut: false }), /exited with code 3: fatal: no login/);
  assert.match(await failedWith({ ok: false, code: null, stdout: "", stderr: "", timedOut: true }), /did not finish in 7 seconds/);
  assert.match(await failedWith({ ok: false, code: null, stdout: "", stderr: "spawn codex ENOENT", timedOut: false }), /could not start.*proposer\.bin/);
});

test("agentProposer runs once for each candidate, each in its own folder, and a failed run is one failed proposal", async () => {
  const problem = problemWith({ agent: "codex" }, { candidates: 3 });
  const folders: string[] = [];
  const run: ProgramFn = async (cwd) => {
    folders.push(cwd);
    assert.equal(readFileSync(join(cwd, "knob.txt"), "utf8"), "level=1\n", "each candidate starts from the kept files");
    const n = folders.length;
    if (n === 2) return { ok: false, code: 1, stdout: "", stderr: "", timedOut: false };
    writeFileSync(join(cwd, "knob.txt"), `level=${n + 1}\n`);
    return ok(`candidate ${n}\n`);
  };
  const { reply } = await agentProposer(problem, { run }).propose(request({ candidates: 3 }));
  assert.equal(new Set(folders).size, 3);
  assert.ok("proposals" in reply);
  assert.deepEqual(reply.proposals.map((p) => [p.summary, p.failed ?? null, p.edits.length]), [["candidate 1", null, 1], ["", "The agent exited with code 1.", 0], ["candidate 3", null, 1]]);
});

test("runProgram stops the whole process group at the time limit, and what the program left behind when it ends", async () => {
  const dir = temp("group");
  const script = (name: string, hang: boolean) => {
    const bin = join(dir, name);
    writeFileSync(bin, `#!${process.execPath}
const child = require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
require("fs").writeFileSync(${JSON.stringify(`${bin}.pids`)}, process.pid + " " + child.pid);
console.log(process.argv.slice(2).join("|"));
${hang ? "setInterval(() => {}, 1000);" : "child.unref();"}
`);
    chmodSync(bin, 0o755);
    return bin;
  };
  const pids = (bin: string) => readFileSync(`${bin}.pids`, "utf8").split(" ").map(Number);
  const gone = async (list: number[]) => { for (let i = 0; i < 50 && list.some(alive); i++) await new Promise((r) => setTimeout(r, 100)); return !list.some(alive); };

  const slow = script("slow", true);
  const started = Date.now();
  const timedOut = await runProgram(dir, slow, ["a b", "$HOME"], agentEnv(), { timeoutMs: 1000 });
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.stdout.trim(), "a b|$HOME", "no shell reads the arguments");
  assert.ok(Date.now() - started < 20_000);
  assert.ok(await gone(pids(slow)), "the agent and its child are stopped");

  const quick = script("quick", false);
  const ended = await runProgram(dir, quick, [], agentEnv(), { timeoutMs: 20_000 });
  assert.equal(ended.ok, true);
  assert.ok(await gone(pids(quick)), "a child that the program left behind is stopped");

  const none = await runProgram(dir, join(dir, "no-such-program"), [], agentEnv(), {});
  assert.equal(none.code, null);
});

test("the problem file accepts the agent form with defaults and refuses an unknown agent", () => {
  assert.deepEqual(problemWith({ agent: "claude" }).proposer, { agent: "claude", bin: "claude", args: [], timeout_s: 600 });
  assert.deepEqual(problemWith({ agent: "codex", bin: "/opt/x/codex", args: ["-m", "n"], timeout_s: 30 }).proposer, { agent: "codex", bin: "/opt/x/codex", args: ["-m", "n"], timeout_s: 30 });
  const dir = temp("bad");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const bad = (proposer: unknown) => {
    const c = checkProblem(JSON.stringify({ version: 1, name: "n", goal: "g", artifact: ["a"], measure: { command: "true", direction: "higher" }, proposer }), join(dir, "p.json"));
    assert.equal(c.ok, false, JSON.stringify(proposer));
    return c.ok ? "" : c.problems.join("\n");
  };
  assert.match(bad({ agent: "cursor" }), /^proposer\.agent: /);
  assert.match(bad({ agent: "claude", timeout_s: 0 }), /^proposer\.timeout_s: /);
  assert.match(bad({ agent: "claude", args: "--x" }), /^proposer\.args: /);
  assert.match(bad({ agent: "claude", bin: "" }), /^proposer\.bin: /);
  assert.match(bad({ agent: "claude", command: "x" }), /^proposer\.command: /);
});

test("the agent's folder and prompt leave out the measure's files, the cases, the problem file and protected paths", async () => {
  const dir = temp("wide");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, "data"));
  writeFileSync(join(dir, "data/cases.jsonl"), `{"id":"c1","input":"x"}\n`);
  const check = checkProblem(JSON.stringify({
    version: 1, name: "wide", goal: "g", artifact: ["**/*"], protect: ["secret/**"], guards: ["node tools/guard.cjs"],
    measure: { judge: { cases: "data/cases.jsonl", run: "node tools/run.cjs", compare: "node tools/compare.cjs" } },
    proposer: { agent: "claude", bin: "bin/agent" },
  }), join(dir, "problem.json"));
  assert.ok(check.ok, JSON.stringify(check));
  const hidden = ["problem.json", "data/cases.jsonl", "tools/run.cjs", "tools/compare.cjs", "tools/guard.cjs", "secret/held.json", "bin/agent"];
  const files = [...hidden, "knob.txt", "src/a.txt"].map((path) => ({ path, text: `text of ${path}\n` }));
  assert.deepEqual(agentFiles(check.problem, files).map((f) => f.path), ["knob.txt", "src/a.txt"]);

  let seen: string[] = [], prompt = "";
  const run: ProgramFn = async (cwd, _file, args) => {
    seen = readdirSync(cwd, { recursive: true }).map(String).sort();
    prompt = args[args.length - 1];
    return ok("");
  };
  // A file that was never copied is not a removed file: the run changed nothing.
  const { reply } = await agentProposer(check.problem, { run }).propose(request({ files }));
  assert.deepEqual(reply, { failed: "The agent changed no file." });
  assert.deepEqual(seen, ["knob.txt", "src", "src/a.txt"]);
  for (const path of hidden) assert.ok(!prompt.includes(`- ${path}`), `the prompt does not list ${path}`);
});

test("agentEnv removes the variables that name the folder where solve started", () => {
  const env = agentEnv({ HOME: "/home/p", PWD: "/home/p/repo", OLDPWD: "/home/p/repo/sub", INIT_CWD: "/home/p/repo" });
  assert.deepEqual(env, { HOME: "/home/p" });
});
