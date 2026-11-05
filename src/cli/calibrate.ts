import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Goal, Scenario } from "../core/goal.ts";
import { sumCosts } from "../core/cost.ts";
import { askJson, pool, type Model } from "../model/client.ts";
import { AGENT_MAX_TOKENS, askChecks } from "../loop/score.ts";

const CASES = 20; // test cases answered and marked twice: all the training ones, so every check comes up enough
const MIN_APPLIED = 4; // fewer replies than this where a check applies is too little to judge it
const QUESTIONS = 8; // replies the team is asked about
const STEADY = 0.85; // below this, the AI marks the same reply differently too often
const AGREE = 0.75; // below this, the AI doesn't mark the way the team means
const MIN_MISSES = 2; // one flip or one disagreement in a handful of cases is noise, not a verdict
const SETUP_CASES = 6; // init's short review: replies made, then up to SETUP_QUESTIONS asked about
const SETUP_QUESTIONS = 4;

export interface CalibrateIo { say(text: string): void; ask(question: string): Promise<string> }
export interface CheckCalibration {
  check: string; applied: number; steady: number; asked: number; agreed: number;
  verdict: "trustworthy" | "unsteady" | "mismatch" | "unused" | "thin" | "unasked" | "reworded";
}
// How the AI's marking of one reply compares with the team's, where "passes" is the positive class.
export interface Label { team: boolean; ai: boolean }
export type Reading = "matches you well" | "unsure" | "disagrees with you" | "too few replies to judge" | "not enough variety";
export interface CheckStats { tpr: number | null; tnr: number | null; kappa: number | null; reading: Reading }
export interface CalibrationRow { check: string; applied: number; agreed: number; steady: number; tpr: number | null; tnr: number | null; kappa: number | null; verdict: Reading }
export interface CalibrationFile { timestamp: string; modelIds: { checker: string; writer: string }; checks: CalibrationRow[] }
const KAPPA_WELL = 0.6; // at or above this the AI marks the way the team does
const KAPPA_UNSURE = 0.2; // below this it marks differently from the team

// One reply to ask the team about: the message, the reply, which check, and how Synthe marked it.
interface Item { input: string; reply: string; c: number; passes: boolean }

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n).trimEnd()}...` : t).replace(/\s+/g, " ").trim();

// Takes checks in turn and mixes replies Synthe passed and failed, so each check is compared with the team on both.
function pick(open: Item[][], max: number): Item[] {
  const items: Item[] = [];
  for (let round = 0; items.length < max && open.some((o) => o.length); round++) {
    for (const o of open) {
      if (items.length >= max || !o.length) continue;
      const at = Math.max(0, o.findIndex((p) => p.passes === (round % 2 === 0)));
      items.push(o.splice(at, 1)[0]);
    }
  }
  return items;
}

// A rewording of the check that matches how the team judged this reply, keeping its intent and keeping it checkable
// from one reply. Null when the model gives nothing usable; the team can always type their own.
async function suggestWording(model: Model, writer: string, check: string, item: Item, teamPasses: boolean, costs: (number | null)[]): Promise<string | null> {
  const { value, costUsd } = await askJson<{ check: string }>(model, {
    model: writer, maxTokens: 400,
    schema: { type: "object", properties: { check: { type: "string" } }, required: ["check"], additionalProperties: false },
    user: `A team measures their AI agent with this check: "${check}"

A user wrote: ${item.input}
The agent replied: ${item.reply}

An AI marked this reply as ${item.passes ? "passing" : "failing"} the check, but the team says it ${teamPasses ? "passes" : "fails"}. Rewrite the check as one plain sentence that keeps its intent, matches the team's judgement of this reply, and can still be decided by reading only the user's message and the reply.`,
  });
  costs.push(costUsd);
  const text = typeof value?.check === "string" ? value.check.trim() : "";
  return text && text.length <= 300 && text !== check ? text : null;
}

// Asks the team about each reply. Where they disagree with Synthe's marking, the check's wording may not say what
// they mean, so it is fixed right there: Synthe suggests a rewording, and the team takes it, types their own or keeps
// the check. "e" rewords a check at any question. A reworded check gets no more questions here: its markings were
// for the old wording.
// Team judgement is the truth, the AI's marking the prediction. With fewer than MIN_APPLIED labels, or a team that
// said the same thing every time, there is no number worth printing, so every field is null.
export function checkStats(labels: Label[]): CheckStats {
  const none = (reading: Reading): CheckStats => ({ tpr: null, tnr: null, kappa: null, reading });
  if (labels.length < MIN_APPLIED) return none("too few replies to judge");
  const tp = labels.filter((l) => l.team && l.ai).length, fn = labels.filter((l) => l.team && !l.ai).length;
  const tn = labels.filter((l) => !l.team && !l.ai).length, fp = labels.filter((l) => !l.team && l.ai).length;
  if (tp + fn === 0 || tn + fp === 0) return none("not enough variety");
  const n = labels.length;
  const po = (tp + tn) / n;
  const pe = ((tp + fn) * (tp + fp) + (tn + fp) * (tn + fn)) / (n * n);
  const kappa = (po - pe) / (1 - pe);
  const reading = kappa >= KAPPA_WELL ? "matches you well" : kappa >= KAPPA_UNSURE ? "unsure" : "disagrees with you";
  return { tpr: tp / (tp + fn), tnr: tn / (tn + fp), kappa, reading };
}

// Everything the table and the file say about each check; one place so they can't differ.
export function calibrationRows(results: CheckCalibration[], labels: Label[][]): CalibrationRow[] {
  return results.map((r, c) => {
    const { tpr, tnr, kappa, reading } = checkStats(labels[c]);
    return { check: r.check, applied: r.applied, agreed: r.agreed, steady: r.steady, tpr, tnr, kappa, verdict: reading };
  });
}

export const calibrationSummary = (rows: CalibrationRow[]) =>
  `Calibration: ${rows.filter((r) => r.kappa !== null && r.kappa >= KAPPA_WELL).length} of ${rows.length} checks match your judgement (kappa 0.6 or more)`;

// Written to a temp file and renamed, so a stopped run never leaves half a file for the next one to read.
export function writeCalibration(dir: string, file: CalibrationFile) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "calibration.json"), temp = join(dir, `calibration.json.${process.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(temp, path);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export async function reviewReplies(io: CalibrateIo, model: Model, writer: string, checks: string[], items: Item[], costs: (number | null)[]) {
  const asked = checks.map(() => 0), agreed = checks.map(() => 0), labels: Label[][] = checks.map(() => []);
  const reworded = new Set<number>();
  const reword = (c: number, text: string) => { checks[c] = text.slice(0, 300); reworded.add(c); io.say("   Check reworded."); };
  for (const [n, it] of items.entries()) {
    if (reworded.has(it.c)) continue;
    io.say(`${n + 1} of ${items.length}. A user wrote: "${clip(it.input, 300)}"`);
    io.say(`   Your agent replied: "${clip(it.reply, 600)}"`);
    io.say(`   Check: ${checks[it.c]}`);
    const answer = (await io.ask("   Does this reply pass the check? Type y, n, s to skip, or e to reword the check: ")).trim().toLowerCase();
    if (answer === "e") {
      const own = (await io.ask("   New wording for this check (Enter to keep it): ")).trim();
      if (own) reword(it.c, own);
      continue;
    }
    if (!/^[yn]/.test(answer)) continue;
    const teamPasses = answer.startsWith("y");
    asked[it.c]++;
    labels[it.c].push({ team: teamPasses, ai: it.passes });
    if (teamPasses === it.passes) { agreed[it.c]++; continue; }
    io.say(`   Synthe marked this as ${it.passes ? "passing" : "failing"}, so the check's wording may not say what you mean.`);
    const suggested = await suggestWording(model, writer, checks[it.c], it, teamPasses, costs);
    if (suggested) io.say(`   Suggested wording: "${suggested}"`);
    const choice = (await io.ask(suggested
      ? "   Type y to use it, type your own wording, or press Enter to keep the check: "
      : "   Type new wording, or press Enter to keep the check: ")).trim();
    if (suggested && /^y(es)?$/i.test(choice)) reword(it.c, suggested);
    else if (choice && !/^n(o)?$/i.test(choice)) reword(it.c, choice);
  }
  return { asked, agreed, reworded, labels };
}

// Setup's short version: a few replies with the team's current prompt, marked once, and up to 4 questions. Returns
// the checks as the team left them, reworded where they disagreed.
export async function reviewChecksAtSetup(io: CalibrateIo, goal: Goal, prompt: string, scenarios: Scenario[], model: Model, agent = false) {
  const checks = [...(goal.checks ?? [])];
  const costs: (number | null)[] = [];
  const cases = scenarios.filter((s) => s.split === "train").slice(0, SETUP_CASES);
  const marked = await pool(cases, 6, async (s) => {
    const r = await model.ask({ model: goal.models.runner, system: prompt, user: s.input, maxTokens: AGENT_MAX_TOKENS, allowCutOff: true });
    costs.push(r.costUsd);
    if (r.text === null) return null;
    const m = await askChecks(goal, model, s, r.text);
    costs.push(m.costUsd);
    return m.verdicts ? { s, reply: r.text, verdicts: m.verdicts } : null;
  });
  const open = checks.map((_, c) => marked.flatMap((m) => (m && m.verdicts[c].applies ? [{ input: m.s.input, reply: m.reply, c, passes: m.verdicts[c].passes }] : [])));
  const items = pick(open, SETUP_QUESTIONS);
  if (agent) {
    for (const sample of marked) {
      if (!sample) continue;
      io.say(`A user wrote: ${sample.s.input}\nYour agent replied: ${sample.reply}`);
      sample.verdicts.forEach((verdict, index) => io.say(`  ${index + 1}. ${checks[index]}: ${verdict.applies ? verdict.passes ? "PASS" : "FAIL" : "NOT APPLICABLE"}`));
    }
  } else if (items.length) {
    io.say(`\nQuick check that Synthe marks these the way you mean: ${items.length} of your agent's replies. Say whether each passes, as you'd judge it. If you disagree with Synthe, you can fix the check's wording right there.\n`);
    await reviewReplies(io, model, goal.models.writer, checks, items, costs);
  }
  return { checks, costUsd: sumCosts(costs), examples: marked.filter((sample) => sample !== null) };
}

// Whether the number Synthe improves can be trusted: does the AI mark each check the same way twice, and the way the
// team would? Uses the same check call as scoring, so it measures exactly what a round relies on.
export async function calibrate(io: CalibrateIo, goal: Goal, prompt: string, scenarios: Scenario[], model: Model, outDir?: string): Promise<{ results: CheckCalibration[]; checks: string[]; costUsd: number | null; report: CalibrationFile } | null> {
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

  // Questions only about replies the AI marked the same way twice: an unsteady marking isn't worth comparing.
  const open = checks.map((_, c) => marked.flatMap((m, i) => (m && m[0][c].applies && m[1][c].applies && m[0][c].passes === m[1][c].passes
    ? [{ input: cases[i].input, reply: replies[i]!, c, passes: m[0][c].passes }] : [])));
  const items = pick(open, QUESTIONS);
  if (items.length) io.say(`Now ${items.length} quick questions. For each, say whether the reply passes the check, as you mean it. If you disagree with Synthe, you can fix the check's wording right there.\n`);
  const review = await reviewReplies(io, model, goal.models.writer, checks, items, costs);

  io.say("\nResults:");
  for (const [c, r] of results.entries()) {
    r.asked = review.asked[c];
    r.agreed = review.agreed[c];
    const flips = r.applied - r.steady, misses = r.asked - r.agreed;
    // Both numbers on every line: the team's answers are the clearer signal, so they're never hidden by another verdict.
    const numbers = `Marked the same way ${r.steady} of ${r.applied} times${r.asked ? `; agreed with you ${r.agreed} of ${r.asked} times` : ""}.`;
    let line: string;
    if (review.reworded.has(c)) {
      r.verdict = "reworded";
      line = `Reworded by you to: "${clip(checks[c], 160)}". Run npx synthe calibrate again to check the new wording.`;
    } else if (r.applied === 0) {
      r.verdict = "unused";
      line = "Never came up in your test cases, so it can't move the number. Add test cases where it matters, or drop it.";
    } else if (misses >= MIN_MISSES && r.agreed / r.asked < AGREE) {
      r.verdict = "mismatch";
      line = `Doesn't match what you mean. ${numbers} Reword it to say exactly what you'd look for.`;
    } else if (flips >= MIN_MISSES && r.steady / r.applied < STEADY) {
      r.verdict = "unsteady";
      line = `Unsteady. ${numbers} Reword it to say exactly what a passing reply contains.`;
    } else if (r.applied < MIN_APPLIED) {
      // Live, checks came up in only 2 or 3 cases, and "steady 2 of 2" proves little.
      r.verdict = "thin";
      line = `Too few cases to tell. ${numbers} Add test cases where it matters to .synthe/scenarios.jsonl.`;
    } else if (r.asked === 0) {
      // Steady isn't the same as right: without the team's answers, only steadiness is known.
      r.verdict = "unasked";
      line = `Steady, but not compared with what you mean. ${numbers} Answer its questions next time.`;
    } else {
      r.verdict = "trustworthy";
      line = `Trustworthy. ${numbers}`;
    }
    io.say(`  ${c + 1}. ${clip(r.check, 90)}\n     ${line}`);
  }

  // A reworded check's labels were for the old wording, so it is not judged here.
  const rows = calibrationRows(results, review.labels.map((l, c) => (review.reworded.has(c) ? [] : l)));
  io.say("\nHow well each check matches your judgement:");
  for (const [c, r] of rows.entries()) {
    const numbers = r.kappa === null ? "" : ` Agreement ${pct(r.agreed / results[c].asked)}, steadiness ${pct(r.steady / r.applied)}, passes caught ${pct(r.tpr!)}, fails caught ${pct(r.tnr!)}, kappa ${r.kappa.toFixed(2)}.`;
    io.say(`  ${c + 1}. ${clip(r.check, 90)}\n     ${r.verdict[0].toUpperCase()}${r.verdict.slice(1)}.${numbers}`);
  }
  const report: CalibrationFile = { timestamp: new Date().toISOString(), modelIds: { checker: goal.models.checker, writer: goal.models.writer }, checks: rows };
  if (outDir !== undefined) writeCalibration(outDir, report);
  io.say(`\n${calibrationSummary(rows)}`);

  const fix = results.filter((r) => r.verdict !== "trustworthy" && r.verdict !== "reworded").length;
  io.say(fix
    ? `\n${fix} of ${checks.length} checks need attention. Edit them in synthe.json, push, then run npx synthe calibrate again.`
    : review.reworded.size ? "" : `\nAll ${checks.length} checks can be trusted, so the number in Synthe's report means what you think it does.`);
  const costUsd = sumCosts(costs);
  io.say(`Cost: ${costUsd === null ? "unknown" : costUsd < 0.01 ? "under $0.01" : `$${costUsd.toFixed(2)}`}`);
  return { results, checks, costUsd, report };
}
