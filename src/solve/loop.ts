import { execFileSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { decide } from "./decide.ts";
import { applyProposal, artifactFiles } from "./edits.ts";
import { appendHistory, readHistory } from "./history.ts";
import { failedGuard, measure, type Split } from "./measure.ts";
import { writeReport } from "./report.ts";
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
export type Proposed = { ok: true; proposals: Proposal[] } | { ok: false; reason: string };
// One measurement of the checkout as it is now. `value` goes to the report; `samples` is opaque to the loop and
// goes back to decide() as is.
export type Measured = { ok: true; value: number; samples?: unknown } | { ok: false; reason: string };
type Ok = Measured & { ok: true };
// `strength` ranks the proposals of one round that pass the rule: the highest is kept.
export interface StepDecision { keep: boolean; reason: string; strength?: number }

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
  say?(line: string): void;
}

export interface LoopOptions {
  maxRounds: number;
  maxCalls?: number | null;
  candidates?: number;
  // Rounds in a row that keep nothing before the run stops.
  patience?: number;
  history?: Attempt[];
}

export interface LoopResult { stopped: string; baseline: number; final: number; attempts: Attempt[]; rounds: number; keptAny: boolean }

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export async function runLoop(steps: LoopSteps, options: LoopOptions): Promise<LoopResult> {
  const say = steps.say ?? (() => {});
  const candidates = Math.max(1, options.candidates ?? 1);
  const patience = options.patience ?? MAX_MISSES;
  const earlier = options.history ?? [];
  const attempts: Attempt[] = [];

  const start = await steps.guards();
  if (!start.ok) throw new SetupError(`${start.reason} This is before any change, so no change can be judged. Fix the guard first.`);
  const first = await steps.measure();
  if (!first.ok) throw new SetupError(`Could not measure the starting point: ${first.reason}`);
  let current: Ok = first;
  say(`Starting score: ${first.value}.`);

  const record = async (attempt: Attempt) => {
    attempts.push(attempt);
    await steps.record?.(attempt);
    say(`Round ${attempt.round}: ${attempt.summary || "(no summary)"}: ${attempt.kept ? "kept" : "not kept"}. ${attempt.reason}`);
  };

  let stopped = `Reached the round limit (${plural(options.maxRounds, "round")}).`;
  let idle = 0;
  let round = 0;
  let keptAny = false;
  while (true) {
    if (round >= options.maxRounds) break;
    if (options.maxCalls != null && steps.calls && steps.calls() >= options.maxCalls) {
      stopped = `Reached the model call limit (${plural(options.maxCalls, "call")}).`;
      break;
    }
    const proposed = await steps.propose(round + 1, [...earlier, ...attempts], candidates);
    if (proposed.ok && proposed.proposals.length === 0) {
      stopped = "The proposer had nothing more to try.";
      break;
    }
    round++;
    let kept = false;
    if (!proposed.ok) {
      await record({ round, summary: "", kept: false, reason: `The proposal failed: ${proposed.reason}` });
    } else {
      const next = await tryRound(steps, round, proposed.proposals.slice(0, candidates), current, record);
      if (next) { current = next; kept = true; keptAny = true; }
    }
    idle = kept ? 0 : idle + 1;
    if (idle >= patience) {
      stopped = `${plural(patience, "round")} in a row kept nothing.`;
      break;
    }
  }
  return { stopped, baseline: first.value, final: current.value, attempts, rounds: round, keptAny };
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

export async function solve(problem: Problem, proposer: Proposer, options: SolveOptions, io: SolveIo): Promise<SolveResult> {
  if (isJudged(problem.measure)) throw new SetupError("Judged measures (measure.judge) are not supported by solve yet.");
  const direction = problem.measure.direction;
  let repoRoot: string, gitDir: string;
  try {
    repoRoot = git(problem.dir, "rev-parse", "--show-toplevel");
    gitDir = resolve(problem.dir, git(problem.dir, "rev-parse", "--git-common-dir"));
  } catch {
    throw new SetupError(`${problem.dir} is not inside a git repository. Synthe works in a scratch checkout of a git repository.`);
  }
  const outDir = options.out ? (isAbsolute(options.out) ? options.out : resolve(process.cwd(), options.out)) : join(repoRoot, ".synthe", "solve", problem.name);
  const history: Attempt[] = readHistory(gitDir, problem.name).map((h) => ({ ...h }));

  let scratch: Scratch;
  try {
    scratch = await openScratch(repoRoot, problem.dir, problem.name);
  } catch (e) {
    throw new SetupError(`Could not make the scratch checkout: ${(e as Error).message}`);
  }

  let calls = 0;
  let lastPaths: string[] = [];
  const measureAt = async (split?: Split): Promise<Measurement | { failed: string }> =>
    measure(scratch.dir, problem, { ...(options.seed !== undefined ? { seed: options.seed } : {}), ...(split ? { split } : {}) });
  const holdout = problem.split.holdout;
  const sign = direction === "higher" ? 1 : -1;
  let first = true;

  const steps: LoopSteps = {
    say: io.say,
    calls: () => calls,
    async propose(round, past, candidates) {
      const files = artifactFiles(scratch.root, problem);
      const { reply, calls: used } = await proposer.propose({ round, goal: problem.goal, files, history: past.map(entry), candidates });
      calls += used;
      return "failed" in reply ? { ok: false, reason: reply.failed } : { ok: true, proposals: reply.proposals };
    },
    reset: () => scratch.reset(),
    async apply(proposal) {
      const applied = applyProposal(scratch.root, problem, proposal);
      if ("refused" in applied) return { ok: false, reason: applied.refused };
      if (applied.paths.length === 0) return { ok: false, reason: "The proposal changed no file." };
      lastPaths = applied.paths;
      return { ok: true };
    },
    async guards() {
      const failed = await failedGuard(scratch.dir, problem);
      return failed === null ? { ok: true } : { ok: false, reason: `The guard \`${failed}\` failed.` };
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
      first = false;
      return { ok: true, value: train.value, samples: sample };
    },
    async decide(kept, cand) {
      const k = kept.samples as Sample, c = cand.samples as Sample;
      const onTrain: Decision = decide(direction, k.train, c.train);
      const strength = sign * (c.train.value - k.train.value);
      if (!onTrain.keep || !holdout) return { ...onTrain, strength };
      // The candidate is still in the checkout, so its holdout number is measured now, and only now.
      const now = await measureAt("holdout");
      if ("failed" in now) return { keep: false, reason: `Could not measure the held-back split: ${now.failed}` };
      c.holdout = now;
      const onHoldout = decide(direction, k.holdout!, now);
      // No holdout numbers in the reason: it goes to the proposer's history.
      if (!onHoldout.keep) return { keep: false, reason: "It won on the train split but not on the held-back split, so it does not generalize." };
      return { keep: true, reason: `${onTrain.reason} It also won on the held-back split.`, strength };
    },
    async keep(proposal, round) {
      await scratch.commit(lastPaths, `synthe solve ${problem.name}, round ${round}: ${proposal.summary || "change"}`.slice(0, 200));
    },
    record(attempt) {
      appendHistory(gitDir, problem.name, [entry(attempt)]);
    },
  };
  let result: LoopResult;
  try {
    result = await runLoop(steps, { maxRounds: problem.budget.max_rounds, maxCalls: problem.budget.max_calls, candidates: problem.candidates, history });
  } catch (e) {
    await scratch.close(false);
    throw e;
  }
  await scratch.close(result.keptAny);
  const solved: SolveResult = {
    problem: problem.name,
    stopped: result.stopped,
    baseline: result.baseline,
    final: result.final,
    branch: result.keptAny ? scratch.branch : null,
    attempts: result.attempts,
  };
  writeReport(outDir, solved);
  io.say(`Wrote ${join(outDir, "result.json")} and report.md.`);
  if (solved.branch) io.say(`Kept changes are on the branch ${solved.branch}.`);
  return solved;
}
