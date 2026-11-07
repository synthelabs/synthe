import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compareBuilderPrompts } from "../scripts/builder-metric-preview.mjs";

test("the same ordinary app can compare two builder prompts on a product metric", async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "synthe-product-fixture-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const original = "export const accepts = (email) => email.includes('@');\n";
  writeFileSync(join(repo, "signup.mjs"), original);
  const git = (...args) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  git("add", "--", "signup.mjs");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Product snapshot");
  const baselinePrompt = "Improve signup email validation.";
  const candidatePrompt = "Improve signup email validation. Accept surrounding whitespace and reject domains without a dot.";
  const promptRunner = async ({ cwd, prompt }) => {
    assert.equal(readFileSync(join(cwd, "signup.mjs"), "utf8"), original);
    const implementation = prompt === baselinePrompt
      ? "export const accepts = email => /^[^@ ]+@[^@ ]+$/.test(email);"
      : "export const accepts = email => /^[^@ ]+@[^@ .]+\\.[^@ ]+$/.test(email.trim());";
    writeFileSync(join(cwd, "signup.mjs"), implementation);
  };
  const productCheck = ({ cwd }) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { accepts } from './signup.mjs';
    const cases = [['a@example.com',true],[' a@example.com ',true],['missing-domain@local',false],['bad',false],['a@@example.com',false]];
    console.log(JSON.stringify({value: cases.filter(([input,expected]) => accepts(input) === expected).length, guardsPassed: !accepts('bad')}));
  `], { cwd, encoding: "utf8" }));
  const result = await compareBuilderPrompts({ repo, baselinePrompt, candidatePrompt, runAgent: promptRunner, measure: productCheck });
  assert.deepEqual([result.baseline.value, result.candidate.value, result.delta, result.observedImprovement], [3, 5, 2, true]);
  assert.equal(readFileSync(join(repo, "signup.mjs"), "utf8"), original);
  const rejected = await compareBuilderPrompts({
    repo, baselinePrompt, candidatePrompt, runAgent: promptRunner,
    measure: ({ cwd }) => ({ ...productCheck({ cwd }), guardsPassed: false }),
  });
  assert.equal(rejected.observedImprovement, false);
  t.diagnostic("Scripted prompt runner: 3/5 → 5/5 product cases; failed guard prevents a win. No real model was called.");
});
