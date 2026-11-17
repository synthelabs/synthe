// Proposed regression tests (privacy lens): what `pilot export` prints when the call log holds a prompt version the
// pilot does not name. The recorder accepts any 1-200 character promptVersion and never tokenises it.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { DEMO } from "../src/pilot/demo-data.ts";
import { DAY_MS, ms } from "../src/pilot/ids.ts";
import { main } from "../src/pilot/main.ts";
import type { ExperimentSpec } from "../src/pilot/types.ts";
import { pilotRecorder } from "../src/pilot/wrap.ts";
import { replayedPilot, tmp } from "./pilot-cli-helpers.ts";

const day = (iso: string, d: number) => new Date(ms(iso) + d * DAY_MS).toISOString().replace(".000Z", "Z");

async function exportWithOddVersion(odd: (s: ExperimentSpec) => string): Promise<string> {
  const ctx = await replayedPilot();
  try {
    assert.equal(await ctx.run(["experiment", "--candidate", ctx.eligible, "--start", DEMO.experiment_c_start]), 0);
    const experiment = ctx.last("experiment.specified");
    const s = ctx.store.get<ExperimentSpec>("experiment", experiment);
    const logDir = join(tmp("rev-refusal-"), "log");
    let clock = new Date(0);
    const rec = pilotRecorder({ logDir, agent: "Juniper", idKey: "review-id-key-0123456789", now: () => clock });
    for (let i = 0; i < 40; i++) {
      clock = new Date(ms(s.window.start) + DAY_MS / 2 + i * 60_000);
      const id = `c-${i}`;
      rec.record({ promptVersion: i === 0 ? odd(s) : i % 2 ? s.arms.baseline.tag : s.arms.candidate.tag, conversationId: id });
      clock = new Date(clock.getTime() + 60_000);
      rec.outcome(id, { resolved: 1, escalated: 0, refund_usd: 0 });
    }
    const lines: string[] = [];
    const code = await main(["export", "--log", logDir, "--experiment", experiment, "--assignment", "randomized", "--dir", ctx.dir], { say: (l) => { lines.push(l); }, env: {}, now: () => new Date(day(s.window.start, 2)) });
    assert.equal(code, 1);
    return lines.join("\n");
  } finally { await ctx.stop(); }
}

test("export: a refusal never sends a control sequence from the call log to the terminal", async () => {
  const out = await exportWithOddVersion((s) => `${s.arms.baseline.tag}\u001b]0;owned\u0007\u001b[2J`);
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f]/.test(out), `stdout carries a control character from the log: ${JSON.stringify(out)}`);
});
