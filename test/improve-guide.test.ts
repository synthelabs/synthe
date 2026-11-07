import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { guide } from "../src/cli/guide.ts";

const nine = guide.indexOf("## 9. Improve mode");
const improve = guide.slice(nine);
const fallback = improve.slice(improve.indexOf("### Without a credential"));

// Most hackathon apps have no AI prompt an hour in. The guide must send those repos to improve mode before any
// prompt-mode step runs, and the generated copy must match the document the e2e test prints.
test("the guide routes repos without an AI prompt to improve mode before any prompt-mode step", () => {
  const zero = guide.indexOf("## 0. Which mode");
  const one = guide.indexOf("## 1. Prerequisites");
  assert.ok(zero > -1 && zero < one && nine > one);
  assert.match(guide.slice(zero, one), /use \*\*improve mode\*\*\. Go to section 9/);
  assert.equal(guide, readFileSync("docs/AGENT-SETUP.md", "utf8"));
});

test("section 9 runs the loop: four answers in one message, codes at the front, a long timeout, no interrupting", () => {
  assert.ok(improve.includes("Never guess the goal, the metric, the check or the mode."));
  assert.ok(improve.includes("npx synthe@latest improve --list"));
  assert.ok(improve.includes("in ONE message"));
  assert.ok(improve.includes("Offer the first one in the list first"));
  assert.ok(improve.includes('SYNTHE_EVENT_CODE=<code> SYNTHE_TEAM_CODE=<team code> npx synthe@latest improve --agent --goal "<sentence>" --metric <id> --guard "<check command>" --mode auto|review'));
  assert.ok(improve.includes("SYNTHE_ANTHROPIC_KEY"));
  assert.match(improve, /Never use `ANTHROPIC_API_KEY`/);
  assert.match(improve, /timeout of at least 30 minutes/);
  assert.match(improve, /Do not interrupt a running `improve`/);
  for (const flag of ["--command", "--label", "--direction", "--unit", "--protect", "--rounds", "--budget", "--lessons"]) assert.ok(improve.includes(flag), flag);
  assert.ok(improve.includes("one pull request") || improve.includes("ONE pull request"));
});

test("section 9 tells the agent what to show and what to do when the run stops, is interrupted or wins nothing", () => {
  assert.ok(improve.includes("It starts over from the current code"));
  assert.ok(improve.includes("the exact same command again"));
  assert.ok(improve.includes("Merged into <branch>. Run git pull."));
  assert.ok(improve.includes("No change beat the current code"));
  assert.ok(improve.includes("`NEXT:` line"));
  assert.ok(improve.includes("Pull request:"));
});

test("without a credential the guide falls back to --handoff and submit, and keeps the old hard rules", () => {
  assert.ok(fallback.includes("npx synthe@latest improve --handoff --agent --goal"));
  assert.ok(fallback.includes("npx synthe@latest submit --agent"));
  assert.ok(fallback.includes("Follow the `NEXT:` line"));
  assert.ok(fallback.includes("Never loosen a test or the metric"));
  assert.ok(fallback.includes("`submit` refuses those changes"));
  // The commands do the measuring; the guide must not send an agent back to doing it by hand.
  assert.ok(!improve.includes("git worktree add"));
  assert.ok(!improve.includes("gh pr create"));
});
