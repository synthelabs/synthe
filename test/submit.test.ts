import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentSetupError } from "../src/cli/agent.ts";
import type { ImproveIo } from "../src/cli/improve.ts";
import { SUBMIT_NEXT_LOSS, SUBMIT_NEXT_WIN, submit, submitOptions } from "../src/cli/submit.ts";
import { improveFile, type ImproveConfig } from "../src/improve/config.ts";
import type { Exec } from "../src/improve/exec.ts";
import { config, custom } from "./improve-helpers.ts";

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const write = (dir: string, path: string, text: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
};

// A repo on main with one commit, an improve config whose baseline is that commit, and a branch to edit.
function repo(over: Partial<ImproveConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "synthe-submit-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  write(dir, "package.json", JSON.stringify({ scripts: { test: "node --test" } }));
  write(dir, "src/a.js", "export const a = 1;\n");
  write(dir, "test/x.test.js", "// test\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  const base = git(dir, "rev-parse", "HEAD");
  const cfg = config({ guard: { command: "npm test" }, metric: { ...custom("node score.js").metric }, ...over });
  writeFileSync(improveFile(join(dir, ".git")), JSON.stringify({ ...cfg, baseline: { ...cfg.baseline, commit: base } }));
  return { dir, base };
}

const branchWith = (dir: string, files: Record<string, string>, name = "synthe/improve-1") => {
  git(dir, "checkout", "-q", "-b", name);
  for (const [p, t] of Object.entries(files)) write(dir, p, t);
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "change");
  return git(dir, "rev-parse", "HEAD");
};

interface Fake { values?: Record<string, number[]>; guardOk?: boolean; mergeFails?: boolean; dirty?: boolean }

function fakeIo(dir: string, f: Fake = {}) {
  const said: string[] = [];
  const ran: { cmd: string; args: string[]; stdin?: string }[] = [];
  const execCalls: string[] = [];
  const shaAt = new Map<string, string>();
  const runIndex = new Map<string, number>();
  const exec: Exec = async (cwd, command) => {
    execCalls.push(command);
    const add = command.match(/^git worktree add --detach '(.+)' (\w+)$/);
    if (add) shaAt.set(add[1], add[2]);
    if (command.startsWith("git worktree")) return { ok: true, stdout: "", stderr: "", ms: 1, timedOut: false };
    const sha = shaAt.get(cwd)!;
    if (command === "npm test") return { ok: f.guardOk ?? true, stdout: "", stderr: "", ms: 1, timedOut: false };
    const i = runIndex.get(sha) ?? 0;
    runIndex.set(sha, i + 1);
    const values = f.values?.[sha] ?? [3, 3, 3];
    return { ok: true, stdout: `${values[i % values.length]}\n`, stderr: "", ms: 1, timedOut: false };
  };
  const io: ImproveIo = {
    say: (t) => said.push(t),
    ask: async () => { throw new Error("submit asks nothing"); },
    exec,
    async run(cmd, args, stdin) {
      ran.push({ cmd, args, stdin });
      const line = args.join(" ");
      if (cmd === "git" && args[0] === "status") return f.dirty ? " M src/a.js\n" : "";
      if (cmd === "git" && (args[0] === "push" || args[0] === "fetch")) return "";
      if (cmd === "git") return execFileSync("git", args, { cwd: dir, encoding: "utf8" });
      if (line === "--version") return "gh version 2.60.0\n";
      if (line.startsWith("repo view")) return JSON.stringify({ nameWithOwner: "o/r", defaultBranchRef: { name: "main" } });
      if (line.startsWith("pr create")) return "Creating pull request...\nhttps://github.com/o/r/pull/1\n";
      if (line.startsWith("pr merge") && f.mergeFails) throw new Error("Pull request is not mergeable: the base branch policy prohibits the merge.\nmore");
      return "";
    },
  };
  return { io, said, ran, execCalls };
}

test("submit refuses a change to a protected path before measuring anything", async () => {   // Review Focus 4
  const { dir } = repo();
  branchWith(dir, { "test/x.test.js": "// loosened\n", "src/a.js": "export const a = 2;\n", "package-lock.json": "{}" });
  const { io, said, execCalls, ran } = fakeIo(dir);
  assert.equal(await submit(io, dir, { agent: true }), false);
  assert.equal(execCalls.length, 0);
  const out = said.join("\n");
  assert.match(out, /test\/x\.test\.js is a test file/);
  assert.match(out, /package-lock\.json lists dependencies/);
  assert.equal(said.at(-1), "Nothing was measured. Undo those edits and run npx synthe submit again.");
  assert.ok(!ran.some((r) => r.args[0] === "push"));
});

test("submit measures the candidate, opens the pull request with the numbers and stops in review mode", async () => {
  const { dir, base } = repo();
  const head = branchWith(dir, { "src/a.js": "export const a = 2;\n" });
  const { io, said, ran, execCalls } = fakeIo(dir, { values: { [head]: [12, 12, 12] } });
  assert.equal(await submit(io, dir, { agent: false }), true);
  assert.ok(!execCalls.some((c) => c.includes(base)), "the stored baseline is reused when the default branch did not move");
  assert.deepEqual(execCalls.filter((c) => !c.startsWith("git")), ["node score.js", "node score.js", "node score.js", "npm test"]);
  assert.ok(ran.some((r) => r.cmd === "git" && r.args.join(" ") === "push -u origin HEAD"));
  const pr = ran.find((r) => r.args[0] === "pr" && r.args[1] === "create")!;
  assert.deepEqual(pr.args.slice(0, 6), ["pr", "create", "--base", "main", "--head", "synthe/improve-1"]);
  assert.ok(pr.args.includes("Synthe: valid signups 3 units → 12 units"));
  assert.ok(pr.args.includes("--body-file") && pr.args.at(-1) === "-");
  assert.ok(pr.stdin!.includes("## Result") && pr.stdin!.includes("3 units → 12 units"));
  assert.ok(pr.stdin!.includes("src/a.js") && pr.stdin!.includes(`- Before: ${base}`) && pr.stdin!.includes(`- After: ${head}`));
  assert.ok(!ran.some((r) => r.args[1] === "merge"));
  assert.ok(said.includes("Pull request: https://github.com/o/r/pull/1"));
  assert.ok(said.includes("Better by 9, more than the run-to-run noise of 0; the regression check passed."));
  assert.equal(said.at(-1), "Review it there; merge it to keep the change.");
});

test("submit in auto mode merges with squash and says to pull; a refused merge leaves the PR open", async () => {
  for (const mergeFails of [false, true]) {
    const { dir } = repo({ mode: "auto" });
    const head = branchWith(dir, { "src/a.js": "export const a = 2;\n" });
    const { io, said, ran } = fakeIo(dir, { values: { [head]: [12] }, mergeFails });
    assert.equal(await submit(io, dir, { agent: true }), true);
    assert.ok(ran.some((r) => r.args.join(" ") === "pr merge https://github.com/o/r/pull/1 --squash --delete-branch"));
    assert.equal(said.at(-2), mergeFails
      ? "Could not merge it (Pull request is not mergeable: the base branch policy prohibits the merge.): the pull request is open for a person to merge."
      : "Merged into main. Run git pull.");
    assert.equal(said.at(-1), SUBMIT_NEXT_WIN);
  }
});

test("submit re-measures the base when the default branch moved", async () => {   // Review Focus 3
  const { dir } = repo();
  write(dir, "README.md", "teammate's push\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "teammate");
  const moved = git(dir, "rev-parse", "HEAD");
  const head = branchWith(dir, { "src/a.js": "export const a = 2;\n" });
  const { io, said, execCalls, ran } = fakeIo(dir, { values: { [moved]: [5, 5, 5], [head]: [12, 12, 12] } });
  assert.equal(await submit(io, dir, { agent: false }), true);
  assert.ok(said.includes(`The default branch moved since you ran improve; measuring it again at ${moved.slice(0, 7)}...`));
  const adds = execCalls.filter((c) => c.startsWith("git worktree add"));
  assert.equal(adds.length, 2);
  assert.ok(adds[0].endsWith(moved) && adds[1].endsWith(head));
  assert.ok(ran.find((r) => r.args[1] === "create")!.args.includes("Synthe: valid signups 5 units → 12 units"));
});

test("submit reports a loss within noise with the exact why and exit code 1", async () => {
  const { dir } = repo({ baseline: { commit: "", median: 100, runs: [100, 98, 103], at: "2026-11-07T00:00:00Z" } });
  const head = branchWith(dir, { "src/a.js": "export const a = 2;\n" });
  const { io, said, ran } = fakeIo(dir, { values: { [head]: [104, 102, 107] } });
  assert.equal(await submit(io, dir, { agent: true }), false);
  assert.ok(said.includes("Not merged: Within noise: changed by 4, but runs vary by up to 5."));
  assert.equal(said.at(-1), SUBMIT_NEXT_LOSS);
  assert.ok(!ran.some((r) => r.args[0] === "push" || r.args[0] === "pr"));
});

test("submit does not open a pull request when the regression check fails on the change", async () => {
  const { dir } = repo();
  const head = branchWith(dir, { "src/a.js": "export const a = 2;\n" });
  const { io, said, ran } = fakeIo(dir, { values: { [head]: [12] }, guardOk: false });
  assert.equal(await submit(io, dir, { agent: false }), false);
  assert.ok(said.includes("Not merged: The regression check did not pass."));
  assert.ok(!ran.some((r) => r.args[0] === "pr"));
});

test("submit requires a branch, a clean tree, a change, a config and a small diff", async () => {
  const main = repo();
  const onMain = fakeIo(main.dir);
  assert.equal(await submit(onMain.io, main.dir, { agent: false }), false);
  assert.match(onMain.said.join("\n"), /Make your change on a branch: git checkout -b synthe\/improve-1/);

  const dirty = fakeIo(main.dir, { dirty: true });
  assert.equal(await submit(dirty.io, main.dir, { agent: false }), false);
  assert.match(dirty.said.join("\n"), /- Commit your change first\./);

  git(main.dir, "checkout", "-q", "-b", "empty");
  const empty = fakeIo(main.dir);
  assert.equal(await submit(empty.io, main.dir, { agent: false }), false);
  assert.match(empty.said.join("\n"), /^No committed change to measure\./m);

  const big = repo();
  branchWith(big.dir, Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`src/f${i}.js`, "x"])));
  const many = fakeIo(big.dir);
  assert.equal(await submit(many.io, big.dir, { agent: false }), false);
  assert.ok(many.said.includes("This change touches 61 files. Synthe measures one small change at a time; split it up."));
  assert.equal(many.execCalls.length, 0);

  const none = repo();
  git(none.dir, "checkout", "-q", "-b", "b");
  execFileSync("rm", [improveFile(join(none.dir, ".git"))]);
  const missing = fakeIo(none.dir);
  assert.equal(await submit(missing.io, none.dir, { agent: false }), false);
  assert.match(missing.said.join("\n"), /^Run npx synthe improve first\./m);
});

test("submit takes only --agent", () => {
  assert.deepEqual(submitOptions([]), { agent: false });
  assert.deepEqual(submitOptions(["--agent"]), { agent: true });
  assert.throws(() => submitOptions(["--agent", "--force"]), AgentSetupError);
  assert.throws(() => submitOptions(["--agent", "--agent"]), AgentSetupError);
  assert.throws(() => submitOptions(["--yes"]), /--yes is not an option of npx synthe submit/);
});
