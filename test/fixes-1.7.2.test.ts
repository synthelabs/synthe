import assert from "node:assert/strict";
import { test } from "node:test";
import { localCredential } from "../src/cli/local-credential.ts";
import { restartState } from "../src/cli/restart.ts";
import { newState, type RoundRecord, type State } from "../src/core/state.ts";
import { failureOf } from "../src/loop/failure.ts";
import { runDecide } from "../src/loop/decide.ts";
import { headline, renderReport } from "../src/loop/report.ts";
import { goal, MemoryRepo } from "./helpers.ts";

const failed = (error: unknown) => ({ candidates: null, scores: null, costUsd: null, error: failureOf("write", error) });

test("local commands say which credential they use, and never charge an app key silently", () => {
  assert.equal(localCredential({}), null);
  const app = localCredential({ ANTHROPIC_API_KEY: "sk-ant-app" })!;
  assert.equal(app.key, "sk-ant-app");
  assert.match(app.line, /ANTHROPIC_API_KEY, charged to that Anthropic account/);
  const own = localCredential({ SYNTHE_ANTHROPIC_KEY: " sk-ant-own ", ANTHROPIC_API_KEY: "sk-ant-app" })!;
  assert.equal(own.key, "sk-ant-own", "the Synthe key beats the app key");
  assert.match(own.line, /SYNTHE_ANTHROPIC_KEY/);
  for (const c of [app, own]) assert.doesNotMatch(c.line, /sk-ant-/, "the line never prints a credential");
});

test("a real Anthropic overload says the API was busy", async () => {
  const repo = new MemoryRepo("Old prompt.");
  const record = await runDecide(goal(), repo, failed({ status: 529, message: "Overloaded" }));
  assert.equal(record!.failure, "busy");
  assert.match(record!.plain!, /Anthropic's API was busy/);
});

const round = (n: number): RoundRecord => ({ round: n, at: "2026-11-06T23:00:00Z", outcome: "skipped", reasons: [], costUsd: 0.3 });
const budgetStop = (rounds: number, over: Partial<State> = {}): State => ({ ...newState(), round: rounds, spendUsd: 4, stopped: "budget of $4 is used", rounds: Array.from({ length: rounds }, (_, i) => round(i + 1)), ...over });

test("budget recovery at the round limit also asks for more rounds, and restart won't pretend otherwise", () => {
  const atLimit = budgetStop(12);
  assert.match(renderReport(goal({ budget: { max_usd: 4 } }), atLimit), /raise budget\.max_usd in synthe\.json\. Synthe has also run all 12 rounds, so raise merge_rule\.max_rounds too/);
  const stillOut = restartState(goal({ budget: { max_usd: 4 } }), atLimit);
  assert.ok("why" in stillOut && /and merge_rule\.max_rounds: all 12 rounds have run/.test(stillOut.why));
  const moreBudget = restartState(goal({ budget: { max_usd: 8 } }), atLimit);
  assert.ok("why" in moreBudget && /also run all 12 rounds\. Raise merge_rule\.max_rounds/.test(moreBudget.why), "more budget alone doesn't restart a run with no rounds left");
  const both = restartState(goal({ budget: { max_usd: 8 }, merge_rule: { ...goal().merge_rule, max_rounds: 20 } }), atLimit);
  assert.ok("state" in both && both.state.stopped === null);
  const early = budgetStop(5);
  assert.doesNotMatch(renderReport(goal({ budget: { max_usd: 4 } }), early), /max_rounds/);
  const resumed = restartState(goal({ budget: { max_usd: 8 } }), early);
  assert.ok("state" in resumed && resumed.state.stopped === null);
});

const refusedRound = (n: number): RoundRecord => ({ round: n, at: "2026-11-06T23:00:00Z", outcome: "failed", failure: "key", reasons: [], costUsd: null, plain: "This round didn't finish. Your Anthropic key was rejected. Run `npx synthe key` to replace your Anthropic key." });

test("a stall that ends on a rejected key restarts once the key is fixed, even after an ordinary no-win round", () => {
  const state: State = { ...newState(), round: 3, stalls: 3, stopped: "3 rounds in a row found no winner", rounds: [round(1), refusedRound(2), refusedRound(3)] };
  const next = restartState(goal(), state);
  assert.ok("state" in next && next.state.stopped === null && next.state.stalls === 0, "the report's advice (fix the key, restart) works");
  assert.equal(headline(goal(), state).title, "Stopped: your Synthe key stopped working");
  const report = renderReport(goal(), state);
  assert.match(report, /Run `npx synthe key` to replace your Anthropic key\. Then run `npx synthe restart`/);
  assert.doesNotMatch(report, /add test cases your agent still gets wrong/);
  assert.doesNotMatch(report, /Nothing more will run or change/);
  const plain: State = { ...state, rounds: [round(1), round(2), round(3)] };
  assert.ok("why" in restartState(goal(), plain), "an ordinary stall still needs new test cases");
});

test("no stop is cleared into a run with no rounds left, whatever stopped it", () => {
  for (const [stopped, over] of [["credit", {}], ["3 rounds in a row found no winner", { rounds: [round(10), refusedRound(11), refusedRound(12)] }], ["GitHub Actions isn't allowed to open pull requests here; turn on the setting", {}]] as [string, Partial<State>][]) {
    const state: State = { ...budgetStop(12), stopped, spendUsd: 1, ...over };
    const stuck = restartState(goal(), state);
    assert.ok("why" in stuck && /also run all 12 rounds\. Raise merge_rule\.max_rounds/.test(stuck.why), stopped);
    assert.match(renderReport(goal(), state), /raise merge_rule\.max_rounds/, stopped);
    const more = restartState(goal({ merge_rule: { ...goal().merge_rule, max_rounds: 20 } }), state);
    assert.ok("state" in more && more.state.stopped === null, stopped);
  }
  // Round 12's key was refused: the stop reads "reached 12 rounds", and fixing the key alone can't continue.
  const lastRoundRefused: State = { ...budgetStop(12), stopped: "reached 12 rounds", spendUsd: 1, rounds: [round(10), round(11), refusedRound(12)] };
  const refusedAtLimit = restartState(goal(), lastRoundRefused);
  assert.ok("why" in refusedAtLimit && /raise merge_rule\.max_rounds/.test(refusedAtLimit.why));
  const refusedReport = renderReport(goal(), lastRoundRefused);
  assert.match(refusedReport, /Run `npx synthe key` to replace your Anthropic key/);
  assert.match(refusedReport, /raise merge_rule\.max_rounds in synthe\.json and push it before you restart/);
  const refusedRaised = restartState(goal({ merge_rule: { ...goal().merge_rule, max_rounds: 20 } }), lastRoundRefused);
  assert.ok("state" in refusedRaised && refusedRaised.state.stopped === null, "with more rounds, fixing the key continues");
  const changed: State = { ...budgetStop(12), stopped: "3 rounds in a row found no winner", spendUsd: 1, scenariosHash: "old" };
  assert.ok("why" in restartState(goal(), changed, "new"), "new test cases don't help with no rounds left either");
  assert.ok("state" in restartState(goal(), { ...changed, round: 5 }, "new"));
});
