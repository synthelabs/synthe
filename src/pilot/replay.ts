// Replay of one prompt, and the paired comparison of two. Lane: replay and failure discovery.
import { canonicalJson } from "../core/evidence.ts";
import { signP } from "../core/merge-rule.ts";
import { sha256 } from "../core/safety.ts";
import { gradeChecks } from "./checks.ts";
import { PilotError } from "./errors.ts";
import { promptId } from "./ids.ts";
import { turnCount } from "./pack.ts";
import type {
  ArmRun, CaseCheck, CaseRun, ChatMessage, ChatModel, ChatReply, CheckResult, Pack, PackCase, PackMessage, PairedCase, ReplayGateConfig, ReplayReport,
  ReplaySettings, Sha256, Split, SplitTally, TurnRef, TurnRun,
} from "./types.ts";

export interface ReplayArmInput {
  pack: Pack;
  pack_id: Sha256;
  prompt: string;
  settings: ReplaySettings;
  model: ChatModel;
  // Replay only this split. Absent: every case.
  split?: Split;
}

const toChat = (m: PackMessage): ChatMessage => (m.role === "assistant" ? { role: "assistant", text: m.text, tool_calls: m.tool_calls ?? [] } : m);

// Tool name plus canonical arguments: two calls are "the same call" when both match.
const callKey = (name: string, input: unknown): string => `${name}\u0000${canonicalJson(input)}`;
const callName = (key: string): string => key.slice(0, key.indexOf("\u0000"));

// Replays every assistant turn of every case against the recorded history, with recorded tool results only.
// Cases run one after another so the order of model calls is the same for every prompt.
export async function replayArm(input: ReplayArmInput): Promise<ArmRun> {
  const { pack, settings, model } = input;
  const counter = { calls: 0 };
  const cases: CaseRun[] = [];
  for (const c of pack.cases) {
    if (input.split !== undefined && c.split !== input.split) continue;
    cases.push(await replayCase(c, input, counter));
  }
  return { prompt_id: promptId(input.prompt), pack_id: input.pack_id, settings, model_destination: model.destination, cases, model_calls: counter.calls };
}

interface Recorded { name: string; key: string; result: string; is_error?: boolean; used: boolean }

async function replayCase(c: PackCase, input: ReplayArmInput, counter: { calls: number }): Promise<CaseRun> {
  const { pack, settings, model, prompt } = input;
  const userAt = c.messages.flatMap((m, i) => (m.role === "user" ? [i] : []));
  const turns: TurnRun[] = [];
  let stopped: CaseRun["stopped"] = null;

  for (let n = 1; n <= userAt.length; n++) {
    const checks = c.checks.filter((k) => k.turn === n);
    const start = userAt[n - 1];
    const end = userAt[n] ?? c.messages.length;
    const recordedTurn = c.messages.slice(start + 1, end);
    const toolsBefore = c.messages.slice(0, start).flatMap((m) => (m.role === "assistant" ? (m.tool_calls ?? []).map((t) => t.name) : []));

    // Recorded results available to this turn, keyed by the call they answered.
    const calls = new Map<string, { name: string; input: unknown }>();
    const recorded: Recorded[] = [];
    const recordedCalls: string[] = [];
    for (const m of recordedTurn) {
      if (m.role === "assistant") for (const t of m.tool_calls ?? []) { calls.set(t.id, { name: t.name, input: t.input }); recordedCalls.push(callKey(t.name, t.input)); }
      else if (m.role === "tool") {
        const call = calls.get(m.tool_call_id);
        if (call) recorded.push({ name: call.name, key: callKey(call.name, call.input), result: m.result, ...(m.is_error === undefined ? {} : { is_error: m.is_error }), used: false });
      }
    }

    const messages: ChatMessage[] = c.messages.slice(0, start + 1).map(toChat);
    const requested: string[] = [];
    const requestedKeys: string[] = [];
    let reply: string | null = null;
    let problem: { why: "unsupported" | "inconclusive"; detail: string } | null = null;

    for (let step = 1; step <= settings.max_steps_per_turn && !reply && !problem; step++) {
      counter.calls++;
      let r: ChatReply;
      try {
        r = await model.chat({ purpose: "replay", model: settings.model, system: prompt, messages: [...messages], tools: pack.tools, max_tokens: settings.max_tokens, temperature: settings.temperature });
      } catch (e) {
        // Budget and approval refusals are the lead's to see; any other failure only makes this turn unusable.
        if (e instanceof PilotError) throw e;
        problem = { why: "inconclusive", detail: "the model call failed" };
        break;
      }
      if (r.stop === "tool_use" && r.tool_calls.length > 0) {
        for (const t of r.tool_calls) { requested.push(t.name); requestedKeys.push(callKey(t.name, t.input)); }
        const results: ChatMessage[] = [];
        for (const t of r.tool_calls) {
          const hit = recorded.find((x) => !x.used && x.key === callKey(t.name, t.input));
          if (!hit) { problem = { why: "unsupported", detail: `requested ${t.name} with arguments the recording has no result for` }; break; }
          hit.used = true;
          results.push({ role: "tool", tool_call_id: t.id, name: t.name, result: hit.result, ...(hit.is_error === undefined ? {} : { is_error: hit.is_error }) });
        }
        if (problem) break;
        messages.push({ role: "assistant", text: r.text, tool_calls: r.tool_calls }, ...results);
      } else if (r.stop === "end" && r.text.trim() !== "") {
        reply = r.text;
      } else {
        problem = { why: "inconclusive", detail: inconclusiveWhy(r.stop, r.text, r.tool_calls.length) };
      }
    }
    if (!reply && !problem) problem = { why: "inconclusive", detail: `the turn used all ${settings.max_steps_per_turn} model call${settings.max_steps_per_turn === 1 ? "" : "s"} allowed without a final reply` };

    const graded = gradeChecks(checks, { reply, tools_requested: requested, tools_before: toolsBefore });
    const digest = reply === null ? null : sha256(reply);
    if (stopped) {
      // The case already left the recording, so this turn is not part of the paired comparison. It is still
      // replayed, against the recorded history, so that a guard on a later turn is never skipped just because
      // an earlier turn changed.
      turns.push({ turn: n, status: "after_stop", tools_requested: requested, checks: graded, reply_sha256: digest });
      continue;
    }
    if (problem) {
      turns.push({ turn: n, status: problem.why, tools_requested: requested, checks: graded, reply_sha256: null });
      stopped = { turn: n, why: problem.why, detail: problem.detail };
      continue;
    }
    turns.push({ turn: n, status: "scored", tools_requested: requested, checks: graded, reply_sha256: digest });

    // Later recorded turns only count in the comparison if this one still follows the recording.
    const diverged = divergence(checks, graded, requestedKeys, recordedCalls, recordedTurn, toolsBefore);
    if (diverged && n < userAt.length) stopped = { turn: n, why: "diverged", detail: diverged };
  }
  return { case_id: c.id, split: c.split, turns, stopped };
}

function inconclusiveWhy(stop: string, text: string, calls: number): string {
  if (stop === "max_tokens") return "the reply was cut off at the token limit";
  if (stop === "refusal") return "the model refused to reply";
  if (stop === "tool_use") return "the model asked for tools but named none";
  if (stop === "end" && text.trim() === "") return "the model returned an empty reply";
  return calls > 0 ? "the model stopped for an unrecognised reason after asking for tools" : "the model stopped for an unrecognised reason";
}

// Null when the replayed turn behaved like the recorded one; otherwise a phrase with tool and check names only.
function divergence(checks: CaseCheck[], graded: CheckResult[], requestedKeys: string[], recordedCalls: string[], recordedTurn: PackMessage[], toolsBefore: string[]): string | null {
  const reasons: string[] = [];
  const a = [...requestedKeys].sort();
  const b = [...recordedCalls].sort();
  if (a.length !== b.length || a.some((k, i) => k !== b[i])) {
    reasons.push(`different tool calls than the recording (replayed: ${names(requestedKeys)}; recorded: ${names(recordedCalls)})`);
  }
  const last = recordedTurn[recordedTurn.length - 1];
  const recordedBehaviour = gradeChecks(checks, {
    reply: last && last.role === "assistant" ? last.text : null,
    tools_requested: recordedCalls.map(callName),
    tools_before: toolsBefore,
  });
  const differing = graded.filter((g, i) => g.pass !== recordedBehaviour[i].pass).map((g) => g.id);
  if (differing.length > 0) reasons.push(`a check result differs from the recording (${[...new Set(differing)].join(", ")})`);
  return reasons.length > 0 ? reasons.join("; ") : null;
}

const names = (keys: string[]): string => (keys.length === 0 ? "none" : keys.map(callName).join(", "));

// ---------------------------------------------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------------------------------------------

export interface PairInput {
  pack: Pack;
  baseline: ArmRun;
  candidate: ArmRun;
  target_check_id: string | null;
  gate: ReplayGateConfig;
}

// What the proposer is told when the only problem sits on cases it must not learn about.
const HIDDEN_PROBLEM = "The change did not hold up on cases you cannot see.";

const emptyTally = (): SplitTally => ({ cases: 0, paired: 0, wins: 0, losses: 0, ties: 0, excluded: 0 });

// A stop that is not "diverged" is a reason the case could not be scored; the earliest one explains an exclusion.
function earliestStop(run: CaseRun): { turn: number; why: "diverged" | "unsupported" | "inconclusive" } | null {
  if (run.stopped) return { turn: run.stopped.turn, why: run.stopped.why };
  const t = run.turns.find((x) => x.status !== "scored");
  if (!t) return null;
  return { turn: t.turn, why: t.status === "unsupported" ? "unsupported" : "inconclusive" };
}

// Pure: the paired report and the review gate, from two arm runs on the same pack with the same settings.
export function pairArms(input: PairInput): ReplayReport {
  const { pack, baseline, candidate, gate } = input;
  const conflict = (message: string): never => { throw new PilotError("conflict", message); };
  if (baseline.pack_id !== candidate.pack_id) conflict("The two replays were run on different packs, so they cannot be compared. Run both on the same pack.");
  if (canonicalJson(baseline.settings) !== canonicalJson(candidate.settings)) conflict("The two replays used different settings, so they cannot be compared. Run both with the same model, token limit, temperature and step limit.");
  // A scripted rehearsal and a provider run are different agents: comparing one prompt on each would measure the
  // model, not the prompt change.
  if (baseline.model_destination !== candidate.model_destination) conflict(`The two replays ran on different models (${baseline.model_destination} and ${candidate.model_destination}), so they cannot be compared. Run both prompts on the same model.`);
  if (baseline.prompt_id === candidate.prompt_id) conflict("The candidate prompt is the same as the baseline prompt, so there is nothing to compare.");
  const packIds = pack.cases.map((c) => c.id).sort();
  for (const [label, arm] of [["baseline", baseline], ["candidate", candidate]] as const) {
    const ids = arm.cases.map((c) => c.case_id).sort();
    if (ids.length !== packIds.length || ids.some((id, i) => id !== packIds[i])) conflict(`The ${label} replay does not cover exactly the cases in the pack. Run it on every case.`);
  }
  const baseRuns = new Map(baseline.cases.map((c) => [c.case_id, c]));
  const candRuns = new Map(candidate.cases.map((c) => [c.case_id, c]));

  const tally = { all: emptyTally(), discovery: emptyTally(), heldout: emptyTally() };
  const paired: PairedCase[] = [];
  const excluded: ReplayReport["coverage"]["excluded"] = [];
  const diverged: ReplayReport["coverage"]["diverged"] = [];
  const regressions: TurnRef[] = [];
  const fixes: TurnRef[] = [];
  const newBlocking: TurnRef[] = [];
  const unchecked: TurnRef[] = [];
  let commonTotal = 0;
  let turnsTotal = 0;

  for (const pc of pack.cases) {
    const b = baseRuns.get(pc.id) as CaseRun;
    const k = candRuns.get(pc.id) as CaseRun;
    const total = turnCount(pc);
    turnsTotal += total;
    const turnOf = (run: CaseRun, n: number): TurnRun | undefined => run.turns.find((t) => t.turn === n);

    let common = 0;
    let basePassed = 0;
    let candPassed = 0;
    let primaryChecks = 0;
    for (let n = 1; n <= total; n++) {
      const bt = turnOf(b, n);
      const kt = turnOf(k, n);
      if (bt?.status === "scored" && kt?.status === "scored") {
        common++;
        for (const r of bt.checks) if (r.role === "primary") { primaryChecks++; if (r.pass === true) basePassed++; }
        for (const r of kt.checks) if (r.role === "primary" && r.pass === true) candPassed++;
      }
      // Check by check. Primary checks are compared only on turns scored for both prompts. Guard checks are
      // compared wherever both prompts were replayed, including turns after one of them left the recording:
      // harm seen there is still harm, and a guard nobody could check is not a pass.
      if (bt && kt) {
        const both = bt.status === "scored" && kt.status === "scored";
        kt.checks.forEach((kr, i) => {
          const br = bt.checks[i];
          if (!br || br.id !== kr.id) return;
          if (!both && kr.role !== "guard") return;
          const ref: TurnRef = { case_id: pc.id, split: pc.split, turn: n, check_id: kr.id, role: kr.role, blocking: kr.blocking };
          if (br.pass === true && kr.pass === false) regressions.push(ref);
          if (br.pass === false && kr.pass === true) fixes.push(ref);
          if (kr.role === "guard" && kr.blocking && kr.pass === false && br.pass !== false) newBlocking.push(ref);
          if (kr.role === "guard" && kr.blocking && kr.pass === null && br.pass !== null) unchecked.push(ref);
        });
      }
    }
    commonTotal += common;

    const cd = k.stopped?.why === "diverged" ? k.stopped : null;
    if (cd) diverged.push({ case_id: pc.id, split: pc.split, turn: cd.turn });

    let entry: PairedCase;
    if (common === 0) {
      const stops = [earliestStop(b), earliestStop(k)].filter((s): s is NonNullable<typeof s> => s !== null);
      // On a tie the reason that is not a divergence is the one that kept the turn from being scored.
      stops.sort((x, y) => x.turn - y.turn || Number(x.why === "diverged") - Number(y.why === "diverged"));
      const first = stops[0];
      const why = first?.why === "unsupported" ? "unsupported" : "inconclusive";
      entry = { case_id: pc.id, split: pc.split, outcome: "excluded", excluded_why: why, common_turns: 0, total_turns: total, baseline_passed: 0, candidate_passed: 0, primary_checks: 0 };
      excluded.push({ case_id: pc.id, split: pc.split, why, turn: first?.turn ?? 1 });
    } else {
      const outcome = candPassed > basePassed ? "win" : candPassed < basePassed ? "loss" : "tie";
      entry = { case_id: pc.id, split: pc.split, outcome, common_turns: common, total_turns: total, baseline_passed: basePassed, candidate_passed: candPassed, primary_checks: primaryChecks };
    }
    paired.push(entry);
    for (const t of [tally.all, tally[pc.split]]) {
      t.cases++;
      if (entry.outcome === "excluded") { t.excluded++; continue; }
      t.paired++;
      if (entry.outcome === "win") t.wins++;
      else if (entry.outcome === "loss") t.losses++;
      else t.ties++;
    }
  }

  // A Map, not a plain object: the outcome names come from the pack file, and a name such as "__proto__" must
  // stay a name.
  const observed = new Map<string, { cases: number; true_or_positive: number }>();
  for (const pc of pack.cases) {
    for (const [key, value] of Object.entries(pc.observed ?? {})) {
      const o = observed.get(key) ?? { cases: 0, true_or_positive: 0 };
      observed.set(key, o);
      if (value === null) continue;
      o.cases++;
      if (value === true || (typeof value === "number" && value > 0)) o.true_or_positive++;
    }
  }
  const sortedObserved: ReplayReport["observed_outcomes"] = Object.fromEntries([...observed].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

  const coverage: ReplayReport["coverage"] = {
    paired_cases: tally.all.cases === 0 ? 0 : tally.all.paired / tally.all.cases,
    common_turns: turnsTotal === 0 ? 0 : commonTotal / turnsTotal,
    excluded, diverged,
  };

  const verdict = judge({ pack, gate, tally, coverage, fixes, newBlocking, unchecked, regressions, paired, target: input.target_check_id, p: signP(tally.all.wins, tally.all.losses) });

  return {
    version: 1, pack_id: baseline.pack_id, baseline_prompt_id: baseline.prompt_id, candidate_id: candidate.prompt_id,
    target_check_id: input.target_check_id, settings: baseline.settings,
    model_destination: baseline.model_destination,
    baseline, candidate, paired, tally, coverage,
    sign_p: signP(tally.all.wins, tally.all.losses), regressions, fixes, new_blocking_guard_failures: newBlocking,
    unchecked_blocking_guards: unchecked,
    observed_outcomes: sortedObserved, gate: verdict,
  };
}

interface Judged {
  pack: Pack; gate: ReplayGateConfig; tally: ReplayReport["tally"]; coverage: ReplayReport["coverage"]; fixes: TurnRef[];
  newBlocking: TurnRef[]; unchecked: TurnRef[]; regressions: TurnRef[]; paired: PairedCase[]; target: string | null; p: number;
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;

// The gate, with two renderings of every finding: one for the reviewer, who may see held-out cases, and one for the
// proposer, which is built only from discovery cases so it can never teach the proposer what the held-out cases hold.
function judge(j: Judged): ReplayReport["gate"] {
  const { gate, tally, coverage, fixes, newBlocking, target } = j;
  const reasons: string[] = [];
  const feedback: string[] = [];
  let hidden = false; // a failed condition that discovery cases alone do not explain
  const disc = (r: { split: Split }) => r.split === "discovery";

  // 1. No new blocking guard failure.
  for (const f of newBlocking) {
    reasons.push(`Blocking guard check ${f.check_id} newly fails on case ${f.case_id} at turn ${f.turn}.`);
    if (disc(f)) feedback.push(`Blocking guard check ${f.check_id} newly fails on case ${f.case_id} at turn ${f.turn}. Do not weaken that behaviour.`);
    else hidden = true;
  }

  // 1b. A blocking guard that could not be checked for the candidate is not a pass.
  if (j.unchecked.length > gate.max_unchecked_blocking_guards) {
    reasons.push(`${j.unchecked.length} blocking guard check${j.unchecked.length === 1 ? "" : "s"} could not be checked for the candidate (the gate allows ${gate.max_unchecked_blocking_guards}): ${j.unchecked.slice(0, 5).map((u) => `${u.check_id} on case ${u.case_id} at turn ${u.turn}`).join("; ")}${j.unchecked.length > 5 ? "; and more in the replay record" : ""}.`);
    const seen = j.unchecked.filter(disc);
    for (const u of seen.slice(0, 5)) feedback.push(`Blocking guard check ${u.check_id} could not be checked on case ${u.case_id} at turn ${u.turn}: the reply did not finish or asked for a tool call the conversation does not show.`);
    if (seen.length < j.unchecked.length) hidden = true;
  }

  const discExcluded = coverage.excluded.filter(disc);
  const excludedFeedback = (): void => {
    for (const e of discExcluded) feedback.push(`Case ${e.case_id} could not be compared at turn ${e.turn} (${e.why === "unsupported" ? "the replay asked for a tool call the recording has no result for" : "no usable reply"}). Keep tool calls to the ones the conversation already shows.`);
  };

  // 2 and 3. Enough of the pack must be comparable.
  const fewCases = tally.all.paired < gate.min_paired_cases;
  const lowCoverage = coverage.paired_cases < gate.min_paired_coverage;
  if (fewCases) reasons.push(`Only ${tally.all.paired} of ${tally.all.cases} cases were scored on both prompts; the gate needs at least ${gate.min_paired_cases}.`);
  if (lowCoverage) reasons.push(`${pct(coverage.paired_cases)} of cases (${tally.all.paired} of ${tally.all.cases}) were scored on both prompts; the gate needs at least ${pct(gate.min_paired_coverage)}.`);
  if ((fewCases || lowCoverage) && discExcluded.length === 0) hidden = true;

  // 4. Net wins.
  const net = tally.all.wins - tally.all.losses;
  if (net < gate.min_net_wins) {
    reasons.push(`Wins minus losses is ${net}; the gate needs at least ${gate.min_net_wins}.`);
    const discNet = tally.discovery.wins - tally.discovery.losses;
    const lost = j.paired.filter((p) => p.split === "discovery" && p.outcome === "loss");
    for (const p of lost) feedback.push(`The change did worse on case ${p.case_id}: it passes fewer checks than the current prompt there.`);
    if (discNet < gate.min_net_wins) {
      if (lost.length === 0) feedback.push("The change did not improve enough of the cases you can see. Aim at the failing checks in the examples.");
    } else hidden = true;
  }

  // 5. Held-out cases must not lose.
  if (tally.heldout.wins < tally.heldout.losses) {
    reasons.push(`On held-out cases the candidate lost ${tally.heldout.losses} and won ${tally.heldout.wins}; held-out wins must be at least held-out losses.`);
    hidden = true;
  }

  // 5b. With no held-out case compared, nothing shows the change holds beyond the cases the proposer saw.
  if (tally.heldout.paired === 0) {
    reasons.push("No held-out case was scored on both prompts, so nothing checks the change on cases the proposer did not see. Add held-out cases to the pack.");
    hidden = true;
  }

  // 6. The target check must be fixed somewhere.
  if (target !== null && !fixes.some((f) => f.check_id === target)) {
    reasons.push(`The target check ${target} was not fixed on any case.`);
    feedback.push(`Check ${target} was not fixed on any case you can see.`);
  }

  const eligible = reasons.length === 0;
  if (eligible) {
    reasons.push(`Every gate condition holds: ${tally.all.wins} wins, ${tally.all.losses} losses and ${tally.all.ties} ties over ${tally.all.paired} paired cases (sign test p = ${j.p.toFixed(4)}), no new blocking guard failure, and held-out cases did not lose.`);
    return { eligible, reasons, proposer_feedback: [`The change passed the replay gate on the cases you can see (${tally.discovery.wins} wins, ${tally.discovery.losses} losses).`] };
  }
  // Cases the proposer can see that could not be compared, and regressions on them, help even when they are not
  // what blocked the gate.
  excludedFeedback();
  for (const r of j.regressions) if (disc(r) && !r.blocking) feedback.push(`Check ${r.check_id} passed before and fails now on case ${r.case_id} at turn ${r.turn}.`);
  if (hidden) feedback.push(HIDDEN_PROBLEM);
  return { eligible, reasons, proposer_feedback: [...new Set(feedback)] };
}

// ---------------------------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------------------------

// Markdown for the operator. Case ids, turns, check ids and catalog sentences only: no conversation text.
export function renderReplay(report: ReplayReport, pack: Pack, replayId: Sha256): string {
  const say = (id: string): string => pack.check_catalog[id] ?? "(no description in the pack)";
  const row = (name: string, t: SplitTally): string => `| ${name} | ${t.cases} | ${t.paired} | ${t.wins} | ${t.losses} | ${t.ties} | ${t.excluded} |`;
  const ref = (r: TurnRef): string => `- case ${r.case_id}, turn ${r.turn}, check ${r.check_id} (${r.role}${r.blocking ? ", blocking" : ""}): ${say(r.check_id)}`;
  const s = report.settings;
  const out: string[] = [];
  out.push(`# Replay ${replayId}`, "");
  out.push("## What was compared", "");
  out.push(`- Replay id: ${replayId}`, `- Pack: ${report.pack_id}`, `- Baseline prompt: ${report.baseline_prompt_id}`, `- Candidate prompt: ${report.candidate_id}`);
  out.push(`- Target check: ${report.target_check_id ?? "none"}`);
  out.push(`- Model: ${s.model}, at most ${s.max_tokens} tokens, temperature ${s.temperature === null ? "default" : s.temperature}, at most ${s.max_steps_per_turn} model calls per turn`);
  out.push(`- Model destination: ${report.model_destination}`);
  out.push(`- Model calls: ${report.baseline.model_calls} baseline, ${report.candidate.model_calls} candidate`, "");
  out.push("## Cases by split", "", "| Split | Cases | Paired | Wins | Losses | Ties | Excluded |", "|---|---|---|---|---|---|---|");
  out.push(row("all", report.tally.all), row("discovery", report.tally.discovery), row("held-out", report.tally.heldout), "");
  out.push("## Coverage", "");
  out.push(`- Paired cases: ${report.tally.all.paired} of ${report.tally.all.cases} (${pct(report.coverage.paired_cases)})`);
  out.push(`- Common turns: ${pct(report.coverage.common_turns)} of all assistant turns in the pack`);
  out.push(`- Excluded cases: ${report.coverage.excluded.length === 0 ? "none" : ""}`);
  for (const e of report.coverage.excluded) out.push(`  - ${e.case_id} (${e.split}): ${e.why} at turn ${e.turn}`);
  out.push(`- Cases where the candidate left the recording: ${report.coverage.diverged.length === 0 ? "none" : ""}`);
  for (const d of report.coverage.diverged) out.push(`  - ${d.case_id} (${d.split}): diverged at turn ${d.turn}`);
  out.push("", `Sign test p (one-sided, wins against losses, ties left out): ${report.sign_p.toFixed(4)}`, "");
  out.push("## Regressions", "");
  out.push(...(report.regressions.length === 0 ? ["None: no check passed on the baseline and failed on the candidate."] : report.regressions.map(ref)));
  out.push("", "## Fixes", "");
  out.push(...(report.fixes.length === 0 ? ["None."] : report.fixes.map(ref)));
  out.push("", "## Guard outcomes", "");
  const guards = new Map<string, { base: [number, number, number]; cand: [number, number, number] }>();
  for (const [which, arm] of [["base", report.baseline], ["cand", report.candidate]] as const) {
    for (const c of arm.cases) for (const t of c.turns) for (const r of t.checks) {
      if (r.role !== "guard") continue;
      const g = guards.get(r.id) ?? { base: [0, 0, 0] as [number, number, number], cand: [0, 0, 0] as [number, number, number] };
      g[which][r.pass === true ? 0 : r.pass === false ? 1 : 2]++;
      guards.set(r.id, g);
    }
  }
  if (guards.size === 0) out.push("No guard checks in this pack.");
  for (const [id, g] of [...guards].sort(([x], [y]) => x.localeCompare(y))) {
    out.push(`- ${id}: baseline passed ${g.base[0]}, failed ${g.base[1]}, undecided ${g.base[2]}; candidate passed ${g.cand[0]}, failed ${g.cand[1]}, undecided ${g.cand[2]}. ${say(id)}`);
  }
  out.push("", report.new_blocking_guard_failures.length === 0 ? "New blocking guard failures: none." : "New blocking guard failures:");
  out.push(...report.new_blocking_guard_failures.map(ref));
  out.push("", report.unchecked_blocking_guards.length === 0 ? "Blocking guard checks that could not be checked for the candidate: none." : "Blocking guard checks that could not be checked for the candidate:");
  out.push(...report.unchecked_blocking_guards.map(ref));
  out.push("", "## Gate", "", `Verdict: ${report.gate.eligible ? "eligible for review" : "not eligible for review"}`, "");
  out.push(...report.gate.reasons.map((r) => `- ${r}`));
  out.push("", "## Historical outcomes of the real conversations (not replay results)", "");
  out.push("These counts come from what happened to the real conversations under the old prompt. They are not produced by this replay and the gate does not use them.", "");
  const keys = Object.keys(report.observed_outcomes);
  out.push(...(keys.length === 0 ? ["No observed outcomes in the pack."] : keys.map((k) => `- ${k}: ${report.observed_outcomes[k].true_or_positive} true or positive of ${report.observed_outcomes[k].cases} cases with a value`)));
  out.push("", "Replay shows checks on recorded conversations. It is not an estimate of business impact.", "");
  return out.join("\n");
}
