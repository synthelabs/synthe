import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGoal, type Goal, type Scenario } from "../src/core/goal.ts";
import { judgeRound, type CandidateScore, type RoundScores } from "../src/core/merge-rule.ts";
import { candidateFingerprint } from "../src/core/candidate-history.ts";
import { sha256 } from "../src/core/safety.ts";
import { newState, type PoolEntry, type State } from "../src/core/state.ts";
import { runDecide } from "../src/loop/decide.ts";
import { POOL_ID, POOL_MAX_P, POOL_SIZE, combinedRounds, explainPool, mergeFromPool, updatePool, validPool } from "../src/loop/pool.ts";
import { runScore } from "../src/loop/score.ts";
import { explainWrite, runWrite, type Candidate } from "../src/loop/write.ts";
import type { Ask, Model } from "../src/model/client.ts";
import { MemoryRepo, goal } from "./helpers.ts";

// A small world, the same shape as compose.test.ts. Training cases t1-t4 reward "Rule A", t5-t8 reward "Rule B";
// the four hidden cases reward a prompt with both. Neither rule alone is clearly better on eight cases (4 wins and
// 4 ties: sign test p 0.0625, over the 0.05 limit), so a round that finds both merges nothing. The agent's reply
// quotes its system prompt, so the fake judge can see which rules a prompt has.
const BASE = "Old prompt.";
const train: Scenario[] = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: `t${n}`, input: `train-q${n}`, expected: "good", split: "train" }));
const hidden: Scenario[] = [1, 2, 3, 4].map((n) => ({ id: `h${n}`, input: `HOLDOUT-SECRET question ${n}`, expected: "good", split: "holdout" }));
const scenarios = [...train, ...hidden];
const scenarioText = scenarios.map((s) => JSON.stringify(s)).join("\n");
const on = (over: Partial<Goal> = {}) => goal({ population: true, ...over });
const steady = () => 0.99;

const isWriter = (a: Ask) => a.user.startsWith("You improve the system prompt of an AI agent by making small, exact edits.\n");
const isCompose = (a: Ask) => a.user.includes("Several edits were just tried on the same test cases");
const value = (reply: string, situation: string) => {
  const a = reply.includes("Rule A"), b = reply.includes("Rule B");
  if (situation.includes("HOLDOUT")) return a && b ? 1 : 0;
  return Number(situation.match(/train-q(\d)/)?.[1]) <= 4 ? (a ? 1 : 0) : (b ? 1 : 0);
};

// The writer's two attempts get the next two rules from the script, so each round proposes something new.
function world(script = ["Rule A.", "Rule B.", "Rule C.", "Rule D.", "Rule E.", "Rule F."]): Model & { seen: Ask[] } {
  const seen: Ask[] = [];
  let next = 0;
  return {
    seen,
    async ask(a) {
      seen.push(a);
      if (isWriter(a)) { const rule = script[next++]; return { text: JSON.stringify({ edits: [{ find: "", replace: rule }], summary: `adds ${rule.replace(".", "").toLowerCase()}`, title: "add a rule" }), costUsd: 0.01 }; }
      if (isCompose(a)) return { text: JSON.stringify({ edits: [{ find: "", replace: "Rule A. Rule B." }], summary: "adds both rules", title: "follow both rules" }), costUsd: 0.01 };
      if (a.system !== undefined) return { text: `reply to ${a.user} using ${a.system}`, costUsd: 0.001 };
      const situation = a.user.match(/Situation: (.*)/)![1];
      const va = value(a.user.match(/<reply_a>\n([\s\S]*?)\n<\/reply_a>/)![1], situation), vb = value(a.user.match(/<reply_b>\n([\s\S]*?)\n<\/reply_b>/)![1], situation);
      return { text: JSON.stringify({ better: va > vb ? "A" : vb > va ? "B" : "tie", a_guardrail_ok: true, b_guardrail_ok: true }), costUsd: 0.001 };
    },
  };
}

// One whole round against an in-memory repo: write, score, decide.
async function round(g: Goal, repo: MemoryRepo, m: Model) {
  const prompt = repo.files.get("prompt.md")!;
  const written = await runWrite(g, await repo.readState(), prompt, scenarios, m);
  const scored = await runScore(g, prompt, written.candidates, scenarios, m, null, steady);
  const record = await runDecide(g, repo, { candidates: written.candidates, scores: scored.scores, costUsd: 0.1 });
  return { written, scored, record };
}
const freshRepo = () => { const repo = new MemoryRepo(BASE); repo.files.set("s.jsonl", scenarioText); return repo; };

// Hand-made scores for the pool's own tests: each candidate wins the listed training cases and ties the rest.
const scoreOf = (id: string, wins: string[], extra: Partial<CandidateScore["train"][number]>[] = []): CandidateScore =>
  ({ id, train: [...train.map((s) => ({ id: s.id, score: wins.includes(s.id) ? 100 : 50, violation: false })), ...extra.map((r) => ({ id: "x", score: 100, violation: false, ...r }))] });
const scoresOf = (...candidates: CandidateScore[]): RoundScores =>
  ({ baselineHash: sha256(BASE), baselineTrain: train.map((s) => ({ id: s.id, score: 50, violation: false })), baselineHoldout: hidden.map((s) => ({ id: s.id, score: 50, violation: false })), candidates });
const adds = (id: string, rule: string): Candidate => ({ id, text: `${BASE}\n\n${rule}\n`, summary: `adds ${rule}`, edits: [{ find: "", replace: rule }] });
const entry = (id: string, round: number, rule: string, wonOn: string[], over: Partial<PoolEntry> = {}): PoolEntry =>
  ({ id, round, summary: `adds ${rule}`, edits: [{ find: "", replace: rule }], wonOn, promptHash: sha256(BASE), ...over });
const update = (over: Partial<Parameters<typeof updatePool>[0]> = {}) => updatePool({
  pool: undefined, round: 1, goal: on(), candidates: [], scores: scoresOf(), scenarioText, promptAfter: BASE, outcome: "skipped", winnerId: null, ...over,
});

test("pool update adds each change that won a training case and broke no guardrail", () => {
  const long = "x".repeat(1200);
  const candidates = [adds("candidate-1", "Rule A."), adds("candidate-2", "Rule B."), adds("candidate-3", "Rule C."), adds("candidate-4", "Rule D."),
    adds(POOL_ID, "Rule E."), adds("winner", "Rule W."), { ...adds("candidate-5", "Rule L."), edits: [{ find: long, replace: long }] }];
  const scores = scoresOf(scoreOf("candidate-1", ["t1", "t2"]), scoreOf("candidate-2", ["t5", "t6"]), scoreOf("candidate-3", []), scoreOf(POOL_ID, ["t6", "t7"]), scoreOf("winner", ["t7", "t8"]), scoreOf("candidate-5", ["t3", "t8"]),
    { id: "candidate-4", train: train.map((s) => ({ id: s.id, score: 100, violation: s.id === "t3" })) });
  const pool = update({ candidates, scores, round: 3, outcome: "proposed", winnerId: "winner" });
  // No wins (candidate-3), a new guardrail break (candidate-4), the merge candidate itself, the round's winner and
  // a change too long to carry in state (candidate-5) are all left out.
  assert.deepEqual(pool, [
    { id: "r3-candidate-1", round: 3, summary: "adds Rule A.", edits: [{ find: "", replace: "Rule A." }], wonOn: ["t1", "t2"], promptHash: sha256(BASE) },
    { id: "r3-candidate-2", round: 3, summary: "adds Rule B.", edits: [{ find: "", replace: "Rule B." }], wonOn: ["t5", "t6"], promptHash: sha256(BASE) },
  ]);
  // A row that couldn't be judged counts as a break, as it does in the merge rule.
  const unknown = scoresOf({ id: "candidate-1", train: train.map((s) => ({ id: s.id, score: s.id === "t1" ? null : 100, violation: s.id === "t1" ? null : false })) });
  assert.deepEqual(update({ candidates, scores: unknown }), []);
  // After an undo the wins were against a prompt that is gone.
  assert.deepEqual(update({ candidates, scores, outcome: "reverted" }), []);
  // A long summary is clipped the way the Actions log clips.
  const wordy = update({ candidates: [{ ...adds("candidate-1", "Rule A."), summary: "s".repeat(500) }], scores });
  assert.equal(wordy[0].summary.length, 203);
});

test("only a change with evidence of its own is pooled: beyond a coin's record, and not already refused on the hidden cases", () => {
  const record = (wins: number, losses: number): CandidateScore => ({ id: "candidate-1", train: train.map((s, i) => ({ id: s.id, score: i < wins ? 100 : i < wins + losses ? 0 : 50, violation: false })) });
  const pooled = (c: CandidateScore) => update({ candidates: [adds("candidate-1", "Rule A.")], scores: scoresOf(c) }).length === 1;
  assert.equal(POOL_MAX_P, 0.25);
  // Two wins and no loss just pass; one win, or wins matched by losses, could be a coin.
  assert.deepEqual([[2, 0], [4, 0], [4, 1], [1, 0], [3, 2], [4, 4], [3, 5]].map(([w, l]) => pooled(record(w, l))), [true, true, true, false, false, false, false]);
  // The round's training leader was tried on the hidden cases and didn't merge: the gate refused it, so pooling it
  // would give the same change a second draw at those cases inside a combination.
  const refused = { ...record(8, 0), holdout: hidden.map((s) => ({ id: s.id, score: 50, violation: false })) };
  assert.equal(pooled(refused), false);
  assert.equal(pooled(record(8, 0)), true);
});

test("pool update prunes an entry whose wins are all inside another's, and keeps the newer of two equals", () => {
  const before = [entry("r1-candidate-1", 1, "Rule A.", ["t1", "t2"]), entry("r1-candidate-2", 1, "Rule B.", ["t5", "t6"])];
  const pool = update({ pool: before, round: 2, candidates: [adds("candidate-1", "Rule C."), adds("candidate-2", "Rule D.")],
    scores: scoresOf(scoreOf("candidate-1", ["t1", "t2", "t3"]), scoreOf("candidate-2", ["t5", "t6"])) });
  assert.deepEqual(pool.map((e) => [e.id, e.wonOn]), [["r2-candidate-1", ["t1", "t2", "t3"]], ["r2-candidate-2", ["t5", "t6"]]]);
  // Entries that each win somewhere the other doesn't both stay.
  assert.deepEqual(update({ pool: before }).map((e) => e.id), ["r1-candidate-1", "r1-candidate-2"]);
});

test("pool update drops entries whose edits no longer apply to the prompt, before they can prune a live one", () => {
  const stale = entry("r1-candidate-1", 1, "", ["t1", "t2", "t3"], { edits: [{ find: "Old prompt.", replace: "New prompt." }] });
  const live = entry("r1-candidate-2", 1, "Rule B.", ["t1", "t2"]);
  const already = entry("r2-candidate-1", 2, "Rule Z.", ["t7"]);
  assert.deepEqual(update({ pool: [stale, live, already] }).map((e) => e.id), ["r1-candidate-1", "r2-candidate-1"]);
  // A teammate rewrote the sentence the first edit needs, and added the third entry's rule by hand.
  assert.deepEqual(update({ pool: [stale, live, already], promptAfter: "A teammate's rewrite.\n\nrule z.\n" }).map((e) => e.id), ["r1-candidate-2"]);
});

test("pool update caps the pool, dropping the oldest first", () => {
  const five = [1, 2, 3, 4, 5].map((n) => entry(`r${n}-candidate-1`, n, `Rule ${n}.`, [`t${n}`]));
  const pool = update({ pool: five });
  assert.equal(pool.length, POOL_SIZE);
  assert.deepEqual(pool.map((e) => e.round), [2, 3, 4, 5]);
  // A new round's entry pushes out the oldest again.
  const next = update({ pool, round: 6, candidates: [adds("candidate-1", "Rule 6.")], scores: scoresOf(scoreOf("candidate-1", ["t6", "t7"])) });
  assert.deepEqual(next.map((e) => e.round), [3, 4, 5, 6]);
});

test("held-back ids are never stored in the pool, even from tampered scores or state", () => {
  // The scores file comes from another job: a held-back row planted among the training rows must not be kept.
  const planted = scoresOf(scoreOf("candidate-1", ["t1", "t3"], [{ id: "h1" }, { id: "not-a-case" }]));
  planted.baselineTrain.push({ id: "h1", score: 50, violation: false }, { id: "not-a-case", score: 50, violation: false });
  const pool = update({ pool: [entry("r1-candidate-9", 1, "Rule H.", ["h2", "h3"]), entry("r1-candidate-8", 1, "Rule G.", ["t2", "h4"])], round: 2, candidates: [adds("candidate-1", "Rule A.")], scores: planted });
  assert.deepEqual(pool.map((e) => [e.id, e.wonOn]), [["r1-candidate-8", ["t2"]], ["r2-candidate-1", ["t1", "t3"]]]);
  // Planted wins don't help a change over the evidence bar either: one real win is still one win.
  const lifted = scoresOf(scoreOf("candidate-1", ["t1"], [{ id: "h1" }, { id: "not-a-case" }]));
  lifted.baselineTrain.push({ id: "h1", score: 50, violation: false }, { id: "not-a-case", score: 50, violation: false });
  assert.deepEqual(update({ candidates: [adds("candidate-1", "Rule A.")], scores: lifted }), []);
  assert.doesNotMatch(JSON.stringify(pool), /"h\d"|HOLDOUT/);
  // A case moved to the held-back split stops counting, and without a readable scenario file nothing is kept.
  const moved = scenarios.map((s) => JSON.stringify(s.id === "t2" ? { ...s, split: "holdout" } : s)).join("\n");
  assert.deepEqual(update({ pool, scenarioText: moved }).map((e) => e.id), ["r2-candidate-1"]);
  assert.deepEqual(update({ pool, scenarioText: null }), []);
  assert.deepEqual(update({ pool, scenarioText: "not json" }), []);
});

test("a merged change's wins stop counting for the entries that stay", () => {
  const pool = update({ pool: [entry("r1-candidate-1", 1, "Rule A.", ["t1", "t2"]), entry("r1-candidate-2", 1, "Rule B.", ["t5", "t6"])], round: 2,
    candidates: [adds("candidate-1", "Rule W."), adds("candidate-2", "Rule C.")], scores: scoresOf(scoreOf("candidate-1", ["t1", "t2", "t5"]), scoreOf("candidate-2", ["t5", "t7"])),
    outcome: "merged", winnerId: "candidate-1", promptAfter: `${BASE}\n\nRule W.\n` });
  assert.deepEqual(pool.map((e) => [e.id, e.wonOn]), [["r1-candidate-2", ["t6"]], ["r2-candidate-2", ["t7"]]]);
});

test("a damaged pool in state is ignored entry by entry, and old state without a pool loads", async () => {
  const good = entry("r1-candidate-1", 1, "Rule A.", ["t1", "t1", "t2"]);
  const bad = [null, "x", { ...good, round: 0 }, { ...good, edits: [] }, { ...good, edits: [{ find: 1, replace: "x" }] }, { ...good, wonOn: [] }, { ...good, wonOn: [1] }, { ...good, promptHash: 1 },
    { ...good, edits: [{ find: "", replace: "a" }, { find: "", replace: "b" }, { find: "", replace: "c" }] }];
  assert.deepEqual(validPool([...bad, good]), [{ ...good, wonOn: ["t1", "t2"] }]);
  for (const junk of [undefined, null, "pool", {}, 3]) assert.deepEqual(validPool(junk), []);

  // State saved before the pool existed: no key at all. It loads, a round runs, and the pool starts.
  const old = JSON.parse(JSON.stringify(newState())) as State;
  assert.equal("pool" in old, false);
  const repo = freshRepo();
  repo.state = old;
  const { written, record } = await round(on(), repo, world());
  assert.equal(written.population?.skipped, "the pool is empty");
  assert.equal(record?.outcome, "skipped");
  assert.deepEqual(repo.state.pool?.map((e) => e.id), ["r1-candidate-1", "r1-candidate-2"]);
});

test("the merge candidate applies the two entries that cover the most training cases", () => {
  const pool = [entry("r1-candidate-1", 1, "Rule A.", ["t1", "t2", "t3"]), entry("r2-candidate-1", 2, "Rule C.", ["t3", "t4"]), entry("r3-candidate-2", 3, "Rule B.", ["t5", "t6", "t7"])];
  const tried = new Set<string>();
  const m = mergeFromPool({ goal: on(), prompt: BASE, train, pool, tried });
  assert.equal(m.candidate?.id, POOL_ID);
  assert.equal(m.candidate?.text, `${BASE}\n\nRule A.\n\nRule B.\n`);
  assert.deepEqual(m.candidate?.edits, [{ find: "", replace: "Rule A." }, { find: "", replace: "Rule B." }]);
  assert.deepEqual(m.candidate?.combines, [{ round: 1, summary: "adds Rule A." }, { round: 3, summary: "adds Rule B." }]);
  assert.equal(m.candidate?.summary, "Combines two changes from rounds 1 and 3 that each did better in different test cases: adds Rule A; adds Rule B");
  assert.equal(m.candidate?.title, "combine fixes from rounds 1 and 3");
  assert.deepEqual(combinedRounds(m.candidate ?? undefined), [1, 3]);
  assert.ok(tried.has(candidateFingerprint(m.candidate!.text)));
  assert.deepEqual(explainPool(m), ['pool: combined applies "adds Rule A." (round 1) and "adds Rule B." (round 3)']);

  // The same combination is never built twice: the next-best pair is used instead.
  const again = mergeFromPool({ goal: on(), prompt: BASE, train, pool, tried });
  assert.equal(again.candidate?.text, `${BASE}\n\nRule C.\n\nRule B.\n`);
  // Cover counts only cases that are still training cases.
  const fewer = mergeFromPool({ goal: on(), prompt: BASE, train: train.filter((s) => !["t1", "t2"].includes(s.id)), pool, tried: new Set() });
  assert.equal(fewer.candidate?.text, `${BASE}\n\nRule C.\n\nRule B.\n`);
  // Only a merge candidate carries rounds, and a tampered one is not trusted.
  assert.equal(combinedRounds(adds("candidate-1", "Rule A.")), undefined);
  assert.equal(combinedRounds({ ...m.candidate!, combines: [{ round: "1" }, null] } as unknown as Candidate), undefined);
});

test("entries whose edits conflict are not combined", () => {
  const prompt = "Be polite. Keep answers short.";
  const promptHash = sha256(prompt);
  const a = entry("r1-candidate-1", 1, "", ["t1", "t2", "t3"], { edits: [{ find: "Be polite.", replace: "Be polite and warm." }], summary: "warmer", promptHash });
  const b = entry("r1-candidate-2", 1, "", ["t4", "t5", "t6"], { edits: [{ find: "polite", replace: "courteous" }], summary: "courteous", promptHash });
  const c = entry("r2-candidate-1", 2, "", ["t7"], { edits: [{ find: "Keep answers short.", replace: "Keep answers under 80 words." }], summary: "word limit", promptHash });
  const two = mergeFromPool({ goal: on(), prompt, train, pool: [a, b], tried: new Set() });
  assert.equal(two.candidate, null);
  assert.equal(two.skipped, "no new combination (r1-candidate-1 + r1-candidate-2: their edits conflict)");
  assert.deepEqual(explainPool(two), ["pool: no merge candidate, no new combination (r1-candidate-1 + r1-candidate-2: their edits conflict)"]);
  // With a third entry that touches another sentence, the best pair that doesn't conflict is used.
  const three = mergeFromPool({ goal: on(), prompt, train, pool: [a, b, c], tried: new Set() });
  assert.equal(three.candidate?.text, "Be polite and warm. Keep answers under 80 words.");
  // Both orders apply here, but they give different sentences, so which one the team would get is arbitrary.
  const d = entry("r1-candidate-1", 1, "", ["t1", "t2"], { edits: [{ find: "polite", replace: "polite and warm" }], summary: "warmer", promptHash });
  const e = entry("r1-candidate-2", 1, "", ["t5", "t6"], { edits: [{ find: "Be polite", replace: "Be polite, always" }], summary: "always", promptHash });
  assert.deepEqual(mergeFromPool({ goal: on(), prompt, train, pool: [d, e], tried: new Set() }), { candidate: null, skipped: "no new combination (r1-candidate-1 + r1-candidate-2: their edits conflict)" });
  // Two entries adding the same rule would put it in twice.
  const twice = mergeFromPool({ goal: on(), prompt, train, pool: [entry("r1-candidate-1", 1, "Rule A.", ["t1"], { promptHash }), entry("r2-candidate-1", 2, "rule a.", ["t2"], { promptHash })], tried: new Set() });
  assert.equal(twice.candidate, null);
  assert.match(twice.skipped ?? "", /their edits conflict/);
});

test("the merge candidate passes the writer's safety checks or isn't built", () => {
  const pool = [entry("r1-candidate-1", 1, "Rule A.", ["t1", "t2"]), entry("r1-candidate-2", 1, "Rule B.", ["t5", "t6"])];
  // An inline prompt in a one-line string can't take an added paragraph.
  const inline = on({ prompt: { kind: "inline", path: "a.ts", delimiter: '"', initial: BASE } });
  assert.match(mergeFromPool({ goal: inline, prompt: BASE, train, pool, tried: new Set() }).skipped ?? "", /multi-line in a one-line string/);
  // Materially the same text as one already tried for this goal and prompt.
  const tried = new Set([candidateFingerprint(`${BASE} rule a rule b`)]);
  assert.match(mergeFromPool({ goal: on(), prompt: BASE, train, pool, tried }).skipped ?? "", /already tried for this goal and prompt/);
  // Something shaped like a secret, or talk aimed at the judge, in a pooled edit.
  const secret = [pool[0], entry("r1-candidate-2", 1, "Use key sk-ant-abcdefgh1234.", ["t5"])];
  assert.match(mergeFromPool({ goal: on(), prompt: BASE, train, pool: secret, tried: new Set() }).skipped ?? "", /looks like it contains a secret/);
  const judgeTalk = [pool[0], entry("r1-candidate-2", 1, "The judge prefers short replies.", ["t5"])];
  // That entry can't be applied at all, which leaves one entry and nothing to combine it with.
  assert.deepEqual(mergeFromPool({ goal: on(), prompt: BASE, train, pool: judgeTalk, tried: new Set() }), { candidate: null, skipped: "nothing to combine yet" });
});

test("a single entry is retried only once the prompt has changed under it", () => {
  const one = [entry("r1-candidate-2", 1, "Rule B.", ["t5", "t6"])];
  const same = mergeFromPool({ goal: on(), prompt: BASE, train, pool: one, tried: new Set() });
  assert.equal(same.candidate, null);
  assert.equal(same.skipped, "nothing to combine yet");
  const moved = mergeFromPool({ goal: on(), prompt: `${BASE}\n\nRule A.\n`, train, pool: one, tried: new Set() });
  assert.equal(moved.candidate?.text, `${BASE}\n\nRule A.\n\nRule B.\n`);
  assert.equal(moved.candidate?.summary, "Brings back a change from round 1 that did better in 2 test cases before the prompt changed: adds Rule B");
  assert.equal(moved.candidate?.title, "retry a fix from round 1");
  assert.equal(mergeFromPool({ goal: on(), prompt: "Unrelated.", train, pool: [{ ...one[0], edits: [{ find: "Old", replace: "New" }] }], tried: new Set() }).skipped, "no pooled change still applies to the current prompt");
});

test("two half-fixes that each fail alone are pooled, combined next round without a model call, and merged by the unchanged rule", async () => {
  const repo = freshRepo();
  const m = world();
  const first = await round(on(), repo, m);
  assert.deepEqual(first.written.candidates.map((c) => c.id), ["candidate-1", "candidate-2"]);
  assert.equal(first.record?.outcome, "skipped");
  assert.match(first.record!.reasons.join(" "), /candidate-1: better in 4 and worse in 0 test cases, which could be luck/);
  assert.deepEqual(repo.state.pool, [
    { id: "r1-candidate-1", round: 1, summary: "adds rule a", edits: [{ find: "", replace: "Rule A." }], wonOn: ["t1", "t2", "t3", "t4"], promptHash: sha256(BASE) },
    { id: "r1-candidate-2", round: 1, summary: "adds rule b", edits: [{ find: "", replace: "Rule B." }], wonOn: ["t5", "t6", "t7", "t8"], promptHash: sha256(BASE) },
  ]);

  const writerCalls = m.seen.filter(isWriter).length;
  const second = await round(on(), repo, m);
  // Still two writer calls a round: the third candidate is built from the pool, not written.
  assert.equal(m.seen.filter(isWriter).length - writerCalls, 2);
  assert.deepEqual(second.written.candidates.map((c) => c.id), ["candidate-1", "candidate-2", POOL_ID]);
  assert.ok(explainWrite(second.written).includes('pool: combined applies "adds rule a" (round 1) and "adds rule b" (round 1)'));
  const combined = second.scored.scores.candidates.find((c) => c.id === POOL_ID)!;
  assert.deepEqual(combined.train.map((r) => r.score), Array(8).fill(100));
  assert.deepEqual(combined.holdout?.map((r) => r.score), Array(4).fill(100));
  // The verdict is exactly what the same text gets as an ordinary candidate with population off.
  const plain = await runScore(goal(), BASE, [...second.written.candidates.slice(0, 2), { id: POOL_ID, text: second.written.candidates[2].text }], scenarios, world(), null, steady);
  assert.deepEqual(judgeRound(second.scored.scores, on(), null), judgeRound(plain.scores, goal(), null));

  assert.equal(second.record?.outcome, "merged");
  assert.deepEqual(second.record?.combined, [1]);
  assert.equal(repo.files.get("prompt.md"), `${BASE}\n\nRule A.\n\nRule B.\n`);
  // The report and the pull request both say which round's ideas were combined.
  assert.match(repo.issue, /Combines two changes from round 1 that each did better in different test cases: adds rule a; adds rule b\./);
  assert.match(repo.prs[0].body, /Combines two changes from round 1 that each did better in different test cases/);
  assert.equal(repo.prs[0].title, "Synthe: combine fixes from round 1");
  // Both entries' wins are in the prompt now, so the pool is empty again.
  assert.deepEqual(repo.state.pool, []);
  // The writer was never shown the pool or a held-back case.
  for (const a of m.seen.filter(isWriter)) assert.doesNotMatch(a.user, /HOLDOUT-SECRET/);
});

test("the gate still refuses a merge candidate that doesn't win the hidden cases", async () => {
  // Rule X and Rule Y each win half the training cases here, but the hidden cases reward only Rule A and Rule B.
  const base = world(["Rule X.", "Rule Y.", "Rule C.", "Rule D.", "Rule E.", "Rule F."]);
  const m: Model & { seen: Ask[] } = { seen: base.seen, ask: (a) => base.ask({ ...a, system: a.system?.replace("Rule X", "Rule A").replace("Rule Y", a.user.includes("HOLDOUT") ? "Rule Y" : "Rule B"), user: a.user }) };
  const repo = freshRepo();
  await round(on(), repo, m);
  assert.equal(repo.state.pool?.length, 2);
  const second = await round(on(), repo, m);
  assert.ok(second.written.candidates.some((c) => c.id === POOL_ID));
  assert.equal(second.record?.outcome, "skipped");
  assert.match(second.record!.reasons.join(" "), /combined: judge score 50\.0 on the hidden test cases/);
  assert.equal(repo.files.get("prompt.md"), BASE);
  // Its parts stay pooled, and the same combination is not built again.
  assert.deepEqual(repo.state.pool?.map((e) => e.id), ["r1-candidate-1", "r1-candidate-2"]);
  const third = await round(on(), repo, m);
  assert.equal(third.written.candidates.some((c) => c.id === POOL_ID), false);
  assert.match(third.written.population?.skipped ?? "", /already tried for this goal and prompt/);
});

test("population off: a planted pool changes no candidate, model call or state, and synthe.json validates the flag", async () => {
  const planted = [entry("r1-candidate-1", 1, "Rule A.", ["t1", "t2", "t3", "t4"]), entry("r1-candidate-2", 1, "Rule B.", ["t5", "t6", "t7", "t8"])];
  const run = async (g: Goal, pool?: PoolEntry[]) => {
    const repo = freshRepo();
    if (pool) repo.state.pool = structuredClone(pool);
    const m = world();
    const rounds = [await round(g, repo, m), await round(g, repo, m)];
    return { repo, m, rounds };
  };
  const plain = await run(goal());
  const off = await run(goal({ population: false }), planted);
  for (const r of [plain, off]) {
    for (const x of r.rounds) {
      assert.deepEqual(x.written.candidates.map((c) => c.id), ["candidate-1", "candidate-2"]);
      assert.equal("population" in x.written, false);
      assert.equal(x.record?.outcome, "skipped");
      assert.equal(x.record?.combined, undefined);
    }
  }
  // The same calls, in the same order, with the same text.
  assert.deepEqual(off.m.seen, plain.m.seen);
  assert.deepEqual(off.rounds.map((x) => x.written), plain.rounds.map((x) => x.written));
  assert.deepEqual(off.rounds.map((x) => x.scored.scores), plain.rounds.map((x) => x.scored.scores));
  // State is the same apart from what differs by construction: the goal is part of the evidence chain and of the
  // candidate history's scope, and timestamps. A pool is never created, and a planted one is left exactly as it was.
  assert.equal("pool" in plain.repo.state, false);
  assert.deepEqual(off.repo.state.pool, planted);
  const comparable = (s: State) => ({ ...s, pool: undefined, evidenceHash: undefined, candidateHistory: s.candidateHistory?.length, rounds: s.rounds.map((r) => ({ ...r, at: "" })) });
  assert.deepEqual(comparable(off.repo.state), comparable(plain.repo.state));

  const base = { version: 1, prompt: { kind: "file", path: "p.md" }, objective: "x", scenarios: "s.jsonl", budget: { max_usd: 1 } };
  assert.equal(parseGoal(JSON.stringify(base)).population, undefined);
  assert.equal(parseGoal(JSON.stringify({ ...base, population: true })).population, true);
  assert.throws(() => parseGoal(JSON.stringify({ ...base, population: "yes" })), /population must be true or false/);
});

test("with compose on too, a round gets one extra candidate, not two", async () => {
  const both = on({ compose: true });
  const repo = freshRepo();
  const m = world();
  // Round 1: the pool is empty, so compose writes the extra candidate as before.
  const first = await round(both, repo, m);
  assert.equal(m.seen.filter(isCompose).length, 1);
  assert.equal(first.scored.scores.candidates.length, 3);
  assert.equal(first.scored.compose?.candidate?.id, "composed");

  // Round 2 from a pool with both half-fixes: the pool's candidate takes the slot and the composer isn't called.
  const repo2 = freshRepo();
  repo2.state.pool = [entry("r1-candidate-1", 1, "Rule A.", ["t1", "t2", "t3", "t4"]), entry("r1-candidate-2", 1, "Rule B.", ["t5", "t6", "t7", "t8"])];
  const m2 = world(["Rule C.", "Rule D."]);
  const second = await round(both, repo2, m2);
  assert.equal(m2.seen.filter(isCompose).length, 0);
  assert.deepEqual(second.scored.scores.candidates.map((c) => c.id), ["candidate-1", "candidate-2", POOL_ID]);
  assert.equal(second.scored.compose?.candidate, null);
  assert.equal(second.scored.compose?.skipped, "the pool already added this round's extra candidate");
  assert.equal(second.record?.outcome, "merged");
});
