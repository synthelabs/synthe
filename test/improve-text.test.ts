import assert from "node:assert/strict";
import { test } from "node:test";
import type { Measurement } from "../src/improve/config.ts";
import { baselineLine, formatValue, loopPrBody, loopPrTitle, money, movement, prBody, prTitle, quantity, roundsTable, triedLines } from "../src/improve/text.ts";
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

test("loop wording uses the label as the unit when it reads that way", () => {
  const signups = config().metric;
  assert.equal(quantity(3, signups), "3 valid signups");
  assert.equal(movement(3, 12, signups), "3 → 12 valid signups");
  const tests = { ...signups, label: "tests passing", unit: "tests" };
  assert.equal(movement(5, 7, tests), "5 → 7 tests passing");
  const bundle = { ...signups, label: "built JS and CSS, gzipped", unit: "bytes" };
  assert.equal(movement(42_345, 40_000, bundle), "built JS and CSS, gzipped 41.4 KB → 39.1 KB");
  assert.equal(quantity(3, { ...signups, unit: "of 12" }), "valid signups 3 of 12");
  assert.equal(baselineLine(config()), "Current code: 3 valid signups (runs: 3, 3, 3)");
  assert.deepEqual([money(0), money(0.004), money(0.25), money(1.5)], ["$0.00", "$0.004", "$0.25", "$1.50"]);
});

const rows = [
  { round: 1, summary: "accept anything | with an @", kept: false, value: 12, why: "the regression check did not pass", costUsd: 0.04 },
  { round: 2, summary: "email check accepts dots, plus signs and subdomains", kept: true, value: 12, why: "kept", costUsd: 0.05 },
  { round: 3, summary: "nothing tried", kept: false, value: null, why: "edit refused: the search text for a.js is not in the file", costUsd: null },
];

test("the loop's pull request has every round in a table, the measurement, the lessons commit and how to undo", () => {
  const cfg = config({ guard: { command: "npm test" } });
  const best = m(12, [12, 12, 12], "bbb");
  assert.equal(loopPrTitle(cfg, best), "Synthe: valid signups 3 → 12");
  assert.equal(roundsTable(rows, cfg.metric).split("\n")[2], "| 1 | accept anything \\| with an @ | 12 | not kept: the regression check did not pass | $0.04 |");
  const body = loopPrBody({ config: cfg, best, rows, spentUsd: 0.09, costKnown: false, stopped: "Stopped after 3 rounds (--rounds 3).", base: "main", lessonsCommit: "lll", lessonsFiles: [".synthe/improve-lessons.md", "CLAUDE.md"], diffstat: " validate.js | 2 +-\n", model: "claude-sonnet-5-5" });
  const headings = ["## Result", "## Rounds", "## What changed", "## How it was measured", "## The last commit only adds lessons", "## Undo"].map((h) => body.indexOf(h));
  assert.ok(headings.every((at, i) => at > -1 && (i === 0 || at > headings[i - 1])), String(headings));
  assert.ok(body.includes("**valid signups: 3 → 12** (higher is better). Synthe ran 3 rounds and kept 1 change"));
  assert.ok(body.includes("| 2 | email check accepts dots, plus signs and subdomains | 12 | **kept** | $0.05 |"));
  assert.ok(body.includes("| 3 | nothing tried | not measured | not kept: edit refused: the search text for a.js is not in the file | unknown |"));
  assert.ok(body.includes("- Model cost: at least $0.09 (some rounds' cost is unknown)"));
  assert.ok(body.includes("The last commit (lll) writes `.synthe/improve-lessons.md` and the Synthe lessons block in `CLAUDE.md`"));
  assert.ok(body.includes("- Started from: c (main)") && body.includes("- Best: bbb"));
  assert.ok(body.includes("Close this pull request."));
  const auto = loopPrBody({ config: config({ mode: "auto" }), best, rows, spentUsd: 0.09, costKnown: true, stopped: "s", base: "dev", lessonsCommit: "l", lessonsFiles: [".synthe/improve-lessons.md"], diffstat: "", model: "m" });
  assert.ok(auto.includes("run `git revert <merge commit>` on dev and push") && auto.includes("- Model cost: $0.09"));
  assert.deepEqual(triedLines([rows[0]]), ["- Round 1: accept anything | with an @. Not kept: the regression check did not pass."]);
});
