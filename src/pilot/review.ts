// The review bundle a person reads before the customer-run experiment. Lane: evidence and review workflow.
import { PilotError } from "./errors.ts";
import { candidateTag, promptId, reviewBranch, shortId } from "./ids.ts";
import type { Candidate, ExperimentSpec, Pack, PilotConfig, ReplayReport, ReviewBundle, Sha256, Stored, TurnRef } from "./types.ts";

const CONTEXT = 3;

// Lines keep their terminator, so a missing final newline shows up as a change instead of vanishing.
const linesOf = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

type Op = { t: " " | "-" | "+"; line: string };

function lineOps(a: string[], b: string[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  // Longest common subsequence table over the part that differs.
  const w = y.length + 1;
  const lcs = new Uint32Array((x.length + 1) * w);
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const ops: Op[] = a.slice(0, head).map((line) => ({ t: " ", line }));
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { ops.push({ t: " ", line: x[i] }); i++; j++; }
    else if (j >= y.length || (i < x.length && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) ops.push({ t: "-", line: x[i++] });
    else ops.push({ t: "+", line: y[j++] });
  }
  for (const line of a.slice(a.length - tail)) ops.push({ t: " ", line });
  return ops;
}

const rendered = (line: string) => (line.endsWith("\n") ? line.slice(0, -1) : `${line}\n\\ No newline at end of file`);

// Unified diff of the prompt file.
export function promptDiff(path: string, before: string, after: string): string {
  if (before === after) return "";
  const ops = lineOps(linesOf(before), linesOf(after));
  const changed: number[] = [];
  ops.forEach((o, i) => { if (o.t !== " ") changed.push(i); });
  const out = [`--- a/${path}`, `+++ b/${path}`];
  let k = 0;
  while (k < changed.length) {
    // Changes whose context would touch share one hunk.
    let last = changed[k];
    let m = k + 1;
    while (m < changed.length && changed[m] - last <= 2 * CONTEXT) last = changed[m++];
    const from = Math.max(0, changed[k] - CONTEXT);
    const to = Math.min(ops.length, last + CONTEXT + 1);
    let oldStart = 1;
    let newStart = 1;
    for (let i = 0; i < from; i++) { if (ops[i].t !== "+") oldStart++; if (ops[i].t !== "-") newStart++; }
    const slice = ops.slice(from, to);
    const oldCount = slice.filter((o) => o.t !== "+").length;
    const newCount = slice.filter((o) => o.t !== "-").length;
    // A side with no lines is named by the line before the hunk, as other diff tools do.
    const range = (start: number, count: number) => `${count === 0 ? start - 1 : start}${count === 1 ? "" : `,${count}`}`;
    out.push(`@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@`);
    for (const o of slice) out.push(`${o.t}${rendered(o.line)}`);
    k = m;
  }
  return `${out.join("\n")}\n`;
}

const conflict = (what: string): never => { throw new PilotError("conflict", `The review inputs disagree: ${what}. Rebuild the replay, experiment and candidate from the same prompt and config.`); };

// Throws PilotError replay_gate_failed when the replay gate did not pass: such a candidate has no review bundle.
export function buildReviewBundle(input: {
  config: PilotConfig; config_id: Sha256; candidate: Candidate; baseline_prompt: string; candidate_prompt: string;
  replay: Stored<ReplayReport>; experiment: Stored<ExperimentSpec>;
}): ReviewBundle {
  const { config, candidate, replay, experiment } = input;
  const r = replay.value;
  const e = experiment.value;
  if (r.gate.eligible !== true) {
    throw new PilotError("replay_gate_failed", `This candidate did not pass the replay gate, so it has no review bundle: ${r.gate.reasons.join("; ") || "no reason recorded"}.`);
  }
  const candidateId = promptId(input.candidate_prompt);
  const baselineId = promptId(input.baseline_prompt);
  if (candidate.prompt_id !== candidateId) conflict("the candidate prompt text does not match the candidate's prompt id");
  if (r.candidate_id !== candidateId) conflict("the replay was run for a different candidate");
  if (e.arms.candidate.prompt_id !== candidateId) conflict("the experiment's candidate arm is a different prompt");
  if (candidate.baseline_prompt_id !== baselineId) conflict("the baseline prompt text does not match the candidate's baseline prompt id");
  if (r.baseline_prompt_id !== baselineId) conflict("the replay was run against a different baseline prompt");
  if (e.arms.baseline.prompt_id !== baselineId) conflict("the experiment's baseline arm is a different prompt");
  if (e.rollback.prompt_id !== baselineId) conflict("the experiment would roll back to a prompt other than the baseline");
  if (e.config_id !== input.config_id) conflict("the experiment was written for a different pilot config");
  if (candidate.pilot_id !== config.pilot_id || e.pilot_id !== config.pilot_id) conflict("the candidate or experiment belongs to a different pilot");

  const copy = <T>(v: T): T => structuredClone(v);
  return {
    version: 1,
    pilot_id: config.pilot_id,
    config_id: input.config_id,
    candidate_id: candidateId,
    baseline_prompt_id: baselineId,
    pack_id: r.pack_id,
    replay_id: replay.id,
    experiment_id: experiment.id,
    repo: { slug: config.repo.slug, base: config.repo.base, prompt_path: config.agent.prompt_path, branch: reviewBranch(candidateId) },
    diff: promptDiff(config.agent.prompt_path, input.baseline_prompt, input.candidate_prompt),
    rationale: candidate.rationale,
    metric: copy(config.metric),
    replay: {
      tally: copy(r.tally),
      coverage: { paired_cases: r.coverage.paired_cases, common_turns: r.coverage.common_turns, excluded: r.coverage.excluded.length, diverged: r.coverage.diverged.length },
      sign_p: r.sign_p,
      regressions: copy(r.regressions),
      fixes: r.fixes.length,
      new_blocking_guard_failures: copy(r.new_blocking_guard_failures),
      gate: { eligible: r.gate.eligible, reasons: [...r.gate.reasons] },
    },
    experiment: copy({ arms: e.arms, allocation: e.allocation, window: e.window, analysis_cutoff: e.analysis_cutoff, required_per_arm: e.required_per_arm, methods: e.methods }),
    rollback: copy(e.rollback),
  };
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
const sentence = (pack: Pack, checkId: string) => pack.check_catalog[checkId] ?? "(no sentence in the pack's check catalog)";
const refLine = (pack: Pack, t: TurnRef) => `- case ${t.case_id}, turn ${t.turn}, check ${t.check_id}: ${sentence(pack, t.check_id)}`;

// Markdown used for REVIEW.md and for the pull request body. It holds ids, counts, check ids, catalog sentences and
// the prompt diff, and no conversation text: the pack is read only for its catalog.
// `targetCheckId` is the check the candidate was written to fix (ReplayReport.target_check_id); the bundle does not
// carry it, so the caller passes it when it has one.
export function renderReview(bundle: ReviewBundle, reviewId: Sha256, pack: Pack, targetCheckId: string | null = null): string {
  const m = bundle.metric;
  const rp = bundle.replay;
  const ex = bundle.experiment;
  const tallyRow = (name: string, t: ReviewBundle["replay"]["tally"]["all"]) => `| ${name} | ${t.cases} | ${t.paired} | ${t.wins} | ${t.losses} | ${t.ties} | ${t.excluded} |`;
  const why: string[] = [bundle.rationale.trim() === "" ? "No rationale was recorded." : bundle.rationale.trim()];
  if (targetCheckId !== null && pack.check_catalog[targetCheckId] !== undefined) {
    why.push(`Target behaviour (check ${targetCheckId}): ${pack.check_catalog[targetCheckId]}`);
  } else {
    const named = [...new Set(rp.regressions.map((t) => t.check_id))].filter((id) => pack.check_catalog[id] !== undefined);
    if (named.length > 0) why.push(`Checks named in the evidence below: ${named.map((id) => `${id} (${pack.check_catalog[id]})`).join("; ")}`);
  }
  const lines = [
    `# Synthe pilot ${bundle.pilot_id}: candidate ${shortId(bundle.candidate_id)}`,
    "",
    "## What changes",
    "",
    `The system prompt file \`${bundle.repo.prompt_path}\` on \`${bundle.repo.base}\` changes as follows.`,
    "",
    "```diff",
    bundle.diff.replace(/\n$/, ""),
    "```",
    "",
    "## Why",
    "",
    ...why.flatMap((p) => [p, ""]),
    "## Metric contract",
    "",
    `- Primary metric: ${m.primary.name}, ${m.primary.kind}, unit ${m.primary.unit}, ${m.primary.direction.replace(/_/g, " ")}. Smallest effect worth acting on: ${m.primary.min_effect}.`,
    ...m.guards.map((g) => `- Guard: ${g.name}, ${g.kind}, unit ${g.unit}, ${g.direction.replace(/_/g, " ")}. Tolerated harm: ${g.max_harm}. ${g.critical ? "Critical: may stop the experiment early." : "Not critical."}`),
    `- Denominator: ${m.denominator}.`,
    `- Analysis window: ${m.analysis_window_days} days. Outcome lag: ${m.outcome_lag_days} days.`,
    `- Minimum samples per arm: ${m.min_samples_per_arm}.`,
    `- Signed off by ${m.signed_off.by} at ${m.signed_off.at}.`,
    "",
    "## Replay evidence",
    "",
    "| Split | Cases | Paired | Wins | Losses | Ties | Excluded |",
    "|---|---|---|---|---|---|---|",
    tallyRow("all", rp.tally.all), tallyRow("discovery", rp.tally.discovery), tallyRow("heldout", rp.tally.heldout),
    "",
    `- Paired-case coverage: ${pct(rp.coverage.paired_cases)}.`,
    `- Common-turn coverage: ${pct(rp.coverage.common_turns)}.`,
    `- Cases excluded: ${rp.coverage.excluded}. Cases where the candidate left the recording: ${rp.coverage.diverged}.`,
    `- Sign test p (one-sided, wins against losses, ties left out): ${rp.sign_p < 0.0001 ? "below 0.0001" : rp.sign_p.toFixed(4)}.`,
    `- Checks the candidate fixes: ${rp.fixes}.`,
    `- Regressions (a check the baseline passed and the candidate fails):${rp.regressions.length === 0 ? " none." : ""}`,
    ...rp.regressions.map((t) => refLine(pack, t).replace(/^- /, "  - ")),
    `- New blocking guard failures:${rp.new_blocking_guard_failures.length === 0 ? " none." : ""}`,
    ...rp.new_blocking_guard_failures.map((t) => refLine(pack, t).replace(/^- /, "  - ")),
    `- Gate verdict: ${rp.gate.eligible ? "eligible for review" : "not eligible"}.${rp.gate.reasons.length > 0 ? ` ${rp.gate.reasons.join(" ")}` : ""}`,
    "",
    "Replay shows checks on recorded conversations. It is not an estimate of business impact.",
    "",
    "## Experiment plan",
    "",
    `- Baseline arm: tag \`${ex.arms.baseline.tag}\`, prompt ${ex.arms.baseline.prompt_id}.`,
    `- Candidate arm: tag \`${ex.arms.candidate.tag}\`, prompt ${ex.arms.candidate.prompt_id}.`,
    `- Intended allocation: baseline ${pct(ex.allocation.baseline)}, candidate ${pct(ex.allocation.candidate)}.`,
    `- Window: ${ex.window.start} to ${ex.window.end}. Analysis cutoff: ${ex.analysis_cutoff}.`,
    `- Required conversations per arm: ${ex.required_per_arm}.`,
    `- Keep: ${ex.methods.keep}`,
    `- Revert: ${ex.methods.revert}`,
    `- Hold: ${ex.methods.hold}`,
    `- ${ex.methods.early_stop}`,
    "",
    "The customer's rollout owner runs the traffic split. Synthe never changes traffic.",
    "",
    "## Rollback",
    "",
    `To roll back, serve prompt ${bundle.rollback.prompt_id} (tag \`${bundle.rollback.tag}\`) again.`,
    "",
    bundle.rollback.instructions,
    "",
    "## Identifiers",
    "",
    `- Config: ${bundle.config_id}`,
    `- Pack: ${bundle.pack_id}`,
    `- Replay: ${bundle.replay_id}`,
    `- Candidate: ${bundle.candidate_id}`,
    `- Baseline prompt: ${bundle.baseline_prompt_id}`,
    `- Experiment: ${bundle.experiment_id}`,
    `- Review: ${reviewId}`,
    `- Candidate tag: \`${candidateTag(bundle.candidate_id)}\``,
    "",
    "## To approve",
    "",
    "After you have read this, record your approval with:",
    "",
    "```",
    `node src/pilot/cli.ts approve --candidate ${bundle.candidate_id} --experiment ${bundle.experiment_id} --approver <your name>`,
    "```",
    "",
    "Merging this pull request is a human decision. Synthe does not merge it.",
    "",
  ];
  return lines.join("\n");
}
