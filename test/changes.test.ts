import assert from "node:assert/strict";
import { test } from "node:test";
import { newState, type RoundRecord, type State } from "../src/core/state.ts";
import { NO_ROUNDS_YET, changesText } from "../src/cli/changes.ts";
import { guide } from "../src/cli/guide.ts";
import { goal } from "./helpers.ts";

const rec = (round: number, over: Partial<RoundRecord> = {}): RoundRecord => ({
  round, at: "2026-11-06T00:00:00Z", outcome: "skipped", reasons: [], costUsd: 0.03, ...over,
});
const stateWith = (rounds: RoundRecord[]): State => ({ ...newState(), round: rounds.length, rounds });

test("changes prints the recorded score movement and the honest no-change line", () => {
  const state = stateWith([
    rec(1, {
      scorePct: 50,
      tried: [
        { summary: "A change", outcome: "Not clearly better." },
        { summary: "Another change", outcome: "Not clearly better." },
      ],
    }),
    rec(2, { outcome: "merged", scorePct: 75, costUsd: 0.04, changed: "Adds the order number to every reply" }),
  ]);
  const out = changesText(goal(), state);
  assert.ok(out.startsWith("Your prompt: 50% → 75% (checks passed on test cases Synthe never trains on)"));
  assert.ok(out.includes("Score by round: "));
  assert.ok(out.includes("Round 2 · merged · $0.04"));
  assert.ok(out.includes("  What changed: Adds the order number to every reply"));
  assert.ok(out.includes("Round 1 · no change · $0.03"));
  assert.ok(out.includes("  Tried 2 changes, but none was clearly better, so nothing merged."));
});

test("changes before any round is the one plain no-rounds line", () => {
  assert.equal(NO_ROUNDS_YET, "No rounds have run yet. The score graph will appear after the first round.");
  assert.ok(!NO_ROUNDS_YET.includes("\n"));
  assert.equal(changesText(goal(), newState()), NO_ROUNDS_YET);
});

test("the guide's after-setup section offers 'what did Synthe do?' and backs it with the changes command", () => {
  const after = guide.slice(guide.indexOf("## 8. After setup"));
  assert.ok(after.includes(`Tell the person: 'Ask me "what did Synthe do?" at any time and I will show you what changed.'`));
  assert.ok(after.includes("run `npx synthe changes` and show its output word for word before adding any commentary of your own"));
});
