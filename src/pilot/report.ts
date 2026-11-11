import { shortId } from "./ids.ts";
import type { Frozen } from "./commands.ts";
import type { PilotStore } from "./store.ts";
import type {
  Approval, BaselineReport, Candidate, ExperimentAnalysis, ExperimentSpec, FailureFinding, Pack, PromotionRecord, ReplayReport, TelemetryImport,
} from "./types.ts";

// The pilot summary: one page that walks the journal in order and cites the stored record behind every line.
// It holds ids, counts and metric numbers only. Each number names its source record and the method that
// produced it, so a reviewer can open that record or recompute it with `verify`.

const num = (v: number | null | undefined, digits = 4): string => (v === null || v === undefined || !Number.isFinite(v) ? "unknown" : String(Number(v.toFixed(digits))));
const cell = (s: string): string => s.replaceAll("|", "\\|").replaceAll("\n", " ");

export function renderPilotReport(store: PilotStore, f: Frozen): string {
  const journal = store.journal();
  const m = f.config.metric;
  const out: string[] = [];
  out.push(`# Pilot ${f.config.pilot_id}: evidence summary`, "");
  out.push("Every line cites the stored record it comes from (`kind:id`). Records are in `objects/<kind>/<id>.json`, named by the SHA-256 of their content. `verify` rechecks every id and recomputes every decision.", "");

  out.push("## 1. Contract (frozen before any change)", "");
  out.push(`- Contract: \`config:${f.config_id}\``);
  out.push(`- Agent: ${f.config.agent.name}; prompt file \`${f.config.agent.prompt_path}\`; baseline prompt \`prompt:${f.baseline_prompt_id}\` at commit \`${f.commit}\`; telemetry tag \`${f.config.agent.baseline_tag}\`.`);
  out.push(`- Primary metric: \`${m.primary.name}\` (${m.primary.kind}; ${m.primary.unit}), ${m.primary.direction.replaceAll("_", " ")}; minimum effect ${m.primary.min_effect}.`);
  for (const g of m.guards) out.push(`- Guard: \`${g.name}\` (${g.kind}; ${g.unit}), ${g.direction.replaceAll("_", " ")}; tolerated harm ${g.max_harm}${g.critical ? "; critical" : ""}${g.early_stop ? `; early stop from ${g.early_stop.min_per_arm} per arm` : ""}.`);
  out.push(`- Denominator: ${m.denominator}. Window ${m.analysis_window_days} days; outcome lag ${m.outcome_lag_days} days; at least ${m.min_samples_per_arm} per arm; alpha ${m.alpha}; power ${m.power}.`);
  out.push(`- Signed off by ${m.signed_off.by} on ${m.signed_off.at}.`, "");

  out.push("## 2. Baseline (from imported telemetry)", "");
  const baselineEntry = journal.filter((e) => e.step === "baseline.reported").at(-1);
  if (!baselineEntry) out.push("No baseline report yet.", "");
  else {
    const b = store.get<BaselineReport>("baseline", baselineEntry.key);
    out.push(`Record \`baseline:${baselineEntry.key}\`, from ${b.telemetry_ids.map((id) => `\`telemetry:${shortId(id)}\``).join(", ")}; window ${b.window.start} to ${b.window.end}; ${b.rows} rows, ${b.mature} mature, ${b.immature} immature.`, "");
    out.push("| Metric | Role | Value | Interval | n | Missing | Source | Method |", "|---|---|---|---|---|---|---|---|");
    for (const x of b.metrics) out.push(`| ${x.name} | ${x.role} | ${num(x.estimate.value)} | ${x.ci ? `${num(x.ci.lo)} to ${num(x.ci.hi)} (${Math.round(x.ci.level * 100)}%)` : "none"} | ${x.n} | ${x.missing} | ${cell(x.estimate.source)} | ${cell(x.estimate.method)} |`);
    out.push(`| daily volume | | ${num(b.daily_volume.value, 1)} | | | | ${cell(b.daily_volume.source)} | ${cell(b.daily_volume.method)} |`);
    out.push(`| needed per arm | | ${num(b.required_per_arm.value, 0)} | | | | ${cell(b.required_per_arm.source)} | ${cell(b.required_per_arm.method)} |`, "");
    if (b.flags.length) out.push(`Flags: ${b.flags.join(", ")}.`, "");
  }

  out.push("## 3. Conversation packs", "");
  for (const e of journal.filter((x) => x.step === "pack.frozen" || x.step === "pack.promoted")) {
    const p = store.get<Pack>("pack", e.refs.pack);
    const held = p.cases.filter((c) => c.split === "heldout").length;
    out.push(`- \`pack:${e.refs.pack}\` version ${p.pack_version}${p.parent_pack_id ? `, promoted from \`pack:${shortId(p.parent_pack_id)}\`` : ""}: ${p.cases.length} cases (${p.cases.length - held} discovery, ${held} held out), ${p.cases.filter((c) => c.regression).length} regression cases. Redaction approved by ${p.source.redaction.approved_by} on ${p.source.redaction.approved_at}. Method: counted from the pack record.`);
  }
  for (const e of journal.filter((x) => x.step === "pack.promoted")) {
    const r = store.get<PromotionRecord>("promotion", e.refs.promotion);
    out.push(`- Promotion \`promotion:${e.refs.promotion}\`: ${r.approver} approved ${r.promoted.length} regression case(s) on ${r.at}: ${r.promoted.map((x) => `${x.case_id} (${x.split}, ${x.kind})`).join(", ")}.`);
  }
  out.push("");

  out.push("## 4. Recurring failures (discovery cases only)", "");
  const findings = journal.filter((e) => e.step === "finding.found");
  if (!findings.length) out.push("None recorded.", "");
  for (const e of findings) {
    const x = store.get<FailureFinding>("finding", e.key);
    out.push(`- \`finding:${e.key}\` on \`pack:${shortId(x.pack_id)}\`: check \`${x.check_id}\` fails in ${x.failing.length} of ${x.discovery_cases_with_check} discovery cases. Method: baseline replay, failed primary checks counted per check id.`);
  }
  out.push("");

  out.push("## 5. Candidates", "");
  for (const e of journal.filter((x) => x.step === "candidate.created")) {
    const c = store.get<Candidate>("candidate", e.refs.candidate);
    out.push(`### Candidate ${shortId(e.key)}`, "");
    out.push(`- \`prompt:${e.key}\`; ${c.origin === "human" ? "written by" : "proposed by"} ${c.author}; ${c.changed_lines} changed line(s)${c.target_check_id ? `; targets \`${c.target_check_id}\`` : ""}.`);
    for (const r of journal.filter((x) => x.step === "replay.paired" && x.refs.candidate === e.key)) {
      const rep = store.get<ReplayReport>("replay", r.key);
      const t = rep.tally.all;
      out.push(`- Replay \`replay:${r.key}\` on \`pack:${shortId(rep.pack_id)}\` (${rep.model_destination}): ${t.paired} of ${t.cases} cases paired, ${t.wins} better, ${t.losses} worse, ${t.ties} the same, ${t.excluded} excluded; held out ${rep.tally.heldout.wins} better and ${rep.tally.heldout.losses} worse; sign test p ${num(rep.sign_p)}. Method: paired comparison of primary checks on turns scored for both prompts.`);
      for (const g of rep.new_blocking_guard_failures) out.push(`  - New blocking guard failure: \`${g.check_id}\`, case ${g.case_id}, turn ${g.turn}.`);
      for (const g of rep.regressions) out.push(`  - Regression: \`${g.check_id}\`, case ${g.case_id}, turn ${g.turn}.`);
      out.push(`  - Gate: ${rep.gate.eligible ? "passed" : "not passed, kept out of review"}. ${rep.gate.reasons.join(" ")}`);
    }
    for (const x of journal.filter((y) => y.step === "experiment.specified" && y.refs.candidate === e.key)) {
      const spec = store.get<ExperimentSpec>("experiment", x.key);
      out.push(`- Experiment \`experiment:${x.key}\`: tags \`${spec.arms.baseline.tag}\` and \`${spec.arms.candidate.tag}\`, ${Math.round(spec.allocation.candidate * 100)}% to the candidate, window ${spec.window.start} to ${spec.window.end}, final analysis from ${spec.analysis_cutoff}, ${spec.required_per_arm} needed per arm.`);
      for (const b of journal.filter((y) => y.step === "review.bundled" && y.refs.experiment === x.key)) {
        const pr = journal.find((y) => y.step === "review.published" && y.key === b.key);
        out.push(`- Review \`review:${b.key}\`${pr ? `: pull request #${pr.refs.pr} on branch \`${pr.refs.branch}\`` : ": local bundle, not published"}.`);
      }
      for (const a of journal.filter((y) => y.step === "approval.recorded" && y.refs.experiment === x.key)) {
        const ap = store.get<Approval>("approval", a.key);
        out.push(`- Approval \`approval:${a.key}\`: ${ap.approver} ${ap.decision} this candidate and experiment on ${ap.at}.`);
      }
      for (const d of journal.filter((y) => y.step === "analysis.decided" && y.refs.experiment === x.key)) {
        const an = store.get<ExperimentAnalysis>("analysis", d.key);
        const src = an.telemetry_ids.map((id) => `telemetry:${shortId(id)}`).join(", ");
        const exports = an.telemetry_ids.map((id) => store.get<TelemetryImport>("telemetry", id).export_id).join(", ");
        out.push(`- Decision \`analysis:${d.key}\` as of ${an.as_of} (${an.final ? "final" : "before the cutoff"}): **${an.recommendation.toUpperCase()}**${an.stopped_by === "early_stop" ? " by the predeclared early stop" : ""}. Source: ${src} (exports ${exports}).`);
        out.push(`  - Conversations: ${an.arms.baseline.mature} mature baseline, ${an.arms.candidate.mature} mature candidate, ${an.coverage.immature} immature, ${an.coverage.unattributed} unattributed, ${an.coverage.duplicates_dropped} duplicates dropped. Allocation observed ${num(an.allocation.observed)} against ${an.allocation.intended} intended (sample ratio p ${num(an.allocation.srm_p)}).`);
        for (const r of [an.primary, ...an.guards]) {
          out.push(`  - ${r.role} \`${r.name}\`: baseline ${num(r.baseline.estimate)} (n ${r.baseline.n}), candidate ${num(r.candidate.estimate)} (n ${r.candidate.n}), difference ${num(r.difference)}${r.ci ? `, interval ${num(r.ci.lo)} to ${num(r.ci.hi)} (${Math.round(r.ci.level * 100)}%)` : ""}: ${r.status}. Method: ${r.method}.`);
        }
        if (an.flags.length) out.push(`  - Flags: ${an.flags.join(", ")}.`);
        for (const reason of an.reasons) out.push(`  - ${reason}`);
        if (an.recommendation === "revert") out.push(`  - Rollback target: tag \`${an.rollback.tag}\`, \`prompt:${an.rollback.prompt_id}\`.`);
      }
    }
    out.push("");
  }

  out.push("## 6. Limits of this evidence", "");
  out.push("- Replay shows checks on recorded conversations. It is not an estimate of business impact.");
  out.push("- The experiment numbers come from the customer's own export. Synthe did not run the traffic split and cannot see how it was run beyond what the export declares.");
  out.push("- A recommendation is for the customer's rollout owner. Nothing here changes traffic, merges a pull request or releases a prompt.", "");
  return `${out.join("\n")}\n`;
}
