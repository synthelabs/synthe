import assert from "node:assert/strict";
import { test } from "node:test";
import { calibrate } from "../src/cli/calibrate.ts";
import { calibrateJudge, judgeAgreement, type JudgedPair } from "../src/cli/calibrate-judge.ts";
import { sameModelNote } from "../src/core/model-notes.ts";
import { runDecide } from "../src/loop/decide.ts";
import { GUARD_EXAMPLE, LENGTH_WARN, NO_LENGTH_PREFERENCE, lengthLines, lengthShift } from "../src/loop/length.ts";
import { JUDGE_PROMPT_VERSION, duelSystem, measureNoise, runScore, scoreKey } from "../src/loop/score.ts";
import { DEFAULTS, type Scenario } from "../src/core/goal.ts";
import type { Ask, Model } from "../src/model/client.ts";
import { MemoryRepo, goal, heldRows, scenarios, scored, trainRows } from "./helpers.ts";

const LONG = "x".repeat(2000);

// The agent answers "short" under the old prompt and 2000 characters under the new one; the judge always picks the
// new prompt's reply.
function lengthModel(): Model & { seen: Ask[] } {
  const seen: Ask[] = [];
  return {
    seen,
    async ask(a) {
      seen.push(a);
      if (a.schema) {
        const better = /<reply_a>\nx/.test(a.user) ? "A" : "B";
        return { text: JSON.stringify({ better, a_guardrail_ok: true, b_guardrail_ok: true }), costUsd: 0.001 };
      }
      return { text: a.system === "Old" ? "short" : LONG, costUsd: 0.001 };
    },
  };
}

test("length is recorded from the full replies, before the clip, and only on training rows", async () => {
  const m = lengthModel();
  const { scores } = await runScore(goal(), "Old", [{ id: "c1", text: "New" }], scenarios, m);
  const [c] = scores.candidates;
  assert.ok(c.holdout, "the candidate reached the held-back cases");
  for (const r of c.train) {
    assert.equal(r.chars, 2000);
    assert.equal(r.currentChars, 5);
    assert.equal(r.reply!.length, 800, "kept text is still clipped");
  }
  for (const r of c.holdout!) assert.deepEqual([r.chars, r.currentChars, r.reply], [undefined, undefined, undefined], "held-back rows carry nothing about their replies");
  assert.deepEqual(lengthShift(c.train), { before: 5, after: 2000 });
});

test("the duel prompt tells the judge not to prefer length, and noise still measures", async () => {
  const m = lengthModel();
  await runScore(goal(), "Old", [{ id: "c1", text: "New" }], scenarios, m);
  const duels = m.seen.filter((a) => a.schema);
  assert.ok(duels.length > 0);
  for (const a of duels) assert.ok(a.user.includes(NO_LENGTH_PREFERENCE));
  const noise = await measureNoise(goal(), "Old", scenarios, lengthModel());
  assert.equal(noise.cases, scenarios.filter((s) => s.split === "train").length);
  assert.ok(noise.costUsd! > 0);
});

test("scoreKey changes with the judge prompt version, so cached scores are measured again", async () => {
  const held = scenarios.filter((s) => s.split === "holdout");
  const now = scoreKey(goal(), "Old", held);
  assert.equal(now, scoreKey(goal(), "Old", held, JUDGE_PROMPT_VERSION));
  const before = scoreKey(goal(), "Old", held, JUDGE_PROMPT_VERSION - 1);
  assert.notEqual(now, before);
  const cached = (key: string) => runScore(goal(), "Old", [{ id: "c1", text: "New" }], scenarios, lengthModel(), null, Math.random, [], null, { key, pct: 77 });
  assert.equal((await cached(now)).scores.scorePct, 77, "a score measured with this judge prompt is reused");
  assert.notEqual((await cached(before)).scores.scorePct, 77, "a score measured with an older judge prompt is not");
});

const withLengths = (chars: number, currentChars: number) => trainRows(60).map((r) => ({ ...r, chars, currentChars }));
async function merged(chars: number, currentChars: number) {
  const repo = new MemoryRepo("Old prompt.");
  const s = scored("Old prompt.", 50, 50, 60, 55);
  s.candidates[0].train = withLengths(chars, currentChars);
  const r = await runDecide(goal(), repo, { candidates: [{ id: "c1", text: "Better prompt." }], scores: s, costUsd: 0.1 });
  assert.equal(r?.outcome, "merged");
  return { pr: repo.prs[0].body, report: repo.issue, record: repo.state.rounds[0] };
}

test("a reply that grew past the threshold gets the length line and a warning with the next step", async () => {
  const { pr, report, record } = await merged(866, 610);
  assert.deepEqual(record.replyLength, { before: 610, after: 866 });
  for (const text of [pr, report]) {
    assert.match(text, /Replies got 42% longer \(median 610 → 866 characters\)\./);
    assert.match(text, new RegExp(`Warning:.*add a guard such as "${GUARD_EXAMPLE}" to \`counter_checks\` in \`synthe.json\``));
  }
  assert.equal(LENGTH_WARN, 0.3);
});

test("a modest change shows the length line and no warning; no measurement shows nothing", async () => {
  const small = await merged(700, 610);
  assert.match(small.pr, /Replies got 15% longer \(median 610 → 700 characters\)\./);
  assert.doesNotMatch(small.pr + small.report, /Warning:/);
  const exactly = await merged(793, 610); // 30% on the nose is not above the threshold
  assert.doesNotMatch(exactly.pr, /Warning:/);
  const shorter = lengthLines({ before: 600, after: 450 });
  assert.deepEqual(shorter, ["Replies got 25% shorter (median 600 → 450 characters)."]);
  assert.deepEqual(lengthLines({ before: 600, after: 601 }), ["Replies stayed about the same length (median 600 → 601 characters)."]);
  const none = await (async () => {
    const repo = new MemoryRepo("Old prompt.");
    await runDecide(goal(), repo, { candidates: [{ id: "c1", text: "Better prompt." }], scores: scored("Old prompt.", 50, 50, 60, 55), costUsd: 0.1 });
    return repo.prs[0].body + repo.issue;
  })();
  assert.doesNotMatch(none, /Replies (got|stayed)/);
});

test("the length warning never blocks a merge", async () => {
  const { record } = await merged(5000, 100);
  assert.equal(record.outcome, "merged");
});

test("a writer that is also the judge gets one line saying why a separate judge is safer", () => {
  assert.equal(sameModelNote(DEFAULTS.models), null);
  const note = sameModelNote({ ...DEFAULTS.models, judge: DEFAULTS.models.writer });
  assert.match(note!, /writer and judge are both claude-sonnet-5-5\. A separate judge model is safer.*favour replies like its own/);
  assert.ok(!note!.includes("\n"));
});

// --- calibrate --judge ---

const cases: Scenario[] = [
  { id: "h0", input: "HIDDEN question", expected: "x", split: "holdout" },
  ...Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, input: `question ${i}`, expected: "a good answer", split: "train" as const })),
];

// The agent is medium under the current prompt, long when asked for detail, short when asked to be brief. The judge
// picks the longer reply, or the shorter one.
function judgeModel(picks: "longer" | "shorter"): Model & { asks: Ask[] } {
  const asks: Ask[] = [];
  return {
    asks,
    async ask(a) {
      asks.push(a);
      if (!a.schema) return { text: a.system!.includes("more detail") ? "d".repeat(300) : a.system!.includes("briefly") ? "b".repeat(40) : "c".repeat(100), costUsd: 0.001 };
      const [ra, rb] = [/<reply_a>\n([^]*?)\n<\/reply_a>/.exec(a.user)![1], /<reply_b>\n([^]*?)\n<\/reply_b>/.exec(a.user)![1]];
      const better = (ra.length > rb.length) === (picks === "longer") ? "A" : "B";
      return { text: JSON.stringify({ better }), costUsd: 0.001 };
    },
  };
}

// The team always prefers the shorter reply, reading the two replies from what was shown.
const shorterTeam = (answerWith: (a: string, b: string) => string = (a, b) => (a.length < b.length ? "a" : "b")) => {
  const said: string[] = [];
  let a = "", b = "", questions = 0;
  return {
    said,
    get questions() { return questions; },
    say(t: string) { said.push(t); const m = t.match(/^ {3}Reply ([AB]): "(.*)"$/); if (m) (m[1] === "A" ? (a = m[2]) : (b = m[2])); },
    async ask() { questions++; return answerWith(a, b); },
  };
};

test("calibrate --judge compares the judge with the team in both orders and measures the lean toward longer replies", async () => {
  const m = judgeModel("longer");
  const t = shorterTeam();
  const out = await calibrateJudge(t, goal(), "Prompt", cases, m, () => 0.7);
  const text = t.said.join("\n");
  assert.equal(t.questions, 6);
  assert.equal(m.asks.filter((a) => a.schema).length, 12, "6 pairs, each judged in both orders");
  assert.ok(m.asks.every((a) => !a.user.includes("HIDDEN") && !a.system?.includes("HIDDEN")));
  assert.ok(m.asks.filter((a) => a.schema).every((a) => a.user.includes(NO_LENGTH_PREFERENCE) && a.user.includes("a good answer")));
  // The same judge as scoring: its static instructions are scoring's own duel system prompt.
  assert.ok(m.asks.filter((a) => a.schema).every((a) => a.system === duelSystem(goal())));
  assert.deepEqual([out!.asked, out!.agreed, out!.flipped], [6, 0, 0]);
  assert.deepEqual(out!.longer, { picked: 12, total: 12 });
  assert.match(text, /Agreement: the judge picked the same reply as you, in both orders, on 0 of 6 pairs \(0%\)\. Reading: disagrees with you\./);
  assert.match(text, /Length: in 12 of 12 judgements on pairs where you didn't prefer the longer reply, the judge picked the longer one\. Reading: leans toward longer replies\. Add a guard such as "Answers the question without padding" to counter_checks/);
  assert.match(text, /Order: the judge changed its answer when the reply order flipped on 0 of 6 pairs\./);
});

test("calibrate --judge reads a judge that agrees with the team as matching, with no pull toward length", async () => {
  const t = shorterTeam();
  const out = await calibrateJudge(t, goal(), "Prompt", cases, judgeModel("shorter"), () => 0.2);
  assert.deepEqual([out!.agreed, out!.asked, out!.longer.picked, out!.longer.total], [6, 6, 0, 12]);
  const text = t.said.join("\n");
  assert.match(text, /on 6 of 6 pairs \(100%\)\. Reading: matches you well\./);
  assert.match(text, /Reading: no pull toward longer replies in this sample\./);
  assert.doesNotMatch(text, /Add a guard/);
});

test("calibrate --judge counts skips as unasked and a team that picks the longer reply as no length evidence", async () => {
  const skipped = await calibrateJudge(shorterTeam(() => ""), goal(), "Prompt", cases, judgeModel("longer"), () => 0.7);
  assert.equal(skipped!.asked, 0);
  const t = shorterTeam((a, b) => (a.length > b.length ? "a" : "b"));
  const out = await calibrateJudge(t, goal(), "Prompt", cases, judgeModel("longer"), () => 0.7);
  assert.deepEqual([out!.agreed, out!.longer.total], [6, 0]);
  assert.match(t.said.join("\n"), /Length: not enough answers from you where the longer reply wasn't your pick/);
});

test("judgeAgreement counts a pair that changed with the order as flipped and not agreed", () => {
  const pair = (longer: "current" | "variant") => ({ input: "q", current: "c", variant: "v", longer });
  const rows: JudgedPair[] = [
    { pair: pair("variant"), team: "current", judge: ["current", "current"] },
    { pair: pair("variant"), team: "current", judge: ["variant", "current"] },
    { pair: pair("current"), team: "same", judge: ["same", "same"] },
    { pair: pair("current"), team: "current", judge: ["current", null] },
    { pair: pair("variant"), team: null, judge: ["variant", "variant"] },
  ];
  const r = judgeAgreement(rows);
  assert.deepEqual([r.asked, r.agreed, r.flipped], [4, 2, 2]);
  // Pairs where the team didn't pick the longer reply: rows 1, 2 and 3. The judge picked it in 1 of 6 judgements.
  assert.deepEqual(r.longer, { picked: 1, total: 6 });
  assert.equal(r.agreement, "unsure");
  assert.equal(r.length, "no pull toward longer replies");
  assert.equal(judgeAgreement(rows.slice(0, 2)).agreement, "too few replies to judge");
});

test("with too few differing replies, calibrate --judge says so and asks nothing", async () => {
  const m: Model = { async ask() { return { text: "same length", costUsd: 0.001 }; } };
  const t = shorterTeam();
  assert.equal(await calibrateJudge(t, goal(), "Prompt", cases, m), null);
  assert.equal(t.questions, 0);
  assert.match(t.said.join("\n"), /Only 0 of your test cases gave two replies different enough in length/);
});

test("default calibrate never asks about reply pairs or calls the duel judge", async () => {
  const asks: Ask[] = [];
  const m: Model = { async ask(a) {
    asks.push(a);
    return a.schema ? { text: JSON.stringify({ results: [{ check: 1, applies: true, passes: true }] }), costUsd: 0.001 } : { text: "reply", costUsd: 0.001 };
  } };
  const said: string[] = [];
  const prompts: string[] = [];
  await calibrate({ say: (t) => said.push(t), async ask(q) { prompts.push(q); return "y"; } }, goal({ checks: ["Be clear"] }), "Prompt", cases, m);
  assert.ok(asks.every((a) => !a.user.includes("Compare two replies") && !a.system?.includes("Compare two replies")));
  assert.ok(prompts.every((q) => !q.includes("Which reply is better")));
  assert.doesNotMatch(said.join("\n"), /Reply A|calibrate --judge/);
});
