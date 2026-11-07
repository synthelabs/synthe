import assert from "node:assert/strict";
import { test } from "node:test";
import type { Measurement } from "../src/improve/config.ts";
import { formatValue, prBody, prTitle } from "../src/improve/text.ts";
import { verdict } from "../src/improve/verdict.ts";
import { config, custom } from "./improve-helpers.ts";

const m = (median: number, runs: number[], commit = "c"): Measurement => ({ commit, median, runs, at: "2026-11-07T00:00:00Z" });

test("formatValue speaks bytes, milliseconds and the person's own unit", () => {
  assert.equal(formatValue(42_345, "bytes"), "41.4 KB");
  assert.equal(formatValue(512, "bytes"), "512 bytes");
  assert.equal(formatValue(3_400_000, "bytes"), "3.24 MB");
  assert.equal(formatValue(3400, "ms"), "3.4 s");
  assert.equal(formatValue(740, "ms"), "740 ms");
  assert.equal(formatValue(12, "tests"), "12 tests");
  assert.equal(formatValue(3, "of 12"), "3 of 12");
  assert.equal(formatValue(2.345, "units"), "2.35 units");
});

test("the pull request shows before and after, how it was measured, and how to undo it", () => {
  const cfg = config({ guard: { command: "npm test" } });
  const base = m(3, [3, 3, 3], "aaa"), cand = m(12, [12, 12, 12], "bbb");
  assert.equal(prTitle(cfg, cand), "Synthe: valid signups 3 units → 12 units");
  assert.equal(prTitle(cfg, cand, m(5, [5])), "Synthe: valid signups 5 units → 12 units");
  const body = prBody({ config: cfg, base, candidate: cand, verdict: verdict("higher", base, cand, true), baseSha: "aaa111", headSha: "bbb222", diffstat: " src/validate.js | 2 +-\n", guardCommand: "npm test" });
  const headings = ["## Result", "## What changed", "## How it was measured", "## Undo"].map((h) => body.indexOf(h));
  assert.ok(headings.every((at, i) => at > -1 && (i === 0 || at > headings[i - 1])), String(headings));
  assert.ok(body.includes("**valid signups: 3 units → 12 units** (up by 9 units; higher is better)"));
  assert.ok(body.includes("- Before: 3 units, median of 3 runs: 3, 3, 3"));
  assert.ok(body.includes("- Regression check: `npm test` passed"));
  assert.ok(body.includes("```\n src/validate.js | 2 +-\n```"));
  assert.ok(body.includes("- Before: aaa111") && body.includes("- After: bbb222"));
  assert.ok(body.includes("each measured in a fresh checkout of its commit, with the same command"));
  assert.ok(body.includes("Close this pull request"));
  assert.ok(body.endsWith("Measured by Synthe. Numbers are from this machine; check them in your own environment too."));
  const auto = prBody({ config: config({ ...custom("x"), mode: "auto" }), base, candidate: cand, verdict: verdict("higher", base, cand, null), baseSha: "a", headSha: "b", diffstat: "", guardCommand: null });
  assert.ok(auto.includes("git revert <merge commit>") && auto.includes("Regression check: none configured"));
});
