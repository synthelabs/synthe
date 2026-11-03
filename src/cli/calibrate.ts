import type { Goal, Scenario } from "../core/goal.ts";
import { sumCosts } from "../core/cost.ts";
import { pool, type Model } from "../model/client.ts";
import { AGENT_MAX_TOKENS, askChecks } from "../loop/score.ts";

const CASES = 20; // test cases answered and marked twice: all the training ones, so every check comes up enough
const MIN_APPLIED = 4; // fewer replies than this where a check applies is too little to judge it
const QUESTIONS = 8; // replies the team is asked about
const STEADY = 0.85; // below this, the AI marks the same reply differently too often
const AGREE = 0.75; // below this, the AI doesn't mark the way the team means

export interface CalibrateIo { say(text: string): void; ask(question: string): Promise<string> }
export interface CheckCalibration { check: string; applied: number; steady: number; asked: number; agreed: number; verdict: "trustworthy" | "unsteady" | "mismatch" | "unused" | "thin" | "unasked" }

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n).trimEnd()}...` : t).replace(/\s+/g, " ").trim();

// Whether the number Synthe improves can be trusted: does the AI mark each check the same way twice, and the way the
// team would? Uses the same check call as scoring, so it measures exactly what a round relies on.
export async function calibrate(io: CalibrateIo, goal: Goal, prompt: string, scenarios: Scenario[], model: Model): Promise<{ results: CheckCalibration[]; costUsd: number | null } | null> {
  const checks = goal.checks?.filter((c) => c.trim()) ?? [];
  if (checks.length === 0) {
    io.say("There are no checks in synthe.json, so there's nothing to calibrate. Synthe is using its AI judge's side-by-side preference instead.");
    return null;
  }
  // Training cases only: the held-back ones stay unseen, even by this.
  const cases = scenarios.filter((s) => s.split === "train").slice(0, CASES);
  io.say(`Calibrate checks whether Synthe's marking of your ${checks.length} checks can be trusted. It answers ${cases.length} of your test cases with your current prompt, marks each reply twice, then asks you about up to ${QUESTIONS} of them. A few minutes, and about a cent.\n`);

  const costs: (number | null)[] = [];
  const replies = await pool(cases, 6, async (s) => {
    const r = await model.ask({ model: goal.models.runner, system: prompt, user: s.input, maxTokens: AGENT_MAX_TOKENS, allowCutOff: true });
    costs.push(r.costUsd);
    return r.text;
  });
  const marked = await pool(cases.map((s, i) => ({ s, text: replies[i] })), 6, async ({ s, text }) => {
    if (text === null) return null;
    const twice = await Promise.all([askChecks(goal, model, s, text), askChecks(goal, model, s, text)]);
    costs.push(twice[0].costUsd, twice[1].costUsd);
    return twice[0].verdicts && twice[1].verdicts ? [twice[0].verdicts, twice[1].verdicts] : null;
  });

  // Steadiness: of the replies where a check applied either time, how often both markings said the same.
  const results: CheckCalibration[] = checks.map((check, c) => {
    let applied = 0, steady = 0;
    for (const m of marked) {
      if (!m) continue;
      const [a, b] = [m[0][c], m[1][c]];
      if (!a.applies && !b.applies) continue;
      applied++;
      // Whether a check passes only matters where it applies.
      if (a.applies === b.applies && (!a.applies || a.passes === b.passes)) steady++;
    }
    return { check, applied, steady, asked: 0, agreed: 0, verdict: "unused" };
  });

  // Questions: replies where a check applied and the AI was steady, taking checks in turn and mixing passes and
  // fails, so each check is compared with the team on both kinds of reply.
  const pairs: { i: number; c: number; passes: boolean }[] = [];
  const open = checks.map((_, c) => marked.flatMap((m, i) => (m && m[0][c].applies && m[1][c].applies && m[0][c].passes === m[1][c].passes ? [{ i, c, passes: m[0][c].passes }] : [])));
  for (let round = 0; pairs.length < QUESTIONS && open.some((o) => o.length); round++) {
    for (const o of open) {
      if (pairs.length >= QUESTIONS || !o.length) continue;
      const want = round % 2 === 0;
      const at = Math.max(0, o.findIndex((p) => p.passes === want));
      pairs.push(o.splice(at, 1)[0]);
    }
  }
  if (pairs.length) io.say(`Now ${pairs.length} quick questions. For each, say whether the reply passes the check, as you mean it.\n`);
  for (const [n, p] of pairs.entries()) {
    io.say(`${n + 1} of ${pairs.length}. A user wrote: "${clip(cases[p.i].input, 300)}"`);
    io.say(`   Your agent replied: "${clip(replies[p.i]!, 600)}"`);
    io.say(`   Check: ${checks[p.c]}`);
    const answer = (await io.ask("   Does this reply pass the check? Type y, n, or s to skip: ")).trim().toLowerCase();
    if (!/^[yn]/.test(answer)) continue;
    results[p.c].asked++;
    if ((answer.startsWith("y")) === p.passes) results[p.c].agreed++;
  }

  io.say("\nResults:");
  for (const [c, r] of results.entries()) {
    const steadyRate = r.applied ? r.steady / r.applied : 0;
    let line: string;
    if (r.applied === 0) {
      r.verdict = "unused";
      line = "Never came up in your test cases, so it can't move the number. Add test cases where it matters, or drop it.";
    } else if (r.applied < MIN_APPLIED) {
      // Live, checks came up in only 2 or 3 cases, and "steady 2 of 2" proves little.
      r.verdict = "thin";
      line = `Only came up in ${r.applied} of your test cases, too few to tell. Add test cases where it matters to .synthe/scenarios.jsonl.`;
    } else if (steadyRate < STEADY) {
      r.verdict = "unsteady";
      line = `Unsteady: the AI marked the same reply differently ${r.applied - r.steady} of ${r.applied} times. Reword it to say exactly what a passing reply contains.`;
    } else if (r.asked > 0 && r.agreed / r.asked < AGREE) {
      r.verdict = "mismatch";
      line = `Doesn't match what you mean: you and the AI disagreed on ${r.asked - r.agreed} of ${r.asked} replies. Reword it to say exactly what you'd look for.`;
    } else if (r.asked === 0) {
      // Steady isn't the same as right: without the team's answers, only steadiness is known.
      r.verdict = "unasked";
      line = `Steady (marked the same way ${r.steady} of ${r.applied} times), but not compared with what you mean: answer its questions next time.`;
    } else {
      r.verdict = "trustworthy";
      line = `Trustworthy: marked the same way ${r.steady} of ${r.applied} times, and agreed with you ${r.agreed} of ${r.asked} times.`;
    }
    io.say(`  ${c + 1}. ${clip(r.check, 90)}\n     ${line}`);
  }
  const fix = results.filter((r) => r.verdict !== "trustworthy").length;
  io.say(fix
    ? `\n${fix} of ${checks.length} checks need attention. Edit them in synthe.json, push, then run npx synthe calibrate again.`
    : `\nAll ${checks.length} checks can be trusted, so the number in Synthe's report means what you think it does.`);
  const costUsd = sumCosts(costs);
  io.say(`Cost: ${costUsd === null ? "unknown" : costUsd < 0.01 ? "under $0.01" : `$${costUsd.toFixed(2)}`}`);
  return { results, costUsd };
}
