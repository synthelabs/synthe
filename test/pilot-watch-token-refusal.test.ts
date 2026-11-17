// Proposed regression test (privacy lens): a recorder token is a plain lowercase word, which the import's refusal
// treats as a column name it may repeat. A CSV that lost its header line then puts a token in WATCH.md and stdout.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEMO } from "../src/pilot/demo-data.ts";
import { DAY_MS, ms } from "../src/pilot/ids.ts";
import { main } from "../src/pilot/main.ts";
import type { ExperimentSpec } from "../src/pilot/types.ts";
import { pickVersion, pilotRecorder } from "../src/pilot/wrap.ts";
import { replayedPilot, tmp } from "./pilot-cli-helpers.ts";

const day = (iso: string, d: number) => new Date(ms(iso) + d * DAY_MS).toISOString().replace(".000Z", "Z");

test("a refusal never repeats a recorder token, even when a CSV lost its header line", async () => {
  const ctx = await replayedPilot();
  try {
    assert.equal(await ctx.run(["experiment", "--candidate", ctx.eligible, "--start", DEMO.experiment_c_start]), 0);
    const experiment = ctx.last("experiment.specified");
    assert.equal(await ctx.run(["review", "--candidate", ctx.eligible]), 0);
    assert.equal(await ctx.run(["approve", "--candidate", ctx.eligible, "--experiment", experiment, "--approver", DEMO.metric_owner]), 0);
    const s = ctx.store.get<ExperimentSpec>("experiment", experiment);
    const logDir = join(tmp("rev-token-"), "log");
    let clock = new Date(0);
    const rec = pilotRecorder({ logDir, agent: "Juniper", idKey: "review-id-key-0123456789", now: () => clock });
    for (let i = 0; i < 60; i++) {
      clock = new Date(ms(s.window.start) + i * 3_600_000);
      const id = `conv-${i}`;
      rec.record({ promptVersion: pickVersion({ key: id, salt: "x", baseline: s.arms.baseline.tag, candidate: s.arms.candidate.tag, candidateShareBp: 5000 }), conversationId: id });
      clock = new Date(clock.getTime() + 60_000);
      rec.outcome(id, { resolved: i % 2, escalated: 0, refund_usd: 0 });
    }
    // The customer's job exports into the inbox, and a later step drops the CSV's header line.
    const inbox = join(tmp("rev-token-inbox-"), "in");
    mkdirSync(inbox);
    const lines: string[] = [];
    const deps = (t: string) => ({ say: (l: string) => { lines.push(l); }, env: {}, now: () => new Date(t) });
    assert.equal(await main(["export", "--log", logDir, "--experiment", experiment, "--assignment", "randomized", "--out", inbox, "--dir", ctx.dir], deps(day(s.window.start, 3))), 0, lines.join("|"));
    const csv = readdirSync(inbox).find((f) => f.endsWith(".csv"))!;
    const [, ...rows] = readFileSync(join(inbox, csv), "utf8").split("\n");
    writeFileSync(join(inbox, csv), rows.join("\n"));
    const token = rows[0].split(",")[0];
    assert.match(token, /^[a-p]{32}$/);
    lines.length = 0;
    assert.equal(await main(["watch", "--inbox", inbox, "--dir", ctx.dir], deps(day(s.window.start, 4))), 1);
    const md = readFileSync(join(ctx.dir, "reports", "WATCH.md"), "utf8");
    console.log(md.split("\n").filter((l) => l.includes(token)).join("\n")); assert.ok(!md.includes(token), `WATCH.md repeats the conversation token ${token}`);
    lines.length = 0;
    await main(["analyze", "--experiment", experiment, "--telemetry", join(inbox, csv.replace(/\.csv$/, ".json")), "--dir", ctx.dir], deps(day(s.window.start, 4)));
    assert.ok(!lines.join("\n").includes(token), `analyze prints the conversation token: ${lines.join(" | ")}`);
  } finally { await ctx.stop(); }
});
