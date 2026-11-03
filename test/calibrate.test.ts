import assert from "node:assert/strict";
import { test } from "node:test";
import { calibrate } from "../src/cli/calibrate.ts";
import type { Scenario } from "../src/core/goal.ts";
import type { Ask, Model } from "../src/model/client.ts";
import { goal } from "./helpers.ts";

const CHECKS = ["Steady and clear", "Flips every time", "The team means it the other way", "Never applies"];
// The hidden case comes first, so a calibrate that ignored the split would send it.
const cases: Scenario[] = [
  { id: "h0", input: "HIDDEN question", expected: "x", split: "holdout" },
  ...Array.from({ length: 15 }, (_, i) => ({ id: `t${i}`, input: `question ${i}`, expected: "x", split: "train" as const })),
];

// Check 1 always passes; check 2 flips between markings of the same reply; check 3 passes, but the team says no;
// check 4 never applies.
function model(): Model & { asks: Ask[] } {
  const asks: Ask[] = [];
  const seen = new Map<string, number>();
  return {
    asks,
    async ask(a) {
      asks.push(a);
      if (!a.schema) return { text: `reply to ${a.user}`, costUsd: 0.001 };
      const n = (seen.get(a.user) ?? 0) + 1;
      seen.set(a.user, n);
      const results = [
        { check: 1, applies: true, passes: true },
        { check: 2, applies: true, passes: n % 2 === 0 },
        { check: 3, applies: true, passes: true },
        { check: 4, applies: false, passes: false },
      ];
      return { text: JSON.stringify({ results }), costUsd: 0.001 };
    },
  };
}

const io = (answer: (check: string) => string) => {
  const said: string[] = [];
  let check = "";
  return {
    said,
    say(t: string) { said.push(t); const m = t.match(/^ {3}Check: (.*)$/); if (m) check = m[1]; },
    async ask() { return answer(check); },
  };
};

test("calibrate says which checks to trust, which flip, which don't match the team, and which never come up", async () => {
  const m = model();
  const t = io((check) => (check === "The team means it the other way" ? "n" : "y"));
  const out = await calibrate(t, goal({ checks: CHECKS }), "Prompt", cases, m);
  assert.deepEqual(out!.results.map((r) => r.verdict), ["trustworthy", "unsteady", "mismatch", "unused"]);
  const [steady, , mismatch] = out!.results;
  assert.equal(steady.steady, 15);
  assert.equal(steady.applied, 15, "every training case is used");
  assert.ok(steady.asked > 0 && steady.agreed === steady.asked);
  assert.equal(mismatch.agreed, 0);
  const text = t.said.join("\n");
  assert.match(text, /Unsteady: the AI marked the same reply differently 15 of 15 times/);
  assert.match(text, /Doesn't match what you mean: you and the AI disagreed on \d of \d replies/);
  assert.match(text, /Never came up in your test cases/);
  assert.match(text, /3 of 4 checks need attention\. Edit them in synthe\.json/);
});

test("calibrate uses training cases only, asks at most 8 questions, and doesn't count skips", async () => {
  const m = model();
  let asked = 0;
  const t = io(() => { asked++; return "s"; });
  const out = await calibrate(t, goal({ checks: CHECKS }), "Prompt", cases, m);
  assert.ok(!m.asks.some((a) => a.user.includes("HIDDEN")));
  assert.ok(asked > 0 && asked <= 8);
  assert.ok(out!.results.every((r) => r.asked === 0));
  assert.equal(out!.results[0].verdict, "unasked", "steady is not the same as trusted");
  assert.match(t.said.join("\n"), /Steady \(marked the same way 15 of 15 times\), but not compared with what you mean/);
  assert.doesNotMatch(t.said.join("\n"), /All \d+ checks can be trusted/);
});

test("without checks, calibrate explains and spends nothing", async () => {
  const m = model();
  const t = io(() => "y");
  assert.equal(await calibrate(t, goal(), "Prompt", cases, m), null);
  assert.equal(m.asks.length, 0);
  assert.match(t.said[0], /no checks in synthe\.json/);
});

test("a check that came up in too few test cases isn't judged either way", async () => {
  const m = model();
  const few = cases.slice(0, 4); // the hidden case plus 3 training cases
  const t = io(() => "y");
  const out = await calibrate(t, goal({ checks: CHECKS }), "Prompt", few, m);
  assert.equal(out!.results[0].verdict, "thin");
  assert.match(t.said.join("\n"), /Only came up in 3 of your test cases, too few to tell/);
});
