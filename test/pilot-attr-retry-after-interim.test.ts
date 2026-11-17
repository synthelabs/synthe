// Regression test proposed by the attribution review.
// The call-log export re-derives every conversation from the whole log at each look. A conversation that was
// exported and imported at an interim look and later becomes ambiguous in the log (a customer retry recorded under
// the other prompt version, or a retried outcome() with a different value, or a retry whose clock stepped back so the
// first call moves earlier) is left out of, or changed in, every later export. The import then refuses every later
// export ("conversations that vanish" / telemetry_conflict), so with `watch --log` the experiment can never reach its
// final analysis, and the refusal does not say which recorder event caused it. One retried conversation is enough.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { DEMO } from "../src/pilot/demo-data.ts";
import { DAY_MS, ms } from "../src/pilot/ids.ts";
import type { ExperimentSpec } from "../src/pilot/types.ts";
import { pickVersion, pilotRecorder, type PilotRecorder } from "../src/pilot/wrap.ts";
import { replayedPilot, tmp } from "./pilot-cli-helpers.ts";

const R = (i: number, d: number) => ({ resolved: (i * 7 + d) % 100 < 62 ? 1 : 0, escalated: (i + d) % 8 === 0 ? 1 : 0, refund_usd: i % 7 === 0 ? 28 : 0 });
function splitLog(rec: PilotRecorder, setClock: (d: Date) => void, s: ExperimentSpec, days: number, perDay: number): void {
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      const at = new Date(ms(s.window.start) + d * DAY_MS + Math.floor((i * DAY_MS) / perDay));
      const id = `conv-${d}-${i}`;
      const version = pickVersion({ key: id, salt: "s", baseline: s.arms.baseline.tag, candidate: s.arms.candidate.tag, candidateShareBp: Math.round(s.allocation.candidate * 10000) });
      setClock(at);
      rec.record({ promptVersion: version, conversationId: id, startedAt: at });
      setClock(new Date(at.getTime() + 600_000));
      rec.outcome(id, R(i, d));
    }
  }
}

// Decided 2026-11-17: a retry served by the other version after the outcome leaves the row as it is, so the final
// analysis runs. A retried outcome with another value is a corrected outcome: it stays refused, as on every other
// path (docs/PILOT.md, Known limits), and the refusal is pinned here so it cannot turn into a silent rewrite.
for (const kind of ["retry served the other version", "retried outcome with another value"] as const) {
  test(kind === "retry served the other version" ? `one ${kind} after an interim look does not block the final analysis` : `one ${kind} after an interim look is refused as a corrected outcome, never used`, async () => {
    const ctx = await replayedPilot();
    try {
      assert.equal(await ctx.run(["experiment", "--candidate", ctx.eligible, "--start", DEMO.experiment_c_start]), 0);
      const experiment = ctx.last("experiment.specified");
      assert.equal(await ctx.run(["review", "--candidate", ctx.eligible]), 0);
      assert.equal(await ctx.run(["approve", "--candidate", ctx.eligible, "--experiment", experiment, "--approver", DEMO.metric_owner]), 0);
      const s = ctx.store.get<ExperimentSpec>("experiment", experiment);
      const logDir = join(tmp("attr-retry-"), "log");
      let clock = new Date(0);
      const rec = pilotRecorder({ logDir, agent: "Juniper", idKey: "attr-test-id-key-0123456789", now: () => clock });
      splitLog(rec, (d) => { clock = d; }, s, 14, 60);
      const argv = ["watch", "--log", logDir, "--assignment", "randomized"];
      assert.equal(await ctx.run(argv, { now: () => new Date(ms(s.window.start) + 5 * DAY_MS + 3_600_000) }), 0, ctx.lines.slice(-4).join("|"));
      assert.equal(ctx.store.find("analysis.decided").length, 1, "the interim look ran");

      // Day 6: the customer's code retries conversation conv-0-0 (its outcome was final and imported at day 5).
      clock = new Date(ms(s.window.start) + 6 * DAY_MS);
      const v = pickVersion({ key: "conv-0-0", salt: "s", baseline: s.arms.baseline.tag, candidate: s.arms.candidate.tag, candidateShareBp: Math.round(s.allocation.candidate * 10000) });
      if (kind === "retry served the other version") rec.record({ promptVersion: v === s.arms.baseline.tag ? s.arms.candidate.tag : s.arms.baseline.tag, conversationId: "conv-0-0" });
      else rec.outcome("conv-0-0", { ...R(0, 0), resolved: 1 - R(0, 0).resolved });

      ctx.lines.length = 0;
      const codes: number[] = [];
      for (let h = 0; h < 3; h++) codes.push(await ctx.run(argv, { now: () => new Date(ms(s.analysis_cutoff) + h * DAY_MS + 60_000) }));
      const finals = ctx.store.find("analysis.decided").filter((e) => e.refs.final === "true");
      if (kind === "retry served the other version") {
        assert.equal(finals.length, 1, `exit codes ${codes.join(",")}; no final analysis after 3 ticks past the cutoff.\n${ctx.lines.filter((l) => /Refused/.test(l)).join("\n")}`);
      } else {
        assert.deepEqual(codes, [1, 1, 1], "each tick refuses");
        assert.equal(finals.length, 0, "a changed outcome never reaches an analysis");
        assert.ok(ctx.lines.some((l) => /Refused \(telemetry_conflict\)/.test(l)), ctx.lines.slice(-6).join("|"));
      }
    } finally { await ctx.stop(); }
  });
}
