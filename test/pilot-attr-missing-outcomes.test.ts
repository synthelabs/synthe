// Regression test proposed by the attribution review.
// A call with no outcome is dropped from the call-log export (src/pilot/export.ts, `no_outcome`) instead of being
// exported as a row with empty values, so the analysis's missing-outcome checks (max_missing_rate per arm, and one
// arm against the other) never see it. When the candidate loses the outcomes of some of its failures (for example
// its agent call throws after the record line and the caller never reports an outcome), a candidate whose true gain
// is below min_effect is read as a gain above it and the final analysis recommends keep.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { DEMO, telemetryExport } from "../src/pilot/demo-data.ts";
import { candidateTag, ms } from "../src/pilot/ids.ts";
import { parseCsv } from "../src/pilot/telemetry.ts";
import type { ExperimentSpec } from "../src/pilot/types.ts";
import { pilotRecorder } from "../src/pilot/wrap.ts";
import { replayedPilot, tmp } from "./pilot-cli-helpers.ts";

// dropEvery: 0 records every outcome; n drops the outcome of every n-th candidate failure.
async function finalRecommendation(dropEvery: number, asNull = false, fallback = false): Promise<{ rec: string | undefined; dropped: number; candidateRows: number; said: string }> {
  const ctx = await replayedPilot();
  try {
    const start = DEMO.experiment_c_start;
    assert.equal(await ctx.run(["experiment", "--candidate", ctx.eligible, "--start", start]), 0, ctx.lines.at(-1) ?? "");
    const experiment = ctx.last("experiment.specified");
    assert.equal(await ctx.run(["review", "--candidate", ctx.eligible]), 0);
    assert.equal(await ctx.run(["approve", "--candidate", ctx.eligible, "--experiment", experiment, "--approver", DEMO.metric_owner]), 0);
    const spec = ctx.store.get<ExperimentSpec>("experiment", experiment);
    const tag = candidateTag(ctx.eligible);
    // The candidate's true gain is 0.02, below the contract's min_effect of 0.03: never a keep on honest data.
    const plan = { per_day: 320, resolved: 0.62, escalated: 0.12, refunded: 0.15, refund_usd: 28 };
    const truth = telemetryExport({
      export_id: "truth", start, days: 14, exported_at: spec.analysis_cutoff, assignment: "randomized", lag_days: 2, csv_name: "truth.csv",
      arms: [{ tag: DEMO.baseline_tag, ...plan }, { tag, ...plan, resolved: 0.64 }],
    });
    const [head, ...rows] = parseCsv(truth.csv, "truth.csv").map((r) => r.fields);
    const col = Object.fromEntries(head.map((h, i) => [h, i]));
    const logDir = join(tmp("attr-missing-"), "log");
    let clock = new Date(0);
    const rec = pilotRecorder({ logDir, agent: "Juniper", idKey: "attr-test-id-key-0123456789", now: () => clock });
    let dropped = 0, failures = 0, candidateRows = 0;
    for (const r of rows) {
      const at = new Date(r[col.started_at]);
      clock = new Date(at.getTime() + 1000);
      rec.record({ promptVersion: r[col.prompt_version], conversationId: r[col.conversation_id], unitId: r[col.unit_id], segment: r[col.segment], startedAt: at });
      if (r[col.prompt_version] === tag) candidateRows++;
      if (dropEvery > 0 && r[col.prompt_version] === tag && r[col.resolved] === "0" && failures++ % dropEvery === 0) { dropped++; if (fallback) { clock = new Date(at.getTime() + 2000); rec.record({ promptVersion: DEMO.baseline_tag, conversationId: r[col.conversation_id] }); clock = new Date(at.getTime() + 3_600_000); rec.outcome(r[col.conversation_id], Object.fromEntries(["resolved", "escalated", "refund_usd"].map((m) => [m, r[col[m]] === "" ? null : Number(r[col[m]])]))); continue; } if (asNull) { clock = new Date(at.getTime() + 3_600_000); rec.outcome(r[col.conversation_id], { resolved: null, escalated: null, refund_usd: null }); } continue; }
      clock = new Date(at.getTime() + 3_600_000);
      rec.outcome(r[col.conversation_id], Object.fromEntries(["resolved", "escalated", "refund_usd"].map((m) => [m, r[col[m]] === "" ? null : Number(r[col[m]])])));
    }
    ctx.lines.length = 0;
    await ctx.run(["watch", "--log", logDir, "--assignment", "randomized"], { now: () => new Date(ms(spec.analysis_cutoff) + 60_000) });
    const decided = ctx.store.find("analysis.decided").filter((e) => e.refs.experiment === experiment);
    return { rec: decided.at(-1)?.refs.recommendation, dropped, candidateRows, said: ctx.lines.join("\n") };
  } finally { await ctx.stop(); }
}

test("control: with every outcome recorded, a 0.02 true gain is not a keep", async () => {
  const r = await finalRecommendation(0);
  assert.notEqual(r.rec, "keep", r.said);
});

test("missing outcomes for a few percent of the candidate's failures cannot turn a below-min_effect change into a keep", async () => {
  const r = await finalRecommendation(13);
  assert.ok(r.dropped / r.candidateRows > 0.02, `dropped ${r.dropped} of ${r.candidateRows}`);
  // Expected: these conversations reach the analysis as missing values (missing_events above max_missing_rate 0.02,
  // or the per-arm comparison), and the result is hold. Observed at 6e51f01: they are silently left out and the
  // final analysis says keep.
  assert.notEqual(r.rec, "keep", `${r.dropped} of ${r.candidateRows} candidate conversations (${(100 * r.dropped / r.candidateRows).toFixed(1)}%) have a call and no outcome; the final analysis says ${r.rec}.\n${r.said}`);
});

test("reference: the same conversations sent as rows with empty values are caught as missing_events", async () => {
  const r = await finalRecommendation(13, true);
  assert.notEqual(r.rec, "keep", r.said);
});

test("a candidate failure retried on the baseline prompt (served two versions) is left out of the candidate's failures; within the unattributed limit that cannot reach keep", async () => {
  const r = await finalRecommendation(13, false, true);
  assert.notEqual(r.rec, "keep", `${r.dropped} of ${r.candidateRows} candidate failures fell back to the baseline prompt; the final analysis says ${r.rec}.\n${r.said}`);
});
