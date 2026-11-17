// Proposed regression test (review "recheck", 2026-11-17).
// docs/PILOT.md: only a retried outcome with a DIFFERENT value after an import is refused; "a call under another
// prompt version made after the outcome does not have this effect: the row is unchanged". But when that late
// other-version call is followed by a retry of the SAME outcome (at-least-once delivery), the newest outcome is now
// after the other-version call, so the export empties a row that an interim import already held with values.
// The import refuses every later export (telemetry_conflict), and `watch --log` never reaches the final analysis.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { DEMO } from "../src/pilot/demo-data.ts";
import { DAY_MS, ms } from "../src/pilot/ids.ts";
import type { ExperimentSpec } from "../src/pilot/types.ts";
import { pickVersion, pilotRecorder } from "../src/pilot/wrap.ts";
import { replayedPilot, tmp } from "./pilot-cli-helpers.ts";

const R = (i: number, d: number) => ({ resolved: (i * 7 + d) % 100 < 62 ? 1 : 0, escalated: (i + d) % 8 === 0 ? 1 : 0, refund_usd: i % 7 === 0 ? 28 : 0 });

test("a same-value outcome retry after a late other-version call does not block the final analysis", async () => {
  const ctx = await replayedPilot();
  try {
    assert.equal(await ctx.run(["experiment", "--candidate", ctx.eligible, "--start", DEMO.experiment_c_start]), 0);
    const experiment = ctx.last("experiment.specified");
    assert.equal(await ctx.run(["review", "--candidate", ctx.eligible]), 0);
    assert.equal(await ctx.run(["approve", "--candidate", ctx.eligible, "--experiment", experiment, "--approver", DEMO.metric_owner]), 0);
    const s = ctx.store.get<ExperimentSpec>("experiment", experiment);
    const bp = Math.round(s.allocation.candidate * 10000);
    const logDir = join(tmp("attr-same-retry-"), "log");
    let clock = new Date(0);
    const rec = pilotRecorder({ logDir, agent: "Juniper", idKey: "attr-test-id-key-0123456789", now: () => clock });
    for (let d = 0; d < 14; d++) for (let i = 0; i < 60; i++) {
      const at = new Date(ms(s.window.start) + d * DAY_MS + Math.floor((i * DAY_MS) / 60));
      const id = `conv-${d}-${i}`;
      clock = at;
      rec.record({ promptVersion: pickVersion({ key: id, salt: "s", baseline: s.arms.baseline.tag, candidate: s.arms.candidate.tag, candidateShareBp: bp }), conversationId: id, startedAt: at });
      clock = new Date(at.getTime() + 600_000);
      rec.outcome(id, R(i, d));
    }
    const argv = ["watch", "--log", logDir, "--assignment", "randomized"];
    assert.equal(await ctx.run(argv, { now: () => new Date(ms(s.window.start) + 5 * DAY_MS + 3_600_000) }), 0);
    assert.equal(ctx.store.find("analysis.decided").length, 1, "the interim look ran");

    // Day 6: conv-0-0 (imported with its values at day 5) is served once by the other version, after its outcome,
    // and then the customer's queue delivers the SAME outcome again.
    const v = pickVersion({ key: "conv-0-0", salt: "s", baseline: s.arms.baseline.tag, candidate: s.arms.candidate.tag, candidateShareBp: bp });
    clock = new Date(ms(s.window.start) + 6 * DAY_MS);
    rec.record({ promptVersion: v === s.arms.baseline.tag ? s.arms.candidate.tag : s.arms.baseline.tag, conversationId: "conv-0-0" });
    clock = new Date(ms(s.window.start) + 6 * DAY_MS + 60_000);
    rec.outcome("conv-0-0", R(0, 0));

    ctx.lines.length = 0;
    const codes: number[] = [];
    for (let h = 0; h < 3; h++) codes.push(await ctx.run(argv, { now: () => new Date(ms(s.analysis_cutoff) + h * DAY_MS + 60_000) }));
    const finals = ctx.store.find("analysis.decided").filter((e) => e.refs.final === "true");
    assert.equal(finals.length, 1, `exit codes ${codes.join(",")}; no final analysis after 3 ticks past the cutoff.\n${ctx.lines.filter((l) => /Refused/.test(l)).join("\n")}`);
  } finally { await ctx.stop(); }
});
