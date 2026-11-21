// The solve loop: rounds of propose -> apply -> guards -> measure -> decide -> keep or undo.
// It knows nothing about git, processes or files. The CLI gives it the steps (LoopSteps), so each module can be
// tested alone, and this file can be tested with fakes.

export interface Edit { path: string; search: string; replace: string }
export interface Proposal { summary: string; edits: Edit[] }

export interface Attempt {
  round: number;
  summary: string;
  kept: boolean;
  reason: string;
  before?: number;
  after?: number;
}

export type Step = { ok: true } | { ok: false; reason: string };
export type Proposed = { ok: true; proposals: Proposal[] } | { ok: false; reason: string };
// One measurement of the checkout as it is now. `value` is the summary number (for a report); `runs` holds the raw
// numbers that the decision rule needs. `samples` is opaque to the loop: decide() gets it back as is.
export type Measured = { ok: true; value: number; samples?: unknown } | { ok: false; reason: string };
export interface Decision { keep: boolean; reason: string; strength?: number }

export interface LoopSteps {
  // Ask for proposals. `history` holds every earlier attempt, from earlier runs too.
  propose(round: number, history: Attempt[], candidates: number): Promise<Proposed>;
  // Put the checkout back to the last kept state.
  reset(): Promise<void>;
  apply(proposal: Proposal): Promise<Step>;
  guards(): Promise<Step>;
  measure(): Promise<Measured>;
  decide(baseline: Measured & { ok: true }, candidate: Measured & { ok: true }): Promise<Decision> | Decision;
  // Commit the change in the checkout as the new kept state.
  keep(proposal: Proposal, round: number): Promise<void>;
  // Store one attempt so a later run sees it (P12).
  record?(attempt: Attempt): Promise<void> | void;
  // Model calls used so far, when the proposer or judge is a model.
  calls?(): number;
  say?(line: string): void;
}

export interface LoopOptions {
  maxRounds: number;
  maxCalls?: number;
  candidates?: number;
  // Rounds in a row that keep nothing before the run stops.
  patience?: number;
  history?: Attempt[];
}

export interface LoopResult {
  stopped: string;
  baseline: number;
  final: number;
  attempts: Attempt[];
  rounds: number;
}

export class SetupError extends Error {}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export async function runLoop(steps: LoopSteps, options: LoopOptions): Promise<LoopResult> {
  const say = steps.say ?? (() => {});
  const candidates = Math.max(1, options.candidates ?? 1);
  const patience = options.patience ?? 3;
  const earlier = options.history ?? [];
  const attempts: Attempt[] = [];

  const guardsAtStart = await steps.guards();
  if (!guardsAtStart.ok) throw new SetupError(`A guard fails before any change, so no change can be judged: ${guardsAtStart.reason}`);
  const first = await steps.measure();
  if (!first.ok) throw new SetupError(`Could not measure the starting point: ${first.reason}`);
  let current: Measured & { ok: true } = first;
  const baseline = first.value;
  say(`Starting score: ${baseline}.`);

  const record = async (attempt: Attempt) => {
    attempts.push(attempt);
    await steps.record?.(attempt);
    say(`Round ${attempt.round}: ${attempt.summary || "(no summary)"}: ${attempt.kept ? "kept" : "not kept"}. ${attempt.reason}`);
  };

  let stopped = `Reached the round limit (${plural(options.maxRounds, "round")}).`;
  let idle = 0;
  let round = 0;
  while (round < options.maxRounds) {
    if (options.maxCalls !== undefined && steps.calls && steps.calls() >= options.maxCalls) {
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
      kept = await tryRound(steps, round, proposed.proposals.slice(0, candidates), current, (m) => { current = m; }, record);
    }
    idle = kept ? 0 : idle + 1;
    if (idle >= patience) {
      stopped = `${plural(patience, "round")} in a row kept nothing.`;
      break;
    }
  }
  return { stopped, baseline, final: current.value, attempts, rounds: round };
}

type Ok = Measured & { ok: true };

// Every proposal is tried on the kept state. The round keeps at most one: the best that passes the decision rule.
async function tryRound(steps: LoopSteps, round: number, proposals: Proposal[], current: Ok, setCurrent: (m: Ok) => void,
  record: (a: Attempt) => Promise<void>): Promise<boolean> {
  const tried: Attempt[] = [];
  const passed: Attempt[] = [];
  let best: { proposal: Proposal; measured: Ok; strength: number; attempt: Attempt } | null = null;
  for (const proposal of proposals) {
    const attempt: Attempt = { round, summary: typeof proposal?.summary === "string" ? proposal.summary : "", kept: false, reason: "", before: current.value };
    tried.push(attempt);
    await steps.reset();
    const applied = await steps.apply(proposal);
    if (!applied.ok) { attempt.reason = applied.reason; continue; }
    const guarded = await steps.guards();
    if (!guarded.ok) { attempt.reason = guarded.reason; continue; }
    const measured = await steps.measure();
    if (!measured.ok) { attempt.reason = `Could not measure the change: ${measured.reason}`; continue; }
    attempt.after = measured.value;
    const decision = await steps.decide(current, measured);
    attempt.reason = decision.reason;
    if (!decision.keep) continue;
    passed.push(attempt);
    const strength = decision.strength ?? 0;
    if (!best || strength > best.strength) best = { proposal, measured, strength, attempt };
  }
  await steps.reset();
  let kept = false;
  if (best) {
    const applied = await steps.apply(best.proposal);
    if (applied.ok) {
      await steps.keep(best.proposal, round);
      best.attempt.kept = true;
      setCurrent(best.measured);
      kept = true;
    } else {
      best.attempt.reason += ` It could not be applied again: ${applied.reason}`;
      await steps.reset();
    }
    if (kept) for (const a of passed) if (a !== best.attempt) a.reason += " A stronger change in the same round was kept instead.";
  }
  for (const a of tried) await record(a);
  return kept;
}
