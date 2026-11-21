import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commandFailure } from "./measure.ts";
import { runCommand } from "./run.ts";
import { isJudged, type Decision, type Problem } from "./types.ts";

// The judged measure (GOAL.md, "The judged measure"). `run` makes one output for each case; `compare` says which
// of two outputs is better. Every comparison is asked twice, with a and b swapped. A case counts for the candidate
// only when it wins in both orders, and against it only when it loses in both. A split (each side wins in the
// first position) is the judge's position bias, so it counts as a tie. A paired sign test across the cases decides.
//
// Length bias: a judge that likes long outputs prefers any longer output. So when the two outputs of a case differ
// in length, the case is asked again with the shorter one padded with filler that adds no content, to a little past
// the longer one. The change is kept only when it also wins that length-matched test.

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

// Filler that adds length, letters and words but no content: `text` padded to at least `length` characters.
const FILLER = " lorem ipsum dolor sit amet";
export function padTo(text: string, length: number): string {
  if (text.length >= length) return text;
  let fill = "";
  while (text.length + fill.length < length) fill += FILLER;
  return text + fill.slice(0, length - text.length);
}

// The length-matched test pads the shorter output a little past the longer one. Characters, letters and words do
// not grow in step, so an exact match on one count can leave the other counts short; the margin covers that.
export function matchedLength(a: string, b: string): number {
  const longer = Math.max(a.length, b.length);
  return longer + Math.max(8, Math.ceil(longer * 0.1));
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

// +1 when the candidate wins both orders, -1 when it loses both, 0 otherwise.
async function askTwice(compare: Compare, c: JudgeCase, kept: string, cand: string): Promise<{ score: -1 | 0 | 1; split: boolean } | { failed: string }> {
  const first = await compare(c, kept, cand); // the candidate is b
  if (typeof first !== "string") return first;
  const second = await compare(c, cand, kept); // the candidate is a
  if (typeof second !== "string") return second;
  const candFirst = first === "b" ? 1 : first === "a" ? -1 : 0;
  const candSecond = second === "a" ? 1 : second === "b" ? -1 : 0;
  const sum = candFirst + candSecond;
  // A win in one order and a tie in the other still leans to one side; a win and a loss is a split.
  return { score: sum > 0 ? 1 : sum < 0 ? -1 : 0, split: candFirst * candSecond === -1 };
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
  matched?: Tally;
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

  // Ask again with both outputs of each case at the same length. Cases whose outputs already match keep their score.
  const matched = await eachLimited(cases, async (c) => {
    const k = kept[c.id] ?? "", d = cand[c.id] ?? "";
    if (k.length === d.length) return rawScores[cases.indexOf(c)];
    // Only the shorter one is padded, so it ends a little longer than the other.
    const len = matchedLength(k, d);
    return k.length < d.length ? askTwice(counted, c, padTo(k, len), d) : askTwice(counted, c, k, padTo(d, len));
  });
  const mFailed = matched.find((m): m is { failed: string } => "failed" in m);
  if (mFailed) return { keep: false, reason: `The judge failed: ${mFailed.failed}`, calls, share, raw: r };
  const m = tally(matched as { score: number; split: boolean }[]);
  if (m.wins <= m.losses || m.p >= alpha) {
    return {
      keep: false,
      reason: `The judge preferred it in ${r.wins} of ${plural(n, "case")}, but with both outputs at the same length it ${score(m)}. The win came from longer output, not better output.`,
      calls, share, raw: r, matched: m,
    };
  }
  return {
    keep: true,
    reason: `The judge preferred it in both orders: of ${plural(n, "case")} it ${score(r)} (sign test p = ${r.p.toFixed(3)}), and it still won with both outputs at the same length.`,
    calls, share, raw: r, matched: m,
  };
}

// Runs every case in both checkouts (their problem folders) and judges the candidate against the kept version.
// The comparisons run in the kept checkout's problem folder. compare "model" is not here yet: P16 adds it.
export async function judgeCandidate(keptCheckout: string, candidateCheckout: string, problem: Problem, _seed?: number): Promise<JudgeDecision> {
  const m = problem.measure;
  if (!isJudged(m)) return { keep: false, reason: "This problem has no judged measure.", calls: 0, share: 0.5 };
  if (m.judge.compare === "model") return { keep: false, reason: 'compare "model" is not supported yet. Give a compare command.', calls: 0, share: 0.5 };
  const cases = readCases(keptCheckout, m.judge.cases);
  if ("failed" in cases) return { keep: false, reason: cases.failed, calls: 0, share: 0.5 };
  const kept = await runCases(keptCheckout, m.judge.run, cases);
  if ("failed" in kept) return { keep: false, reason: `The kept version could not run: ${kept.failed}`, calls: 0, share: 0.5 };
  const cand = await runCases(candidateCheckout, m.judge.run, cases);
  if ("failed" in cand) return { keep: false, reason: `The change could not run: ${cand.failed}`, calls: 0, share: 0.5 };
  return judgeOutputs(cases, kept, cand, commandCompare(keptCheckout, m.judge.compare));
}
