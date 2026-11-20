// Run: node scripts/pool-sim.ts. Offline only: a scripted fake model, no API calls, no money.
// Shows what "population": true changes, using the real write, score and decide steps against an in-memory repo
// (the one the tests use). The world: eight training cases, four hidden ones. "Rule A" fixes training cases t1-t4,
// "Rule B" fixes t5-t8. Each alone wins 4 cases and ties 4, a sign-test p of 0.0625, over the merge rule's 0.05, so
// neither can merge on its own. A prompt with both rules wins all eight.
//   World 1: the hidden cases reward a prompt with both rules. Population should merge the combination.
//   World 2: the hidden cases reward nothing. The combination still wins training; the gate must refuse it.
import { judgeRound, paired, signP } from "../src/core/merge-rule.ts";
import { DEFAULTS, type Goal, type Scenario } from "../src/core/goal.ts";
import { runDecide } from "../src/loop/decide.ts";
import { runScore } from "../src/loop/score.ts";
import { runWrite } from "../src/loop/write.ts";
import type { Ask, Model } from "../src/model/client.ts";
import { MemoryRepo } from "../test/helpers.ts";

const BASE = "Old prompt.";
const ROUNDS = 3;
const train: Scenario[] = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: `t${n}`, input: `train-q${n}`, expected: "good", split: "train" }));
const hidden: Scenario[] = [1, 2, 3, 4].map((n) => ({ id: `h${n}`, input: `hidden-q${n}`, expected: "good", split: "holdout" }));
const scenarios = [...train, ...hidden];
const goal = (population: boolean): Goal => ({ version: 1, prompt: { kind: "file", path: "prompt.md" }, objective: "Be right", guardrails: [], scenarios: "s.jsonl", ...DEFAULTS, ...(population ? { population: true } : {}) });

// The writer proposes the next two rules from the script each round. Rules C to F change nothing, like most
// ideas. The agent's reply quotes its prompt, and the judge prefers the reply whose prompt has the rule the case needs.
function world(hiddenRewardsBoth: boolean): Model & { calls: Record<string, number> } {
  const script = ["Rule A.", "Rule B.", "Rule C.", "Rule D.", "Rule E.", "Rule F."];
  const calls: Record<string, number> = { writer: 0, agent: 0, judge: 0 };
  let next = 0;
  const value = (reply: string, situation: string) => {
    const a = reply.includes("Rule A"), b = reply.includes("Rule B");
    if (situation.includes("hidden")) return hiddenRewardsBoth && a && b ? 1 : 0;
    return Number(situation.match(/train-q(\d)/)?.[1]) <= 4 ? (a ? 1 : 0) : (b ? 1 : 0);
  };
  return {
    calls,
    async ask(a: Ask) {
      if (a.user.startsWith("You improve the system prompt")) {
        calls.writer++;
        const rule = script[next++];
        return { text: JSON.stringify({ edits: [{ find: "", replace: rule }], summary: `Adds ${rule.replace(".", "").toLowerCase()}.`, title: "add a rule" }), costUsd: 0.01 };
      }
      if (a.system !== undefined) { calls.agent++; return { text: `reply to ${a.user} using ${a.system}`, costUsd: 0.001 }; }
      calls.judge++;
      const situation = a.user.match(/Situation: (.*)/)![1];
      const va = value(a.user.match(/<reply_a>\n([\s\S]*?)\n<\/reply_a>/)![1], situation), vb = value(a.user.match(/<reply_b>\n([\s\S]*?)\n<\/reply_b>/)![1], situation);
      return { text: JSON.stringify({ better: va > vb ? "A" : vb > va ? "B" : "tie", a_guardrail_ok: true, b_guardrail_ok: true }), costUsd: 0.001 };
    },
  };
}

async function run(label: string, population: boolean, hiddenRewardsBoth: boolean) {
  console.log(`  ${label}`);
  const g = goal(population);
  const repo = new MemoryRepo(BASE);
  repo.files.set("s.jsonl", scenarios.map((s) => JSON.stringify(s)).join("\n"));
  const m = world(hiddenRewardsBoth);
  let merges = 0;
  for (let n = 1; n <= ROUNDS; n++) {
    const before = { ...m.calls };
    const prompt = repo.files.get("prompt.md")!;
    const written = await runWrite(g, await repo.readState(), prompt, scenarios, m);
    const { scores } = await runScore(g, prompt, written.candidates, scenarios, m, null, () => 0.99);
    const record = await runDecide(g, repo, { candidates: written.candidates, scores, costUsd: 0.1 });
    const verdict = judgeRound(scores, g, null);
    console.log(`    round ${n}: ${record?.outcome}${verdict.action === "merge" ? ` (${verdict.candidateId})` : ""}; model calls: writer ${m.calls.writer - before.writer}, agent ${m.calls.agent - before.agent}, judge ${m.calls.judge - before.judge}`);
    for (const c of scores.candidates) {
      const t = paired(c.train, scores.baselineTrain)!;
      const h = c.holdout ? paired(c.holdout, scores.baselineHoldout)! : null;
      console.log(`      ${c.id.padEnd(11)} training: won ${t.wins}, lost ${t.losses}, tied ${c.train.length - t.wins - t.losses} (p ${t.p.toFixed(4)}, needs ${g.merge_rule.max_p})${h ? `; hidden: won ${h.wins}, lost ${h.losses} (p ${signP(h.wins, h.losses).toFixed(4)}, needs ${g.merge_rule.holdout_max_p})` : "; hidden: not tried"}`);
    }
    if (written.population && !written.population.candidate) console.log(`      pool: no merge candidate, ${written.population.skipped}`);
    if (population) console.log(`      pool after the round: ${JSON.stringify((repo.state.pool ?? []).map((e) => ({ id: e.id, wonOn: e.wonOn.join(",") })))}`);
    if (record?.outcome === "merged") {
      merges++;
      console.log(`      merged: "${record.changed}"`);
      console.log(`      record.combined (earlier rounds it came from): ${JSON.stringify(record.combined ?? null)}`);
      break;
    }
  }
  console.log(`    result: ${merges} merge${merges === 1 ? "" : "s"}; prompt is now ${JSON.stringify(repo.files.get("prompt.md"))}; model calls in all: ${m.calls.writer + m.calls.agent + m.calls.judge}`);
}

console.log("World 1: two half-fixes, the hidden cases reward having both");
await run("population off", false, true);
await run("population on", true, true);
console.log("World 2: the same half-fixes, but the hidden cases reward nothing (the combination only fits the training cases)");
await run("population off", false, false);
await run("population on", true, false);
