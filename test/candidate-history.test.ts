import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { candidateFingerprint, candidateScope, MAX_CANDIDATE_MEMORY, rememberCandidates, validateCandidateMemory } from "../src/core/candidate-history.ts";
import { newState } from "../src/core/state.ts";
import { applyEdits, runWrite } from "../src/loop/write.ts";
import { runDecide } from "../src/loop/decide.ts";
import { runLocalTry } from "../src/cli/try-round.ts";
import type { Ask, Model } from "../src/model/client.ts";
import { goal, MemoryRepo, scenarios, scored } from "./helpers.ts";

function writer(texts = ["Ask before approving.", "Ask before approving."], failScore = false) {
  const seen: Ask[] = [];
  let next = 0;
  const model: Model = { async ask(request) {
    seen.push(request);
    if (JSON.stringify(request.schema ?? {}).includes('"edits"')) return { text: JSON.stringify({ edits: [{ find: "Old", replace: texts[next++ % texts.length] }], summary: "a new title every time" }), costUsd: 0.01 };
    if (failScore) throw new Error("scoring failed");
    if (request.schema) return { text: JSON.stringify({ better: "tie", a_guardrail_ok: true, b_guardrail_ok: true }), costUsd: 0.001 };
    return { text: "An answer", costUsd: 0.001 };
  } };
  return { model, seen };
}

test("exact no-op edits and net-zero edits are rejected", () => {
  for (const edits of [[{ find: "Old", replace: "Old" }], [{ find: "Old", replace: "New" }, { find: "New", replace: "Old" }], [{ find: "", replace: " " }]]) {
    assert.deepEqual(applyEdits("Old", edits), { problem: "edits change nothing" });
  }
});

test("formatting variants and duplicate writer angles are rejected before scoring", async () => {
  const variants = writer(["Ask before approving.", "ASK  before approving!"]);
  const written = await runWrite(goal(), newState(), "Old", scenarios, variants.model);
  assert.equal(written.candidates.length, 1);
  assert.match(written.rejected!.join(" "), /already tried/);
  const noop = writer([" OLD! "]);
  assert.equal((await runWrite(goal(), newState(), "Old", scenarios, noop.model)).candidates.length, 0);
});

test("history scope changes with goal or prompt, not hidden case text", async () => {
  const configured = goal();
  const history = rememberCandidates([], candidateScope(configured, "Old"), ["Ask before approving."]);
  const state = { ...newState(), candidateHistory: history, rounds: [{ round: 1, at: "t", outcome: "skipped" as const, costUsd: 0, reasons: ["HIDDEN-REASON"], tried: [{ summary: "CUSTOMER-DATA", outcome: "lost" }] }] };
  const repeated = writer();
  const written = await runWrite(configured, state, "Old", [...scenarios, { id: "hidden", input: "SECRET-HIDDEN", expected: "PRIVATE", split: "holdout" }], repeated.model);
  assert.equal(written.candidates.length, 0);
  assert.ok(repeated.seen.every((request) => !/HIDDEN-REASON|SECRET-HIDDEN|PRIVATE|Ask before approving/.test(request.user)));
  assert.equal((await runWrite(goal({ objective: "Another goal" }), state, "Old", scenarios, writer().model)).candidates.length, 1);
  assert.equal((await runWrite(configured, state, "Old\n", scenarios, writer().model)).candidates.length, 1);
});

test("history validates its schema and retains only bounded fingerprints", () => {
  for (const bad of [null, {}, [{ scope: "bad", fingerprint: "bad" }], [{ scope: "a".repeat(64), fingerprint: "b".repeat(64), text: "private" }], Array(MAX_CANDIDATE_MEMORY + 1).fill({})]) assert.throws(() => validateCandidateMemory(bad), /corrupt/);
  const saved = rememberCandidates([], candidateScope(goal(), "Old"), Array.from({ length: MAX_CANDIDATE_MEMORY + 2 }, (_, index) => `Candidate ${index}`));
  assert.equal(saved.length, MAX_CANDIDATE_MEMORY);
  assert.equal(saved.at(-1)?.fingerprint, candidateFingerprint(`Candidate ${MAX_CANDIDATE_MEMORY + 1}`));
  assert.doesNotMatch(JSON.stringify(saved), /Candidate|Old|Be right/);
});

test("local try persists rejections across calls, never rewrites the prompt, and skips repeat scoring", async () => {
  const directory = mkdtempSync(join(tmpdir(), "synthe-history-"));
  try {
    writeFileSync(join(directory, "prompt.md"), "Old");
    const first = writer();
    const result = await runLocalTry(directory, goal(), "Old", scenarios, first.model);
    assert.equal(result.written.candidates.length, 1);
    const saved = readFileSync(join(directory, ".synthe-local/try-history.json"), "utf8");
    assert.doesNotMatch(saved, /Ask before|train question|HOLDOUT|An answer/);
    const second = writer();
    const repeated = await runLocalTry(directory, goal(), "Old", scenarios, second.model);
    assert.equal(repeated.written.candidates.length, 0);
    assert.equal(repeated.costUsd, 0);
    assert.equal(second.seen.length, 2);
    assert.equal(readFileSync(join(directory, "prompt.md"), "utf8"), "Old");
    assert.equal(readFileSync(join(directory, ".synthe-local/try-history.json"), "utf8"), saved);
    assert.equal(existsSync(join(directory, ".synthe-local/try-history.json.lock")), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("local history survives scoring failure, fails closed on corruption and rejects overlapping tries", async () => {
  const directory = mkdtempSync(join(tmpdir(), "synthe-history-"));
  const path = join(directory, ".synthe-local/try-history.json");
  try {
    await assert.rejects(runLocalTry(directory, goal(), "Old", scenarios, writer(undefined, true).model), /scoring failed/);
    assert.equal((await runLocalTry(directory, goal(), "Old", scenarios, writer().model)).written.candidates.length, 0);
    for (const raw of ["{", "null", '{"version":2,"history":[]}', '{"version":1,"history":[{"scope":"bad"}]}']) {
      writeFileSync(path, raw);
      const fake = writer();
      await assert.rejects(runLocalTry(directory, goal(), "Old", scenarios, fake.model), /history is corrupt/);
      assert.equal(fake.seen.length, 0);
      assert.equal(readFileSync(path, "utf8"), raw);
    }
    writeFileSync(`${path}.lock`, "");
    await assert.rejects(runLocalTry(directory, goal(), "Old", scenarios, writer().model), /history lock/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("decide persists candidate fingerprints before a crash, including losing candidates", async () => {
  for (const crash of [false, true]) {
    const repo = new MemoryRepo("Old");
    if (crash) repo.crashOn = "upsertIssue";
    const decision = runDecide(goal(), repo, { candidates: [{ id: "c1", text: "Ask before approving." }], scores: scored("Old", 50, 50, 50, 50), costUsd: 0.1 });
    if (crash) await assert.rejects(decision); else await decision;
    assert.equal(repo.state.spendUsd, 0.1);
    assert.equal((await runWrite(goal(), repo.state, "Old", scenarios, writer().model)).candidates.length, 0);
  }
});
