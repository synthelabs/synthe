// Regression test proposed by the attribution review.
// A `watch --log` tick that dies after `analyze` recorded telemetry.imported for the first post-cutoff export, but
// before it recorded analysis.decided, leaves the experiment with no final analysis. Every later tick writes a NEW
// export (made later, also after the cutoff), and analyze refuses it as a second final export, so the final analysis
// on the earliest post-cutoff export never happens and each tick fails with a conflict.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { DEMO } from "../src/pilot/demo-data.ts";
import { DAY_MS, ms } from "../src/pilot/ids.ts";
import type { ExperimentSpec } from "../src/pilot/types.ts";
import { pickVersion, pilotRecorder } from "../src/pilot/wrap.ts";
import { PilotStore } from "../src/pilot/store.ts";
import { replayedPilot, tmp } from "./pilot-cli-helpers.ts";

function splitLog(dir: string, s: ExperimentSpec, days: number, perDay: number): void {
  let clock = new Date(0);
  const rec = pilotRecorder({ logDir: dir, agent: "Juniper", idKey: "attr-test-id-key-0123456789", now: () => clock });
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      const at = new Date(ms(s.window.start) + d * DAY_MS + Math.floor((i * DAY_MS) / perDay));
      const id = `conv-${d}-${i}`;
      const version = pickVersion({ key: id, salt: "s", baseline: s.arms.baseline.tag, candidate: s.arms.candidate.tag, candidateShareBp: Math.round(s.allocation.candidate * 10000) });
      clock = at;
      rec.record({ promptVersion: version, conversationId: id, startedAt: at });
      clock = new Date(at.getTime() + 600_000);
      rec.outcome(id, { resolved: (i * 7 + d) % 100 < 62 ? 1 : 0, escalated: (i + d) % 8 === 0 ? 1 : 0, refund_usd: i % 7 === 0 ? 28 : 0 });
    }
  }
}

test("a watch tick killed between the final import and the final analysis: the restarted tick still gives exactly one final analysis", async () => {
  const ctx = await replayedPilot();
  try {
    assert.equal(await ctx.run(["experiment", "--candidate", ctx.eligible, "--start", DEMO.experiment_c_start]), 0);
    const experiment = ctx.last("experiment.specified");
    assert.equal(await ctx.run(["review", "--candidate", ctx.eligible]), 0);
    assert.equal(await ctx.run(["approve", "--candidate", ctx.eligible, "--experiment", experiment, "--approver", DEMO.metric_owner]), 0);
    const s = ctx.store.get<ExperimentSpec>("experiment", experiment);
    const logDir = join(tmp("attr-kill-"), "log");
    splitLog(logDir, s, 14, 60);
    const argv = ["watch", "--log", logDir, "--assignment", "randomized"];

    // The process dies right after the import is journalled (simulated: the next journal write throws once).
    const proto = PilotStore.prototype as unknown as { record: (this: PilotStore, ...a: unknown[]) => unknown };
    const original = proto.record;
    let armed = true;
    proto.record = function (this: PilotStore, ...a: unknown[]) { if (armed && a[0] === "analysis.decided") { armed = false; throw new Error("killed"); } return original.apply(this, a); };
    const cutoff = ms(s.analysis_cutoff);
    // main() turns the crash into exit 1, as a killed cron job would leave it.
    assert.equal(await ctx.run(argv, { now: () => new Date(cutoff + 60_000) }), 1);
    proto.record = original;
    assert.equal(ctx.store.find("telemetry.imported").filter((e) => e.refs.scope === experiment).length, 1, "the first post-cutoff export was imported");
    assert.equal(ctx.store.find("analysis.decided").length, 0, "and no analysis was recorded");

    // The next cron tick, an hour later.
    ctx.lines.length = 0;
    const code = await ctx.run(argv, { now: () => new Date(cutoff + 3_600_000) });
    const finals = ctx.store.find("analysis.decided").filter((e) => e.refs.experiment === experiment && e.refs.final === "true");
    assert.equal(finals.length, 1, `exit ${code}; expected the restarted tick to record the final analysis on the earliest post-cutoff export.\n${ctx.lines.join("\n")}`);
  } finally { await ctx.stop(); }
});
