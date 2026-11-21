import type { Goal, Scenario } from "../core/goal.ts";
import { sumCosts } from "../core/cost.ts";
import { askJson, pool, type Model } from "../model/client.ts";
import { AGENT_MAX_TOKENS, duelSystem } from "../loop/score.ts";
import { GUARD_EXAMPLE, NO_LENGTH_PREFERENCE } from "../loop/length.ts";
import { clip, type CalibrateIo, type Reading } from "./calibrate.ts";

// `npx synthe calibrate --judge`: does the AI judge that picks between two replies pick the way the team would, and
// does it lean toward the longer reply? Opt-in, and separate from the checks calibration: it writes no file.
const JUDGE_CASES = 10; // training cases answered twice, once by the current prompt and once by a variant
const PAIRS = 6; // pairs the team is asked about
const MIN_PAIRS = 3; // fewer usable pairs than this is too few to say anything
const MIN_ASKED = 4; // fewer team answers than this is too few to read agreement from
const MIN_LONGER = 6; // judgements on pairs where the team didn't prefer the longer reply, below which a lean toward length can't be read
const GAP = 0.1; // replies closer in length than this aren't a test of length
const AGREE_WELL = 0.75; // at or above this share of pairs the judge picks what the team picks
const AGREE_UNSURE = 0.5; // below this it picks differently from the team
const LEANS_LONGER = 0.5; // at or above this share of judgements, where the team didn't prefer the longer reply, the judge picked it anyway

// The variants differ from the current prompt mainly in length, so the pairs show whether the judge follows length.
const VARIANTS = [
  "Answer in more detail than you normally would, with extra explanation and context.",
  "Answer as briefly as you can while still helping.",
];

type Side = "current" | "variant";
type Verdict = Side | "same";
export interface JudgePair { input: string; current: string; variant: string; longer: Side }
export interface JudgedPair { pair: JudgePair; team: Verdict | null; judge: (Verdict | null)[] }
export interface JudgeAgreement {
  asked: number; agreed: number; flipped: number;
  longer: { picked: number; total: number };
  agreement: Reading; length: "leans toward longer replies" | "no pull toward longer replies" | "too few replies to judge";
}

// What scoring's duel asks the judge, for the same wording and the same rule about length, with only the verdict kept.
// The static part is scoring's own system prompt (duelSystem), so the two can't drift apart and it is cached the same way.
function duelPrompt(goal: Goal, s: Scenario, a: string, b: string): { system: string; user: string } {
  return { system: duelSystem(goal), user: `Situation: ${s.input}
A good response: ${s.expected}

<reply_a>
${a}
</reply_a>

<reply_b>
${b}
</reply_b>

Which reply better meets the goal for this situation? ${NO_LENGTH_PREFERENCE} Answer "A" or "B", or "tie" only if they are equally good.` };
}

const SCHEMA = {
  type: "object",
  properties: { better: { type: "string", enum: ["A", "B", "tie"] } },
  required: ["better"],
  additionalProperties: false,
};

// Pairs from the two length directions in turn, so the team sees replies that are longer and shorter than the current
// prompt's. The judge's own answers are never used to choose, or the lean toward length could be hidden.
function pickPairs(pairs: JudgePair[], max: number): JudgePair[] {
  const open: JudgePair[][] = [pairs.filter((p) => p.longer === "variant"), pairs.filter((p) => p.longer === "current")];
  const picked: JudgePair[] = [];
  while (picked.length < max && open.some((o) => o.length)) {
    for (const o of open) if (picked.length < max && o.length) picked.push(o.shift()!);
  }
  return picked;
}

// How the judge's answers compare with the team's. Each pair was judged in both orders. A pair counts as agreed only
// when both orders gave the team's answer; one that changed with the order is counted as flipped.
export function judgeAgreement(rows: JudgedPair[]): JudgeAgreement {
  const asked = rows.filter((r) => r.team !== null);
  const agreed = asked.filter((r) => r.judge.length > 0 && r.judge.every((j) => j === r.team)).length;
  const flipped = rows.filter((r) => r.judge.some((j) => j === null) || new Set(r.judge).size > 1).length;
  // Judgements where the team did not prefer the longer reply: did the judge pick it anyway?
  const without = asked.filter((r) => r.team !== r.pair.longer);
  const longer = {
    picked: without.reduce((n, r) => n + r.judge.filter((j) => j === r.pair.longer).length, 0),
    total: without.reduce((n, r) => n + r.judge.filter((j) => j !== null).length, 0),
  };
  const rate = asked.length ? agreed / asked.length : 0;
  return {
    asked: asked.length, agreed, flipped, longer,
    agreement: asked.length < MIN_ASKED ? "too few replies to judge" : rate >= AGREE_WELL ? "matches you well" : rate >= AGREE_UNSURE ? "unsure" : "disagrees with you",
    length: longer.total < MIN_LONGER ? "too few replies to judge" : longer.picked / longer.total >= LEANS_LONGER ? "leans toward longer replies" : "no pull toward longer replies",
  };
}

const teamAnswer = (text: string): Verdict | "a" | "b" | null => {
  const t = text.trim().toLowerCase();
  if (/^a\b/.test(t)) return "a";
  if (/^b\b/.test(t)) return "b";
  return /^(same|tie|=)/.test(t) ? "same" : null;
};

export async function calibrateJudge(io: CalibrateIo, goal: Goal, prompt: string, scenarios: Scenario[], model: Model, random: () => number = Math.random) {
  // Training cases only: the held-back ones stay unseen, even by this.
  const cases = scenarios.filter((s) => s.split === "train").slice(0, JUDGE_CASES);
  io.say(`Calibrate --judge checks whether Synthe's judge picks the better of two replies the way you would, and whether it favours the longer one. It answers ${cases.length} of your test cases with your current prompt and with a variant (some asked to be more detailed, some briefer), then asks you which reply is better for up to ${PAIRS} pairs, and gives the same pairs to the judge in both orders. A few minutes, and a few cents.\n`);

  const costs: (number | null)[] = [];
  const answer = async (system: string, s: Scenario) => {
    const r = await model.ask({ model: goal.models.runner, system, user: s.input, maxTokens: AGENT_MAX_TOKENS, allowCutOff: true });
    costs.push(r.costUsd);
    return r.text;
  };
  const made = await pool(cases.map((s, i) => ({ s, variant: `${prompt}\n\n${VARIANTS[i % VARIANTS.length]}` })), 6, async ({ s, variant }) => {
    const [current, other] = await Promise.all([answer(prompt, s), answer(variant, s)]);
    return current === null || other === null ? null : { s, current, other };
  });
  const usable = made.flatMap((m) => {
    if (!m) return [];
    const [a, b] = [m.current.length, m.other.length];
    // Replies of nearly the same length can't show whether the judge follows length.
    return Math.abs(a - b) / Math.max(1, Math.min(a, b)) >= GAP && m.current.trim() !== m.other.trim()
      ? [{ s: m.s, pair: { input: m.s.input, current: m.current, variant: m.other, longer: (b > a ? "variant" : "current") as Side } }] : [];
  });
  const chosen = new Set(pickPairs(usable.map((u) => u.pair), PAIRS));
  const items = usable.filter((u) => chosen.has(u.pair));
  if (items.length < MIN_PAIRS) {
    io.say(`Only ${items.length} of your test cases gave two replies different enough in length to compare, so there is nothing to measure yet. Add more test cases to .synthe/scenarios.jsonl, then run npx synthe calibrate --judge again.`);
    return null;
  }

  // The judge sees each pair in both orders; the team sees it in a random order, so neither is steered by position.
  const judged = await pool(items, 6, async ({ s, pair }) => {
    const ask = async (first: Side) => {
      const [a, b] = first === "variant" ? [pair.variant, pair.current] : [pair.current, pair.variant];
      const r = await askJson<{ better: string }>(model, { model: goal.models.judge, maxTokens: 200, schema: SCHEMA, ...duelPrompt(goal, s, a, b) });
      costs.push(r.costUsd);
      const v = r.value?.better;
      if (v !== "A" && v !== "B" && v !== "tie") return null;
      return v === "tie" ? "same" as const : (v === "A") === (first === "variant") ? "variant" as const : "current" as const;
    };
    return [await ask("variant"), await ask("current")];
  });

  io.say(`Now ${items.length} questions. For each, say which reply is better for that message, as you mean it.\n`);
  const rows: JudgedPair[] = [];
  for (const [n, { pair }] of items.entries()) {
    const flip = random() < 0.5; // shows the variant as A
    const [a, b] = flip ? [pair.variant, pair.current] : [pair.current, pair.variant];
    io.say(`${n + 1} of ${items.length}. A user wrote: "${clip(pair.input, 300)}"`);
    io.say(`   Reply A: "${clip(a, 600)}"`);
    io.say(`   Reply B: "${clip(b, 600)}"`);
    const said = teamAnswer(await io.ask("   Which reply is better: A, B or the same? Type a, b or same (Enter to skip): "));
    const team: Verdict | null = said === null ? null : said === "same" ? "same" : (said === "a") === flip ? "variant" : "current";
    rows.push({ pair, team, judge: judged[n] });
  }

  const r = judgeAgreement(rows);
  io.say("\nResults:");
  if (r.asked === 0) io.say("  You didn't answer any question, so the judge wasn't compared with you. Run npx synthe calibrate --judge again and answer them.");
  else {
    const percent = Math.round((100 * r.agreed) / r.asked);
    const advice = r.agreement === "disagrees with you"
      ? " Describe in \"objective\" in synthe.json what a better reply means to you, and add checks for it."
      : r.agreement === "unsure" ? " Sharper \"objective\" and \"expected\" sentences help the judge choose the way you do." : "";
    io.say(`  Agreement: the judge picked the same reply as you, in both orders, on ${r.agreed} of ${r.asked} pairs (${percent}%). Reading: ${r.agreement}.${advice}`);
  }
  io.say(`  Order: the judge changed its answer when the reply order flipped on ${r.flipped} of ${rows.length} pairs.${r.flipped * 3 > rows.length ? " That is often, so a single judgement is shaky; Synthe judges each reply in both orders to cancel this." : ""}`);
  if (r.longer.total === 0) io.say("  Length: not enough answers from you where the longer reply wasn't your pick, so a lean toward length can't be read.");
  else {
    const lean = r.length === "leans toward longer replies"
      ? ` Reading: leans toward longer replies. Add a guard such as "${GUARD_EXAMPLE}" to counter_checks in synthe.json, and read the longer replies in the report before trusting a win.`
      : r.length === "too few replies to judge" ? " Reading: too few to judge. Run it again with more of your test cases." : " Reading: no pull toward longer replies in this sample.";
    io.say(`  Length: in ${r.longer.picked} of ${r.longer.total} judgements on pairs where you didn't prefer the longer reply, the judge picked the longer one.${lean}`);
  }
  const costUsd = sumCosts(costs);
  io.say(`Cost: ${costUsd === null ? "unknown" : costUsd < 0.01 ? "under $0.01" : `$${costUsd.toFixed(2)}`}`);
  return { rows, ...r, costUsd };
}
