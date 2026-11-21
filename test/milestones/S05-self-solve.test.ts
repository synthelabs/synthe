// S05 checks this statement from swarm/milestones.json: "`solve synthe.self.json` with an outside proposer runs at
// least one round on Synthe's own repository, measures with the bench score, refuses a change that breaks a test,
// and leaves the working tree unchanged."
//
// How the check decides: it clones this checkout into a temp folder and copies the working files over the clone, so
// work that is not committed yet is in the copy too. In the copy, synthe.self.json gets an outside proposer and a
// budget of one round; no other field changes. The proposer reads src/cli/main.ts from its stdin and proposes one
// change: a line at the end of that file that throws. The types stay correct, and each test that starts the CLI
// fails. `solve` must exit 0 with that attempt in result.json, not kept, and with a reason that names the guard
// `npm test`. The baseline in result.json must be the number that `npm run bench -- --score` prints in the copy.
// The copy's working tree, branch and commit must be the same before and after.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { assertTreeUnchanged, attempt, gitIn, readProposerLog, readResult, ROOT, runCli, snapshot, start, tag, tail, tempDir } from "./helpers-s.ts";

// A copy of this checkout as a git repository: the committed files plus the working files.
function copyOfSynthe(dir: string) {
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", ROOT, dir], { stdio: ["ignore", "pipe", "pipe"] });
  const git = gitIn(dir);
  git("config", "user.email", "team@example.com");
  git("config", "user.name", "Team");
  git("config", "commit.gpgsign", "false");
  for (const f of git("ls-files", "-z").split("\0").filter(Boolean)) rmSync(join(dir, f), { force: true });
  for (const f of gitIn(ROOT)("ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0").filter(Boolean)) {
    if (!lstatSync(join(ROOT, f), { throwIfNoEntry: false })) continue;
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(join(ROOT, f), join(dir, f), { verbatimSymlinks: true });
  }
  git("add", "-A");
  if (git("status", "--porcelain")) git("commit", "-qm", "Working files");
  // The measure and the guards need the dependencies. .gitignore covers the link.
  assert.ok(existsSync(join(ROOT, "node_modules")), "run `npm ci` first: the check needs node_modules");
  symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "dir");
}

// CommonJS source of the proposer. It decides from its stdin: with an empty history it proposes the change that
// breaks the tests, built from the text of src/cli/main.ts that Synthe sent. After that it has nothing more.
function breakingProposer(log: string, summary: string, marker: string): string {
  return `const fs = require("fs");
let raw = "";
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ raw }) + "\\n");
  const input = JSON.parse(raw);
  const main = (input.files || []).find((f) => f.path === "src/cli/main.ts");
  if (!main || (input.history || []).length > 0) { process.stdout.write(JSON.stringify({ proposals: [] })); return; }
  // The shortest end of the file that occurs exactly once: the edit adds one line after it.
  let n = Math.min(40, main.text.length);
  while (n < main.text.length && main.text.split(main.text.slice(-n)).length !== 2) n += 40;
  const search = main.text.slice(-n);
  const replace = search + (search.endsWith("\\n") ? "" : "\\n") + ${JSON.stringify(`if (process.env.${marker} !== "1") throw new Error("${marker}");\n`)};
  process.stdout.write(JSON.stringify({ proposals: [{ summary: ${JSON.stringify(summary)}, edits: [{ path: "src/cli/main.ts", search, replace }] }] }));
});
`;
}

test("S05: solve runs on Synthe's own repository and refuses a change that breaks a test", { timeout: 20 * 60_000 }, async () => {
  const work = tempDir("s05");
  const repo = join(work, "repo"), home = join(work, "home"), out = join(work, "out"), log = join(work, "proposer.log");
  const t = tag();
  const summary = `end main.ts with a throw ${t}`;
  copyOfSynthe(repo);

  const file = join(repo, "synthe.self.json");
  assert.ok(existsSync(file), "synthe.self.json is at the repository root");
  const problem = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(join(work, "propose.cjs"), breakingProposer(log, summary, `SYNTHE_CHECK_${t.toUpperCase()}`));
  problem.proposer = { command: `node ${JSON.stringify(join(work, "propose.cjs"))}` };
  problem.budget = { ...(problem.budget ?? {}), max_rounds: 1 };
  writeFileSync(file, JSON.stringify(problem, null, 2) + "\n");
  gitIn(repo)("commit", "-qam", "Use an outside proposer");

  // The bench score of the copy, measured apart from solve. The last number on stdout is the score.
  const bench = await start("npm", ["run", "bench", "--", "--score"], { cwd: repo, home, timeoutMs: 5 * 60_000 }).done;
  assert.equal(bench.code, 0, `npm run bench -- --score failed in the copy:\n${tail(bench.out)}`);
  const score = Number(bench.stdout.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)?.pop());
  assert.ok(Number.isFinite(score), `the bench printed no number:\n${tail(bench.stdout)}`);

  const before = snapshot(repo);
  const r = await runCli(["solve", "synthe.self.json", "--out", out], { cwd: repo, home, timeoutMs: 18 * 60_000 });
  assert.equal(r.code, 0, `solve synthe.self.json exited ${r.code}:\n${tail(r.out)}`);
  const result = readResult(out, r);

  const calls = readProposerLog(log);
  assert.ok(calls.length >= 1, "solve did not ask the outside proposer");
  assert.ok(calls[0].files.some((f: any) => f.path === "src/cli/main.ts"), "the proposer got no src/cli/main.ts in files");
  assert.ok(result.attempts.length >= 1, "solve ran at least one round");
  assert.equal(result.baseline, score, "the baseline in result.json is the bench score");

  const a = attempt(result, summary);
  assert.equal(a.kept, false, `the change breaks the tests, so it must not be kept: ${JSON.stringify(a)}`);
  assert.ok(typeof a.reason === "string" && a.reason.includes("npm test"), `the reason names the guard \`npm test\`: ${JSON.stringify(a.reason)}`);
  for (const b of gitIn(repo)("for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").filter(Boolean)) {
    assert.ok(!gitIn(repo)("show", `${b}:src/cli/main.ts`).includes(`SYNTHE_CHECK_${t.toUpperCase()}`), `the refused change is on the branch ${b}`);
  }
  assertTreeUnchanged(repo, before);
});
