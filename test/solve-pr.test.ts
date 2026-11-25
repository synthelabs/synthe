import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPullRequest, type Ran, type Runner } from "../src/solve/pr.ts";
import type { SolveResult } from "../src/solve/types.ts";

const ok = (stdout = ""): Ran => ({ code: 0, stdout, stderr: "", missing: false });
const fail = (stderr: string, code = 1): Ran => ({ code, stdout: "", stderr, missing: false });

function fake(answers: (file: string, args: string[]) => Ran) {
  const calls: { file: string; args: string[]; input?: string }[] = [];
  const run: Runner = async (file, args, o) => { calls.push({ file, args, input: o.input }); return answers(file, args); };
  return { run, calls };
}

function setup(branch: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "solve-pr-"));
  const reportPath = join(dir, "report.md");
  writeFileSync(reportPath, "# Report\n\nKept: raise the knob.\n");
  const result: SolveResult = { problem: "p", stopped: "done", baseline: 1, final: 2, branch, attempts: [] };
  return { result, a: { repoRoot: dir, reportPath, goal: "Make the knob higher." } };
}

test("openPullRequest with no kept change runs nothing and says no pull request was opened", async () => {
  const { result, a } = setup(null);
  const f = fake(() => ok());
  const r = await openPullRequest(result, a, f.run);
  assert.equal(r.ok, true);
  assert.match(r.message, /no pull request/i);
  assert.deepEqual(f.calls, []);
});

test("openPullRequest pushes the branch, then runs gh pr create with --head and report.md on stdin", async () => {
  const { result, a } = setup("synthe/solve-p-1");
  const f = fake((file, args) => {
    if (args.includes("rev-parse")) return ok("main\n");
    if (file === "gh" && args[0] === "pr") return ok("https://github.com/t/p/pull/3\n");
    return ok();
  });
  const r = await openPullRequest(result, a, f.run);
  assert.equal(r.ok, true, r.message);
  assert.equal(r.url, "https://github.com/t/p/pull/3");
  const push = f.calls.findIndex((c) => c.file === "git" && c.args.includes("push"));
  const create = f.calls.findIndex((c) => c.file === "gh" && c.args[0] === "pr");
  assert.ok(push >= 0 && create > push, "push comes before gh pr create");
  // The push takes its credentials from gh, so no token has to stay in .git/config (persist-credentials: false).
  assert.deepEqual(f.calls[push].args.slice(2, 6), ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]);
  const args = f.calls[create].args;
  assert.equal(args[args.indexOf("--head") + 1], "synthe/solve-p-1");
  assert.equal(args[args.indexOf("--base") + 1], "main");
  assert.equal(f.calls[create].input, "# Report\n\nKept: raise the knob.\n");
});

test("openPullRequest names gh when it is missing or not logged in, and pushes nothing", async () => {
  for (const [answer, want] of [[{ code: null, stdout: "", stderr: "", missing: true }, /gh is not installed/], [fail("You are not logged into any GitHub hosts."), /gh is not logged in/]] as const) {
    const { result, a } = setup("synthe/solve-p-2");
    const f = fake((file) => (file === "gh" ? answer : ok()));
    const r = await openPullRequest(result, a, f.run);
    assert.equal(r.ok, false);
    assert.match(r.message, want);
    assert.match(r.message, /synthe\/solve-p-2/);
    assert.ok(!f.calls.some((c) => c.args.includes("push")), "nothing is pushed");
  }
});

test("openPullRequest names the push when origin refuses it, and does not run gh pr create", async () => {
  const { result, a } = setup("synthe/solve-p-3");
  const f = fake((file, args) => (args.includes("push") ? fail("remote: refused") : ok()));
  const r = await openPullRequest(result, a, f.run);
  assert.equal(r.ok, false);
  assert.match(r.message, /could not push synthe\/solve-p-3.*remote: refused/);
  assert.ok(!f.calls.some((c) => c.file === "gh" && c.args[0] === "pr"));
});

test("openPullRequest reports a failed gh pr create after the push", async () => {
  const { result, a } = setup("synthe/solve-p-4");
  const f = fake((file, args) => (file === "gh" && args[0] === "pr" ? fail("GraphQL: no permission") : ok("main")));
  const r = await openPullRequest(result, a, f.run);
  assert.equal(r.ok, false);
  assert.match(r.message, /gh could not open the pull request \(GraphQL: no permission\)/);
});

test("templates/synthe-solve.yml leaves no token in .git/config for the measure's code to find", async () => {
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(new URL("../templates/synthe-solve.yml", import.meta.url), "utf8");
  assert.match(text, /uses: actions\/checkout@v4\n(?:\s+.*\n)*?\s+persist-credentials: false/);
});
