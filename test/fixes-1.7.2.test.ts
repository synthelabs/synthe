import assert from "node:assert/strict";
import { test } from "node:test";
import { localCredential } from "../src/cli/local-credential.ts";
import { restartState } from "../src/cli/restart.ts";
import { PROXY_REFUSED } from "../src/core/share.ts";
import { newState, type RoundRecord, type State } from "../src/core/state.ts";
import { failureOf } from "../src/loop/failure.ts";
import { runDecide } from "../src/loop/decide.ts";
import { headline, renderReport } from "../src/loop/report.ts";
import { ProxyError } from "../src/model/client.ts";
import { goal, MemoryRepo } from "./helpers.ts";

const failed = (error: unknown) => ({ candidates: null, scores: null, costUsd: null, error: failureOf("write", error) });

test("local commands say which credential they use, and never charge an app key silently", () => {
  assert.equal(localCredential({}), null);
  const app = localCredential({ ANTHROPIC_API_KEY: "sk-ant-app" })!;
  assert.equal(app.key, "sk-ant-app");
  assert.match(app.line, /ANTHROPIC_API_KEY, charged to that Anthropic account/);
  assert.match(app.line, /set SYNTHE_EVENT_CODE and SYNTHE_TEAM_CODE/);
  const event = localCredential({ ANTHROPIC_API_KEY: "sk-ant-app", SYNTHE_EVENT_CODE: " crimson ", SYNTHE_TEAM_CODE: "crim-abcd-efgh-jkmn-pqrs" })!;
  assert.deepEqual([event.key, event.eventCode, event.teamCode], [undefined, "crimson", "crim-abcd-efgh-jkmn-pqrs"], "event codes beat the app key");
  assert.match(event.line, /event credit, with your team code/);
  assert.match(localCredential({ SYNTHE_EVENT_CODE: "crimson", SYNTHE_TEAM_CODE: " " })!.line, /SYNTHE_TEAM_CODE isn't set/);
  const own = localCredential({ SYNTHE_ANTHROPIC_KEY: "sk-ant-own", SYNTHE_EVENT_CODE: "crimson", ANTHROPIC_API_KEY: "sk-ant-app" })!;
  assert.deepEqual([own.key, own.eventCode], ["sk-ant-own", undefined]);
  assert.match(own.line, /SYNTHE_ANTHROPIC_KEY/);
  for (const c of [app, event, own]) assert.doesNotMatch(c.line, /sk-ant-|crimson|crim-/, "the line never prints a credential");
});

test("a refused team code points at the repo secret, not at replacing an Anthropic key", async () => {
  const message = `${PROXY_REFUSED}This team code was turned off. Ask at the Synthe table for a new one; your team's spend is kept.`;
  const repo = new MemoryRepo("Old prompt.");
  const record = await runDecide(goal(), repo, failed(new ProxyError(403, message)));
  assert.equal(record!.failure, "key");
  assert.equal(record!.plain, message);
  assert.match(record!.reasons.join(" "), /refused by the Synthe proxy: This team code was turned off/);
  assert.match(repo.issue, /gh secret set SYNTHE_TEAM_CODE/);
  assert.doesNotMatch(repo.issue, /replacing the key|replace your Anthropic key/);
  // Once the rounds that failed this way stop the run, the headline and next step still name the code.
  await runDecide(goal(), repo, failed(new ProxyError(403, message)));
  await runDecide(goal(), repo, failed(new ProxyError(403, message)));
  assert.ok(repo.state.stopped);
  assert.equal(headline(goal(), repo.state).title, "Stopped: the Synthe proxy refused this repo's code");
  assert.match(repo.issue, /gh secret set SYNTHE_TEAM_CODE/);
  assert.doesNotMatch(repo.issue, /your Synthe key stopped working|replacing the key/);
});

test("every Synthe-table 503 keeps the server's words instead of blaming Anthropic", async () => {
  for (const words of ["Credit could not be settled. Ask at the Synthe table.", "Credit is unavailable. Ask at the Synthe table."]) {
    const repo = new MemoryRepo("Old prompt.");
    const record = await runDecide(goal(), repo, failed(new ProxyError(503, words)));
    assert.equal(record!.failure, "busy");
    assert.equal(record!.plain, words);
    assert.ok(repo.issue.includes(words));
    assert.doesNotMatch(repo.issue, /Anthropic's API was busy/);
  }
  const repo = new MemoryRepo("Old prompt.");
  const record = await runDecide(goal(), repo, failed({ status: 529, message: "Overloaded" }));
  assert.match(record!.plain!, /Anthropic's API was busy/, "a real Anthropic overload still says so");
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

const refusedRound = (n: number): RoundRecord => ({ round: n, at: "2026-11-06T23:00:00Z", outcome: "failed", failure: "key", reasons: [], costUsd: null, plain: `${PROXY_REFUSED}That team code isn't recognised. Check the card from the Synthe table.` });

test("a stall that ends on a refused code restarts once the code is fixed, even after an ordinary no-win round", () => {
  const state: State = { ...newState(), round: 3, stalls: 3, stopped: "3 rounds in a row found no winner", rounds: [round(1), refusedRound(2), refusedRound(3)] };
  const next = restartState(goal(), state);
  assert.ok("state" in next && next.state.stopped === null && next.state.stalls === 0, "the report's advice (fix the code, restart) works");
  assert.equal(headline(goal(), state).title, "Stopped: the Synthe proxy refused this repo's code");
  const report = renderReport(goal(), state);
  assert.match(report, /gh secret set SYNTHE_TEAM_CODE/);
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
  const changed: State = { ...budgetStop(12), stopped: "3 rounds in a row found no winner", spendUsd: 1, scenariosHash: "old" };
  assert.ok("why" in restartState(goal(), changed, "new"), "new test cases don't help with no rounds left either");
  assert.ok("state" in restartState(goal(), { ...changed, round: 5 }, "new"));
});
