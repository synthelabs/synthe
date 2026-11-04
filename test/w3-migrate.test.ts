import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { migrate } from "../src/cli/migrate.ts";
import { costUsd } from "../src/core/cost.ts";
import type { Model } from "../src/model/client.ts";

const MAIN = join(import.meta.dirname, "../src/cli/main.ts");
const TOKENS = { input_tokens: 500, output_tokens: 300 };

// A project folder with 7 train and 3 holdout test cases.
function project(checks?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "synthe-migrate-"));
  mkdirSync(join(dir, ".synthe"));
  writeFileSync(join(dir, "prompt.md"), "You are a careful support agent.");
  writeFileSync(join(dir, "synthe.json"), JSON.stringify({
    version: 1, prompt: { kind: "file", path: "prompt.md" }, objective: "Answer customers correctly",
    guardrails: ["Never invent order details"], scenarios: ".synthe/scenarios.jsonl", budget: { max_usd: 3 }, ...(checks ? { checks } : {}),
  }));
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, input: `question ${i}`, expected: "a good answer", split: i < 7 ? "train" : "holdout" }));
  writeFileSync(join(dir, ".synthe/scenarios.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n"));
  return dir;
}

const run = async (dir: string, args: string[], model?: Model) => {
  const said: string[] = [];
  const code = await migrate(args, { cwd: dir, say: (t) => said.push(t), model, random: () => 0.9 });
  return { code, out: said.join("\n") };
};

// Answers as the agent with a line naming the model. The judge sides with the new model ("win"), the old one
// ("lose") or neither ("tie"), and with failToChecks the new model's replies fail the first check.
function scripted(to: string, mode: "win" | "lose" | "tie", failToChecks = false): Model & { calls: number } {
  return {
    calls: 0,
    async ask(a) {
      this.calls++;
      const costUsdFor = costUsd(a.model, TOKENS);
      if (!a.schema) return { text: `reply from ${a.model}`, costUsd: costUsdFor };
      if ("results" in (a.schema.properties as object)) {
        const text = a.user.match(/<reply>\n([\s\S]*?)\n<\/reply>/)![1];
        const results = [{ check: 1, applies: true, passes: !(failToChecks && text.includes(to)) }, { check: 2, applies: true, passes: true }];
        return { text: JSON.stringify({ results }), costUsd: costUsdFor };
      }
      const aIsNew = a.user.match(/<reply_a>\n([\s\S]*?)\n<\/reply_a>/)![1].includes(to);
      const better = mode === "tie" ? "tie" : aIsNew === (mode === "win") ? "A" : "B";
      return { text: JSON.stringify({ better, a_guardrail_ok: true, b_guardrail_ok: true }), costUsd: costUsdFor };
    },
  };
}

const neverCalled: Model = { async ask() { throw new Error("a real model call was made"); } };

test("--dry-run prints the comparison from the scenario file without calling a model", async () => {
  const { code, out } = await run(project(), ["--to", "claude-haiku-5-5", "--dry-run"], neverCalled);
  assert.equal(code, 0);
  assert.match(out, /^Migrating from claude-sonnet-5-5 to claude-haiku-5-5$/m);
  assert.match(out, /Scenarios: 7 train \+ 3 holdout = 10 total/);
  assert.match(out, /Judge score \(all scenarios, head to head: 50 is even\)\n {2}Before: 50\.0 {2}After: 50\.0 {2}Change: 0\.0/);
  // 10 replies of 500 in and 300 out: Sonnet 5.5 costs $0.040, Haiku 5.5 $0.002.
  assert.match(out, /Cost per round[^\n]*\n {2}Before: \$0\.040 {2}After: \$0\.002 {2}Change: -95%/);
  assert.match(out, /Verdict: none from a dry run/);
  assert.match(out, /Dry run: no model was called/);
  assert.match(out, /Cost of this comparison: \$0\.00 \(dry run\)/);
});

test("an unknown --to model is an error that names it and lists the known ones", async () => {
  const { code, out } = await run(project(), ["--to", "claude-nonsense-9"], neverCalled);
  assert.equal(code, 1);
  assert.match(out, /doesn't know the model "claude-nonsense-9"/);
  assert.match(out, /claude-haiku-5-5/);
});

test("an unknown --from model, a missing --to and the same model twice are errors", async () => {
  const dir = project();
  assert.match((await run(dir, ["--from", "gpt-x", "--to", "claude-haiku-5-5"], neverCalled)).out, /doesn't know the model "gpt-x"/);
  assert.match((await run(dir, ["--dry-run"], neverCalled)).out, /Say which model to try/);
  assert.match((await run(dir, ["--to", "claude-sonnet-5-5"], neverCalled)).out, /both claude-sonnet-5-5/);
  for (const args of [[], ["--to"], ["--bogus"]]) assert.equal((await run(dir, args, neverCalled)).code, 1);
});

test("without checks, only the judge score is reported", async () => {
  const { code, out } = await run(project(), ["--to", "claude-haiku-5-5"], scripted("claude-haiku-5-5", "tie"));
  assert.equal(code, 0);
  assert.match(out, /Judge score/);
  assert.doesNotMatch(out, /Check pass rate/);
});

test("with checks, the pass rate is reported before and after", async () => {
  const { out } = await run(project(["Is polite", "Is short"]), ["--to", "claude-haiku-5-5"], scripted("claude-haiku-5-5", "tie"));
  assert.match(out, /Check pass rate\n {2}Before: 100% {2}After: 100% {2}Change: 0pp/);
});

test("a clear drop in judge score and check pass rate is called out", async () => {
  const to = "claude-haiku-5-5";
  const { code, out } = await run(project(["Is polite", "Is short"]), ["--to", to], scripted(to, "lose", true));
  assert.equal(code, 0, "a warning is not a failure");
  assert.match(out, /better on claude-haiku-5-5 in 0, worse in 10, the same in 0/);
  assert.match(out, /Before: 50\.0 {2}After: 0\.0 {2}Change: -50\.0/);
  assert.match(out, /Before: 100% {2}After: 50% {2}Change: -50pp/);
  assert.match(out, /Verdict: judge score dropped more than 5 points; check pass rate dropped more than 5pp\. Review before switching\./);
  assert.doesNotMatch(out, /Looks good/);
});

test("similar quality at a lower cost looks good, and the cost of the run is reported", async () => {
  const to = "claude-haiku-5-5";
  const { out } = await run(project(), ["--to", to], scripted(to, "tie"));
  assert.match(out, /Before: \$0\.040 {2}After: \$0\.002 {2}Change: -95%/);
  assert.match(out, /Verdict: Looks good: similar quality, lower cost\./);
  // 10 Sonnet replies ($0.040), 10 Haiku replies ($0.002) and 10 judgements on Haiku ($0.002).
  assert.match(out, /Cost of this comparison: \$0\.044\n?$/);
  assert.doesNotMatch(out, /Review before switching/);
});

test("a clearly better model at a lower cost looks good", async () => {
  const to = "claude-haiku-5-5";
  const { out } = await run(project(), ["--to", to], scripted(to, "win"));
  assert.match(out, /Change: \+50\.0/);
  assert.match(out, /Verdict: Looks good: better quality, lower cost\./);
});

test("a model that costs more is left to a person to review", async () => {
  const to = "claude-opus-5-5";
  const { out } = await run(project(), ["--from", "claude-haiku-5-5", "--to", to], scripted(to, "tie"));
  assert.match(out, /Verdict: Review before switching\. The new model doesn't cost less\./);
});

test("the command is in the help and runs from the CLI without a key", () => {
  const help = spawnSync(process.execPath, [MAIN], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.match(help.stdout, /npx synthe migrate --to <model>/);
  const dir = project();
  const env = { PATH: process.env.PATH };
  const dry = spawnSync(process.execPath, [MAIN, "migrate", "--to", "claude-haiku-5-5", "--dry-run"], { cwd: dir, encoding: "utf8", env });
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Migrating from claude-sonnet-5-5 to claude-haiku-5-5/);
  const unknown = spawnSync(process.execPath, [MAIN, "migrate", "--to", "claude-nonsense-9"], { cwd: dir, encoding: "utf8", env });
  assert.equal(unknown.status, 1);
  const keyless = spawnSync(process.execPath, [MAIN, "migrate", "--to", "claude-haiku-5-5"], { cwd: dir, encoding: "utf8", env });
  assert.equal(keyless.status, 1);
  assert.match(keyless.stdout, /needs your Synthe key/);
});

test("outside a set-up project it says to run init", async () => {
  const { code, out } = await run(mkdtempSync(join(tmpdir(), "synthe-empty-")), ["--to", "claude-haiku-5-5", "--dry-run"]);
  assert.equal(code, 1);
  assert.match(out, /npx synthe init/);
});
