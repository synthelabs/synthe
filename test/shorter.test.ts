// Shorter rounds (merge_rule.allow_shorter): a deletion candidate merges when it is no worse, by an exact
// non-inferiority test, and every other gate still applies.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULTS, parseGoal, type Goal, type Scenario } from "../src/core/goal.ts";
import { judgeRound, signP, type CandidateScore, type RoundScores, type ScoreRow } from "../src/core/merge-rule.ts";
import { NON_INFERIORITY_MARGIN, nonInferiorityP, notWorseProblem } from "../src/core/non-inferiority.ts";
import { buildEvidence, hashEvidence, recomputeProblem } from "../src/core/evidence.ts";
import { newState, type State } from "../src/core/state.ts";
import { sha256 } from "../src/core/safety.ts";
import { runWrite } from "../src/loop/write.ts";
import { runScore } from "../src/loop/score.ts";
import { runDecide } from "../src/loop/decide.ts";
import { minShorterBy, shorterFields, shorterProblem, undoEdits } from "../src/loop/shorter.ts";
import type { Ask, Model } from "../src/model/client.ts";
import { goal, MemoryRepo, rows, scored, trainRows, heldRows } from "./helpers.ts";

const on = (over: Partial<Goal> = {}) => goal({ ...over, merge_rule: { ...DEFAULTS.merge_rule, allow_shorter: true, ...over.merge_rule } });
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} is not ${b}`);

// w wins, l losses and t ties against an even current prompt.
const mix = (w: number, l: number, t: number, prefix = "s") => rows([...Array(w).fill(100), ...Array(l).fill(0), ...Array(t).fill(50)], false, prefix);
const even = (n: number, prefix = "s") => rows(Array(n).fill(50), false, prefix);
const CHARS = { before: 4578, after: 4166 }; // 412 characters, 9%
const shorterCand = (train: [number, number, number], held: [number, number, number], over: Partial<CandidateScore> = {}): CandidateScore =>
  ({ id: "c2", kind: "shorter", chars: CHARS, train: mix(...train), holdout: mix(...held, "h"), ...over });
const round = (cands: CandidateScore[], trainN = 40, heldN = 30): RoundScores =>
  ({ baselineHash: "h", baselineTrain: even(trainN), baselineHoldout: even(heldN, "h"), candidates: cands });
// An even split: 18 wins, 18 losses, 4 ties on training (p 0.0457), 12, 12 and 6 on the hidden cases (p 0.0940).
const EVEN = () => shorterCand([18, 18, 4], [12, 12, 6]);

test("non-inferiority p-values match the binomial worked by hand", () => {
  assert.equal(NON_INFERIORITY_MARGIN, 0.15);
  // H0: P(loss | decided) >= 0.65. p = P(X <= losses), X ~ Binomial(decided, 0.65).
  assert.equal(nonInferiorityP(0, 0), 1); // nothing decided: no evidence
  close(nonInferiorityP(1, 0), 0.35);
  close(nonInferiorityP(2, 0), 0.35 ** 2); // 0.1225
  close(nonInferiorityP(5, 0), 0.0052521875); // 0.35^5
  close(nonInferiorityP(4, 1), 0.0052521875 + 5 * 0.65 * 0.35 ** 4); // 0.0540225
  close(nonInferiorityP(3, 2), 0.0540225 + 10 * 0.65 ** 2 * 0.35 ** 3); // 0.235169375
  close(nonInferiorityP(0, 3), 1); // every outcome is at most 3 losses
  // With no margin the test is the sign test read from the other side: (1 + 10 + 45) / 1024.
  close(nonInferiorityP(8, 2, 0), 56 / 1024);
  close(nonInferiorityP(8, 2, 0), signP(8, 2));
  // The numbers the margin's comment relies on.
  assert.equal(nonInferiorityP(12, 8).toFixed(4), "0.0196");
  assert.equal(nonInferiorityP(11, 9).toFixed(4), "0.0532");
  assert.equal(nonInferiorityP(18, 18).toFixed(4), "0.0457");
  assert.ok(nonInferiorityP(17, 17) > 0.05);
  assert.ok(nonInferiorityP(-1, 2) === 1 && nonInferiorityP(1.5, 2) === 1);
});

test("notWorseProblem refuses a split that can't rule out a loss, and an uncomparable one", () => {
  assert.equal(notWorseProblem("c2", { wins: 12, losses: 8 }, 0.05, "test cases"), null);
  assert.match(notWorseProblem("c2", { wins: 11, losses: 9 }, 0.05, "test cases")!, /shorter, but better in 11 and worse in 9 test cases doesn't rule out a loss \(p 0\.053 that it is no worse, needs 0\.05\)/);
  assert.match(notWorseProblem("c2", null, 0.05, "hidden test cases")!, /hidden test cases could not be compared/);
});

test("an even shorter candidate merges when allow_shorter is on, with the plain sentence", () => {
  const v = judgeRound(round([EVEN()]), on(), null);
  assert.equal(v.action, "merge");
  if (v.action !== "merge") return;
  assert.match(v.plain, /^Removed 412 characters \(9%\) from the prompt with no measured loss: better in 18, worse in 18, the same in 4\. On the hidden test cases it never saw: better in 12, worse in 12, the same in 6\./);
  assert.match(v.reasons[0], /^shorter and no worse: p 0\.046 on the learned-from test cases, 0\.094 on the hidden ones; judge score 50\.0/);
  assert.equal(v.notes.c2, "Merged.");
});

test("the same even candidate is not merged when allow_shorter is off", () => {
  for (const g of [goal(), goal({ merge_rule: { ...DEFAULTS.merge_rule, allow_shorter: false } })]) {
    const v = judgeRound(round([EVEN()]), g, null);
    assert.equal(v.action, "skip");
    assert.match(v.reasons.join(), /judge score 50\.0, needs 52\.0/);
  }
});

test("a shorter candidate that loses clearly is refused, on training or on the hidden cases", () => {
  const train = judgeRound(round([shorterCand([4, 12, 24], [12, 12, 6])]), on(), null);
  assert.equal(train.action, "skip");
  assert.match(train.reasons.join(), /c2: shorter, but better in 4 and worse in 12 test cases doesn't rule out a loss/);
  assert.equal(train.notes.c2, "Shorter, but it may do worse on your test cases: better in 4, worse in 12, the same in 24, so it wasn't used.");
  const held = judgeRound(round([shorterCand([18, 18, 4], [3, 8, 19])]), on(), null);
  assert.equal(held.action, "skip");
  assert.match(held.reasons.join(), /better in 3 and worse in 8 hidden test cases doesn't rule out a loss/);
  assert.match(held.notes.c2, /may do worse on your hidden test cases: better in 3, worse in 8, the same in 19/);
  // Every case tied: nothing decided, so no evidence it is no worse.
  assert.equal(judgeRound(round([shorterCand([0, 0, 40], [0, 0, 30])]), on(), null).action, "skip");
  // An unjudged row is unknown, never a pass.
  const unknown = EVEN();
  unknown.train[0] = { ...unknown.train[0], score: null };
  assert.equal(judgeRound(round([unknown]), on(), null).action, "skip");
});

test("guardrail, guard and attack gates still block a shorter candidate", () => {
  const broke = EVEN();
  broke.train[0] = { ...broke.train[0], violation: true };
  const rule = judgeRound(round([broke]), on(), null);
  assert.equal(rule.action, "skip");
  assert.match(rule.reasons.join(), /c2: breaks a rule where the current prompt follows it/);

  const attacked = { ...round([{ ...EVEN(), attackFailed: ["a1"] }]), attacks: { total: 2, baselineFailed: [], inputs: { a1: "x", a2: "y" } } };
  const attack = judgeRound(attacked, on(), null);
  assert.equal(attack.action, "skip");
  assert.match(attack.reasons.join(), /c2: fails attack a1 that the current prompt passes/);
  assert.equal(judgeRound({ ...attacked, candidates: [{ ...EVEN(), attackFailed: [] }] }, on(), null).action, "merge");

  // Guards: the current prompt passes every guard, the shorter one fails one in four cases.
  const guarded = (r: ScoreRow, i: number, fail: boolean) => ({ ...r, guardApplicable: 1, guardFailed: fail && i % 4 === 0 ? 1 : 0 });
  const s = round([EVEN()]);
  s.baselineTrain = s.baselineTrain.map((r, i) => guarded(r, i, false));
  s.baselineHoldout = s.baselineHoldout.map((r, i) => guarded(r, i, false));
  s.candidates[0].train = s.candidates[0].train.map((r, i) => guarded(r, i, true));
  s.candidates[0].holdout = s.candidates[0].holdout!.map((r, i) => guarded(r, i, true));
  const guard = judgeRound(s, on({ counter_checks: ["Stays on topic"] }), null);
  assert.equal(guard.action, "skip");
  assert.match(guard.reasons.join(), /c2: guards passed \d+% against 100% for the current prompt/);
});

test("the revert check still runs first", () => {
  // The prompt the last merge replaced now wins 40 of 70 cases and loses none against the current one.
  const replaced = [...mix(25, 0, 15), ...mix(15, 0, 15, "h")];
  assert.equal(judgeRound(round([EVEN()]), on(), replaced).action, "revert");
});

test("a better change beats a shorter one in the same round, whatever the order or score", () => {
  const better: CandidateScore = { id: "c1", train: mix(14, 2, 24), holdout: mix(8, 0, 22, "h") }; // mean 65 on training
  const shorterAndBetter = shorterCand([30, 0, 10], [20, 0, 10]); // mean 87.5: higher, but it is the shorter one
  for (const cands of [[shorterAndBetter, better], [better, shorterAndBetter], [EVEN(), better]]) {
    const v = judgeRound(round(cands), on(), null);
    assert.equal(v.action === "merge" && v.candidateId, "c1");
    assert.equal(v.notes.c2, "Shorter and no worse, but a change that did better was used instead.");
  }
});

test("with allow_shorter off, verdicts are byte-identical to the rule without it", () => {
  const fixtures: RoundScores[] = [
    scored("p", 50, 50, 60, 55), scored("p", 50, 50, 51, 60), scored("p", 50, 50, 90, 40), scored("p", 50, 50, 100, 100),
    { ...scored("p", 50, 50, 100, 100), candidates: [{ id: "c1", train: trainRows(100, true), holdout: heldRows(100) }] },
    round([EVEN()]), round([shorterCand([30, 0, 10], [20, 0, 10])]), round([shorterCand([4, 12, 24], [12, 12, 6])]),
    round([EVEN(), { id: "c1", train: mix(14, 2, 24), holdout: mix(8, 0, 22, "h") }]),
  ];
  const plain = (s: RoundScores) => ({ ...s, candidates: s.candidates.map(({ kind: _k, chars: _c, ...c }) => c) });
  for (const s of fixtures) {
    const without = JSON.stringify(judgeRound(plain(s), goal(), null));
    // The flag off, or absent, ignores the kind entirely.
    assert.equal(JSON.stringify(judgeRound(s, goal(), null)), without);
    assert.equal(JSON.stringify(judgeRound(s, goal({ merge_rule: { ...DEFAULTS.merge_rule, allow_shorter: false } }), null)), without);
    // And with it on, a round with no shorter candidate is unchanged too.
    assert.equal(JSON.stringify(judgeRound(plain(s), on(), null)), without);
  }
});

test("synthe.json: allow_shorter is optional and must be true or false", () => {
  const base = { version: 1, prompt: { kind: "file", path: "p.md" }, objective: "o", scenarios: "s.jsonl", budget: { max_usd: 1 } };
  assert.equal(parseGoal(JSON.stringify(base)).merge_rule.allow_shorter, undefined);
  assert.equal(parseGoal(JSON.stringify({ ...base, merge_rule: { allow_shorter: true } })).merge_rule.allow_shorter, true);
  for (const bad of ["yes", 1, null]) assert.throws(() => parseGoal(JSON.stringify({ ...base, merge_rule: { allow_shorter: bad } })), /merge_rule\.allow_shorter must be true or false/);
});

test("a shorter candidate must remove 5% of the prompt or 200 characters, whichever is smaller", () => {
  assert.equal(minShorterBy("x".repeat(1000)), 50);
  assert.equal(minShorterBy("x".repeat(4000)), 200);
  assert.equal(minShorterBy("x".repeat(9000)), 200);
  assert.equal(shorterProblem("x".repeat(1000), "x".repeat(950)), null);
  assert.match(shorterProblem("x".repeat(1000), "x".repeat(951))!, /must remove at least 50 characters, and this one removes 49/);
  assert.match(shorterProblem("x".repeat(1000), "x".repeat(1010))!, /this one adds 10/);
  assert.deepEqual(shorterFields({ id: "c", text: "abc", kind: "shorter" }, "abcdef"), { kind: "shorter", chars: { before: 6, after: 3 } });
  assert.deepEqual(shorterFields({ id: "c", text: "abc" }, "abcdef"), {});
});

const PROMPT = "Be kind.\n\nAlways greet the customer warmly and by name, every single time, without any exception at all.\n\nAnswer the question.";
const train: Scenario[] = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id, input: `question ${id}`, expected: "good", split: "train" }));
const scenarios: Scenario[] = [...train, ...["h1", "h2", "h3", "h4"].map((id) => ({ id, input: `HOLDOUT ${id}`, expected: "good", split: "holdout" as const }))];

// A writer that answers the deletion slot with `deletion` and every other slot with a small addition.
function writer(deletion: { find: string; replace: string }) {
  const seen: Ask[] = [];
  const model: Model = { async ask(a) {
    seen.push(a);
    const edit = a.user.includes("This attempt: Make the prompt shorter") ? deletion : { find: "Answer the question.", replace: "Answer the question fully." };
    return { text: JSON.stringify({ edits: [edit], summary: "s", title: "t" }), costUsd: 0.01 };
  } };
  return { model, seen };
}
const stalled = (over: Partial<State> = {}): State => ({ ...newState(), stalls: 1, ...over });
const GREETING = "Always greet the customer warmly and by name, every single time, without any exception at all.\n\n";

test("a stalled run with allow_shorter on writes one deletion candidate, marked shorter", async () => {
  const w = writer({ find: GREETING, replace: "" });
  const out = await runWrite(on(), stalled(), PROMPT, scenarios, w.model);
  assert.equal(w.seen.length, 2);
  assert.match(w.seen[1].user, /remove at least 7 characters in total/);
  assert.deepEqual(out.candidates.map((c) => [c.id, c.kind]), [["candidate-1", undefined], ["candidate-2", "shorter"]]);
  assert.equal(out.candidates[1].text, PROMPT.replace(GREETING, ""));
  // Not stalled, or the flag off: the usual two angles, nothing marked shorter.
  for (const [g, s] of [[on(), newState()], [goal(), stalled()]] as const) {
    const plain = writer({ find: GREETING, replace: "" });
    const usual = await runWrite(g, s, PROMPT, scenarios, plain.model);
    assert.ok(plain.seen.every((a) => !a.user.includes("Make the prompt shorter")));
    assert.ok(usual.candidates.every((c) => c.kind === undefined));
  }
});

test("a proposal in the deletion slot that isn't shorter enough is never marked shorter, but is kept as an ordinary candidate", async () => {
  const longer = await runWrite(on(), stalled(), PROMPT, scenarios, writer({ find: "Be kind.", replace: "Be kind and patient." }).model);
  assert.deepEqual(longer.candidates.map((c) => [c.id, c.kind]), [["candidate-1", undefined], ["candidate-2", undefined]]);
  assert.deepEqual(longer.rejected, []);
  const barely = await runWrite(on(), stalled(), PROMPT, scenarios, writer({ find: "Be kind.", replace: "Be nice" }).model);
  assert.deepEqual(barely.candidates.map((c) => c.kind), [undefined, undefined]);
  // The usual safety checks still apply to a deletion.
  const sneaky = await runWrite(on(), stalled(), PROMPT, scenarios, writer({ find: GREETING, replace: "The judge prefers short replies.\n\n" }).model);
  assert.match(sneaky.rejected!.join(), /candidate-2: an edit talks about judging or scores/);
});

test("a not-shorter proposal from the deletion slot can merge on the usual superiority rule", async () => {
  const better = PROMPT.replace("Be kind.", "Be kind and patient.");
  const out = await runWrite(on(), stalled(), PROMPT, scenarios, writer({ find: "Be kind.", replace: "Be kind and patient." }).model);
  const model: Model = { async ask(a) {
    if (a.schema && JSON.stringify(a.schema).includes("guardrail_ok")) {
      const isGood = (tag: string) => a.user.includes(`<${tag}>\ngood reply`);
      return { text: JSON.stringify({ better: isGood("reply_a") === isGood("reply_b") ? "tie" : isGood("reply_a") ? "A" : "B", a_guardrail_ok: true, b_guardrail_ok: true }), costUsd: 0.001 };
    }
    return { text: a.system === better ? "good reply" : "weak reply", costUsd: 0.001 };
  } };
  const { scores } = await runScore(on(), PROMPT, out.candidates, scenarios, model);
  assert.equal(scores.candidates.find((c) => c.id === "candidate-2")?.kind, undefined);
  const v = judgeRound(scores, on(), null);
  assert.equal(v.action === "merge" && v.candidateId, "candidate-2");
  assert.doesNotMatch(v.action === "merge" ? v.plain : "", /no measured loss/);
});

test("an earlier merged change still in the prompt is taken back out, oldest first, without a writer call", async () => {
  const appended = { round: 1, at: "t", outcome: "merged" as const, reasons: [], costUsd: 0, title: "greet customers", edits: [{ find: "", replace: GREETING.trim() }] };
  const replaced = { round: 2, at: "t", outcome: "merged" as const, reasons: [], costUsd: 0, edits: [{ find: "Be kind.", replace: "Be kind." }] };
  const prompt = `Be kind.\n\nAnswer the question.\n\n${GREETING.trim()}\n`;
  assert.deepEqual(undoEdits(prompt, stalled({ rounds: [appended, replaced] })).map((u) => u.round), [1, 2]);
  const w = writer({ find: "Be kind.\n\n", replace: "" });
  const out = await runWrite(on(), stalled({ rounds: [appended] }), prompt, scenarios, w.model);
  assert.equal(w.seen.length, 1);
  const undo = out.candidates.find((c) => c.id === "candidate-2")!;
  assert.equal(undo.kind, "shorter");
  assert.equal(undo.text, "Be kind.\n\nAnswer the question.\n");
  assert.match(undo.summary!, /Takes out the change merged in round 1 \("greet customers"\)/);
  // Edited since, so its text isn't there word for word: nothing to take back, and the writer gets the slot.
  assert.deepEqual(undoEdits(prompt.replace("warmly", "kindly"), stalled({ rounds: [appended] })), []);
  // Reverted or never merged: not taken back.
  assert.deepEqual(undoEdits(prompt, stalled({ rounds: [{ ...appended, outcome: "skipped" }] })), []);
});

test("the score step marks the shorter candidate and sends it to the hidden cases only when nothing better passed", async () => {
  const shortText = PROMPT.replace(GREETING, "");
  const model = (good: string[]): Model => ({ async ask(a) {
    if (a.schema && JSON.stringify(a.schema).includes("guardrail_ok")) {
      const isGood = (tag: string) => a.user.includes(`<${tag}>\ngood reply`);
      const better = isGood("reply_a") === isGood("reply_b") ? "tie" : isGood("reply_a") ? "A" : "B";
      return { text: JSON.stringify({ better, a_guardrail_ok: true, b_guardrail_ok: true }), costUsd: 0.001 };
    }
    return { text: good.includes(a.system!) ? "good reply" : "weak reply", costUsd: 0.001 };
  } });
  const cands = [{ id: "candidate-1", text: "Better." }, { id: "candidate-2", text: shortText, kind: "shorter" as const }];
  // Both win every case: the better one, not the shorter one, gets the hidden cases.
  const both = await runScore(on(), PROMPT, cands, scenarios, model(["Better.", shortText]));
  assert.deepEqual(both.scores.candidates.map((c) => [c.id, c.kind, Boolean(c.holdout)]), [["candidate-1", undefined, true], ["candidate-2", "shorter", false]]);
  assert.deepEqual(both.scores.candidates[1].chars, { before: PROMPT.length, after: shortText.length });
  // Only the shorter one passes: it gets them, and merges.
  const only = await runScore(on(), PROMPT, cands, scenarios, model([shortText]));
  assert.deepEqual(only.scores.candidates.map((c) => Boolean(c.holdout)), [false, true]);
  const v = judgeRound(only.scores, on(), null);
  assert.equal(v.action === "merge" && v.candidateId, "candidate-2");
});

test("decide: a shorter merge says it was a deletion in the pull request and report, and resets stalls", async () => {
  const short = PROMPT.replace(GREETING, "");
  const scores = { ...round([{ ...EVEN(), id: "c2", chars: { before: PROMPT.length, after: short.length } }]), baselineHash: sha256(PROMPT) };
  for (const mode of ["auto", "propose"] as const) {
    const repo = new MemoryRepo(PROMPT);
    repo.state.stalls = 2;
    const g = on({ merge_rule: { ...DEFAULTS.merge_rule, mode } });
    const r = await runDecide(g, repo, { candidates: [{ id: "c2", kind: "shorter", text: short, summary: "Drops the greeting rule.", title: "drop greeting rule", edits: [{ find: GREETING, replace: "" }] }], scores, costUsd: 0.1 });
    assert.equal(r?.outcome, mode === "auto" ? "merged" : "proposed");
    assert.equal(repo.prs[0].title, "Synthe: shorter prompt, drop greeting rule");
    assert.match(repo.prs[0].body, /\*\*What changed in `prompt\.md`:\*\* Shorter prompt: removed 96 characters and added no new instruction\. Drops the greeting rule\./);
    assert.match(repo.prs[0].body, /Removed 96 characters \(\d+%\) from the prompt with no measured loss/);
    if (mode === "propose") assert.match(repo.prs[0].body, /Synthe found a shorter prompt that did as well\./);
    assert.match(r!.changed!, /^Shorter prompt: removed 96 characters/);
    if (mode === "auto") {
      assert.equal(repo.state.stalls, 0);
      assert.equal(repo.files.get("prompt.md"), short);
      assert.match(repo.issue, /Removed 96 characters/);
    }
  }
});

test("verify re-runs a shorter verdict with the no-worse test, and catches the flag being removed", () => {
  const s = round([EVEN()]);
  const g = on();
  const v = judgeRound(s, g, null);
  assert.equal(v.action, "merge");
  const rec = buildEvidence({ round: 3, goal: g, promptBefore: "a long prompt", promptAfter: "a prompt", verdict: "merge", verdictReasons: v.reasons, scores: s, candidateId: "c2", costUsd: 0.1, prevEvidenceHash: null });
  assert.equal(rec.shorter, true);
  const splits = new Map([...s.baselineTrain.map((r) => [r.id, "train"] as const), ...s.baselineHoldout.map((r) => [r.id, "holdout"] as const)]);
  // Checked under the team's goal as it is now, even with the flag since turned off: the record says how it ran.
  assert.equal(recomputeProblem(rec, goal(), splits), null);
  const stripped = { ...rec, shorter: undefined };
  stripped.sha256 = hashEvidence(stripped);
  assert.match(recomputeProblem(stripped, goal(), splits)!, /the stored verdict is merge, but the recorded scores give skip/);
  // Ordinary records don't carry the field.
  const usual = scored("p", 50, 50, 100, 100);
  const plainRec = buildEvidence({ round: 1, goal: g, promptBefore: "p", promptAfter: "q", verdict: "merge", verdictReasons: judgeRound(usual, g, null).reasons, scores: usual, candidateId: "c1", costUsd: 0.1, prevEvidenceHash: null });
  assert.equal("shorter" in plainRec, false);
});
