import assert from "node:assert/strict";
import { test } from "node:test";
import { restartState } from "../src/cli/restart.ts";
import { renderReport } from "../src/loop/report.ts";
import { newState, type RoundRecord, type State } from "../src/core/state.ts";
import { goal } from "./helpers.ts";

const round = (n: number, outcome: RoundRecord["outcome"]): RoundRecord => ({ round: n, at: "2026-11-06T23:00:00Z", outcome, reasons: [], costUsd: 0.03 });
const stoppedWith = (stopped: string, over: Partial<State> = {}): State => ({ ...newState(), round: 3, stalls: 2, stopped, rounds: [round(1, "skipped"), round(2, "merged"), round(3, "skipped")], ...over });

test("restart clears a stop that needed a person, and the report tells the team to run it", () => {
  const s = stoppedWith("GitHub Actions isn't allowed to open pull requests here; turn on the setting");
  const next = restartState(goal(), s);
  assert.ok("state" in next);
  assert.equal(next.state.stopped, null);
  assert.equal(next.state.stalls, 0);
  assert.equal(next.state.round, 3, "rounds already run still count");
  assert.match(next.note, /turn on the setting/);
  assert.match(renderReport(goal(), s), /Once you've fixed it, run `npx synthe restart`/);
});

test("restart clears rounds that all failed on a key, once the team has a new one", () => {
  const s = stoppedWith("3 rounds in a row found no winner", { rounds: [1, 2, 3].map((n) => ({ ...round(n, "failed"), failure: "key" as const })) });
  const next = restartState(goal(), s);
  assert.ok("state" in next && next.state.stopped === null);
});

test("a finished run isn't restarted, and says what would let it continue", () => {
  const noWinner = restartState(goal(), stoppedWith("3 rounds in a row found no winner"));
  assert.ok("why" in noWinner && /add test cases your agent still gets wrong to s\.jsonl/.test(noWinner.why));
  const budget = restartState(goal(), stoppedWith("budget of $3 is used"));
  assert.ok("why" in budget && /whole \$3 budget/.test(budget.why));
  const rounds = restartState(goal(), stoppedWith("reached 12 rounds", { round: 12 }));
  assert.ok("why" in rounds && /raise merge_rule\.max_rounds/.test(rounds.why));
  assert.equal(renderReport(goal(), stoppedWith("budget of $3 is used")).includes("npx synthe restart"), false);
});

test("raising max_rounds lets a run that reached its rounds restart; unknown spend never restarts", () => {
  const raised = restartState(goal(), stoppedWith("reached 12 rounds", { round: 12 }));
  assert.ok("why" in raised);
  const g = goal();
  const more = restartState({ ...g, merge_rule: { ...g.merge_rule, max_rounds: 20 } }, stoppedWith("reached 12 rounds", { round: 12 }));
  assert.ok("state" in more && more.state.stopped === null);
  const unknown = restartState(goal(), stoppedWith("spend could not be measured", { spendUnknown: true }));
  assert.ok("why" in unknown && /couldn't measure/.test(unknown.why));
});

test("a run that isn't stopped is left as it is", () => {
  const s = newState();
  const next = restartState(goal(), s);
  assert.ok("state" in next && next.state === s);
});

test("each Actions run page says what the round did, what it cost and where the report is", async () => {
  const { roundSummary } = await import("../src/loop/report.ts");
  const record: RoundRecord = { ...round(4, "merged"), pr: 9, plain: "Its replies were better in 12 cases and worse in 0.", tried: [{ summary: "Warns celiac customers", outcome: "Merged." }] };
  const s: State = { ...newState(), round: 4, issue: 1, spendUsd: 0.12, rounds: [record] };
  const text = roundSummary(goal(), s, record, "o/r");
  assert.match(text, /^## Synthe round 4: merged \(#9\)/);
  assert.match(text, /better in 12 cases[\s\S]*- Warns celiac customers \*Merged\.\*[\s\S]*Cost of this round: \$0\.03/);
  assert.match(text, /Full report: https:\/\/github\.com\/o\/r\/issues\/1/);
  assert.match(roundSummary(goal(), { ...s, stopped: "budget of $3 is used" }, null, "o/r"), /^## Synthe: Done/);
});

test("decide settles a proposal the team merged and judges this round's scores in the same run", async () => {
  const { MemoryRepo, scored } = await import("./helpers.ts");
  const { runDecide } = await import("../src/loop/decide.ts");
  const repo = new MemoryRepo("Better prompt.");
  repo.prs.push({ number: 1, title: "Synthe: x", body: "", closed: false, branch: "synthe/round-1", merged: true });
  repo.state = { ...newState(), round: 1, spendUsd: 0.05, rounds: [{ ...round(1, "proposed"), pr: 1 }],
    proposal: { pr: 1, round: 1, branch: "synthe/round-1", kind: "merge", text: "Better prompt.", priorPrompt: "Old prompt.", propose: true } };
  const record = await runDecide(goal(), repo, { candidates: [{ id: "c1", text: "Even better prompt.", summary: "More" }], scores: scored("Better prompt.", 50, 50, 50, 50), costUsd: 0.03 });
  assert.equal(record?.round, 2, "this round was judged, not just the settling");
  assert.equal(repo.state.rounds[0].outcome, "merged");
  assert.equal(repo.state.proposal, null);
  assert.equal(repo.state.lastMerge?.pr, 1, "the undo check protects the team's merge");
});

test("after npx synthe stop, status reads as stopped, not still running", async () => {
  const { headline } = await import("../src/loop/report.ts");
  const s: State = { ...newState(), round: 3, spendUsd: 0.09, rounds: [{ ...round(1, "merged"), checks: { before: 47, after: 81 } }, round(2, "skipped"), round(3, "skipped")] };
  const paused = headline(goal(), s, true);
  assert.equal(paused.title, "Stopped by you after 1 merged change");
  assert.match(paused.summary, /^Your checks now pass 81% of the time, up from 47%\. It ran 3 rounds before you stopped it\./);
  assert.doesNotMatch(paused.summary, /still running/);
  assert.match(headline(goal(), s).summary, /still running/);
});
