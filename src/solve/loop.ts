import { execFileSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { decide, decideWithConfirm, type Remeasure } from "./decide.ts";
import { applyProposal, artifactFiles } from "./edits.ts";
import { meterFor } from "./cost.ts";
import { appendHistory, nextRun, readHistory } from "./history.ts";
import { guardFailure, measure, type Split } from "./measure.ts";
import { commandCompare, judgeOutputs, readCases, runCases, type Compare, type Outputs } from "./judge.ts";
import { modelCompare } from "./model-compare.ts";
import { writeReport } from "./report.ts";
import { stopRunning } from "./run.ts";
import { idleRounds, readRun, type RunRecord, stillRunning, writeRun } from "./resume.ts";
import { openScratch, type Scratch } from "./scratch.ts";
import { isJudged, MAX_MISSES, type Attempt, type Decision, type HistoryEntry, type Measurement, type Problem, type Proposal, type Proposer, type SolveOptions, type SolveResult } from "./types.ts";

export interface SolveIo { say(line: string): void; env: NodeJS.ProcessEnv }

// A failed setup: not in a git repository, a guard that fails on the baseline, a measure that prints no number.
// The CLI prints the message and exits 1.
export class SetupError extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// The loop itself: rounds of propose -> apply -> guards -> measure -> decide -> keep or undo. It knows nothing
// about git, processes or files: solve() below gives it the steps, so this part is tested with fakes.

export type Step = { ok: true } | { ok: false; reason: string };
export type Proposed = { ok: true; proposals: Proposal[] } | { ok: false; reason: string; summary?: string };
// One measurement of the checkout as it is now. `value` goes to the report; `samples` is opaque to the loop and
// goes back to decide() as is.
export type Measured = { ok: true; value: number; samples?: unknown } | { ok: false; reason: string };
type Ok = Measured & { ok: true };
// `strength` ranks the proposals of one round that pass the rule: the highest is kept. `value`, when given, is the
// attempt's "after" number in place of the measured value: a judged measure only has a number for a comparison.
export interface StepDecision { keep: boolean; reason: string; strength?: number; value?: number }

export interface LoopSteps {
  // `history` holds every earlier attempt, from earlier runs too.
  propose(round: number, history: Attempt[], candidates: number): Promise<Proposed>;
  // Puts the checkout back to the last kept state.
  reset(): Promise<void>;
  apply(proposal: Proposal): Promise<Step>;
  guards(): Promise<Step>;
  measure(): Promise<Measured>;
  decide(kept: Ok, candidate: Ok): Promise<StepDecision> | StepDecision;
  // Commits the change that is in the checkout now as the new kept state.
  keep(proposal: Proposal, round: number): Promise<void>;
  // Stores one finished attempt, so a later run sees it (P12).
  record?(attempt: Attempt): Promise<void> | void;
  // Model calls used so far.
  calls?(): number;
  // A plain reason to stop before the next model call (budget.max_usd), or null.
  budget?(): string | null;
  say?(line: string): void;
}

export interface LoopOptions {
  maxRounds: number;
  maxCalls?: number | null;
  candidates?: number;
  // Rounds in a row that keep nothing before the run stops.
  patience?: number;
  history?: Attempt[];
  // A resumed run (solve --resume): the rounds it already finished, their attempts, the rounds in a row at their
  // end that kept nothing, and the baseline of the first start. The rounds go on from there.
  resume?: { rounds: number; attempts: Attempt[]; idle: number; baseline: number | null };
  // Called after each finished round with every attempt of this run so far, so a stopped run can be resumed.
  onRound?(round: number, attempts: Attempt[]): Promise<void> | void;
}

export interface LoopResult { stopped: string; baseline: number; final: number; attempts: Attempt[]; rounds: number; keptAny: boolean }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export async function runLoop(steps: LoopSteps, options: LoopOptions): Promise<LoopResult> {
  const say = steps.say ?? (() => {});
  const candidates = Math.max(1, options.candidates ?? 1);
  const patience = options.patience ?? MAX_MISSES;
  const earlier = options.history ?? [];
  const attempts: Attempt[] = [];
  const prior = options.resume?.attempts ?? [];

  const start = await steps.guards();
  if (!start.ok) throw new SetupError(`${start.reason} This is before any change, so no change can be judged. Fix the guard first.`);
  const first = await steps.measure();
  if (!first.ok) throw new SetupError(`Could not measure the starting point: ${first.reason}`);
  let current: Ok = first;
  const baseline = options.resume?.baseline ?? first.value;
  say(options.resume ? `Resuming after round ${options.resume.rounds}. Score now: ${first.value} (baseline ${baseline}).` : `Starting score: ${first.value}.`);

  const record = async (attempt: Attempt) => {
    attempts.push(attempt);
    await steps.record?.(attempt);
    say(`Round ${attempt.round}: ${attempt.summary || "(no summary)"}: ${attempt.kept ? "kept" : "not kept"}. ${attempt.reason}`);
  };

  let stopped = `Reached the round limit (${plural(options.maxRounds, "round")}).`;
  let idle = options.resume?.idle ?? 0;
  let round = options.resume?.rounds ?? 0;
  let keptAny = prior.some((a) => a.kept);
  while (true) {
    if (round >= options.maxRounds) break;
    if (idle >= patience) {
      stopped = `${plural(patience, "round")} in a row kept nothing.`;
      break;
    }
    if (options.maxCalls != null && steps.calls && steps.calls() >= options.maxCalls) {
      stopped = `Reached the model call limit (${plural(options.maxCalls, "call")}).`;
      break;
    }
    const overBudget = steps.budget?.() ?? null;
    if (overBudget) { stopped = overBudget; break; }
    const proposed = await steps.propose(round + 1, [...earlier, ...attempts], candidates);
    if (proposed.ok && proposed.proposals.length === 0) {
      stopped = "The proposer had nothing more to try.";
      break;
    }
    round++;
    let kept = false;
    if (!proposed.ok) {
      await record({ round, summary: proposed.summary ?? "", kept: false, reason: `The proposal failed: ${proposed.reason}` });
    } else {
      const next = await tryRound(steps, round, proposed.proposals.slice(0, candidates), current, record);
      if (next) { current = next; kept = true; keptAny = true; }
    }
    idle = kept ? 0 : idle + 1;
    await options.onRound?.(round, [...prior, ...attempts]);
    if (idle >= patience) {
      stopped = `${plural(patience, "round")} in a row kept nothing.`;
      break;
    }
  }
  return { stopped, baseline, final: current.value, attempts: [...prior, ...attempts], rounds: round, keptAny };
}

// Every proposal is tried on the kept state. The round keeps at most one: the strongest that passes the rule.
// Returns the new kept measurement, or null when the round kept nothing.
async function tryRound(steps: LoopSteps, round: number, proposals: Proposal[], current: Ok, record: (a: Attempt) => Promise<void>): Promise<Ok | null> {
  const tried: Attempt[] = [];
  const passed: Attempt[] = [];
  let best: { proposal: Proposal; measured: Ok; strength: number; attempt: Attempt } | null = null;
  for (const proposal of proposals) {
    const attempt: Attempt = { round, summary: typeof proposal?.summary === "string" ? proposal.summary : "", kept: false, reason: "" };
    tried.push(attempt);
    await steps.reset();
    const applied = await steps.apply(proposal);
    if (!applied.ok) { attempt.reason = applied.reason; continue; }
    const guarded = await steps.guards();
    if (!guarded.ok) { attempt.reason = guarded.reason; continue; }
    const measured = await steps.measure();
    if (!measured.ok) { attempt.reason = `Could not measure the change: ${measured.reason}`; continue; }
    attempt.before = current.value;
    attempt.after = measured.value;
    const decision = await steps.decide(current, measured);
    attempt.reason = decision.reason;
    if (decision.value !== undefined) attempt.after = decision.value;
    if (!decision.keep) continue;
    passed.push(attempt);
    const strength = decision.strength ?? 0;
    if (!best || strength > best.strength) best = { proposal, measured, strength, attempt };
  }
  await steps.reset();
  let next: Ok | null = null;
  if (best) {
    const applied = await steps.apply(best.proposal);
    if (applied.ok) {
      await steps.keep(best.proposal, round);
      best.attempt.kept = true;
      next = best.measured;
      for (const a of passed) if (a !== best.attempt) a.reason += " A stronger change in the same round was kept instead.";
    } else {
      best.attempt.reason += ` It could not be applied again: ${applied.reason}`;
      await steps.reset();
    }
  }
  for (const a of tried) await record(a);
  return next;
}

// ---------------------------------------------------------------------------------------------------------------
// One solve run on a real repository.

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

interface Sample { train: Measurement; holdout?: Measurement }

// The proposer only hears the round, summary, kept flag and reason: never a holdout number.
const entry = (a: Attempt): HistoryEntry => ({ round: a.round, summary: a.summary, kept: a.kept, reason: a.reason });

// Ctrl-C, a kill or the terminal closing: clean up, say what is left, and exit 130. Returns the function that
// removes the handlers.
function onInterrupt(cleanUp: () => Promise<void>, say: () => void): () => void {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const stop = () => {
    const exit = () => { say(); process.exit(130); };
    cleanUp().then(exit, exit);
  };
  for (const s of signals) process.once(s, stop);
  return () => { for (const s of signals) process.off(s, stop); };
}

export async function solve(problem: Problem, proposer: Proposer, options: SolveOptions, io: SolveIo): Promise<SolveResult> {
  const judged = isJudged(problem.measure) ? problem.measure.judge : null;
  const direction = isJudged(problem.measure) ? "higher" : problem.measure.direction;
  let repoRoot: string, gitDir: string;
  try {
    repoRoot = git(problem.dir, "rev-parse", "--show-toplevel");
    gitDir = resolve(problem.dir, git(problem.dir, "rev-parse", "--git-common-dir"));
  } catch {
    throw new SetupError(`${problem.dir} is not inside a git repository. Synthe works in a scratch checkout of a git repository.`);
  }
  const outDir = options.out ? (isAbsolute(options.out) ? options.out : resolve(process.cwd(), options.out)) : join(repoRoot, ".synthe", "solve", problem.name);
  const history: Attempt[] = readHistory(gitDir, problem.name).map((h) => ({ ...h }));

  // --resume goes on with the most recent run when it stopped before its own stop rule (GOAL-2.md).
  const last = readRun(gitDir, problem.name);
  let from: RunRecord | null = null;
  if (options.resume) {
    if (last?.status === "running") {
      if (stillRunning(last)) throw new SetupError(`The last run of ${problem.name} is still going (process ${last.pid}). Stop it or let it end, then resume.`);
      from = last;
    } else {
      io.say(last ? `The last run of ${problem.name} ended normally, so --resume starts a new run.` : `There is no earlier run of ${problem.name}, so --resume starts a new run.`);
    }
  }
  const run = from ? from.run : Math.max(nextRun(gitDir, problem.name), (last?.run ?? 0) + 1);

  let scratch: Scratch;
  try {
    scratch = await openScratch(repoRoot, problem.dir, problem.name, from ? { branch: from.branch, base: from.base, head: from.head, staleRoot: from.root } : undefined);
  } catch (e) {
    throw new SetupError(`Could not ${from ? "resume on" : "make"} the scratch checkout: ${(e as Error).message}`);
  }
  if (from) io.say(`Resuming run ${run} of ${problem.name} on ${scratch.branch} after round ${from.rounds}.`);

  const record: RunRecord = {
    run, status: "running", branch: scratch.branch, base: from?.base ?? scratch.base, head: git(scratch.root, "rev-parse", "HEAD"), root: scratch.root,
    pid: process.pid, rounds: from?.rounds ?? 0, calls: from?.calls ?? 0, baseline: from?.baseline ?? null, attempts: from?.attempts ?? [],
  };
  writeRun(gitDir, problem.name, record);

  let calls = record.calls;
  const meter = meterFor(problem);
  let keptCount = record.attempts.filter((a) => a.kept).length;
  let lastPaths: string[] = [];
  let lastProposal: Proposal | null = null;
  const measureAt = async (split?: Split): Promise<Measurement | { failed: string }> =>
    measure(scratch.dir, problem, { ...(options.seed !== undefined ? { seed: options.seed } : {}), ...(split ? { split } : {}) });
  const holdout = problem.split.holdout;
  const sign = direction === "higher" ? 1 : -1;
  let first = true;

  const steps: LoopSteps = {
    say: io.say,
    // The meter also counts judge calls (compare "model"), which the proposer's own count does not see.
    calls: () => Math.max(calls, meter.calls),
    budget: () => meter.stopReason(),
    async propose(round, past, candidates) {
      const files = artifactFiles(scratch.root, problem);
      const { reply, calls: used } = await proposer.propose({ round, goal: problem.goal, files, history: past.map(entry), candidates });
      calls += used;
      if ("failed" in reply) return { ok: false, reason: reply.failed, ...(reply.summary ? { summary: reply.summary } : {}) };
      return { ok: true, proposals: reply.proposals };
    },
    reset: () => scratch.reset(),
    async apply(proposal) {
      const applied = applyProposal(scratch.root, problem, proposal);
      if ("refused" in applied) return { ok: false, reason: applied.refused };
      if (applied.paths.length === 0) return { ok: false, reason: "The proposal changed no file." };
      lastPaths = applied.paths;
      lastProposal = proposal;
      return { ok: true };
    },
    async guards() {
      // The reason names the guard and the lines that say what failed, so the proposer can learn from it.
      const failed = await guardFailure(scratch.dir, problem);
      return failed === null ? { ok: true } : { ok: false, reason: failed.reason };
    },
    async measure() {
      const train = await measureAt(holdout ? "train" : undefined);
      if ("failed" in train) return { ok: false, reason: train.failed };
      const sample: Sample = { train };
      // The first measurement is the baseline: its holdout number is the one every later winner must beat.
      if (holdout && first) {
        const held = await measureAt("holdout");
        if ("failed" in held) return { ok: false, reason: `the held-back split gave no number: ${held.failed}` };
        sample.holdout = held;
      }
      if (first && record.baseline === null) record.baseline = train.value;
      first = false;
      return { ok: true, value: train.value, samples: sample };
    },
    async decide(kept, cand) {
      const k = kept.samples as Sample, c = cand.samples as Sample;
      // The second look of the keep rule (P06): fresh runs of the candidate (in the checkout now), then of the kept
      // state, then the candidate goes back so the holdout step below still finds it in the checkout.
      const proposal = lastProposal!;
      const remeasure: Remeasure = async () => {
        const after = await measureAt(holdout ? "train" : undefined);
        if ("failed" in after) return after;
        await scratch.reset();
        const before = await measureAt(holdout ? "train" : undefined);
        const back = applyProposal(scratch.root, problem, proposal);
        if ("refused" in back) return { failed: `the change could not be applied again: ${back.refused}` };
        lastPaths = back.paths;
        return "failed" in before ? before : { before, after };
      };
      const confirmed = await decideWithConfirm(direction, k.train, c.train, remeasure);
      // More runs of the kept state make every later comparison against it sharper.
      k.train = confirmed.before;
      c.train = confirmed.after;
      const onTrain: Decision = { keep: confirmed.keep, reason: confirmed.reason };
      const strength = sign * (c.train.value - k.train.value);
      if (!onTrain.keep || !holdout) return { ...onTrain, strength };
      // The candidate is still in the checkout, so its holdout number is measured now, and only now.
      const now = await measureAt("holdout");
      if ("failed" in now) {
        // The failure output is held-back data (it can name cases and expected answers), and the reason goes to the
        // proposer's history, result.json and report.md. So only the person sees the details, in Synthe's output.
        io.say(`The held-back measure failed for this change: ${now.failed}`);
        return { keep: false, reason: "It won on the train split, but the held-back measure failed for it, so it is not kept. Synthe's output has the details; the proposer never sees held-back output." };
      }
      c.holdout = now;
      const onHoldout = decide(direction, k.holdout!, now);
      // No holdout numbers in the reason: it goes to the proposer's history.
      if (!onHoldout.keep) return { keep: false, reason: "It won on the train split but not on the held-back split, so it does not generalize." };
      return { keep: true, reason: `${onTrain.reason} It also won on the held-back split.`, strength };
    },
    async keep(proposal, round) {
      await scratch.commit(lastPaths, `synthe solve ${problem.name}, round ${round}: ${proposal.summary || "change"}`.slice(0, 200));
      keptCount++;
    },
    record(attempt) {
      appendHistory(gitDir, problem.name, [entry(attempt)], run);
    },
  };
  // A judged measure has no number for one version alone, only for a comparison. So each version's "measurement"
  // is its outputs, and decide() asks the judge. The numbers in the report are the share of cases the newer
  // version won (a tie is half): 0.5 is the starting point, and `final` compares the last kept version with it.
  let judgeFinal: (() => Promise<number>) | null = null;
  // A model judge's questions are model calls and count against budget.max_calls; a compare command's are not.
  // The limit is checked before each question, not only at the start of a round: one round asks many questions.
  // The check and the count happen before the call is awaited, so parallel questions can not pass the limit.
  const withCallLimit = (ask: Compare): Compare => async (c, a, b) => {
    const max = problem.budget.max_calls;
    if (max != null && calls >= max) return { failed: `the model call limit (${max} calls) was reached, so the model judge was not asked.` };
    calls++;
    return ask(c, a, b);
  };
  if (judged) {
    const cases = readCases(scratch.dir, judged.cases);
    if ("failed" in cases) {
      await scratch.close(false);
      throw new SetupError(`The judged measure could not start: ${cases.failed}`);
    }
    let compareFn: Compare;
    try {
      compareFn = judged.compare === "model" ? withCallLimit(modelCompare(problem, io.env)) : commandCompare(scratch.dir, judged.compare);
    } catch (e) {
      await scratch.close(false);
      throw new SetupError(`The judged measure could not start: ${(e as Error).message}`);
    }
    let baseOutputs: Outputs | null = null;
    steps.measure = async () => {
      const out = await runCases(scratch.dir, judged.run, cases);
      if ("failed" in out) return { ok: false, reason: out.failed };
      baseOutputs ??= out;
      return { ok: true, value: 0.5, samples: out };
    };
    steps.decide = async (kept, cand) => {
      const d = await judgeOutputs(cases, kept.samples as Outputs, cand.samples as Outputs, compareFn);
      return { keep: d.keep, reason: d.reason, strength: d.share, value: d.share };
    };
    judgeFinal = async () => {
      await scratch.reset();
      const out = await runCases(scratch.dir, judged.run, cases);
      if ("failed" in out || !baseOutputs) return 0.5;
      return (await judgeOutputs(cases, baseOutputs, out, compareFn)).share;
    };
  }
  // A crash or a Ctrl-C must leave no scratch worktree and no empty branch. A branch that holds kept changes stays:
  // that work was measured and is worth keeping.
  const cleanUp = async () => { stopRunning(); await scratch.close(keptCount > 0); };
  const unhook = onInterrupt(cleanUp, () => io.say(keptCount > 0
    ? `\nStopped. Synthe removed its scratch checkout. The ${keptCount === 1 ? "change" : `${keptCount} changes`} kept so far ${keptCount === 1 ? "is" : "are"} on the branch ${scratch.branch}. Your working tree did not change.`
    : "\nStopped. Synthe removed its scratch checkout and kept no change. Your working tree did not change."));
  let result: LoopResult;
  let final: number;
  try {
    result = await runLoop(steps, {
      maxRounds: problem.budget.max_rounds, maxCalls: problem.budget.max_calls, candidates: problem.candidates, history,
      ...(from ? { resume: { rounds: from.rounds, attempts: from.attempts, idle: idleRounds(from), baseline: from.baseline } } : {}),
      onRound(round, attempts) {
        Object.assign(record, { rounds: round, calls, attempts, head: git(scratch.root, "rev-parse", "HEAD") });
        writeRun(gitDir, problem.name, record);
      },
    });
    final = judgeFinal && result.keptAny ? await judgeFinal() : result.final;
  } catch (e) {
    await cleanUp();
    throw e;
  } finally {
    unhook();
  }
  await scratch.close(result.keptAny);
  const solved: SolveResult = {
    problem: problem.name,
    stopped: result.stopped,
    baseline: result.baseline,
    final,
    branch: result.keptAny ? scratch.branch : null,
    attempts: result.attempts,
    cost: meter.summary(),
  };
  const unit = judged ? "share of cases won" : isJudged(problem.measure) ? undefined : problem.measure.unit;
  writeReport(outDir, solved, { goal: problem.goal, direction, ...(unit ? { unit } : {}) });
  writeRun(gitDir, problem.name, { ...record, status: "ended" });
  io.say(`Wrote ${join(outDir, "result.json")} and report.md.`);
  if (solved.branch) io.say(`Kept changes are on the branch ${solved.branch}.`);
  return solved;
}
