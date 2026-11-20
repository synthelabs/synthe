// CLI-level tests for the statistics options: --accept-flags on `experiment`, --reopen on `analyze`, and verify
// replaying a reopened analysis. Each one fails if the command line wiring is removed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEMO, demoConfig, demoPack, experimentCFinal, telemetryExport } from "../src/pilot/demo-data.ts";
import { addDays, candidateTag } from "../src/pilot/ids.ts";
import type { BaselineReport, ExperimentAnalysis, ExperimentSpec } from "../src/pilot/types.ts";
import { json, replayedPilot, workspace, writeExport, type Ctx } from "./pilot-cli-helpers.ts";

const refused = (lines: string[], code: string): boolean => lines.some((l) => l.startsWith(`Refused (${code})`));

// The pilot of replayedPilot, but with a baseline export of only five days, so the baseline report raises flags.
async function shortBaselinePilot(): Promise<Ctx & { eligible: string }> {
  const ctx = await workspace();
  const must = async (argv: string[]) => { if (await ctx.run(argv) !== 0) throw new Error(`setup failed at ${argv[0]}: ${ctx.lines.slice(-3).join(" | ")}`); };
  const short = telemetryExport({
    export_id: "fernhill-baseline-short", start: DEMO.baseline_window.start, days: 5, exported_at: "2026-10-17T00:00:00Z",
    assignment: "none", lag_days: 2, csv_name: "baseline.csv", arms: [{ tag: DEMO.baseline_tag, per_day: 640, resolved: 0.62, escalated: 0.12, refunded: 0.15, refund_usd: 28 }],
  });
  await must(["init", "--config", ctx.put("pilot.json", json(demoConfig())), "--repo-dir", ctx.repoDir]);
  await must(["baseline", "--telemetry", writeExport(ctx, "baseline.json", short)]);
  await must(["pack", "--file", ctx.put("pack.v1.json", json(demoPack()))]);
  await must(["discover", "--model", ctx.model]);
  const finding = ctx.last("finding.found");
  await must(["propose", "--finding", finding, "--proposer", ctx.proposer]);
  await must(["replay", "--candidate", ctx.last("candidate.created"), "--model", ctx.model]);
  await must(["propose", "--finding", finding, "--proposer", ctx.proposer]);
  const eligible = ctx.last("candidate.created");
  await must(["replay", "--candidate", eligible, "--model", ctx.model]);
  return Object.assign(ctx, { eligible });
}

test("a flagged baseline needs each flag named with --accept-flags before an experiment is written", async () => {
  const ctx = await shortBaselinePilot();
  try {
    const report = ctx.store.get<BaselineReport>("baseline", ctx.last("baseline.reported"));
    const needing = report.flags.filter((f) => ["short_window", "window_too_short_for_required_samples", "missing_events"].includes(f));
    assert.ok(needing.includes("short_window"), report.flags.join(","));
    const start = ["--start", DEMO.experiment_c_start];
    const run = (...extra: string[]) => ctx.run(["experiment", "--candidate", ctx.eligible, ...start, ...extra]);

    assert.equal(await run(), 1);
    assert.ok(refused(ctx.lines, "conflict"), ctx.lines.at(-1) ?? "");
    assert.match(ctx.lines.at(-1) ?? "", /short_window.*--accept-flag/s);
    assert.equal(ctx.store.find("experiment.specified").length, 0, "a refused specification leaves no record");

    // A flag the baseline did not raise is a typo, not an acceptance.
    assert.equal(await run("--accept-flags", `${needing.join(",")},short_windows`), 1);
    assert.ok(refused(ctx.lines, "usage"), ctx.lines.at(-1) ?? "");
    assert.equal(ctx.store.find("experiment.specified").length, 0);

    // Naming all but one is not enough (only when the baseline raised more than one).
    if (needing.length > 1) {
      assert.equal(await run("--accept-flags", needing.slice(1).join(",")), 1);
      assert.equal(ctx.store.find("experiment.specified").length, 0);
    }

    // Every flag named, with spaces around the commas allowed: written, and the plan carries the acceptance.
    assert.equal(await run("--accept-flags", needing.join(" , ")), 0, ctx.lines.at(-1) ?? "");
    const spec = ctx.store.get<ExperimentSpec>("experiment", ctx.last("experiment.specified"));
    assert.deepEqual(spec.accepted_baseline_flags, needing);
    assert.deepEqual(spec.baseline_flags, report.flags);
  } finally { await ctx.stop(); }
});

// The final export of the second experiment with the candidate's resolved value blanked for 8% of its rows: more than
// max_missing_rate, so the final result is a hold, which (unlike a keep or a revert) does not end the experiment.
function blankedFinal(tag: string): { header: Record<string, unknown>; csv: string } {
  const full = experimentCFinal(tag);
  const [head, ...lines] = full.csv.trimEnd().split("\n");
  let blanked = 0;
  const limit = Math.ceil(0.08 * lines.filter((l) => l.split(",")[1] === tag).length);
  const out = lines.map((l) => {
    const cells = l.split(",");
    if (cells[1] !== tag || blanked >= limit || cells[5] === "") return l;
    blanked++;
    cells[5] = "";
    return cells.join(",");
  });
  return { header: { ...full.header, export_id: "fernhill-exp2-final-blanked", rows_csv: "experiment-2-final-blanked.csv" }, csv: `${[head, ...out].join("\n")}\n` };
}

test("a second final export needs --reopen, and verify replays the reopened analysis", async () => {
  const ctx = await replayedPilot();
  try {
    const { eligible } = ctx;
    const tag = candidateTag(eligible);
    assert.equal(await ctx.run(["experiment", "--candidate", eligible, "--start", DEMO.experiment_c_start]), 0);
    const experiment = ctx.last("experiment.specified");
    assert.equal(await ctx.run(["review", "--candidate", eligible]), 0);
    ctx.on("2026-10-26");
    assert.equal(await ctx.run(["approve", "--candidate", eligible, "--experiment", experiment, "--approver", "Tomas Lindqvist"]), 0);

    // The first final export: 8% of the candidate's resolved values are missing, so the final result is a hold.
    ctx.on("2026-11-12");
    assert.equal(await ctx.run(["analyze", "--experiment", experiment, "--telemetry", writeExport(ctx, "final-blanked.json", blankedFinal(tag))]), 0, ctx.lines.at(-1) ?? "");
    const first = ctx.store.get<ExperimentAnalysis>("analysis", ctx.last("analysis.decided"));
    assert.equal(first.final, true);
    assert.equal(first.recommendation, "hold");
    assert.ok(first.flags.includes("missing_events"), first.flags.join(","));
    assert.equal(first.reopened, undefined);

    // A later export, also after the cutoff, fills the values in. Without --reopen the first final result stands.
    const later = experimentCFinal(tag);
    const fixed = writeExport(ctx, "final-fixed.json", { header: { ...later.header, export_id: "fernhill-exp2-final-fixed", exported_at: addDays(DEMO.experiment_c_start, 17), rows_csv: "experiment-2-final-fixed.csv" }, csv: later.csv });
    ctx.on("2026-11-13");
    const imported = ctx.store.find("telemetry.imported").length;
    const analyses = ctx.store.find("analysis.decided").length;
    assert.equal(await ctx.run(["analyze", "--experiment", experiment, "--telemetry", fixed]), 1);
    assert.ok(refused(ctx.lines, "conflict"), ctx.lines.at(-1) ?? "");
    assert.match(ctx.lines.at(-1) ?? "", /reopen/i);
    assert.equal(ctx.store.find("telemetry.imported").length, imported, "a refused export leaves no trace");
    assert.equal(ctx.store.find("analysis.decided").length, analyses);

    // With --reopen it is analysed, and the decision says it was reopened.
    assert.equal(await ctx.run(["analyze", "--experiment", experiment, "--telemetry", fixed, "--reopen"]), 0, ctx.lines.at(-1) ?? "");
    const reopened = ctx.store.get<ExperimentAnalysis>("analysis", ctx.last("analysis.decided"));
    assert.equal(reopened.reopened, true);
    assert.equal(reopened.recommendation, "keep");
    assert.equal(ctx.store.find("analysis.decided").length, analyses + 1);

    // verify recomputes the reopened analysis (it must replay it with reopen), and still passes.
    assert.equal(await ctx.run(["verify"]), 0, ctx.lines.slice(-4).join(" | "));
  } finally { await ctx.stop(); }
});
