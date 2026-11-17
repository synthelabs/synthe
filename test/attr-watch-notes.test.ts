// Regression test proposed by the attribution review.
// `pilot export` prints what it left out or exported empty (calls with no outcome, conversations served two versions, recorder
// problem lines, unreadable lines). `watch --log` builds the same export through realLogExporter, which returns only
// the path, so none of those counts reaches WATCH.md or the tick's output.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEMO } from "../src/pilot/demo-data.ts";
import { DAY_MS, ms } from "../src/pilot/ids.ts";
import type { ExperimentSpec } from "../src/pilot/types.ts";
import { pickVersion, pilotRecorder } from "../src/pilot/wrap.ts";
import { replayedPilot, tmp } from "./pilot-cli-helpers.ts";

test("watch --log reports the conversations its export left out", async () => {
  const ctx = await replayedPilot();
  try {
    assert.equal(await ctx.run(["experiment", "--candidate", ctx.eligible, "--start", DEMO.experiment_c_start]), 0);
    const experiment = ctx.last("experiment.specified");
    assert.equal(await ctx.run(["review", "--candidate", ctx.eligible]), 0);
    assert.equal(await ctx.run(["approve", "--candidate", ctx.eligible, "--experiment", experiment, "--approver", DEMO.metric_owner]), 0);
    const s = ctx.store.get<ExperimentSpec>("experiment", experiment);
    const logDir = join(tmp("attr-notes-"), "log");
    let clock = new Date(0);
    const rec = pilotRecorder({ logDir, agent: "Juniper", idKey: "attr-test-id-key-0123456789", now: () => clock });
    let skipped = 0;
    for (let d = 0; d < 4; d++) for (let i = 0; i < 60; i++) {
      const at = new Date(ms(s.window.start) + d * DAY_MS + Math.floor((i * DAY_MS) / 60));
      const id = `conv-${d}-${i}`;
      clock = at;
      rec.record({ promptVersion: pickVersion({ key: id, salt: "s", baseline: s.arms.baseline.tag, candidate: s.arms.candidate.tag, candidateShareBp: 5000 }), conversationId: id, startedAt: at });
      if (i % 10 === 0) { skipped++; continue; } // the agent call threw; no outcome is ever recorded
      clock = new Date(at.getTime() + 600_000);
      rec.outcome(id, { resolved: i % 3 ? 1 : 0, escalated: 0, refund_usd: 0 });
    }
    rec.outcome("bad", { resolved: Number.NaN }); // one problem line
    ctx.lines.length = 0;
    assert.equal(await ctx.run(["watch", "--log", logDir, "--assignment", "randomized"], { now: () => new Date(ms(s.window.start) + 4 * DAY_MS + 3_600_000) }), 0, ctx.lines.join("|"));
    const text = readFileSync(join(ctx.dir, "reports", "WATCH.md"), "utf8") + "\n" + ctx.lines.join("\n");
    assert.match(text, new RegExp(`${skipped} conversations have a recorded call and no outcome yet`), `the ${skipped} calls with no outcome are not reported by the tick:\n${text}`);
    assert.match(text, /problem/, "the recorder's problem line is not reported by the tick");
  } finally { await ctx.stop(); }
});
