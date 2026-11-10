import assert from "node:assert/strict";
import { execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, describe, test } from "node:test";
import { startFakeAnthropic, type FakeReply } from "../scripts/dev/fake-anthropic.ts";

// The whole improve flow through the bundled CLI, on a small signup app shaped like synthelabs/builder-signup-demo:
// real git, a real local "origin", real node metric and tests, and only `gh` stubbed.
const work = mkdtempSync(join(tmpdir(), "synthe-improve-e2e-"));
const cli = join(work, "bundle/cli.js");

before(() => {
  // The same esbuild command `npm run build` uses for dist/cli.js, written elsewhere: e2e.test.ts rebuilds dist/
  // in a parallel process, and reading a bundle mid-write would make both tests flaky.
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const buildCli = pkg.scripts.build.split(" && ")[0];
  assert.ok(buildCli.includes("--outfile=dist/cli.js"));
  execSync(`npx ${buildCli.replace("--outfile=dist/cli.js", `--outfile=${cli}`)}`, { stdio: "ignore" });
});

const EMAILS = ["ann@example.com", "bob@test.com", "cy@site.com", "Dana@example.com", "eve.smith@example.com", "fay@mail.example.org",
  "gus+tag@example.com", "hal@example.io", "ivy_2@example.com", "jo@example.co.uk", "kim@EXAMPLE.COM", "lee-ann@example.net"];
const EVENT = "crimson-demo-event", TEAM = "crim-abcd-efgh-jkmn-pqrs";

// Each scenario gets its own folder: app, bare origin, gh state, temp dir. They share only the bundle.
function signupApp(name: string) {
  const root = join(work, name);
  const dir = join(root, "app");
  const marker = join(root, "metric-ran");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const write = (path: string, text: string) => { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), text); };
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, "tmp"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  write("package.json", JSON.stringify({ name: "signup", version: "1.0.0", scripts: { test: "node --test test/validate.test.js", metric: "node metrics/score.js" } }));
  write("validate.js", "module.exports = (email) => /^[a-z]+@[a-z]+\\.com$/.test(email);\n");
  write("server.js", "const valid = require(\"./validate.js\");\nmodule.exports = (req) => (valid(req.email) ? { ok: true } : { ok: false, error: \"Enter a valid email\" });\n");
  write("metrics/valid-signups.json", JSON.stringify(EMAILS));
  write("metrics/score.js", `const fs = require("fs");\nfs.writeFileSync(${JSON.stringify(marker)}, "ran");\nconst valid = require("../validate.js");\nconsole.log(require("./valid-signups.json").filter(valid).length);\n`);
  write("test/validate.test.js", `const test = require("node:test");\nconst assert = require("node:assert");\nconst valid = require("../validate.js");\ntest("rejects what is not an email", () => { assert.equal(valid("not-an-email"), false); assert.equal(valid("a@b"), false); });\ntest("accepts a plain address", () => { assert.equal(valid("ann@example.com"), true); });\n`);
  git("add", ".");
  git("commit", "-qm", "Signup app");
  write("README.md", "# Signup\n");
  git("add", ".");
  git("commit", "-qm", "README");
  execFileSync("git", ["init", "-q", "--bare", join(root, "origin.git")]);
  git("remote", "add", "origin", join(root, "origin.git"));
  git("push", "-q", "-u", "origin", "main");
  const origin = (...args: string[]) => execFileSync("git", ["--git-dir", join(root, "origin.git"), ...args], { encoding: "utf8" }).trim();
  return { root, dir, git, write, marker, origin, base: git("rev-parse", "HEAD") };
}
type App = ReturnType<typeof signupApp>;

// A stub `gh` that logs one JSON line per call ({args, stdin}) into <root>/gh/calls.jsonl. `pr list` answers an empty
// list unless <root>/gh/pr-list.json exists; `pr create` fails after logging when <root>/gh/fail-create exists (a lost reply).
function stubGh(app: App) {
  const state = join(app.root, "gh");
  const bin = join(state, "bin");
  mkdirSync(bin, { recursive: true });
  const calls = join(state, "calls.jsonl");
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2), line = args.join(" "), state = ${JSON.stringify(state)};
const log = (stdin) => fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, stdin }) + "\\n");
const done = (out, code = 0) => { if (out) console.log(out); process.exit(code); };
if (line === "--version") done("gh version 2.60.0");
if (line === "auth status") done("");
if (line.startsWith("repo view")) done('{"nameWithOwner":"o/r","defaultBranchRef":{"name":"main"}}');
if (line.startsWith("pr list")) { log(""); done(fs.existsSync(state + "/pr-list.json") ? fs.readFileSync(state + "/pr-list.json", "utf8") : "[]"); }
if (line.startsWith("pr create") || line.startsWith("pr merge")) {
  let stdin = ""; process.stdin.on("data", (c) => { stdin += c; }).on("end", () => {
    log(stdin);
    if (line.startsWith("pr create")) { if (fs.existsSync(state + "/fail-create")) { console.error("gh: connection reset"); process.exit(1); } done("https://github.com/o/r/pull/1"); }
    done("");
  });
  if (process.stdin.isTTY) process.stdin.emit("end");
} else { console.error("unexpected gh " + line); process.exit(1); }
`);
  chmodSync(join(bin, "gh"), 0o755);
  const all = () => (existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { args: string[]; stdin: string }) : []);
  const of = (sub: string) => all().filter((c) => c.args[0] === "pr" && c.args[1] === sub);
  return { bin, state, all, creates: () => of("create"), merges: () => of("merge") };
}

// "Synthe: valid signups 3 → 12", with or without the unit after each number.
const TITLE = /^Synthe: valid signups 3\b.*→ 12\b/;
const arg = (call: { args: string[] }, flag: string) => call.args[call.args.indexOf(flag) + 1];

// What a model would say. The edits are exact search/replace against the fixture's validate.js.
const PICK = { paths: ["validate.js", "server.js"], why: "validate.js decides which signups are accepted" };
const SHORTCUT = { summary: "accept any address that contains an @", edits: [{ path: "validate.js", search: "/^[a-z]+@[a-z]+\\.com$/.test(email)", replace: "email.includes(\"@\")" }] };
const RIGHT = { summary: "email check accepts dots, plus signs, capitals and subdomains", edits: [{ path: "validate.js", search: "/^[a-z]+@[a-z]+\\.com$/", replace: "/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/" }] };
const NOOP = { summary: "explain the email pattern in a comment", edits: [{ path: "validate.js", search: "module.exports = (email) =>", replace: "// One signup email, checked by pattern.\nmodule.exports = (email) =>" }] };
const NOTHING = { summary: "no further honest change to the validator would raise the count", edits: [] };
const TOUCH_TEST = { summary: "loosen the test so more addresses pass", edits: [{ path: "test/validate.test.js", search: "assert.equal(valid(\"a@b\"), false);", replace: "" }] };
const TOUCH_PACKAGE = { summary: "swap the test script for a no-op", edits: [{ path: "package.json", search: "node --test test/validate.test.js", replace: "true" }] };
const CREDIT = { status: 402, error: { type: "synthe_credit", message: "Your team's event credit is used up. Ask at the Synthe table for more." } } as const;

// The scripted model: `proposals[n-1]` is what round n proposes (an empty proposal after the script runs out), or a
// refusal in place of any reply.
const script = (proposals: (typeof RIGHT | FakeReply)[]) => (kind: "pick" | "propose", round: number): FakeReply => {
  if (kind === "pick") { const p = proposals[round - 1]; return p && "status" in p ? p : { json: PICK }; }
  const p = proposals[round - 1] ?? NOTHING;
  return "status" in p ? p : { json: p };
};

interface Run { code: number | null; out: string }
// Runs the bundled CLI the way a person's agent would: flags only, no questions, TMPDIR inside the scenario so a
// leaked scratch checkout shows up, and only the event credential (never a real key).
function synthe(app: App, gh: ReturnType<typeof stubGh>, url: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${gh.bin}:${process.env.PATH}`, SYNTHE_PROXY_URL: url, SYNTHE_EVENT_CODE: EVENT, SYNTHE_TEAM_CODE: TEAM,
    XDG_CONFIG_HOME: join(app.root, "config"), TMPDIR: join(app.root, "tmp"), ...extra };
  for (const k of ["ANTHROPIC_API_KEY", "SYNTHE_ANTHROPIC_KEY", "ANTHROPIC_BASE_URL"]) delete env[k];
  const child = spawn("node", [cli, ...args], { cwd: app.dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  const done = new Promise<Run>((resolve) => child.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); }));
  return { done, kill: (signal: NodeJS.Signals = "SIGINT") => child.kill(signal), output: () => out };
}

const IMPROVE = ["improve", "--agent", "--goal", "Let normal emails sign up", "--metric", "custom", "--command", "node metrics/score.js",
  "--label", "valid signups", "--unit", "of 12", "--direction", "higher", "--guard", "npm test"];
const improveArgs = (mode: "review" | "auto", rounds: number) => [...IMPROVE, "--mode", mode, "--rounds", String(rounds)];

// Every scenario: what the person owns is untouched, nothing was left behind, and the proxy saw only what it should.
function assertClean(app: App, fake: Awaited<ReturnType<typeof startFakeAnthropic>>, run: Run) {
  assert.equal(app.git("status", "--porcelain"), "", "the person's working tree is untouched");
  assert.equal(app.git("rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(app.git("rev-parse", "HEAD"), app.base);
  assert.equal(readFileSync(join(app.dir, "validate.js"), "utf8"), "module.exports = (email) => /^[a-z]+@[a-z]+\\.com$/.test(email);\n");
  assert.equal(app.git("worktree", "list").split("\n").length, 1, "no worktree left registered");
  assert.deepEqual(readdirSync(join(app.root, "tmp")).filter((n) => n.startsWith("synthe-improve-")), [], "no scratch checkout left in the temp folder");
  assert.ok(fake.requests.length > 0);
  for (const r of fake.requests) {
    assert.equal(r.headers["x-synthe-team"], TEAM);
    assert.equal(r.headers["x-synthe-event"], EVENT);
    assert.ok(!/key|synthe-|crim/i.test(r.path.replace("/v1/messages", "")), `no credential in the URL: ${r.path}`);
  }
  assert.ok(!run.out.includes(EVENT) && !run.out.includes(TEAM), "no event or team code in the output");
}

async function scenario(name: string, proposals: Parameters<typeof script>[0], args: (app: App) => string[], check: (x: { app: App; gh: ReturnType<typeof stubGh>; fake: Awaited<ReturnType<typeof startFakeAnthropic>>; run: Run }) => void) {
  const app = signupApp(name);
  const gh = stubGh(app);
  const fake = await startFakeAnthropic(script(proposals));
  try {
    const run = await synthe(app, gh, fake.url, args(app)).done;
    check({ app, gh, fake, run });
    assertClean(app, fake, run);
  } finally { await fake.close(); }
}

const tableRows = (body: string) => body.split("\n").filter((l) => l.startsWith("|"));
const lastLine = (s: string) => s.trim().split("\n").at(-1);

describe("improve loop through the bundle", { concurrency: true }, () => {
  test("a win: shortcut that breaks npm test not kept, the right fix kept, a no-op not kept; one pull request", async () => {
    await scenario("win", [SHORTCUT, RIGHT, NOOP], () => improveArgs("review", 3), ({ app, gh, fake, run }) => {
      assert.equal(run.code, 0, run.out);
      assert.ok(/3 of 12/.test(run.out) && /12 of 12/.test(run.out), run.out);
      const created = gh.creates();
      assert.equal(created.length, 1, "exactly one pull request");
      assert.equal(gh.merges().length, 0, "review mode never merges");
      assert.match(arg(created[0], "--title"), TITLE);
      assert.equal(arg(created[0], "--base"), "main");
      const branch = arg(created[0], "--head");
      assert.match(branch, /^synthe\/improve-\d+$/);
      assert.ok(lastLine(run.out)!.length > 0 && run.out.includes("https://github.com/o/r/pull/1"), run.out);

      // The body carries a per-round table: one row per round, only round 2 kept.
      const rows = tableRows(created[0].stdin).slice(2);
      assert.equal(rows.length, 3, created[0].stdin);
      assert.ok(rows[0].includes(SHORTCUT.summary) && rows[1].includes(RIGHT.summary) && rows[2].includes(NOOP.summary));
      assert.ok(!/kept\*\*/.test(rows[0]) && /kept\*\*/.test(rows[1]) && !/kept\*\*/.test(rows[2]), rows.join("\n"));
      assert.ok(rows[1].includes("12"));

      // Origin: base + the kept commit + a lessons-only commit.
      assert.equal(app.origin("rev-parse", `refs/heads/${branch}`).length, 40);
      const commits = app.origin("rev-list", "--reverse", `${app.base}..refs/heads/${branch}`).split("\n");
      assert.equal(commits.length, 2, "kept commit plus lessons commit");
      const files = (c: string) => app.origin("diff-tree", "--no-commit-id", "--name-only", "-r", c).split("\n");
      assert.deepEqual(files(commits[0]), ["validate.js"]);
      assert.ok(files(commits[1]).length > 0 && files(commits[1]).every((f) => f === ".synthe/improve-lessons.md" || f === "CLAUDE.md" || f === "AGENTS.md"), files(commits[1]).join(","));
      assert.equal(app.origin("rev-parse", `${commits[1]}~1`), commits[0]);
      assert.ok(app.origin("show", `refs/heads/${branch}:validate.js`).includes("[^\\s@]+"));
      assert.equal(app.origin("rev-parse", "refs/heads/main"), app.base, "main on origin did not move");

      // The model was asked once per round, never more.
      assert.equal(fake.requests.filter((r) => r.kind === "pick").length, 3);
    });
  });

  test("credit runs out in round 2: the round 1 win is still published and the refusal is not retried", async () => {
    await scenario("credit", [RIGHT, CREDIT], () => improveArgs("review", 3), ({ gh, fake, run }) => {
      assert.equal(run.code, 0, run.out);
      assert.equal(gh.creates().length, 1);
      assert.match(arg(gh.creates()[0], "--title"), TITLE);
      assert.ok(run.out.includes("event credit is used up"), run.out);
      assert.equal(fake.requests.filter((r) => r.round === 2).length, 1, "the 402 was asked once");
      assert.equal(fake.requests.length, 3, "round 1 pick and propose, round 2 pick");
    });
  });

  test("no wins: nothing pushed, no pull request, exit 1, and what was tried is shown", async () => {
    await scenario("nowin", [SHORTCUT, NOOP, NOTHING], () => improveArgs("review", 3), ({ app, gh, run }) => {
      assert.equal(run.code, 1, run.out);
      assert.equal(gh.creates().length, 0);
      assert.equal(app.origin("for-each-ref", "--format=%(refname)"), "refs/heads/main", "no branch was pushed");
      assert.match(run.out, /what was tried/i);
      assert.ok(run.out.includes(SHORTCUT.summary) && run.out.includes(NOOP.summary) && run.out.includes(NOTHING.summary), run.out);
    });
  });

  test("a model edit to a test file or package.json is refused and counts as a miss", async () => {
    await scenario("refused", [TOUCH_TEST, TOUCH_PACKAGE, NOTHING], () => improveArgs("review", 3), ({ app, gh, run }) => {
      assert.equal(run.code, 1, run.out);
      assert.equal(gh.creates().length, 0);
      assert.equal(app.origin("for-each-ref", "--format=%(refname)"), "refs/heads/main");
      assert.ok(run.out.includes(TOUCH_TEST.summary) && run.out.includes(TOUCH_PACKAGE.summary), run.out);
      assert.ok(run.out.includes("test/validate.test.js") && run.out.includes("package.json"), "the refusal names the file");
      assert.ok(!run.out.includes("Round 1: trying") && !run.out.includes("Round 2: trying"), "a refused edit is never applied or measured");
      assert.equal(readFileSync(app.marker, "utf8"), "ran", "only the baseline ever ran the metric");
    });
  });

  test("auto mode merges the pull request with --squash --delete-branch, after creating it", async () => {
    await scenario("auto", [RIGHT], () => improveArgs("auto", 1), ({ gh, run }) => {
      assert.equal(run.code, 0, run.out);
      const order = gh.all().filter((c) => c.args[1] !== "list").map((c) => c.args.slice(0, 2).join(" "));
      assert.deepEqual(order, ["pr create", "pr merge"]);
      const merge = gh.merges()[0];
      assert.deepEqual(merge.args.slice(2), ["https://github.com/o/r/pull/1", "--squash", "--delete-branch"]);
    });
  });
});

test("improve then submit on a signup app: 3 → 12 opens a pull request; a shortcut that breaks the test does not", () => {
  const app = signupApp("handoff");
  const gh = stubGh(app);
  const run = (...args: string[]) => {
    const r = spawnSync("node", [cli, ...args], { cwd: app.dir, encoding: "utf8", env: { ...process.env, PATH: `${gh.bin}:${process.env.PATH}` }, timeout: 120_000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const prCreates = () => gh.creates().length;

  // 1. Baseline.
  const improved = run(...IMPROVE, "--handoff", "--mode", "review");
  assert.equal(improved.code, 0, improved.out);
  assert.ok(improved.out.includes("Current code: 3 of 12 (3 runs: 3, 3, 3)."), improved.out);
  assert.ok(improved.out.includes("git checkout -b synthe/improve-1"));
  assert.ok(existsSync(join(app.dir, ".git/synthe-improve.json")));
  assert.equal(app.git("status", "--porcelain"), "");
  assert.equal(app.git("worktree", "list").split("\n").length, 1);

  // 2. The real fix wins and opens a pull request with the numbers.
  app.git("checkout", "-q", "-b", "synthe/improve-1");
  app.write("validate.js", "module.exports = (email) => /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);\n");
  app.git("commit", "-qam", "Accept ordinary email addresses");
  const won = run("submit", "--agent");
  assert.equal(won.code, 0, won.out);
  assert.ok(won.out.includes("valid signups: 3 of 12 → 12 of 12 (higher is better)."), won.out);
  assert.ok(won.out.includes("Pull request: https://github.com/o/r/pull/1"));
  const created = gh.creates()[0];
  assert.equal(arg(created, "--title"), "Synthe: valid signups 3 of 12 → 12 of 12");
  assert.ok(created.stdin.includes("**valid signups: 3 of 12 → 12 of 12**") && created.stdin.includes("## How it was measured") && created.stdin.includes("validate.js"));
  assert.equal(app.git("ls-remote", "origin", "synthe/improve-1").split("\t")[0], app.git("rev-parse", "HEAD"));

  // 3. A shortcut that makes the number go up but breaks the test is not published.
  app.git("checkout", "-q", "main");
  app.git("checkout", "-q", "-b", "synthe/improve-2");
  app.write("validate.js", "module.exports = () => true;\n");
  app.git("commit", "-qam", "Accept everything");
  const shortcut = run("submit", "--agent");
  assert.equal(shortcut.code, 1, shortcut.out);
  assert.ok(shortcut.out.includes("Not merged: The regression check did not pass."), shortcut.out);
  assert.equal(prCreates(), 1);

  // 4. Editing the metric's own data is refused before anything runs.
  app.git("checkout", "-q", "main");
  app.git("checkout", "-q", "-b", "synthe/improve-3");
  app.write("metrics/valid-signups.json", JSON.stringify(EMAILS.slice(0, 3)));
  app.git("commit", "-qam", "Fewer signups to check");
  rmSync(app.marker, { force: true });
  const gamed = run("submit", "--agent");
  assert.equal(gamed.code, 1, gamed.out);
  assert.ok(gamed.out.includes("metrics/valid-signups.json is in a test, benchmark, metric or fixture folder"), gamed.out);
  assert.ok(gamed.out.includes("Nothing was measured."));
  assert.ok(!existsSync(app.marker), "the metric must not run for a refused change");
  assert.equal(prCreates(), 1);
  assert.equal(app.git("worktree", "list").split("\n").length, 1);
});

test("the bundle's help lists improve and submit", () => {
  const help = execFileSync("node", [cli, "--help"], { encoding: "utf8" });
  assert.match(help, /npx synthe improve/);
  assert.match(help, /npx synthe submit/);
});
