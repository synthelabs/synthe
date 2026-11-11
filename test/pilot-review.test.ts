import assert from "node:assert/strict";
import { test } from "node:test";
import { PilotError } from "../src/pilot/errors.ts";
import { contentId, promptId, reviewBranch, shortId } from "../src/pilot/ids.ts";
import { buildReviewBundle, promptDiff, renderReview } from "../src/pilot/review.ts";
import {
  BASELINE_PROMPT, CANARY_ORDER, CANARY_SENTENCE, CANARY_TOOL_ARG, CANDIDATE_PROMPT, PROMPT_PATH,
  fixture, makeReplay, stored,
} from "./pilot-review-helpers.ts";

const code = (c: string) => (e: unknown) => e instanceof PilotError && e.code === c;

function build(f = fixture(), over: Record<string, unknown> = {}) {
  return () => buildReviewBundle({
    config: f.config, config_id: f.configId, candidate: f.candidate, baseline_prompt: BASELINE_PROMPT, candidate_prompt: CANDIDATE_PROMPT,
    replay: f.replay, experiment: f.experiment, ...over,
  });
}

test("promptDiff: identical texts give an empty string", () => {
  assert.equal(promptDiff("p.md", "a\nb\n", "a\nb\n"), "");
});

test("promptDiff: an added line, with headers and context", () => {
  const d = promptDiff("p.md", "a\nb\nc\n", "a\nb\nx\nc\n");
  assert.equal(d, "--- a/p.md\n+++ b/p.md\n@@ -1,3 +1,4 @@\n a\n b\n+x\n c\n");
});

test("promptDiff: a replaced line far from another change makes two hunks with 3 lines of context", () => {
  const before = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
  const after = before.replace("l3\n", "L3\n").replace("l18\n", "L18\n");
  const d = promptDiff("p.md", before, after);
  assert.equal(d.split("\n").filter((l) => l.startsWith("@@")).length, 2);
  assert.match(d, /@@ -1,6 \+1,6 @@/);
  assert.match(d, /@@ -15,6 \+15,6 @@/);
  assert.match(d, /-l3\n\+L3\n/);
});

test("promptDiff: nearby changes share a hunk, and a missing final newline is shown", () => {
  const d = promptDiff("p.md", "a\nb\nc\nd\ne", "a\nB\nc\nd\nE\n");
  assert.equal(d.split("\n").filter((l) => l.startsWith("@@")).length, 1);
  assert.match(d, /\\ No newline at end of file/);
});

test("promptDiff: a deletion at the start", () => {
  assert.equal(promptDiff("p.md", "a\nb\n", "b\n"), "--- a/p.md\n+++ b/p.md\n@@ -1,2 +1 @@\n-a\n b\n");
});

test("bundle refuses a replay that did not pass the gate, naming the reasons", () => {
  const f = fixture();
  const bad = stored(makeReplay(f.pack, { gate: { eligible: false, reasons: ["net wins 0 is below 1"], proposer_feedback: [] } }));
  assert.throws(build(f, { replay: bad }), (e: unknown) => code("replay_gate_failed")(e) && /net wins 0 is below 1/.test((e as Error).message));
});

test("bundle refuses mismatched ids", () => {
  const f = fixture();
  const other = promptId("something else\n");
  const cases: [string, Record<string, unknown>][] = [
    ["candidate prompt_id", { candidate: { ...f.candidate, prompt_id: other } }],
    ["candidate baseline id", { candidate: { ...f.candidate, baseline_prompt_id: other } }],
    ["replay candidate id", { replay: stored({ ...f.replay.value, candidate_id: other }) }],
    ["replay baseline id", { replay: stored({ ...f.replay.value, baseline_prompt_id: other }) }],
    ["experiment candidate arm", { experiment: stored({ ...f.experiment.value, arms: { ...f.experiment.value.arms, candidate: { ...f.experiment.value.arms.candidate, prompt_id: other } } }) }],
    ["experiment baseline arm", { experiment: stored({ ...f.experiment.value, arms: { ...f.experiment.value.arms, baseline: { ...f.experiment.value.arms.baseline, prompt_id: other } } }) }],
    ["rollback prompt", { experiment: stored({ ...f.experiment.value, rollback: { ...f.experiment.value.rollback, prompt_id: other } }) }],
    ["config id", { config_id: other }],
    ["pilot id", { candidate: { ...f.candidate, pilot_id: "someone-else" } }],
    ["candidate text", { candidate_prompt: CANDIDATE_PROMPT + "extra\n" }],
    ["baseline text", { baseline_prompt: BASELINE_PROMPT + "extra\n" }],
  ];
  for (const [name, over] of cases) assert.throws(build(f, over), code("conflict"), name);
});

test("bundle fills the typed fields", () => {
  const f = fixture();
  const b = f.bundle.value;
  assert.equal(b.candidate_id, promptId(CANDIDATE_PROMPT));
  assert.equal(b.repo.branch, reviewBranch(b.candidate_id));
  assert.deepEqual(b.repo, { slug: "fernhill/support-agent", base: "main", prompt_path: PROMPT_PATH, branch: reviewBranch(b.candidate_id) });
  assert.equal(b.replay.fixes, 2);
  assert.equal(b.replay.coverage.excluded, 0);
  assert.equal(b.replay.coverage.diverged, 1);
  assert.equal(b.replay_id, f.replay.id);
  assert.equal(b.experiment_id, f.experiment.id);
  assert.deepEqual(b.rollback, f.experiment.value.rollback);
  assert.deepEqual(b.replay.gate, { eligible: true, reasons: f.replay.value.gate.reasons });
  assert.ok(!("proposer_feedback" in b.replay.gate));
  assert.match(b.diff, /\+Always call lookup_order/);
});

test("rendered review has the diff, every full id, the sentence, the approve command, and no conversation text", () => {
  const f = fixture();
  const reviewId = "d".repeat(64);
  const md = renderReview(f.bundle.value, reviewId, f.pack.value, "looks_up_order");
  assert.ok(md.includes(f.bundle.value.diff.trimEnd()));
  assert.ok(md.includes("```diff"));
  for (const id of [f.configId, f.pack.id, f.replay.id, f.bundle.value.candidate_id, f.bundle.value.baseline_prompt_id, f.experiment.id, reviewId]) {
    assert.ok(md.includes(id), `missing id ${id}`);
  }
  assert.ok(md.includes("Replay shows checks on recorded conversations. It is not an estimate of business impact."));
  assert.ok(md.includes(`node src/pilot/cli.ts approve --candidate ${f.bundle.value.candidate_id} --experiment ${f.experiment.id} --approver <your name>`));
  assert.ok(md.includes("Merging this pull request is a human decision"));
  assert.ok(md.includes("Synthe never changes traffic"));
  assert.ok(md.includes(f.pack.value.check_catalog.looks_up_order));
  assert.ok(md.includes(`case c2, turn 1, check no_early_refund: ${f.pack.value.check_catalog.no_early_refund}`));
  assert.ok(md.includes(f.experiment.value.methods.keep) && md.includes(f.experiment.value.methods.early_stop));
  assert.ok(md.includes("Signed off by Dana Whitlock at 2026-10-01T00:00:00Z"));
  assert.ok(md.includes(`tag \`${f.experiment.value.rollback.tag}\``));
  assert.ok(md.includes(shortId(f.bundle.value.candidate_id)));
  // No pack conversation text, in any form.
  for (const canary of [CANARY_SENTENCE, CANARY_ORDER, CANARY_TOOL_ARG, "I am sorry about that", "shipped on a Tuesday", "[EMAIL_1]"]) {
    assert.ok(!md.includes(canary), `leaked ${canary}`);
  }
});

test("sections appear in the specified order", () => {
  const f = fixture();
  const md = renderReview(f.bundle.value, "e".repeat(64), f.pack.value);
  const heads = ["## What changes", "## Why", "## Metric contract", "## Replay evidence", "## Experiment plan", "## Rollback", "## Identifiers", "## To approve"];
  const at = heads.map((h) => md.indexOf(h));
  assert.ok(at.every((i) => i >= 0));
  assert.deepEqual([...at].sort((a, b) => a - b), at);
  assert.ok(md.startsWith("# Synthe pilot fernhill-pilot: candidate "));
});

test("a long regression list is cut in the review, and the full list stays in the replay record it names", () => {
  const f = fixture();
  const many = Array.from({ length: 100 }, (_, i) => ({ case_id: `case-${String(i).padStart(3, "0")}`, split: "discovery" as const, turn: 1, check_id: Object.keys(f.pack.value.check_catalog)[0], role: "primary" as const, blocking: false }));
  const bundle = { ...f.bundle.value, replay: { ...f.bundle.value.replay, regressions: many } };
  const md = renderReview(bundle, contentId(bundle), f.pack.value);
  assert.ok(md.includes("case-039") && !md.includes("case-040"), "the first 40 are listed");
  assert.match(md, /and 60 more, listed in the replay record/);
  assert.ok(md.includes(bundle.replay_id));
  assert.ok(md.length < 60_000);
});
