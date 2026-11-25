import { test } from "node:test";
import assert from "node:assert/strict";
import type { Attack, Goal, Scenario } from "../src/core/goal.ts";
import { costUsd } from "../src/core/cost.ts";
import { judgeRound } from "../src/core/merge-rule.ts";
import { runScore } from "../src/loop/score.ts";
import {
  callBoundUsd, fakeDisk, fakeDurableStore, JournalReplaced, journalSpend, openJournal, roundSpend, runScoreResumable, scoreBinding, settleJournal,
  spendDecision, type FakeDisk, type ScoreInputs,
} from "../src/loop/score-journal.ts";
import type { Ask, Model, Reply } from "../src/model/client.ts";
import { goal } from "./helpers.ts";

// The score journal (prototype): a score step that stops partway resumes on a new runner from the calls it already
// finished. Every test uses a fake provider and a fake durable store; nothing reaches a real API.

class Killed extends Error {}
const tick = () => new Promise<void>((r) => setImmediate(r));
const bytes = (a: Ask) => Buffer.byteLength(`${a.system ?? ""}${a.user}${JSON.stringify(a.schema ?? "")}`, "utf8");
const keyOf = (a: Ask) => JSON.stringify([a.model, a.system ?? null, a.user, a.maxTokens, a.schema ?? null]);

// What the fake provider did, shared by every attempt at one round: each request it accepted and what it billed.
interface Ledger { calls: Ask[]; billedUsd: number }
const ledger = (): Ledger => ({ calls: [], billedUsd: 0 });
const timesCalled = (l: Ledger) => {
  const n = new Map<string, number>();
  for (const a of l.calls) n.set(keyOf(a), (n.get(keyOf(a)) ?? 0) + 1);
  return n;
};
// The machine a runner lives on. When it dies, its calls in flight lose their replies and its store stops.
interface World { dead: boolean }

type Result = "win" | "loss" | "tie";
// The agent quotes its prompt; the judge looks each prompt up in a table; every check applies and passes. The cost
// is the real price of a plausible token count, so it always sits under the journal's upper bound for the call.
function answer(a: Ask, table: Record<string, (id: string) => Result>): Reply {
  const cost = costUsd(a.model, { input_tokens: Math.ceil(bytes(a) / 4), output_tokens: 20 });
  const schema = JSON.stringify(a.schema ?? {});
  if (schema.includes('"better"')) {
    const id = /Situation: q-(\w+)/.exec(a.user)![1];
    const who = (tag: string) => new RegExp(`<${tag}>\\n(\\S+) says`).exec(a.user)![1];
    const challenger = who("reply_a") !== "Base" ? "reply_a" : "reply_b";
    const result = table[who(challenger)]?.(id) ?? "tie";
    const better = result === "tie" ? "tie" : (result === "win") === (challenger === "reply_a") ? "A" : "B";
    return { text: JSON.stringify({ better, a_guardrail_ok: true, b_guardrail_ok: true }), costUsd: cost };
  }
  if (schema.includes('"breaks"')) return { text: JSON.stringify({ breaks: false, guardrail: "", quote: "" }), costUsd: cost };
  if (schema.includes('"results"')) {
    const count = (a.user.split("The team's checks:")[1].match(/^\d+\. /gm) ?? []).length;
    return { text: JSON.stringify({ results: Array.from({ length: count }, (_, i) => ({ check: i + 1, applies: true, passes: true })) }), costUsd: cost };
  }
  return { text: `${a.system} says ${a.user}`, costUsd: cost };
}

// dieAt: the machine dies while the provider answers its n-th call of this attempt. That call and every call
// already sent are billed, and their replies are lost. Nothing is sent after the death.
function provider(table: Record<string, (id: string) => Result>, l: Ledger, world: World = { dead: false }, dieAt?: number): Model {
  let mine = 0;
  return {
    async ask(a) {
      if (world.dead) throw new Killed("the runner is gone");
      l.calls.push(a);
      const out = answer(a, table);
      l.billedUsd += out.costUsd ?? 0;
      const n = ++mine;
      await tick();
      if (dieAt !== undefined && n >= dieAt) world.dead = true;
      if (world.dead) throw new Killed("the runner died with this call in flight");
      return out;
    },
  };
}
// A stop between calls (a cancelled workflow): calls in flight finish and are recorded, and no new call starts.
function cancelAfter(model: Model, n: number): Model {
  let started = 0;
  return { async ask(a) { if (++started > n) throw new Killed("cancelled"); return model.ask(a); } };
}
// The store on a machine: it stops with the machine.
const storeOn = (disk: FakeDisk, world: World) => {
  const store = fakeDurableStore(disk);
  return {
    read: () => (world.dead ? Promise.reject(new Killed("the runner is gone")) : store.read()),
    write: (text: string, expected: string | null) => (world.dead ? Promise.reject(new Killed("the runner is gone")) : store.write(text, expected)),
  };
};
// A new runner shares nothing with the old one but the stored text.
const copyOf = (disk: FakeDisk): FakeDisk => JSON.parse(JSON.stringify(disk));

const cases = (train = 12, held = 6): Scenario[] => [
  ...Array.from({ length: train }, (_, i): Scenario => ({ id: `t${i}`, input: `q-t${i}`, expected: "good", split: "train" })),
  ...Array.from({ length: held }, (_, i): Scenario => ({ id: `h${i}`, input: `q-h${i}`, expected: "good", split: "holdout" })),
];
const attacks: Attack[] = [{ id: "a0", input: "q-a0", must: "Refuses." }, { id: "a1", input: "q-a1", must: "Refuses." }];
const table = { Winner: (): Result => "win", Loser: (): Result => "loss" };
const inputs = (over: Partial<ScoreInputs> = {}): ScoreInputs => ({
  round: 3, goal: goal({ checks: ["Answers the question.", "Is polite."] }), baseline: "Base",
  candidates: [{ id: "winner", text: "Winner" }, { id: "loser", text: "Loser" }], scenarios: cases(), attacks, ...over,
});

type Scored = Awaited<ReturnType<typeof runScore>>;
// One attempt at the score step on one runner. cancelAt stops it between calls; world and dieAt kill the machine.
async function attempt(disk: FakeDisk, i: ScoreInputs, l: Ledger, o: { cancelAt?: number; dieAt?: number; seed?: number } = {}) {
  const world: World = { dead: false };
  const journal = await openJournal(storeOn(disk, world), i, { seed: o.seed });
  const through = journal.model(provider(table, l, world, o.dieAt));
  const model = o.cancelAt === undefined ? through : cancelAfter(through, o.cancelAt);
  let scored: Scored | null = null;
  try {
    scored = await runScore(i.goal, i.baseline, i.candidates, i.scenarios, model, i.prior ?? null, journal.random, i.attacks ?? [], i.attackCache ?? null, i.scoreCache ?? null, i.stopEarly ?? true);
    await journal.seal();
  } catch (e) {
    if (!(e instanceof Killed)) throw e;
    await journal.idle();
  }
  return { scored, journal };
}
const verdictOf = (s: Scored, g: Goal) => { const v = judgeRound(s.scores, g, null); return { action: v.action, reasons: v.reasons }; };

test("a score step cancelled twice resumes on fresh runners: same scores, verdict and spend, and no call is made twice", async () => {
  const straightLedger = ledger();
  const straight = await attempt(fakeDisk(), inputs(), straightLedger, { seed: 11 });
  assert.ok(straight.scored);
  assert.equal(verdictOf(straight.scored, inputs().goal).action, "merge");
  const total = straightLedger.calls.length;
  assert.ok(total > 80, `the round is big enough to cut twice (${total} calls)`);

  const l = ledger();
  let disk = fakeDisk();
  const first = await attempt(disk, inputs(), l, { seed: 11, cancelAt: 25 });
  assert.equal(first.scored, null);
  const afterFirst = l.calls.length;
  assert.ok(afterFirst >= 25 && afterFirst < total);

  disk = copyOf(disk);
  const second = await attempt(disk, inputs(), l, { cancelAt: 60 });
  assert.equal(second.scored, null);
  assert.equal(second.journal.resumed, true);
  assert.equal(second.journal.replayed(), afterFirst, "everything the first runner finished is replayed");
  const afterSecond = l.calls.length;
  assert.ok(afterSecond > afterFirst && afterSecond < total);

  disk = copyOf(disk);
  const third = await attempt(disk, inputs(), l);
  assert.ok(third.scored);
  assert.equal(third.journal.replayed(), afterSecond);
  assert.equal(third.journal.sent(), total - afterSecond);

  assert.deepEqual(third.scored.scores, straight.scored.scores);
  assert.deepEqual(verdictOf(third.scored, inputs().goal), verdictOf(straight.scored, inputs().goal));
  // Zero repeats: over three runners the provider saw exactly the calls one uninterrupted run makes.
  assert.equal(l.calls.length, total);
  assert.deepEqual([...timesCalled(l)].sort(), [...timesCalled(straightLedger)].sort());
  // Spend is counted once: the journal's total is the uninterrupted run's, and it is what the provider billed.
  const spend = third.journal.spend(), plain = straight.journal.spend();
  assert.deepEqual(spend, plain);
  assert.equal(spend.boundUsd, 0);
  assert.equal(spend.calls, total);
  assert.ok(Math.abs(spend.chargeUsd! - l.billedUsd) < 1e-12);
});

test("wherever a round is cancelled, and however often, the resumed scores equal the uninterrupted ones", async () => {
  const straightLedger = ledger();
  const straight = await attempt(fakeDisk(), inputs(), straightLedger, { seed: 5 });
  const total = straightLedger.calls.length;
  let state = 20241124;
  const rand = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let trial = 0; trial < 12; trial++) {
    const l = ledger();
    let disk = fakeDisk();
    const cuts = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => 1 + Math.floor(rand() * (total - 1))).sort((a, b) => a - b);
    for (const [k, cut] of cuts.entries()) {
      await attempt(disk, inputs(), l, { cancelAt: cut, ...(k === 0 ? { seed: 5 } : {}) });
      disk = copyOf(disk);
    }
    const last = await attempt(disk, inputs(), l);
    assert.deepEqual(last.scored?.scores, straight.scored?.scores, `cuts at ${cuts.join(", ")}`);
    assert.equal(l.calls.length, total, `cuts at ${cuts.join(", ")}: no call repeated`);
    assert.deepEqual(last.journal.spend(), straight.journal.spend(), `cuts at ${cuts.join(", ")}`);
  }
});

test("a runner that dies with calls in flight: recorded calls are not repeated, lost ones are charged at an upper bound", async () => {
  const straightLedger = ledger();
  const straight = await attempt(fakeDisk(), inputs(), straightLedger, { seed: 11 });

  const l = ledger();
  let disk = fakeDisk();
  const dead = await attempt(disk, inputs(), l, { seed: 11, dieAt: 40 });
  assert.equal(dead.scored, null);
  const sentBeforeDeath = l.calls.length;
  const billedAtDeath = l.billedUsd;

  disk = copyOf(disk);
  // What the decide step could read after the death, with no runner left: not $0.
  const left = (await journalSpend(fakeDurableStore(disk)))!;
  const lost = left.calls - left.finished;
  // Six workers, each with at most two calls at once (a reply checked against the checks beside the current one).
  assert.ok(lost >= 1 && lost <= 12, `between one and twelve calls were in flight (${lost})`);
  assert.equal(left.calls, sentBeforeDeath, "every call that was sent has a record written before it went out");
  assert.equal(left.unbounded, 0);
  assert.ok(left.boundUsd > 0);
  assert.ok(left.chargeUsd! >= billedAtDeath, "the accounted spend is never below what the provider billed");
  assert.equal(left.sealed, false);

  const resumed = await attempt(disk, inputs(), l);
  assert.ok(resumed.scored);
  assert.deepEqual(resumed.scored.scores, straight.scored!.scores);
  assert.deepEqual(verdictOf(resumed.scored, inputs().goal), verdictOf(straight.scored!, inputs().goal));
  // The calls whose replies were recorded went out once. Only the calls that died in flight went out again.
  const repeats = [...timesCalled(l).values()].filter((n) => n > 1);
  assert.equal(repeats.length, lost);
  assert.ok(repeats.every((n) => n === 2));
  assert.equal(resumed.journal.replayed(), sentBeforeDeath - lost);
  const spend = resumed.journal.spend();
  assert.equal(spend.calls, straightLedger.calls.length + lost);
  assert.ok(spend.chargeUsd! >= l.billedUsd, "still never below what the provider billed");
  assert.ok(Math.abs(spend.knownUsd! - (l.billedUsd - (billedAtDeath - left.knownUsd!))) < 1e-12, "known spend is each recorded reply's cost, once");
});

test("a checkpoint is refused when any input it was measured for changes, and its spend is kept", async () => {
  const base = inputs();
  const changed: [string, ScoreInputs, RegExp][] = [
    ["a test case", inputs({ scenarios: cases().map((s) => (s.id === "t3" ? { ...s, expected: "better" } : s)) }), /test cases/],
    ["a candidate", inputs({ candidates: [{ id: "winner", text: "Winner" }, { id: "loser", text: "Loser2" }] }), /proposed changes/],
    ["the current prompt", inputs({ baseline: "Base2" }), /current prompt/],
    ["a check", inputs({ goal: goal({ checks: ["Answers the question.", "Is kind."] }) }), /goal settings/],
    ["the judge model", inputs({ goal: goal({ checks: base.goal.checks, models: { ...base.goal.models, judge: "claude-sonnet-5-5" } }) }), /goal settings/],
    ["the merge rule", inputs({ goal: goal({ checks: base.goal.checks, merge_rule: { ...base.goal.merge_rule, max_p: 0.01 } }) }), /goal settings/],
    ["the attack set", inputs({ attacks: [attacks[0]] }), /attack set/],
    ["the round", inputs({ round: 4 }), /round/],
  ];
  for (const [what, next, why] of changed) {
    const l = ledger();
    let disk = fakeDisk();
    const first = await attempt(disk, base, l, { seed: 11, cancelAt: 30 });
    const paid = first.journal.spend();
    const before = l.calls.length;
    disk = copyOf(disk);
    const fresh = ledger();
    const second = await attempt(disk, next, fresh);
    assert.equal(second.journal.resumed, false, what);
    assert.match(second.journal.refused ?? "", why, what);
    assert.equal(second.journal.replayed(), 0, `${what}: nothing is reused`);
    const spend = second.journal.spend();
    assert.equal(spend.calls, before + fresh.calls.length, `${what}: the refused checkpoint's calls still count`);
    assert.ok(Math.abs(spend.chargeUsd! - (paid.chargeUsd! + fresh.billedUsd)) < 1e-12, `${what}: its spend is carried, once`);
  }
});

test("a raised budget or round limit does not discard a checkpoint, and a new one is refused the old one's results", () => {
  const base = inputs();
  const same = (over: Partial<Goal>) => scoreBinding({ ...base, goal: { ...base.goal, ...over } }).hash;
  assert.equal(same({ budget: { max_usd: 50 } }), scoreBinding(base).hash);
  assert.equal(same({ budget: { max_usd: 3, max_calls: 900 } }), scoreBinding(base).hash);
  assert.equal(same({ merge_rule: { ...base.goal.merge_rule, max_rounds: 40, stall_rounds: 9, mode: "propose" } }), scoreBinding(base).hash);
  assert.notEqual(same({ merge_rule: { ...base.goal.merge_rule, min_improvement: 5 } }), scoreBinding(base).hash);
  assert.notEqual(same({ guardrails: ["No lies", "No refunds"] }), scoreBinding(base).hash);
  // With run_alpha set, the round limit changes the held-back limit (run-alpha.ts), so it counts then.
  const alpha = (max_rounds: number) => same({ merge_rule: { ...base.goal.merge_rule, run_alpha: 0.05, max_rounds } });
  assert.notEqual(alpha(12), alpha(40));
  assert.equal(same({ merge_rule: { ...base.goal.merge_rule, run_alpha: 0.05, stall_rounds: 9 } }), alpha(base.goal.merge_rule.max_rounds));
  assert.notEqual(scoreBinding({ ...base, stopEarly: false }).hash, scoreBinding(base).hash);
  assert.notEqual(scoreBinding({ ...base, prior: "Older" }).hash, scoreBinding(base).hash);
  assert.notEqual(scoreBinding({ ...base, scoreCache: { key: "k", pct: 80 } }).hash, scoreBinding(base).hash);
});

test("a lost call with no price pauses the round before it spends more, and spendDecision pauses on an unknown known spend", async () => {
  const unpriced = inputs({ goal: goal({ checks: ["Answers the question."], models: { writer: "claude-sonnet-5-5", runner: "mystery-model", judge: "claude-haiku-5-5", checker: "claude-sonnet-5-5" } }) });
  const l = ledger();
  let disk = fakeDisk();
  await attempt(disk, unpriced, l, { seed: 2, dieAt: 4 });
  disk = copyOf(disk);
  const spend = (await journalSpend(fakeDurableStore(disk)))!;
  assert.ok(spend.unbounded > 0);
  assert.equal(spend.chargeUsd, null);
  assert.equal(spendDecision(spend, 100).action, "pause");

  const before = l.calls.length;
  const out = await runScoreResumable(fakeDurableStore(disk), { ...unpriced, model: provider(table, l), budgetLeftUsd: 100 });
  assert.ok("paused" in out);
  assert.equal(out.paused.action, "pause");
  assert.match(out.paused.why, /could not be measured/);
  assert.equal(l.calls.length, before, "a paused round sends nothing");

  // A reply that came back with no cost is as unknown as a lost call.
  const known = spendDecision({ knownUsd: null, boundUsd: 0, unbounded: 0, calls: 3, chargeUsd: null }, 100);
  assert.equal(known.action, "pause");
});

test("lost calls that fit the remaining budget let the round go on; ones that may have used it up stop it", async () => {
  const l = ledger();
  let disk = fakeDisk();
  await attempt(disk, inputs(), l, { seed: 11, dieAt: 40 });
  disk = copyOf(disk);
  const spend = (await journalSpend(fakeDurableStore(disk)))!;

  const tight = copyOf(disk);
  const before = l.calls.length;
  const stopped = await runScoreResumable(fakeDurableStore(tight), { ...inputs(), model: provider(table, l), budgetLeftUsd: spend.chargeUsd! });
  assert.ok("paused" in stopped);
  assert.equal(stopped.paused.action, "stop");
  assert.match(stopped.paused.why, /budget/);
  assert.equal(l.calls.length, before);

  const done = await runScoreResumable(fakeDurableStore(disk), { ...inputs(), model: provider(table, l), budgetLeftUsd: 3 });
  assert.ok("scored" in done);
  assert.equal(done.resume.resumed, true);
  assert.ok(done.resume.replayed > 0);
  // The round's cost and calls are the journal's: known spend once, plus the bound for the lost calls.
  assert.equal(done.scored.costUsd, done.spend.chargeUsd);
  assert.equal(done.scored.calls, done.spend.calls);
  assert.ok(done.scored.costUsd! >= l.billedUsd);
  assert.equal((await journalSpend(fakeDurableStore(disk)))!.sealed, true);
});

test("the upper bound for a call is never below its real price, and is unknown when the model has no price", () => {
  const ask: Ask = { model: "claude-haiku-5-5", system: "S".repeat(4000), user: "U".repeat(4000), maxTokens: 2000 };
  const worst = costUsd(ask.model, { input_tokens: 0, cache_creation_input_tokens: 8000, output_tokens: 2000 })!;
  assert.ok(callBoundUsd(ask)! >= worst);
  assert.equal(callBoundUsd({ ...ask, model: "mystery-model" }), null);
  const other = { kind: "openai-compatible" as const, base_url: "https://example.test/v1", prices: { "some-model": { input: 1, output: 4 } } };
  assert.ok(callBoundUsd({ ...ask, model: "some-model" }, other)! >= (8000 * 1 + 2000 * 4) / 1_000_000);
  assert.equal(callBoundUsd({ ...ask, model: "unlisted" }, other), null);
});

test("a round that finished scoring replays in full on a new runner with no model call", async () => {
  const l = ledger();
  let disk = fakeDisk();
  const first = await attempt(disk, inputs(), l, { seed: 11 });
  const total = l.calls.length;
  disk = copyOf(disk);
  const again = await attempt(disk, inputs(), l);
  assert.equal(l.calls.length, total);
  assert.equal(again.journal.sent(), 0);
  assert.deepEqual(again.scored!.scores, first.scored!.scores);
  assert.deepEqual(again.journal.spend(), first.journal.spend());
});

test("the next round starts clean once decide has recorded the spend, and carries it when decide has not", async () => {
  const l = ledger();
  let disk = fakeDisk();
  const first = await attempt(disk, inputs(), l, { seed: 11 });
  const paid = first.journal.spend();

  const unsettled = copyOf(disk);
  const carried = await openJournal(fakeDurableStore(unsettled), inputs({ round: 4 }));
  assert.equal(carried.spend().calls, paid.calls);
  assert.equal(carried.spend().chargeUsd, paid.chargeUsd);

  disk = copyOf(disk);
  await settleJournal(fakeDurableStore(disk), (await journalSpend(fakeDurableStore(disk)))!.version);
  const clean = await openJournal(fakeDurableStore(disk), inputs({ round: 4 }));
  assert.equal(clean.refused, null);
  assert.deepEqual(clean.spend(), { knownUsd: 0, boundUsd: 0, unbounded: 0, calls: 0, chargeUsd: 0 });
});

test("two runners on one journal lose no record: both spends count and the first stored result is the one reused", async () => {
  const disk = fakeDisk();
  const l = ledger();
  const a = await openJournal(fakeDurableStore(disk), inputs(), { seed: 1, writer: "a" });
  const b = await openJournal(fakeDurableStore(disk), inputs(), { writer: "b" });
  // Each runner's provider marks its replies, so the replay shows whose reply it reused.
  const tagged = (tag: string): Model => { const p = provider(table, l); return { async ask(q) { const r = await p.ask(q); return { ...r, text: `${r.text} (${tag})` }; } }; };
  const ma = a.model(tagged("a")), mb = b.model(tagged("b"));
  const ask = (n: number): Ask => ({ model: "claude-haiku-5-5", system: "Base", user: `q-x${n}`, maxTokens: 2000 });
  const replies = await Promise.all([ma.ask(ask(1)), mb.ask(ask(2)), ma.ask(ask(3)), mb.ask(ask(1)), mb.ask(ask(4))]);
  assert.deepEqual(replies.map((r) => r.text), ["Base says q-x1 (a)", "Base says q-x2 (b)", "Base says q-x3 (a)", "Base says q-x1 (b)", "Base says q-x4 (b)"]);
  assert.ok(disk.conflicts > 0, "the two writers did collide");

  const spend = (await journalSpend(fakeDurableStore(disk)))!;
  assert.equal(spend.calls, 5);
  assert.ok(Math.abs(spend.knownUsd! - l.billedUsd) < 1e-12, "the call both runners made is paid for twice and counted twice");
  assert.equal(spend.boundUsd, 0);

  const later = await openJournal(fakeDurableStore(copyOf(disk)), inputs());
  const untouched = ledger();
  const again = await later.model(provider(table, untouched)).ask(ask(1));
  const stored = JSON.parse(disk.text!).records as { t: string; id: string; reply?: { text: string } }[];
  const texts = new Map(stored.filter((r) => r.t === "done").map((r) => [r.id, r.reply!.text]));
  const firstStored = stored.find((r) => r.t === "ask" && texts.get(r.id)?.startsWith("Base says q-x1"));
  assert.equal(again.text, texts.get(firstStored!.id), "the reply of the call stored first");
  assert.equal(untouched.calls.length, 0);
});

test("a runner whose journal was replaced for other inputs stops instead of writing over it", async () => {
  const disk = fakeDisk();
  const l = ledger();
  const old = await openJournal(fakeDurableStore(disk), inputs(), { seed: 1 });
  const model = old.model(provider(table, l));
  await model.ask({ model: "claude-haiku-5-5", system: "Base", user: "q-x1", maxTokens: 2000 });
  await openJournal(fakeDurableStore(disk), inputs({ round: 4 }));
  await assert.rejects(model.ask({ model: "claude-haiku-5-5", system: "Base", user: "q-x2", maxTokens: 2000 }), JournalReplaced);
  assert.equal(l.calls.length, 1, "the call is not sent once the journal belongs to another round");
  const stored = JSON.parse(disk.text!);
  assert.equal(stored.parts.round, "4");
});

test("a journal that cannot be read is not trusted: its spend is unknown, so the round pauses", async () => {
  const disk = fakeDisk();
  disk.text = "{ not json";
  disk.version = 1;
  const journal = await openJournal(fakeDurableStore(disk), inputs());
  assert.match(journal.refused ?? "", /could not be read/);
  assert.equal(journal.spend().chargeUsd, null);
  assert.equal(spendDecision(journal.spend(), 100).action, "pause");
});

// What a round adds to the run's spend (prototype for the decide step; not wired in). Today a failed score step with
// $0.03 of known write spend adds $0 to the run and leaves spendUnknown false.
test("a failed score step: the known write cost and the journal's charge are both counted, once", async () => {
  const l = ledger();
  const disk = fakeDisk();
  await attempt(disk, inputs(), l, { seed: 11, dieAt: 40 });
  const left = (await journalSpend(fakeDurableStore(copyOf(disk))))!;
  const added = roundSpend({ writeRan: true, writeUsd: 0.03, scoreStarted: true, scoreFinished: false, scoreUsd: null, journal: left });
  assert.equal(added.action, "continue");
  assert.ok(Math.abs(added.addUsd! - (0.03 + left.chargeUsd!)) < 1e-12);
  assert.ok(added.addUsd! >= 0.03 + l.billedUsd - 1e-12, "never below what was billed");

  // Settled: the decide step already added it, so a second look adds only what is new.
  const again = roundSpend({ writeRan: true, writeUsd: 0.03, scoreStarted: true, scoreFinished: false, scoreUsd: null, journal: { ...left, settled: true } });
  assert.equal(again.addUsd, 0.03);
});

test("a failed score step with no record of its calls is unknown spend, not $0, so the run pauses", () => {
  const added = roundSpend({ writeRan: true, writeUsd: 0.03, scoreStarted: true, scoreFinished: false, scoreUsd: null, journal: null });
  assert.equal(added.addUsd, null);
  assert.equal(added.action, "pause");
  assert.match(added.why, /score step stopped/);
});

test("a round whose score step never started adds the write cost only; an unknown write cost pauses", () => {
  assert.deepEqual(roundSpend({ writeRan: true, writeUsd: 0.03, scoreStarted: false, scoreFinished: false, scoreUsd: null, journal: null }), { addUsd: 0.03, action: "continue", why: "" });
  assert.equal(roundSpend({ writeRan: true, writeUsd: null, scoreStarted: false, scoreFinished: false, scoreUsd: null, journal: null }).action, "pause");
  assert.equal(roundSpend({ writeRan: false, writeUsd: undefined, scoreStarted: false, scoreFinished: false, scoreUsd: null, journal: null }).addUsd, 0);
});

test("a finished round adds the write cost and the score cost; with a journal, the journal's charge is the score cost", () => {
  assert.equal(roundSpend({ writeRan: true, writeUsd: 0.03, scoreStarted: true, scoreFinished: true, scoreUsd: 0.2, journal: null }).addUsd, 0.03 + 0.2);
  const journal = { knownUsd: 0.18, boundUsd: 0.05, unbounded: 0, calls: 90, chargeUsd: 0.23, finished: 88, sealed: true, settled: false };
  assert.equal(roundSpend({ writeRan: true, writeUsd: 0.03, scoreStarted: true, scoreFinished: true, scoreUsd: 0.2, journal }).addUsd, 0.03 + 0.23);
  assert.equal(roundSpend({ writeRan: true, writeUsd: 0.03, scoreStarted: true, scoreFinished: true, scoreUsd: null, journal: null }).action, "pause");
});

// ---- Tests added after the mutation check (48 of 100 deliberate faults survived the first set). ----

// A stored journal written by hand, for the spend and parsing rules.
const docText = (o: { records?: unknown[]; carried?: Record<string, unknown>; v?: number; id?: string }) => JSON.stringify({
  v: o.v ?? 1, id: o.id ?? "j1", binding: "b", parts: {}, seed: 1,
  carried: o.carried ?? { knownUsd: 0, boundUsd: 0, unbounded: 0, calls: 0 }, records: o.records ?? [],
});
const diskWith = (text: string): FakeDisk => ({ text, version: 1, conflicts: 0 });
const ask = (id: string, bound: number | null = 0.5) => ({ t: "ask", id, key: `k-${id}`, model: "m", bound });
const done = (id: string, costUsd: unknown) => ({ t: "done", id, key: `k-${id}`, reply: { text: "x", ...(costUsd === undefined ? {} : { costUsd }) } });

test("spend from a stored journal: carried bound and unbounded calls count, a missing cost is unknown, the first reply for a call wins", async () => {
  const carried = await journalSpend(fakeDurableStore(diskWith(docText({ carried: { knownUsd: 0.1, boundUsd: 0.05, unbounded: 0, calls: 3 }, records: [ask("a"), done("a", 0.2), ask("b", 0.4)] }))));
  assert.equal(carried!.calls, 5);
  assert.ok(Math.abs(carried!.boundUsd - 0.45) < 1e-12);
  assert.ok(Math.abs(carried!.chargeUsd! - (0.1 + 0.2 + 0.05 + 0.4)) < 1e-12);

  const lost = await journalSpend(fakeDurableStore(diskWith(docText({ carried: { knownUsd: 0.1, boundUsd: 0, unbounded: 1, calls: 1 } }))));
  assert.equal(lost!.unbounded, 1);
  assert.equal(lost!.chargeUsd, null);
  assert.equal(spendDecision(lost!, 100).action, "pause");

  for (const bad of [undefined, null, "0.2"]) {
    const s = await journalSpend(fakeDurableStore(diskWith(docText({ records: [ask("a"), done("a", bad)] }))));
    assert.equal(s!.knownUsd, null, `cost ${String(bad)}`);
    assert.equal(s!.chargeUsd, null, `cost ${String(bad)}`);
  }

  const twice = await journalSpend(fakeDurableStore(diskWith(docText({ records: [ask("a"), done("a", 0.2), done("a", 0.9)] }))));
  assert.equal(twice!.knownUsd, 0.2);
  assert.equal(twice!.finished, 1);
});

test("the same costs give the same total in any order, even where float addition depends on order", async () => {
  const costs = [0.1, 0.2, 0.3, 1e-17, 7e-3];
  const recs = (order: number[]) => order.flatMap((i) => [ask(`c${i}`), done(`c${i}`, costs[i])]);
  const forward = await journalSpend(fakeDurableStore(diskWith(docText({ records: recs([0, 1, 2, 3, 4]) }))));
  const back = await journalSpend(fakeDurableStore(diskWith(docText({ records: recs([4, 3, 2, 1, 0]) }))));
  const mixed = await journalSpend(fakeDurableStore(diskWith(docText({ records: recs([2, 0, 4, 1, 3]) }))));
  assert.notEqual((0.1 + 0.2) + 0.3, (0.3 + 0.2) + 0.1, "this data does depend on order");
  assert.equal(forward!.knownUsd, back!.knownUsd);
  assert.equal(forward!.knownUsd, mixed!.knownUsd);
});

test("a stored journal that is the wrong version, has no record list, or holds a bad record is not trusted", async () => {
  const texts = [docText({ v: 2 }), JSON.stringify({ ...JSON.parse(docText({})), records: "none" }), docText({ records: [{ t: "ask", id: 7, key: "k" }] }), docText({ records: [{ t: "other" }] }), docText({ carried: { knownUsd: "0", boundUsd: 0, unbounded: 0, calls: 0 } })];
  for (const text of texts) {
    const journal = await openJournal(fakeDurableStore(diskWith(text)), inputs());
    assert.match(journal.refused ?? "", /could not be read/, text.slice(0, 80));
    assert.equal(journal.spend().chargeUsd, null);
    const s = await journalSpend(fakeDurableStore(diskWith(text)));
    assert.equal(s!.knownUsd, null);
    assert.equal(s!.chargeUsd, null);
  }
});

test("spendDecision pauses on any unknown part, and stops only when the charge reaches what is left", () => {
  const base = { knownUsd: 0.1, boundUsd: 0.1, unbounded: 0, calls: 2, chargeUsd: 0.2 };
  assert.equal(spendDecision({ ...base, unbounded: 1 }, 100).action, "pause");
  assert.equal(spendDecision({ ...base, knownUsd: null }, 100).action, "pause");
  assert.equal(spendDecision({ ...base, chargeUsd: null }, 100).action, "pause");
  assert.equal(spendDecision(base, 0.2).action, "stop");
  assert.equal(spendDecision(base, 0.2000001).action, "continue");
});

test("settling: twice writes one settle record; a store that always refuses the write reports false", async () => {
  const disk = fakeDisk();
  const j = await openJournal(fakeDurableStore(disk), inputs(), { seed: 1 });
  await j.seal();
  const counted = (await journalSpend(fakeDurableStore(disk)))!.version;
  assert.equal(await settleJournal(fakeDurableStore(disk), counted), true);
  assert.equal(await settleJournal(fakeDurableStore(disk), counted), true);
  assert.equal(JSON.parse(disk.text!).records.filter((r: { t: string }) => r.t === "settle").length, 1);
  assert.equal((await journalSpend(fakeDurableStore(disk)))!.settled, true);

  const fresh = fakeDisk();
  await openJournal(fakeDurableStore(fresh), inputs(), { seed: 1 });
  const refusing = { read: fakeDurableStore(fresh).read, write: async () => null };
  assert.equal(await settleJournal(refusing, (await journalSpend(fakeDurableStore(fresh)))!.version), false);
  assert.equal(await settleJournal(fakeDurableStore(fakeDisk()), "1"), false);
});

test("the same request sent twice in one run is sent twice, and a resumed run gets each reply back in order", async () => {
  let n = 0;
  const counting: Model = { async ask() { n++; return { text: `reply ${n}`, costUsd: 0.01 }; } };
  const disk = fakeDisk();
  const first = await openJournal(fakeDurableStore(disk), inputs(), { seed: 1 });
  const m1 = first.model(counting);
  const q: Ask = { model: "claude-haiku-5-5", system: "Base", user: "same question", maxTokens: 100 };
  assert.equal((await m1.ask(q)).text, "reply 1");
  assert.equal((await m1.ask(q)).text, "reply 2");
  assert.equal(n, 2);

  const again = await openJournal(fakeDurableStore(copyOf(disk)), inputs());
  const m2 = again.model(counting);
  assert.equal((await m2.ask(q)).text, "reply 1");
  assert.equal((await m2.ask(q)).text, "reply 2");
  assert.equal(n, 2, "both came back from the journal");
  assert.equal((await m2.ask(q)).text, "reply 3", "a third is new and is sent");
});

test("a recorded reply is reused only for exactly the same request", async () => {
  const q: Ask = { model: "claude-haiku-5-5", system: "Base", user: "q", maxTokens: 100, schema: { type: "object" } };
  const variants: [string, Ask][] = [
    ["model", { ...q, model: "claude-sonnet-5-5" }], ["system", { ...q, system: "Other" }], ["no system", { ...q, system: undefined }],
    ["user", { ...q, user: "q2" }], ["maxTokens", { ...q, maxTokens: 101 }], ["schema", { ...q, schema: { type: "array" } }],
    ["no schema", { ...q, schema: undefined }], ["allowCutOff", { ...q, allowCutOff: true }],
  ];
  for (const [what, v] of variants) {
    const l = ledger();
    const disk = fakeDisk();
    await (await openJournal(fakeDurableStore(disk), inputs(), { seed: 1 })).model(provider(table, l)).ask(q);
    await (await openJournal(fakeDurableStore(copyOf(disk)), inputs())).model(provider(table, l)).ask(v);
    assert.equal(l.calls.length, 2, `${what}: a different request is sent`);
  }
});

test("a caller that changes a reply it got does not change what the journal stored", async () => {
  const disk = fakeDisk();
  const l = ledger();
  const q = (u: string): Ask => ({ model: "claude-haiku-5-5", system: "Base", user: u, maxTokens: 100 });
  const j = await openJournal(fakeDurableStore(disk), inputs(), { seed: 1 });
  const m = j.model(provider(table, l));
  const sent = await m.ask(q("one"));
  sent.text = "changed after sending";
  await m.ask(q("two"));
  const r = await openJournal(fakeDurableStore(disk), inputs());
  const rm = r.model(provider(table, l));
  const replayed = await rm.ask(q("one"));
  assert.equal(replayed.text, "Base says one");
  replayed.text = "changed after replay";
  await rm.ask(q("three"));
  const stored = JSON.parse(disk.text!).records.filter((x: { t: string }) => x.t === "done").map((x: { reply: Reply }) => x.reply.text);
  assert.deepEqual(stored, ["Base says one", "Base says two", "Base says three"]);
});

test("a reply another runner recorded is replayed once this runner has read it", async () => {
  const disk = fakeDisk();
  const l = ledger();
  const a = await openJournal(fakeDurableStore(disk), inputs(), { seed: 1, writer: "a" });
  const b = await openJournal(fakeDurableStore(disk), inputs(), { writer: "b" });
  const q = (u: string): Ask => ({ model: "claude-haiku-5-5", system: "Base", user: u, maxTokens: 100 });
  await a.model(provider(table, l)).ask(q("x"));
  const mb = b.model(provider(table, l));
  await mb.ask(q("y")); // b's write meets a's records and reads them in
  assert.equal(l.calls.length, 2);
  assert.equal((await mb.ask(q("x"))).text, "Base says x");
  assert.equal(l.calls.length, 2, "x came from a's record");
  assert.equal(b.replayed(), 1);
});

test("a runner stops when the stored journal is a new one with the same inputs, or lost records it had written", async () => {
  const q = (u: string): Ask => ({ model: "claude-haiku-5-5", system: "Base", user: u, maxTokens: 100 });
  // Settled, then opened again for the same inputs: a new journal with a new id.
  const disk = fakeDisk();
  const l = ledger();
  const old = await openJournal(fakeDurableStore(disk), inputs(), { seed: 1 });
  const m = old.model(provider(table, l));
  await m.ask(q("x"));
  await settleJournal(fakeDurableStore(disk), (await journalSpend(fakeDurableStore(disk)))!.version);
  await openJournal(fakeDurableStore(disk), inputs());
  await assert.rejects(m.ask(q("y")), JournalReplaced);
  await assert.rejects(m.ask(q("z")), JournalReplaced, "and every later call too");
  assert.equal(l.calls.length, 1);
  assert.equal(JSON.parse(disk.text!).records.length, 0, "nothing was written into the new journal");

  // The store went back to an older copy with fewer records.
  const disk2 = fakeDisk();
  const j = await openJournal(fakeDurableStore(disk2), inputs(), { seed: 1 });
  const m2 = j.model(provider(table, l));
  const empty = disk2.text!;
  await m2.ask(q("x"));
  disk2.text = empty;
  disk2.version++;
  await assert.rejects(m2.ask(q("y")), JournalReplaced);
});

test("opening retries when another runner wrote first", async () => {
  const disk = fakeDisk();
  const store = fakeDurableStore(disk);
  let refused = 0;
  const busy = { read: store.read, write: async (t: string, e: string | null) => (refused++ < 3 ? null : store.write(t, e)) };
  const j = await openJournal(busy, inputs(), { seed: 1 });
  assert.equal(j.resumed, false);
  assert.ok(disk.text !== null);
});

test("when scoring fails, every call still in flight is answered and written down before the error comes back", async () => {
  const disk = fakeDisk();
  const store = fakeDurableStore(disk);
  // A slow store: each write lands on a later turn of the event loop.
  const slow = { read: store.read, write: async (t: string, e: string | null) => { await tick(); await tick(); return store.write(t, e); } };
  let n = 0;
  const failing: Model = { async ask(a) { const mine = ++n; await tick(); if (mine === 9) throw new Error("provider error"); return answer(a, table); } };
  await assert.rejects(runScoreResumable(slow, { ...inputs(), model: failing, budgetLeftUsd: 3, seed: 11 }), /provider error/);
  const s = (await journalSpend(store))!;
  assert.equal(s.calls, n, "every call sent has its ask record");
  assert.equal(s.calls - s.finished, 1, "only the failed call has no reply");
});

test("the seeded reply order is fixed for a given seed", async () => {
  const draw = async (seed: number) => { const j = await openJournal(fakeDurableStore(fakeDisk()), inputs(), { seed }); return [j.random(), j.random(), j.random()]; };
  const a = await draw(42), b = await draw(42), c = await draw(43);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  for (const x of [...a, ...(await draw(0)), ...(await draw(0xffffffff))]) assert.ok(x >= 0 && x < 1);
  assert.deepEqual((await draw(0)).map((x) => x.toFixed(12)), ["0.266429208685", "0.000329745701", "0.223272027448"]);
});

test("the binding covers each case's split, each change's kind, each attack's sentence and the attack cache, and only scoring cases", () => {
  const base = inputs();
  const h = (i: ScoreInputs) => scoreBinding(i).hash;
  assert.notEqual(h({ ...base, scenarios: base.scenarios.map((s) => (s.id === "t0" ? { ...s, split: "holdout" as const } : s)) }), h(base));
  assert.notEqual(h({ ...base, candidates: [{ id: "winner", text: "Winner", kind: "shorter" }, base.candidates[1]] }), h(base));
  assert.notEqual(h({ ...base, attacks: [{ ...attacks[0], must: "Says no." }, attacks[1]] }), h(base));
  assert.notEqual(h({ ...base, attackCache: { key: "k", failed: [] } }), h(base));
  assert.equal(h({ ...base, scenarios: [...base.scenarios, { id: "v0", input: "q-v0", expected: "good", split: "vault" }] }), h(base));
  // Settings scoring never reads, and the order a goal's keys were written in, change nothing.
  assert.equal(h({ ...base, goal: { ...base.goal, share: "full", share_notice: "v2" } }), h(base));
  const reordered = Object.fromEntries(Object.entries(base.goal).reverse()) as unknown as Goal;
  assert.equal(h({ ...base, goal: reordered }), h(base));
});

test("the upper bound counts the schema and the framing allowance", () => {
  const a: Ask = { model: "claude-sonnet-5-5", system: "sys", user: "user text", maxTokens: 500, schema: { type: "object", properties: { better: { type: "string" } } } };
  const bytes = Buffer.byteLength(`sys${"user text"}${JSON.stringify(a.schema)}`, "utf8");
  assert.equal(callBoundUsd(a), costUsd("claude-sonnet-5-5", { input_tokens: 0, cache_creation_input_tokens: bytes + 1024, output_tokens: 500 }));
});

// ---- Tests for the independent review's four confirmed findings. ----

// A provider whose replies differ for the same request (a counter in each reply), and where some calls finish after
// calls sent later. The judge picks by the counter in the reply shown first.
function shuffled(l: Ledger): Model {
  let n = 0;
  return {
    async ask(a) {
      l.calls.push(a);
      const k = ++n;
      for (let i = 0; i < (k % 3 === 1 ? 5 : 1); i++) await tick();
      const schema = JSON.stringify(a.schema ?? {});
      if (!a.schema) return { text: `${a.system} says ${a.user} #${k}`, costUsd: 0.001 };
      if (schema.includes('"better"')) {
        const first = Number(/<reply_a>\n[^\n]* #(\d+)/.exec(a.user)?.[1] ?? 0);
        return { text: JSON.stringify({ better: first % 2 === 0 ? "A" : "B", a_guardrail_ok: true, b_guardrail_ok: true }), costUsd: 0.001 };
      }
      return { ...answer(a, table), costUsd: 0.001 };
    },
  };
}

test("identical requests get their own replies back on resume, even when they finished in another order", async () => {
  const same: ScoreInputs = inputs({
    scenarios: [
      { id: "t0", input: "q-same", expected: "good", split: "train" }, { id: "t1", input: "q-same", expected: "fine", split: "train" },
      ...cases(10, 6).map((s) => ({ ...s, id: `${s.id}x`, input: `${s.input}x` })),
    ],
    attacks: [{ id: "a0", input: "q-a", must: "Refuses." }, { id: "a1", input: "q-a", must: "Says no." }],
  });
  const l = ledger();
  const disk = fakeDisk();
  const j = await openJournal(fakeDurableStore(disk), same, { seed: 3 });
  const straight = await runScore(same.goal, same.baseline, same.candidates, same.scenarios, j.model(shuffled(l)), null, j.random, same.attacks);
  await j.seal();
  const replay = await openJournal(fakeDurableStore(copyOf(disk)), same);
  const again = await runScore(same.goal, same.baseline, same.candidates, same.scenarios, replay.model(shuffled(ledger())), null, replay.random, same.attacks);
  assert.equal(replay.sent(), 0, "a sealed journal replays in full");
  assert.deepEqual(again.scores, straight.scores);
});

test("after decide settles a journal, a runner still writing to it stops, and its later calls are never sent", async () => {
  const disk = fakeDisk();
  const l = ledger();
  const q = (u: string): Ask => ({ model: "claude-haiku-5-5", system: "Base", user: u, maxTokens: 100 });
  const j = await openJournal(fakeDurableStore(disk), inputs(), { seed: 1 });
  const m = j.model(provider(table, l));
  await m.ask(q("x"));
  const counted = (await journalSpend(fakeDurableStore(disk)))!;
  assert.equal(await settleJournal(fakeDurableStore(disk), counted.version), true);
  await assert.rejects(m.ask(q("y")), JournalReplaced);
  assert.equal(l.calls.length, 1);
  assert.equal(JSON.parse(disk.text!).records.filter((r: { t: string }) => r.t === "ask").length, 1);
});

test("decide settles only the journal it counted: a record written after it read the spend makes the settle fail", async () => {
  const disk = fakeDisk();
  const l = ledger();
  const q = (u: string): Ask => ({ model: "claude-haiku-5-5", system: "Base", user: u, maxTokens: 100 });
  const j = await openJournal(fakeDurableStore(disk), inputs(), { seed: 1 });
  const m = j.model(provider(table, l));
  await m.ask(q("x"));
  const counted = (await journalSpend(fakeDurableStore(disk)))!;
  await m.ask(q("y"));
  assert.equal(await settleJournal(fakeDurableStore(disk), counted.version), false);
  const now = (await journalSpend(fakeDurableStore(disk)))!;
  assert.equal(now.settled, false);
  assert.equal(now.calls, 2, "the later call is still there to be counted");
});

test("two runners with the same writer name never hide each other's lost calls", async () => {
  const disk = fakeDisk();
  const l = ledger();
  const q = (u: string): Ask => ({ model: "claude-opus-5-5", system: "Base", user: u, maxTokens: 2000 });
  const dies: Model = { async ask(a) { l.calls.push(a); throw new Killed("the runner died with this call in flight"); } };
  const first = await openJournal(fakeDurableStore(disk), inputs(), { seed: 1, writer: "run-77" });
  await assert.rejects(first.model(dies).ask(q("x")), Killed);
  const bound = (await journalSpend(fakeDurableStore(disk)))!.boundUsd;
  assert.ok(bound > 0.04, `an Opus call with a 2,000-token reply limit is bounded near $0.045 (${bound})`);
  const second = await openJournal(fakeDurableStore(disk), inputs(), { writer: "run-77" });
  await second.model(provider(table, l)).ask(q("y"));
  const s = (await journalSpend(fakeDurableStore(disk)))!;
  assert.equal(s.calls, 2);
  assert.equal(s.boundUsd, bound, "the lost call keeps its bound");
});

test("the binding covers every field of a proposed change, including the ones compose reads", () => {
  const base = inputs();
  const h = (c: ScoreInputs["candidates"]) => scoreBinding({ ...base, candidates: c }).hash;
  const plain = h(base.candidates);
  assert.notEqual(h([{ ...base.candidates[0], summary: "fixes refunds" }, base.candidates[1]]), plain);
  assert.notEqual(h([{ ...base.candidates[0], edits: [{ find: "a", replace: "b" }] }, base.candidates[1]]), plain);
  assert.notEqual(h([{ ...base.candidates[0], title: "Refunds" }, base.candidates[1]]), plain);
});

test("a stored journal that can't be read is kept inside the new one, not thrown away", async () => {
  const disk = diskWith('{"v":2,"future":true}');
  await openJournal(fakeDurableStore(disk), inputs());
  assert.equal(JSON.parse(disk.text!).previous, '{"v":2,"future":true}');
});

// ---- Tests for the second review: a late reply from another runner must not change what a replay returns. ----

// A provider whose replies a test releases by hand.
function heldProvider(l: Ledger) {
  const waiting: ((text: string) => void)[] = [];
  const model: Model = { ask: (a) => { l.calls.push(a); return new Promise((res) => waiting.push((text) => res({ text, costUsd: 0.001 }))); } };
  return { model, release: (i: number, text: string) => waiting[i](text), waiting };
}
const qK: Ask = { model: "claude-haiku-5-5", system: "Base", user: "K", maxTokens: 100 };

test("a reply that arrives after another runner re-sent the call and sealed the journal is refused; a replay gets what the sealing run used", async () => {
  const disk = fakeDisk();
  const l = ledger();
  const b = await openJournal(fakeDurableStore(disk), inputs(), { seed: 1, writer: "b" });
  const held = heldProvider(l);
  const late = b.model(held.model).ask(qK);
  while (held.waiting.length === 0) await tick(); // B's ask is stored and its call is out
  const c = await openJournal(fakeDurableStore(disk), inputs(), { writer: "c" });
  const fromC: Model = { async ask() { return { text: "from C", costUsd: 0.001 }; } };
  assert.equal((await c.model(fromC).ask(qK)).text, "from C");
  await c.seal();
  held.release(0, "from B");
  await assert.rejects(late, JournalReplaced);
  const d = await openJournal(fakeDurableStore(copyOf(disk)), inputs(), { writer: "d" });
  const none = ledger();
  assert.equal((await d.model(provider(table, none)).ask(qK)).text, "from C");
  assert.equal(none.calls.length, 0);
  const s = (await journalSpend(fakeDurableStore(disk)))!;
  assert.equal(s.calls, 2, "both calls count");
  assert.equal(s.unbounded, 0);
  assert.ok(s.boundUsd > 0, "B's call, never recorded as answered, keeps its bound");
});

test("a reply that arrives after another runner re-sent the call, but before the seal, does not replace the re-sent reply in a replay", async () => {
  const disk = fakeDisk();
  const l = ledger();
  const b = await openJournal(fakeDurableStore(disk), inputs(), { seed: 1, writer: "b" });
  const held = heldProvider(l);
  const late = b.model(held.model).ask(qK);
  while (held.waiting.length === 0) await tick();
  const c = await openJournal(fakeDurableStore(disk), inputs(), { writer: "c" });
  const fromC: Model = { async ask() { return { text: "from C", costUsd: 0.001 }; } };
  assert.equal((await c.model(fromC).ask(qK)).text, "from C");
  held.release(0, "from B");
  assert.equal((await late).text, "from B");
  await c.seal();
  const d = await openJournal(fakeDurableStore(copyOf(disk)), inputs(), { writer: "d" });
  const none = ledger();
  assert.equal((await d.model(provider(table, none)).ask(qK)).text, "from C", "the replay follows the re-send the sealing run used");
  assert.equal(none.calls.length, 0);
  // Both replies are paid for and both count.
  assert.ok(Math.abs((await journalSpend(fakeDurableStore(disk)))!.knownUsd! - 0.002) < 1e-12);
});

// ---- Tests for the mutation rerun's survivors. ----

test("roundSpend pauses on a journal charge that is unknown, and on a write cost that is not a finite number", () => {
  const journal = { knownUsd: null, boundUsd: 0, unbounded: 0, calls: 4, chargeUsd: null, settled: false };
  assert.deepEqual(roundSpend({ writeRan: true, writeUsd: 0.03, scoreStarted: true, scoreFinished: false, scoreUsd: null, journal }).addUsd, null);
  assert.equal(roundSpend({ writeRan: true, writeUsd: 0.03, scoreStarted: true, scoreFinished: true, scoreUsd: 0.2, journal }).action, "pause");
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.equal(roundSpend({ writeRan: true, writeUsd: bad, scoreStarted: false, scoreFinished: false, scoreUsd: null, journal: null }).action, "pause", String(bad));
    assert.equal(roundSpend({ writeRan: true, writeUsd: 0.03, scoreStarted: true, scoreFinished: true, scoreUsd: bad, journal: null }).action, "pause", String(bad));
  }
});

test("a lost call sent again is followed through on the next replay, so two identical requests keep their own replies", async () => {
  let n = 0;
  const counting: Model = { async ask() { n++; return { text: `reply ${n}`, costUsd: 0.01 }; } };
  const disk = fakeDisk();
  const first = await openJournal(fakeDurableStore(disk), inputs(), { seed: 1 });
  await assert.rejects(first.model({ async ask() { throw new Killed("lost"); } }).ask(qK), Killed);
  const second = await openJournal(fakeDurableStore(disk), inputs());
  const m2 = second.model(counting);
  assert.equal((await m2.ask(qK)).text, "reply 1");
  assert.equal((await m2.ask(qK)).text, "reply 2");
  assert.equal(n, 2);
  const third = await openJournal(fakeDurableStore(copyOf(disk)), inputs());
  const m3 = third.model(counting);
  assert.equal((await m3.ask(qK)).text, "reply 1");
  assert.equal((await m3.ask(qK)).text, "reply 2");
  assert.equal(n, 2);
});

test("a runner stops when another journal with more records takes the store, and then never writes again", async () => {
  const disk = fakeDisk();
  const store = fakeDurableStore(disk);
  let writes = 0;
  const counted = { read: store.read, write: (t: string, e: string | null) => { writes++; return store.write(t, e); } };
  const j = await openJournal(counted, inputs(), { seed: 1 });
  const m = j.model(provider(table, ledger()));
  await m.ask(qK);
  const other = JSON.parse(disk.text!);
  disk.text = JSON.stringify({ ...other, id: "someone-else", records: [...other.records, { t: "ask", id: "z", key: "zz", model: "m", bound: 0.1 }] });
  disk.version++;
  await assert.rejects(m.ask({ ...qK, user: "y" }), JournalReplaced);
  const before = writes;
  await assert.rejects(m.ask({ ...qK, user: "w" }), JournalReplaced);
  assert.equal(writes, before, "no further write is tried");
  assert.equal(JSON.parse(disk.text!).id, "someone-else");
});

test("journalSpend on an unreadable journal still reports the store's version, and a readable journal is never copied into previous", async () => {
  const disk: FakeDisk = { text: "{ broken", version: 7, conflicts: 0 };
  assert.equal((await journalSpend(fakeDurableStore(disk)))!.version, "7");
  const fine = fakeDisk();
  await openJournal(fakeDurableStore(fine), inputs({ round: 3 }), { seed: 1 });
  await openJournal(fakeDurableStore(fine), inputs({ round: 4 }));
  assert.equal(JSON.parse(fine.text!).previous, undefined);
});

// Rows of identical cases may swap on a resume: compare each list of case rows as a multiset, ids left out.
const rowsAnyOrder = (x: unknown): unknown => Array.isArray(x)
  ? x.every((r) => r && typeof r === "object" && "id" in r && "score" in r)
    ? x.map((r) => { const { id: _id, ...rest } = r as Record<string, unknown>; return JSON.stringify(rowsAnyOrder(rest)); }).sort()
    : x.map(rowsAnyOrder)
  : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, rowsAnyOrder(v)])) : x;

// A fuzz over many rounds: each round stops several times at random points, by a cancel between calls or by a
// machine that dies with calls in flight, and resumes each time on a new runner. Two input sets: the usual one, and
// one with two identical cases and no early stop (identical cases may swap rows, so that set compares totals only).
test("random kills and cancels across many rounds: the verdict, the known spend and every finished call are kept, and the charge never falls below the bill", async () => {
  let state = 77001;
  const rand = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const twin: Scenario = { id: "t1b", input: "q-t1", expected: "good", split: "train" };
  const variants = [
    { name: "usual", i: inputs(), rows: true },
    { name: "twins", i: inputs({ scenarios: [...cases(8, 4), twin], stopEarly: false }), rows: false },
  ];
  let lostCalls = 0, cancels = 0, deaths = 0;
  for (const v of variants) {
    for (const seed of [3, 19]) {
      const straightLedger = ledger();
      const straight = await attempt(fakeDisk(), v.i, straightLedger, { seed });
      const total = straightLedger.calls.length;
      const plain = straight.journal.spend();
      for (let trial = 0; trial < 8; trial++) {
        const l = ledger();
        let disk = fakeDisk();
        const stops: string[] = [];
        let last: Awaited<ReturnType<typeof attempt>> | null = null;
        for (let k = 0; k < 6 && !last?.scored; k++) {
          const finished = (await journalSpend(fakeDurableStore(disk)) ?? { finished: 0 }).finished;
          const at = 1 + Math.floor(rand() * Math.max(1, total - finished));
          const kind = k === 5 ? "none" : rand() < 0.5 ? "die" : "cancel";
          stops.push(`${kind}@${at}`);
          // A cancel counts every request, replayed ones too, so it falls after the replays. A death counts sent calls.
          const o = kind === "die" ? { dieAt: at } : kind === "cancel" ? { cancelAt: finished + at } : {};
          last = await attempt(disk, v.i, l, { ...o, ...(k === 0 ? { seed } : {}) });
          if (!last.scored) {
            assert.ok(last.journal.sent() > 0, `stops ${stops.join(", ")}: each stopped attempt sent a new call`);
            if (kind === "die") deaths++; else if (kind === "cancel") cancels++;
          }
          disk = copyOf(disk);
          const stored = (await journalSpend(fakeDurableStore(disk)))!;
          const where = `${v.name} seed ${seed} trial ${trial} stops ${stops.join(", ")}`;
          assert.ok(stored.chargeUsd! >= l.billedUsd - 1e-12, `${where}: the charge is never below the bill`);
          assert.ok(stored.calls >= l.calls.length, `${where}: every call sent has a record`);
          assert.equal(stored.unbounded, 0, where);
        }
        const where = `${v.name} seed ${seed} trial ${trial} stops ${stops.join(", ")}`;
        assert.ok(last?.scored, `${where}: the round finishes`);
        assert.deepEqual(verdictOf(last.scored, v.i.goal), verdictOf(straight.scored!, v.i.goal), where);
        if (v.rows) assert.deepEqual(last.scored.scores, straight.scored!.scores, where);
        else assert.deepEqual(rowsAnyOrder(last.scored.scores), rowsAnyOrder(straight.scored!.scores), where);
        const end = (await journalSpend(fakeDurableStore(disk)))!;
        assert.equal(end.finished, total, `${where}: one finished call for each call of an uninterrupted run`);
        assert.equal(end.knownUsd, plain.knownUsd, `${where}: the known spend is the uninterrupted run's, to the last bit`);
        // A request is sent again only for a call with no reply: never for a finished one.
        assert.ok(l.calls.length - total <= end.calls - end.finished, `${where}: no finished call was sent again`);
        assert.ok(end.chargeUsd! >= l.billedUsd - 1e-12, where);
        lostCalls += end.calls - end.finished;
        // The sealed journal replays in full on one more runner: the same scores, no call, and nothing added.
        const sealedText = disk.text;
        const sent = l.calls.length;
        const replay = await attempt(disk, v.i, l);
        assert.deepEqual(replay.scored?.scores, last.scored.scores, `${where}: a replay of the sealed journal`);
        assert.equal(l.calls.length, sent, `${where}: a replay of the sealed journal sends nothing`);
        assert.equal(disk.text, sealedText, where);
      }
    }
  }
  assert.ok(deaths > 10 && cancels > 10 && lostCalls > 10, `the fuzz did stop rounds both ways and lost calls (${deaths}, ${cancels}, ${lostCalls})`);
});

// ---- Third review: a sealed journal replays the replies the sealing run used, and nothing is added to it. ----

const fromText = (text: string, l?: Ledger): Model => ({ async ask(a) { l?.calls.push(a); return { text, costUsd: 0.001 }; } });

test("the original runner seals after another runner re-sent its call: a replay returns the original's reply and sends nothing", async () => {
  const disk = fakeDisk();
  const b = await openJournal(fakeDurableStore(disk), inputs(), { seed: 1, writer: "b" });
  const heldB = heldProvider(ledger());
  const fromB = b.model(heldB.model).ask(qK);
  while (heldB.waiting.length === 0) await tick();
  const c = await openJournal(fakeDurableStore(disk), inputs(), { writer: "c" });
  const heldC = heldProvider(ledger());
  const fromC = c.model(heldC.model).ask(qK); // C takes B's call, which has no reply yet, and sends it again
  while (heldC.waiting.length === 0) await tick();
  heldB.release(0, "from B");
  assert.equal((await fromB).text, "from B");
  await b.seal();
  heldC.release(0, "from C");
  await assert.rejects(fromC, JournalReplaced);
  const before = disk.text;
  const d = await openJournal(fakeDurableStore(copyOf(disk)), inputs(), { writer: "d" });
  const none = ledger();
  assert.equal((await d.model(fromText("from D", none)).ask(qK)).text, "from B");
  assert.equal(none.calls.length, 0);
  assert.equal(disk.text, before);
});

test("a re-sent reply recorded before the original runner seals does not change what a replay of the sealed journal returns", async () => {
  const disk = fakeDisk();
  const b = await openJournal(fakeDurableStore(disk), inputs(), { seed: 1, writer: "b" });
  const heldB = heldProvider(ledger());
  const fromB = b.model(heldB.model).ask(qK);
  while (heldB.waiting.length === 0) await tick();
  const c = await openJournal(fakeDurableStore(disk), inputs(), { writer: "c" });
  const heldC = heldProvider(ledger());
  const fromC = c.model(heldC.model).ask(qK);
  while (heldC.waiting.length === 0) await tick();
  heldB.release(0, "from B");
  assert.equal((await fromB).text, "from B");
  heldC.release(0, "from C");
  assert.equal((await fromC).text, "from C");
  await b.seal();
  const d = await openJournal(fakeDurableStore(copyOf(disk)), inputs(), { writer: "d" });
  const none = ledger();
  assert.equal((await d.model(fromText("from D", none)).ask(qK)).text, "from B", "the reply the sealed verdict used");
  assert.equal(none.calls.length, 0);
  assert.ok(Math.abs((await journalSpend(fakeDurableStore(disk)))!.knownUsd! - 0.002) < 1e-12, "both replies were paid for and both count");
});

test("two runners re-send the same lost call: a replay of the sealed journal returns the sealing runner's reply", async () => {
  const disk = fakeDisk();
  const lost = await openJournal(fakeDurableStore(disk), inputs(), { seed: 1, writer: "a" });
  await assert.rejects(lost.model({ async ask() { throw new Error("lost"); } }).ask(qK));
  const e = await openJournal(fakeDurableStore(disk), inputs(), { writer: "e" });
  const f = await openJournal(fakeDurableStore(disk), inputs(), { writer: "f" });
  const heldE = heldProvider(ledger()), heldF = heldProvider(ledger());
  const fromF = f.model(heldF.model).ask(qK); // F's re-send is stored first
  while (heldF.waiting.length === 0) await tick();
  const fromE = e.model(heldE.model).ask(qK);
  while (heldE.waiting.length === 0) await tick();
  heldE.release(0, "from E");
  assert.equal((await fromE).text, "from E");
  await e.seal();
  heldF.release(0, "from F");
  await assert.rejects(fromF, JournalReplaced);
  const d = await openJournal(fakeDurableStore(copyOf(disk)), inputs(), { writer: "d" });
  const none = ledger();
  assert.equal((await d.model(fromText("from D", none)).ask(qK)).text, "from E");
  assert.equal(none.calls.length, 0);
  const s = (await journalSpend(fakeDurableStore(disk)))!;
  assert.equal(s.calls, 3);
  assert.equal(s.finished, 1, "the lost call and F's refused reply keep their bounds");
});

test("a replay of a sealed journal never sends a call: a request the sealing run did not make fails, and the journal is unchanged", async () => {
  const disk = fakeDisk();
  const j = await openJournal(fakeDurableStore(disk), inputs(), { seed: 1 });
  assert.equal((await j.model(fromText("first")).ask(qK)).text, "first");
  await j.seal();
  const before = disk.text;
  const again = await openJournal(fakeDurableStore(disk), inputs());
  const none = ledger();
  const through = again.model(fromText("second", none));
  assert.equal((await through.ask(qK)).text, "first");
  await assert.rejects(through.ask(qK), /sealed/);
  await assert.rejects(through.ask({ ...qK, user: "something new" }), /sealed/);
  await again.seal();
  assert.equal(none.calls.length, 0);
  assert.equal(disk.text, before, "nothing was added to the sealed journal, not even a second seal");
});

// A stored journal that can't be read reports an unknown spend.
const parseable = async (text: string) => (await journalSpend(fakeDurableStore(diskWith(text))))!.knownUsd !== null;

test("a stored seal must list the calls the sealing run used", async () => {
  for (const seal of [{ t: "seal" }, { t: "seal", used: "x" }, { t: "seal", used: [1] }]) {
    assert.equal(await parseable(docText({ records: [ask("x"), done("x", 0.1), seal] })), false, JSON.stringify(seal));
  }
  assert.equal(await parseable(docText({ records: [ask("x"), done("x", 0.1), { t: "seal", used: ["x"] }] })), true);
});

// ---- runScoreResumable on a sealed journal. ----

test("a sealed journal replays in full even when its charge reaches what is left of the budget: the replay spends nothing", async () => {
  const l = ledger();
  const disk = fakeDisk();
  const first = await runScoreResumable(fakeDurableStore(disk), { ...inputs(), model: provider(table, l), budgetLeftUsd: 3, seed: 11 });
  assert.ok("scored" in first);
  const calls = l.calls.length;
  for (const left of [first.spend.chargeUsd!, 0]) {
    const again = await runScoreResumable(fakeDurableStore(copyOf(disk)), { ...inputs(), model: provider(table, l), budgetLeftUsd: left });
    assert.ok("scored" in again, `budget left ${left}`);
    assert.deepEqual(again.scored.scores, first.scored.scores);
    assert.deepEqual(again.resume, { resumed: true, refused: null, replayed: calls, sent: 0 });
    assert.deepEqual(again.spend, first.spend);
    assert.equal(again.scored.costUsd, first.scored.costUsd);
  }
  assert.equal(l.calls.length, calls);
});

test("a sealed journal with a call of unknown cost still pauses: the round's spend is not known", async () => {
  const disk = fakeDisk();
  const j = await openJournal(fakeDurableStore(disk), inputs(), { seed: 1 });
  await j.model({ async ask() { return { text: "no cost", costUsd: null }; } }).ask(qK);
  await j.seal();
  const l = ledger();
  const out = await runScoreResumable(fakeDurableStore(disk), { ...inputs(), model: provider(table, l), budgetLeftUsd: 3 });
  assert.ok("paused" in out);
  assert.equal(out.paused.action, "pause");
  assert.equal(l.calls.length, 0);
});

test("two runners score one round at once: the one that seals second stops with a clear reason, and a rerun replays the first seal", async () => {
  const disk = fakeDisk();
  const l = ledger();
  const runs = await Promise.allSettled(["a", "b"].map((writer) =>
    runScoreResumable(fakeDurableStore(disk), { ...inputs(), model: provider(table, l), budgetLeftUsd: 3, seed: 11, writer })));
  const kept = runs.filter((r) => r.status === "fulfilled");
  const stopped = runs.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  assert.equal(kept.length, 1);
  assert.equal(stopped.length, 1);
  assert.ok(stopped[0].reason instanceof JournalReplaced);
  assert.match(stopped[0].reason.message, /sealed/);
  const winner = (kept[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof runScoreResumable>>>).value;
  assert.ok("scored" in winner);
  const sent = l.calls.length;
  const again = await runScoreResumable(fakeDurableStore(copyOf(disk)), { ...inputs(), model: provider(table, l), budgetLeftUsd: 3 });
  assert.ok("scored" in again);
  assert.deepEqual(again.scored.scores, winner.scored.scores);
  assert.equal(again.resume.sent, 0);
  assert.equal(l.calls.length, sent);
  assert.equal((await journalSpend(fakeDurableStore(disk)))!.chargeUsd, again.spend.chargeUsd, "both runners' calls count");
});

test("a runner stopped by a settled journal says that decide already counted it", async () => {
  const disk = fakeDisk();
  const j = await openJournal(fakeDurableStore(disk), inputs(), { seed: 1 });
  const other = await openJournal(fakeDurableStore(disk), inputs());
  await other.model(fromText("x")).ask(qK);
  await other.seal();
  assert.equal(await settleJournal(fakeDurableStore(disk), (await journalSpend(fakeDurableStore(disk)))!.version), true);
  await assert.rejects(j.model(fromText("y")).ask({ ...qK, user: "other" }), (e: Error) => e instanceof JournalReplaced && /recorded|counted/.test(e.message));
});

test("a caller that changes a reply from a sealed replay does not change the journal or the next replay", async () => {
  const disk = fakeDisk();
  const j = await openJournal(fakeDurableStore(disk), inputs(), { seed: 1 });
  await j.model(fromText("kept")).ask(qK);
  await j.seal();
  const again = await openJournal(fakeDurableStore(disk), inputs());
  const spend = again.spend();
  const through = again.model(fromText("never"));
  const got = await through.ask(qK);
  got.text = "changed";
  got.costUsd = 99;
  assert.deepEqual(again.spend(), spend);
  const third = await openJournal(fakeDurableStore(disk), inputs());
  assert.equal((await third.model(fromText("never")).ask(qK)).text, "kept");
});
