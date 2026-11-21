import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commandFailure } from "./measure.ts";
import { modelCompare } from "./model-compare.ts";
import { runCommand } from "./run.ts";
import { isJudged, type Decision, type Problem } from "./types.ts";

// The judged measure (GOAL.md, "The judged measure"). `run` makes one output for each case; `compare` says which
// of two outputs is better. Every comparison is asked twice, with a and b swapped. A case counts for the candidate
// only when it wins in both orders, and against it only when it loses in both. A split (each side wins in the
// first position) is the judge's position bias, so it counts as a tie. A paired sign test across the cases decides.
//
// The judge always reads exactly what `run` printed. Synthe never pads or changes an output to control for length:
// a real judge reads filler as a worse reply. A judge that follows length by chance wins too few cases in both
// orders to pass the test. A judge that prefers the longer output almost every time cannot be told apart from a
// true preference by its answers alone, so the reason of a kept change says when every win was also longer.

export interface JudgeCase { id: string; input: unknown; [key: string]: unknown }
export type Winner = "a" | "b" | "tie";
// Answers one comparison. A plain reason when the judge failed.
export type Compare = (c: JudgeCase, a: string, b: string) => Promise<Winner | { failed: string }>;
export type Outputs = Record<string, string>;

export const JUDGE_ALPHA = 0.05;
const PARALLEL = 4;

export function readCases(problemDir: string, casesPath: string): JudgeCase[] | { failed: string } {
  let text: string;
  try { text = readFileSync(join(problemDir, casesPath), "utf8"); } catch { return { failed: `Could not read the cases file ${casesPath}.` }; }
  const cases: JudgeCase[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let c: unknown;
    try { c = JSON.parse(lines[i]); } catch { return { failed: `Line ${i + 1} of ${casesPath} is not valid JSON.` }; }
    if (!c || typeof c !== "object" || Array.isArray(c) || !("id" in c) || !("input" in c)) {
      return { failed: `Line ${i + 1} of ${casesPath} needs an "id" and an "input".` };
    }
    const id = String((c as { id: unknown }).id);
    if (seen.has(id)) return { failed: `The case id ${id} occurs more than once in ${casesPath}.` };
    seen.add(id);
    cases.push({ ...(c as object), id } as JudgeCase);
  }
  if (cases.length === 0) return { failed: `${casesPath} has no cases.` };
  return cases;
}

async function eachLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
  return out;
}

// Runs `run` once for each case in `checkoutDir` (the problem folder of a checkout), with the case on stdin.
export async function runCases(checkoutDir: string, run: string, cases: JudgeCase[]): Promise<Outputs | { failed: string }> {
  const results = await eachLimited(cases, async (c) => ({ c, r: await runCommand(checkoutDir, run, { stdin: JSON.stringify(c) + "\n" }) }));
  const outputs: Outputs = {};
  for (const { c, r } of results) {
    if (!r.ok) return { failed: `For case ${c.id}: ${commandFailure("The run command", run, r)}` };
    outputs[c.id] = r.stdout.replace(/\s+$/, "");
  }
  return outputs;
}

// The judge's answer is one JSON object; extra lines of logging before it are allowed.
export function parseWinner(stdout: string): Winner | null {
  const lines = stdout.trim().split("\n").reverse();
  for (const text of [stdout.trim(), ...lines]) {
    try {
      const w = (JSON.parse(text) as { winner?: unknown })?.winner;
      if (w === "a" || w === "b" || w === "tie") return w;
    } catch { /* try the next line */ }
  }
  return null;
}

export function commandCompare(problemDir: string, command: string): Compare {
  return async (c, a, b) => {
    const r = await runCommand(problemDir, command, { stdin: JSON.stringify({ case: c, a, b }) + "\n" });
    if (!r.ok) return { failed: commandFailure("The compare command", command, r) };
    const w = parseWinner(r.stdout);
    return w ?? { failed: `The compare command \`${command}\` did not print {"winner": "a" | "b" | "tie"}.` };
  };
}

// Exact one-sided sign test: the chance of `wins` or more out of `wins + losses` fair coin flips.
export function signTestP(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  let p = 0;
  let term = Math.pow(0.5, n); // C(n,0) / 2^n
  for (let k = 0; k <= n; k++) {
    if (k >= wins) p += term;
    term = (term * (n - k)) / (k + 1);
  }
  return Math.min(1, p);
}

export interface Tally { wins: number; losses: number; ties: number; splits: number; p: number }

// +1 only when the candidate wins in both orders, -1 only when it loses in both, 0 otherwise. A win in one order
// and a tie in the other is not a win: a judge that picks by position or by length some of the time gives exactly
// that pattern for two outputs of the same quality, and counting it would keep changes that are no better.
async function askTwice(compare: Compare, c: JudgeCase, kept: string, cand: string): Promise<{ score: -1 | 0 | 1; split: boolean } | { failed: string }> {
  const first = await compare(c, kept, cand); // the candidate is b
  if (typeof first !== "string") return first;
  const second = await compare(c, cand, kept); // the candidate is a
  if (typeof second !== "string") return second;
  const candFirst = first === "b" ? 1 : first === "a" ? -1 : 0;
  const candSecond = second === "a" ? 1 : second === "b" ? -1 : 0;
  const sum = candFirst + candSecond;
  return { score: sum === 2 ? 1 : sum === -2 ? -1 : 0, split: candFirst * candSecond === -1 };
}

function tally(scores: { score: number; split: boolean }[]): Tally {
  const wins = scores.filter((s) => s.score > 0).length;
  const losses = scores.filter((s) => s.score < 0).length;
  const splits = scores.filter((s) => s.split).length;
  return { wins, losses, ties: scores.length - wins - losses, splits, p: signTestP(wins, losses) };
}

export interface JudgeDecision extends Decision {
  // Comparisons asked (each one is a model call when compare is "model").
  calls: number;
  // The candidate's share of the cases, with a tie as half: 0.5 means no better and no worse.
  share: number;
  raw?: Tally;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const score = (t: Tally) => `won ${t.wins}, lost ${t.losses}, tied ${t.ties}`;

// Compares the candidate's outputs with the kept outputs, case by case. Never throws.
export async function judgeOutputs(cases: JudgeCase[], kept: Outputs, cand: Outputs, compare: Compare, alpha = JUDGE_ALPHA): Promise<JudgeDecision> {
  let calls = 0;
  const counted: Compare = async (c, a, b) => { calls++; return compare(c, a, b); };
  const raw = await eachLimited(cases, (c) => askTwice(counted, c, kept[c.id] ?? "", cand[c.id] ?? ""));
  const failed = raw.find((r): r is { failed: string } => "failed" in r);
  if (failed) return { keep: false, reason: `The judge failed: ${failed.failed}`, calls, share: 0.5 };
  const rawScores = raw as { score: -1 | 0 | 1; split: boolean }[];
  const r = tally(rawScores);
  const share = (r.wins + r.ties / 2) / cases.length;
  const n = cases.length;

  if (r.wins <= r.losses || r.p >= alpha) {
    let reason = `The judge did not clearly prefer it: of ${plural(n, "case")} it ${score(r)} (sign test p = ${r.p.toFixed(3)}, needs < ${alpha}).`;
    if (r.splits > 0 && r.splits >= r.wins + r.losses) {
      reason += ` In ${plural(r.splits, "case")} the judge picked whichever output came first or second, so its choice followed the position, not the output.`;
    }
    return { keep: false, reason, calls, share, raw: r };
  }

  // Only a note for the reader: the answers cannot separate a length bias from a true preference here.
  const longerWins = cases.filter((c, i) => rawScores[i].score > 0 && (cand[c.id] ?? "").length > (kept[c.id] ?? "").length).length;
  const note = longerWins === r.wins ? " Every output it preferred was also longer, so check that your judge does not favour length." : "";
  return {
    keep: true,
    reason: `The judge preferred it in both orders: of ${plural(n, "case")} it ${score(r)} (sign test p = ${r.p.toFixed(3)}).${note}`,
    calls, share, raw: r,
  };
}

// Runs every case in both checkouts (their problem folders) and judges the candidate against the kept version.
// The comparisons run in the kept checkout's problem folder. compare "model" asks the problem's model instead.
export async function judgeCandidate(keptCheckout: string, candidateCheckout: string, problem: Problem, _seed?: number): Promise<JudgeDecision> {
  const m = problem.measure;
  if (!isJudged(m)) return { keep: false, reason: "This problem has no judged measure.", calls: 0, share: 0.5 };
  let compare: Compare;
  try {
    compare = m.judge.compare === "model" ? modelCompare(problem) : commandCompare(keptCheckout, m.judge.compare);
  } catch (e) {
    return { keep: false, reason: e instanceof Error ? e.message : String(e), calls: 0, share: 0.5 };
  }
  const cases = readCases(keptCheckout, m.judge.cases);
  if ("failed" in cases) return { keep: false, reason: cases.failed, calls: 0, share: 0.5 };
  const kept = await runCases(keptCheckout, m.judge.run, cases);
  if ("failed" in kept) return { keep: false, reason: `The kept version could not run: ${kept.failed}`, calls: 0, share: 0.5 };
  const cand = await runCases(candidateCheckout, m.judge.run, cases);
  if ("failed" in cand) return { keep: false, reason: `The change could not run: ${cand.failed}`, calls: 0, share: 0.5 };
  return judgeOutputs(cases, kept, cand, compare);
}
