import { createInterface } from "node:readline";
import { costUsd } from "../src/core/cost.ts";
import { anthropicModel, type Model } from "../src/model/client.ts";
import { FIXTURES } from "./improve/fixtures.ts";
import { runFixture, type ImproveRun } from "./improve/run.ts";
import { PROMPT_TASKS } from "./prompt/tasks.ts";
import { runPromptTask, type PromptRun } from "./prompt/run.ts";

export const SEEDS = ["1", "2", "3"];
// How far a branch may move from the baseline before --check fails, summed over every task and seed of a mode.
// False keeps get no slack: the loop must never keep more non-gains than main does. Real gains get one, since a
// stricter keep rule can fairly trade one borderline gain for safety; a second lost gain is a regression.
export const TOLERANCE = { falseKeeps: 0, realGains: 1 };
// Live mode refuses to start any call past this multiple of the scripted run's upper estimate.
const LIVE_MARGIN = 1.5;

export interface Totals {
  prompt: { runs: number; gainsKept: number; gainsOffered: number; falseKeeps: number; trapsKept: number; neutralKept: number; gainsMissed: number; reverts: number; calls: number; costUsd: number };
  improve: { runs: number; realKept: number; falseKeeps: number; gamingKept: number; noiseKept: number; realMissed: number; heldOff: number; modelCalls: number; metricRuns: number };
}
export interface Results { version: 1; seeds: string[]; rounds: Record<string, number>; prompt: PromptRun[]; improve: ImproveRun[]; totals: Totals }

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const total = <T>(xs: T[], f: (x: T) => number) => xs.reduce((n, x) => n + f(x), 0);

export function totals(prompt: PromptRun[], improve: ImproveRun[]): Totals {
  const gainsOffered = total(prompt, (r) => PROMPT_TASKS.find((t) => t.name === r.task)!.menu.filter((m) => m.kind === "gain").length);
  return {
    prompt: {
      runs: prompt.length, gainsKept: total(prompt, (r) => r.gainsKept), gainsOffered, falseKeeps: total(prompt, (r) => r.falseKeeps),
      trapsKept: total(prompt, (r) => r.trapsKept), neutralKept: total(prompt, (r) => r.neutralKept), gainsMissed: total(prompt, (r) => r.gainsMissed),
      reverts: total(prompt, (r) => r.reverts), calls: total(prompt, (r) => Object.values(r.calls).reduce((a, b) => a + b, 0)), costUsd: round3(total(prompt, (r) => r.costUsd)),
    },
    improve: {
      runs: improve.length, realKept: total(improve, (r) => r.realKept), falseKeeps: total(improve, (r) => r.falseKeeps), gamingKept: total(improve, (r) => r.gamingKept),
      noiseKept: total(improve, (r) => r.noiseKept), realMissed: total(improve, (r) => r.realMissed), heldOff: total(improve, (r) => r.heldOff),
      modelCalls: total(improve, (r) => r.calls.pick + r.calls.propose), metricRuns: total(improve, (r) => r.metricRuns),
    },
  };
}

export interface BenchOptions { seeds?: string[]; tasks?: string[]; rounds?: number; improve?: boolean; live?: Model | null }

export async function runBench(o: BenchOptions = {}): Promise<Results> {
  const seeds = o.seeds ?? SEEDS;
  const tasks = PROMPT_TASKS.filter((t) => !o.tasks || o.tasks.includes(t.name));
  const prompt: PromptRun[] = [];
  for (const t of tasks) for (const s of seeds) prompt.push(await runPromptTask(t, s, o.rounds ?? t.rounds, o.live ?? null));
  const improve: ImproveRun[] = [];
  if (o.improve !== false) for (const f of FIXTURES) for (const s of seeds) improve.push(await runFixture(f, s));
  return { version: 1, seeds, rounds: Object.fromEntries(tasks.map((t) => [t.name, o.rounds ?? t.rounds])), prompt, improve, totals: totals(prompt, improve) };
}

const pad = (cells: string[], widths: number[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
const money = (n: number) => `$${n.toFixed(3)}`;

// One table: a row per task (summed over seeds), then a total row per mode.
export function formatTable(r: Results): string {
  const head = ["mode", "task", "runs", "true score start -> end (best)", "real kept", "false keeps", "missed", "calls", "cost proxy", "per kept gain"];
  const rows: string[][] = [];
  const byTask = new Map<string, PromptRun[]>();
  for (const p of r.prompt) byTask.set(p.task, [...(byTask.get(p.task) ?? []), p]);
  for (const [task, runs] of byTask) {
    const mean = (f: (x: PromptRun) => number) => (total(runs, f) / runs.length).toFixed(2);
    const gains = total(runs, (x) => x.gainsKept);
    const offered = runs.length * PROMPT_TASKS.find((t) => t.name === task)!.menu.filter((m) => m.kind === "gain").length;
    const traps = total(runs, (x) => x.trapsKept), neutral = total(runs, (x) => x.neutralKept);
    const calls = (k: keyof PromptRun["calls"]) => total(runs, (x) => x.calls[k]);
    const cost = total(runs, (x) => x.costUsd);
    rows.push(["prompt", task, String(runs.length), `${mean((x) => x.qualityStart)} -> ${mean((x) => x.qualityEnd)} (${mean((x) => x.qualityBest)})`,
      `${gains}/${offered}`, `${traps + neutral} (${traps} trap, ${neutral} neutral)`, String(total(runs, (x) => x.gainsMissed)),
      `w${calls("writer")} r${calls("runner")} j${calls("judge")} c${calls("checker")}`, money(cost), gains ? money(cost / gains) : "-"]);
  }
  const byFixture = new Map<string, ImproveRun[]>();
  for (const i of r.improve) byFixture.set(i.fixture, [...(byFixture.get(i.fixture) ?? []), i]);
  for (const [fixture, runs] of byFixture) {
    const f = FIXTURES.find((x) => x.name === fixture)!;
    const mean = (g: (x: ImproveRun) => number) => (total(runs, g) / runs.length).toFixed(2);
    const gaming = total(runs, (x) => x.gamingKept), noise = total(runs, (x) => x.noiseKept);
    const kept = total(runs, (x) => x.realKept);
    const modelCalls = total(runs, (x) => x.calls.pick + x.calls.propose);
    rows.push(["improve", fixture, String(runs.length), `${mean((x) => x.start)} -> ${mean((x) => x.end)} ${f.unit} (${f.direction} is better)`,
      `${kept}/${runs.length * f.menu.filter((c) => c.kind === "real").length}`, `${gaming + noise} (${gaming} gaming, ${noise} noise)`, String(total(runs, (x) => x.realMissed)),
      `m${modelCalls} metric${total(runs, (x) => x.metricRuns)}`, "-", kept ? `${(total(runs, (x) => x.metricRuns) / kept).toFixed(1)} metric runs` : "-"]);
  }
  const t = r.totals;
  if (t.prompt.runs) rows.push(["prompt", "TOTAL", String(t.prompt.runs), "", `${t.prompt.gainsKept}/${t.prompt.gainsOffered}`, String(t.prompt.falseKeeps), String(t.prompt.gainsMissed), String(t.prompt.calls), money(t.prompt.costUsd), t.prompt.gainsKept ? money(t.prompt.costUsd / t.prompt.gainsKept) : "-"]);
  if (t.improve.runs) rows.push(["improve", "TOTAL", String(t.improve.runs), `${t.improve.heldOff} held off by re-measuring`, String(t.improve.realKept), String(t.improve.falseKeeps), String(t.improve.realMissed), String(t.improve.modelCalls + t.improve.metricRuns), "-", "-"]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  return [pad(head, widths), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map((row) => pad(row, widths))].join("\n");
}

// Problems that make --check fail: false keeps up, or real gains down by more than the tolerance, in either mode.
// Results from a different bench (other seeds or round counts) can't be compared and fail too.
export function checkResults(r: Results, base: Results): string[] {
  if (JSON.stringify(r.seeds) !== JSON.stringify(base.seeds) || JSON.stringify(r.rounds) !== JSON.stringify(base.rounds) || r.prompt.length !== base.prompt.length || r.improve.length !== base.improve.length) {
    return [`These results ran a different bench from the baseline (seeds ${r.seeds.join(",")} vs ${base.seeds.join(",")}, ${r.prompt.length + r.improve.length} runs vs ${base.prompt.length + base.improve.length}). Run the full bench: npm run bench -- --check`];
  }
  const problems: string[] = [];
  const now = r.totals, was = base.totals;
  if (now.prompt.falseKeeps > was.prompt.falseKeeps + TOLERANCE.falseKeeps) problems.push(`prompt mode kept ${now.prompt.falseKeeps} neutral or trap edits, up from ${was.prompt.falseKeeps} (tolerance ${TOLERANCE.falseKeeps})`);
  if (now.prompt.gainsKept < was.prompt.gainsKept - TOLERANCE.realGains) problems.push(`prompt mode kept ${now.prompt.gainsKept} real gains, down from ${was.prompt.gainsKept} (tolerance ${TOLERANCE.realGains})`);
  if (now.improve.falseKeeps > was.improve.falseKeeps + TOLERANCE.falseKeeps) problems.push(`improve mode kept ${now.improve.falseKeeps} noise or gaming changes, up from ${was.improve.falseKeeps} (tolerance ${TOLERANCE.falseKeeps})`);
  if (now.improve.realKept < was.improve.realKept - TOLERANCE.realGains) problems.push(`improve mode kept ${now.improve.realKept} real fixes, down from ${was.improve.realKept} (tolerance ${TOLERANCE.realGains})`);
  return problems;
}

// One number for `npm run bench -- --score`, so Synthe can measure itself (synthe.self.json): real gains kept,
// minus a heavier cost for every false keep. A false keep costs more than a gain earns, so a change that keeps
// one more gain only by also keeping one more trap lowers the score.
export const FALSE_KEEP_COST = 2;
export function scoreOf(r: Results): number {
  const gains = r.totals.prompt.gainsKept + r.totals.improve.realKept;
  const falseKeeps = r.totals.prompt.falseKeeps + r.totals.improve.falseKeeps;
  return gains - FALSE_KEEP_COST * falseKeeps;
}

// Every task and seed's change from the baseline, so a person can see where a failing check comes from.
export function diffLines(r: Results, base: Results): string[] {
  const lines: string[] = [];
  for (const p of r.prompt) {
    const b = base.prompt.find((x) => x.task === p.task && x.seed === p.seed);
    if (b && (b.gainsKept !== p.gainsKept || b.falseKeeps !== p.falseKeeps)) lines.push(`prompt ${p.task} seed ${p.seed}: real gains ${b.gainsKept} -> ${p.gainsKept}, false keeps ${b.falseKeeps} -> ${p.falseKeeps}`);
  }
  for (const i of r.improve) {
    const b = base.improve.find((x) => x.fixture === i.fixture && x.seed === i.seed);
    if (b && (b.realKept !== i.realKept || b.falseKeeps !== i.falseKeeps)) lines.push(`improve ${i.fixture} seed ${i.seed}: real fixes ${b.realKept} -> ${i.realKept}, false keeps ${b.falseKeeps} -> ${i.falseKeeps}`);
  }
  return lines;
}

// Live mode: the judge and checker calls go to a real model, the writer and the agent stay scripted. It is a
// design that has never been run. It reads only SYNTHE_ANTHROPIC_KEY (Synthe never reads ANTHROPIC_API_KEY),
// refuses unless SYNTHE_BENCH_LIVE=1, prints the plan and an upper cost, and needs the cost typed back. The cap is
// enforced by the model wrapper below, which refuses any call that could take spending past it.
export interface LiveIo { env: NodeJS.ProcessEnv; say(t: string): void; ask(q: string): Promise<string> }

export async function planLive(): Promise<{ calls: number; upperUsd: number }> {
  // The plan comes from the scripted run, which is free: the judge and checker calls it made, scaled up as if every
  // task had run all its rounds, since a live judge may keep a run going longer than the scripted one.
  const r = await runBench({ improve: false });
  let calls = 0, upperUsd = 0;
  for (const p of r.prompt) {
    const scale = r.rounds[p.task] / Math.max(1, p.rounds);
    calls += Math.ceil((p.calls.judge + p.calls.checker) * scale);
    upperUsd += (p.upperUsd.judge + p.upperUsd.checker) * scale;
  }
  return { calls, upperUsd: Math.ceil(upperUsd * LIVE_MARGIN * 100) / 100 };
}

export function cappedModel(inner: Model, capUsd: number): Model & { spent(): number } {
  let spent = 0;
  return {
    spent: () => spent,
    async ask(a) {
      // The most this call could cost: its input, at about four characters a token, and a reply at its full limit.
      const most = costUsd(a.model, { input_tokens: Math.ceil(((a.system?.length ?? 0) + a.user.length) / 4), output_tokens: a.maxTokens });
      if (most === null) throw new Error(`Live bench stopped: ${a.model} has no known price, so the cap can't be kept.`);
      if (spent + most > capUsd) throw new Error(`Live bench stopped before a call that could take spending from $${spent.toFixed(2)} past the $${capUsd.toFixed(2)} you confirmed.`);
      const r = await inner.ask(a);
      if (r.costUsd === null) throw new Error("Live bench stopped: a call's cost was unknown, so the cap can't be kept.");
      spent += r.costUsd;
      return r;
    },
  };
}

export async function runLive(io: LiveIo): Promise<Results | null> {
  if (io.env.SYNTHE_BENCH_LIVE !== "1") {
    io.say("Live mode sends the bench's judge and checker calls to Anthropic and spends real money. It is off unless SYNTHE_BENCH_LIVE=1 is set. Nothing was run.");
    return null;
  }
  const key = io.env.SYNTHE_ANTHROPIC_KEY?.trim();
  if (!key) {
    io.say("Live mode needs SYNTHE_ANTHROPIC_KEY. It never reads ANTHROPIC_API_KEY. Nothing was run.");
    return null;
  }
  const plan = await planLive();
  io.say(`Planned: about ${plan.calls} judge and checker calls across ${PROMPT_TASKS.length} tasks and ${SEEDS.length} seeds; the writer and the agent stay scripted and cost nothing.`);
  io.say(`Upper estimate: $${plan.upperUsd.toFixed(2)}, counting every reply at its full length limit. Spending stops there.`);
  const typed = (await io.ask(`Type "spend up to $${plan.upperUsd.toFixed(2)}" to run: `)).trim();
  if (typed !== `spend up to $${plan.upperUsd.toFixed(2)}`) {
    io.say("That didn't match, so nothing was run.");
    return null;
  }
  const live = cappedModel(anthropicModel(key), plan.upperUsd);
  const r = await runBench({ improve: false, live });
  io.say(`Spent $${live.spent().toFixed(2)}.`);
  return r;
}

export function askLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    let answered = false;
    rl.question(question, (a) => { answered = true; rl.close(); resolve(a); });
    rl.on("close", () => { if (!answered) resolve(""); });
  });
}
