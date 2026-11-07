// Runs `npx synthe improve` the way a person would, through the real bundled CLI, against a fake Messages API:
// a signup app with a local bare origin and a stub `gh`, questions answered on stdin as they appear. Spends nothing.
//   node scripts/dev/improve-user-flow.ts
// Scenarios: (A) the loop: a shortcut, the right fix, a no-op, then nothing left; (B) event credit runs out in
// round 2 of an auto-mode run; (C) --handoff, then npx synthe submit.
import assert from "node:assert/strict";
import { execFileSync, execSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeAnthropic, type FakeReply } from "./fake-anthropic.ts";

const work = mkdtempSync(join(tmpdir(), "synthe-user-flow-"));
const cli = join(work, "bundle/cli.js");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
execSync(`npx ${pkg.scripts.build.split(" && ")[0].replace("--outfile=dist/cli.js", `--outfile=${cli}`)}`, { stdio: "ignore" });

const EMAILS = ["ann@example.com", "bob@test.com", "cy@site.com", "Dana@example.com", "eve.smith@example.com", "fay@mail.example.org",
  "gus+tag@example.com", "hal@example.io", "ivy_2@example.com", "jo@example.co.uk", "kim@EXAMPLE.COM", "lee-ann@example.net"];
const EVENT = "crimson-demo-event", TEAM = "crim-abcd-efgh-jkmn-pqrs";

function signupApp(name: string) {
  const dir = join(work, name);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const write = (path: string, text: string) => { mkdirSync(join(dir, path, ".."), { recursive: true }); writeFileSync(join(dir, path), text); };
  mkdirSync(dir);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "team@example.com");
  git("config", "user.name", "Team");
  write("package.json", JSON.stringify({ name: "signup", version: "1.0.0", scripts: { test: "node --test test/validate.test.js" } }, null, 2));
  write("validate.js", "module.exports = (email) => /^[a-z]+@[a-z]+\\.com$/.test(email);\n");
  write("server.js", "const valid = require(\"./validate.js\");\nmodule.exports = (req) => (valid(req.email) ? { ok: true } : { ok: false, error: \"Enter a valid email\" });\n");
  write("metrics/valid-signups.json", JSON.stringify(EMAILS));
  write("metrics/score.js", "const valid = require(\"../validate.js\");\nconsole.log(require(\"./valid-signups.json\").filter(valid).length);\n");
  write("test/validate.test.js", "const test = require(\"node:test\");\nconst assert = require(\"node:assert\");\nconst valid = require(\"../validate.js\");\ntest(\"rejects what is not an email\", () => { assert.equal(valid(\"not-an-email\"), false); assert.equal(valid(\"a@b\"), false); });\ntest(\"accepts a plain address\", () => { assert.equal(valid(\"ann@example.com\"), true); });\n");
  write("CLAUDE.md", "# Signup app\n\nRun npm test before pushing.\n");
  write("README.md", "# Signup\n");
  git("add", ".");
  git("commit", "-qm", "Signup app");
  execFileSync("git", ["init", "-q", "--bare", join(work, `${name}-origin.git`)]);
  git("remote", "add", "origin", join(work, `${name}-origin.git`));
  git("push", "-q", "-u", "origin", "main");
  return { dir, git, write };
}

const bin = join(work, "bin");
const ghLog = join(work, "gh.log");
mkdirSync(bin);
writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$*" in
  "--version") echo "gh version 2.60.0" ;;
  "auth status") exit 0 ;;
  "repo view"*) echo '{"nameWithOwner":"team/signup","defaultBranchRef":{"name":"main"}}' ;;
  "pr create"*) { echo "ARGS: $*"; cat; echo; } >> ${JSON.stringify(ghLog)}; echo "https://github.com/team/signup/pull/1" ;;
  "pr merge"*) echo "ARGS: $*" >> ${JSON.stringify(ghLog)} ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`);
chmodSync(join(bin, "gh"), 0o755);

const SHORTCUT = { summary: "accept any address that contains an @", edits: [{ path: "validate.js", search: "/^[a-z]+@[a-z]+\\.com$/.test(email)", replace: "email.includes(\"@\")" }] };
const RIGHT = { summary: "email check accepts dots, plus signs, capitals and subdomains", edits: [{ path: "validate.js", search: "/^[a-z]+@[a-z]+\\.com$/", replace: "/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/" }] };
const NOOP = { summary: "explain the email pattern in a comment", edits: [{ path: "validate.js", search: "module.exports = (email) => /^[^\\s@]+@", replace: "// One signup email: something@something.tld, no spaces.\nmodule.exports = (email) => /^[^\\s@]+@" }] };
const NOTHING = { summary: "no further honest change to the validator would raise the count", edits: [] };
const PICK = { paths: ["validate.js", "server.js"], why: "validate.js decides which signups are accepted" };

// A person at a terminal: answer each question when it appears.
function improve(dir: string, args: string[], url: string, answers: [string, string][]) {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SYNTHE_PROXY_URL: url, SYNTHE_EVENT_CODE: EVENT, SYNTHE_TEAM_CODE: TEAM, XDG_CONFIG_HOME: join(work, "config") };
  for (const k of ["ANTHROPIC_API_KEY", "SYNTHE_ANTHROPIC_KEY", "ANTHROPIC_BASE_URL"]) delete env[k];
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn("node", [cli, ...args], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", sinceAnswer = "";
    const pending = [...answers];
    const take = (d: Buffer) => {
      out += d; sinceAnswer += d;
      while (pending.length && sinceAnswer.includes(pending[0][0])) {
        child.stdin.write(`${pending.shift()![1]}\n`);
        sinceAnswer = "";
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("close", (code) => resolve({ code, out }));
  });
}

const answers = (auto: boolean): [string, string][] => [
  ["What should get better?", "Let people with ordinary email addresses sign up"],
  ["Type 1-", "2"],
  ["Command that prints the number:", "node metrics/score.js"],
  ["What does the number count?", "valid signups"],
  ["Unit (press Enter for units):", ""],
  ["Is a higher number better? y/n:", "y"],
  ["Regression check that must pass", ""],
  ["automatically? y/n", auto ? "y" : ""],
];

const show = (title: string, r: { code: number | null; out: string }) => {
  console.log(`\n===== ${title} (exit ${r.code}) =====`);
  console.log(r.out.trimEnd());
  assert.ok(!r.out.includes(EVENT) && !r.out.includes(TEAM), "no event or team code in the output");
};

// A: the loop.
const a = signupApp("app-a");
const scriptA = [SHORTCUT, RIGHT, NOOP];
const serverA = await startFakeAnthropic((kind, round): FakeReply => ({ json: kind === "pick" ? PICK : scriptA[round - 1] ?? NOTHING }));
const runA = await improve(a.dir, ["improve"], serverA.url, answers(false));
show("A: npx synthe improve (review mode)", runA);
console.log("\n--- A: pull request body (from the stub gh) ---");
console.log(readFileSync(ghLog, "utf8").trimEnd());
console.log("\n--- A: git ---");
console.log(a.git("ls-remote", "--heads", "origin"));
console.log(a.git("log", "--format=%h %an: %s", "synthe/improve-1", "-3"));
console.log("lessons commit touches:", a.git("diff-tree", "--no-commit-id", "--name-only", "-r", "synthe/improve-1").split("\n").join(", "));
console.log("working tree clean:", a.git("status", "--porcelain") === "", "| worktrees:", a.git("worktree", "list").split("\n").length);
console.log("local lesson log:", existsSync(join(a.dir, ".git/.synthe/improve-lessons.md")));
// What the organizers receive on event credit: the run record, batched to the proxy's /improve endpoint.
const showReceipts = (label: string, receipts: { headers: any; body: any }[]) => {
  console.log(`\n--- ${label}: run record received by the (fake) proxy ---`);
  const events = receipts.flatMap((r) => r.body.events);
  const last = receipts.at(-1)?.body;
  console.log(`batches: ${receipts.length}; run ${last?.run_id}; final: ${last?.final}; seq: ${receipts.map((r) => r.body.seq).join(",")}; sizes: ${receipts.map((r) => JSON.stringify(r.body).length).join(",")} bytes`);
  console.log(`headers carry the codes (event: ${receipts.every((r) => r.headers["x-synthe-event"] === EVENT)}, team: ${receipts.every((r) => r.headers["x-synthe-team"] === TEAM)}, install id: ${receipts.every((r) => /^[0-9a-f-]{36}$/.test(r.headers["x-synthe-install"]))}); bodies never do: ${!receipts.some((r) => JSON.stringify(r.body).includes(EVENT) || JSON.stringify(r.body).includes(TEAM))}`);
  console.log(`run: ${JSON.stringify(last?.run)}`);
  console.log(`summary: ${JSON.stringify(last?.summary)}`);
  const counts: Record<string, number> = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  console.log(`events: ${events.length} (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")})`);
  for (const e of events) {
    if (e.type === "say") console.log(`  ${e.i} say      ${String(e.text).slice(0, 110)}`);
    else if (e.type === "ask") console.log(`  ${e.i} ask      ${e.question} -> ${JSON.stringify(e.answer)}`);
    else if (e.type === "model") console.log(`  ${e.i} model    ${e.purpose} ${e.model} max ${e.max_tokens} in ${e.input_tokens} out ${e.output_tokens} $${e.cost_usd} ${e.stop_reason} ${e.ms}ms ok=${e.ok}`);
    else if (e.type === "candidate") console.log(`  ${e.i} candidate round ${e.round} "${e.summary}" files ${JSON.stringify(e.files)} refused=${e.refused} cut=${e.cut}\n${String(e.diff).split("\n").map((l: string) => `           | ${l}`).join("\n")}`);
    else if (e.type === "command") console.log(`  ${e.i} command  ${e.command} ok=${e.ok} ${e.ms}ms${e.tail ? ` tail=${JSON.stringify(String(e.tail).slice(-80))}` : ""}`);
    else console.log(`  ${e.i} ${e.type.padEnd(8)} ${JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !["i", "t", "type"].includes(k)))).slice(0, 200)}`);
  }
};
showReceipts("A", serverA.receipts);
const reqA = serverA.requests;
console.log(`requests: ${reqA.length}; models: ${[...new Set(reqA.map((r) => r.body.model))].join(", ")}; max_tokens: ${[...new Set(reqA.map((r) => r.body.max_tokens))].join(", ")}; stream: ${reqA.some((r) => r.body.stream)}; tools: ${reqA.some((r) => r.body.tools)}`);
console.log(`x-synthe-team header on every request, equal to SYNTHE_TEAM_CODE: ${reqA.every((r) => r.headers["x-synthe-team"] === TEAM)}`);
console.log(`x-synthe-event header on every request: ${reqA.every((r) => r.headers["x-synthe-event"] === EVENT)}; x-api-key is the proxy placeholder: ${reqA.every((r) => r.headers["x-api-key"] === "synthe-proxy")}`);
await serverA.close();

// B: credit runs out in round 2 of an auto-mode run.
writeFileSync(ghLog, "");
const b = signupApp("app-b");
const serverB = await startFakeAnthropic((kind, round): FakeReply => round >= 2
  ? { status: 402, error: { type: "synthe_credit", message: "Your team's event credit is used up. Ask at the Synthe table for more, or set SYNTHE_ANTHROPIC_KEY to use your own key." } }
  : { json: kind === "pick" ? PICK : RIGHT });
const runB = await improve(b.dir, ["improve"], serverB.url, answers(true));
show("B: npx synthe improve (auto mode, 402 synthe_credit in round 2)", runB);
console.log("\n--- B: stub gh calls ---");
console.log(readFileSync(ghLog, "utf8").split("\n").filter((l) => l.startsWith("ARGS:")).join("\n"));
console.log(`requests: ${serverB.requests.length} (the 402 is not retried); x-synthe-team on every request: ${serverB.requests.every((r) => r.headers["x-synthe-team"] === TEAM)}`);
await serverB.close();

// C: --handoff, then the person's own change and npx synthe submit.
writeFileSync(ghLog, "");
const c = signupApp("app-c");
const serverC = await startFakeAnthropic(() => ({ json: NOTHING }));
const runC = await improve(c.dir, ["improve", "--handoff"], serverC.url, answers(false));
show("C: npx synthe improve --handoff", runC);
c.git("checkout", "-q", "-b", "synthe/improve-1");
c.write("validate.js", "module.exports = (email) => /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);\n");
c.git("commit", "-qam", "Accept ordinary email addresses");
show("C: npx synthe submit", await improve(c.dir, ["submit"], serverC.url, []));
console.log(`\nC: requests to the model: ${serverC.requests.length}`);
console.log(`C: run records: ${serverC.receipts.length} batches; commands ${JSON.stringify([...new Set(serverC.receipts.map((r) => r.body.run.command))])}; outcomes ${JSON.stringify(serverC.receipts.filter((r) => r.body.final).map((r) => r.body.summary.outcome))}`);
console.log(`B: run record: ${serverB.receipts.length} batches; outcome ${serverB.receipts.at(-1)?.body.summary.outcome}; stop: ${serverB.receipts.at(-1)?.body.summary.stop_reason}`);
await serverC.close();
console.log(`\nWork folder: ${work}`);
