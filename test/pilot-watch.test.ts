import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { GITHUB_TOKEN_ENV, type PilotDeps } from "../src/pilot/commands.ts";
import {
  type ArmPlan, DEMO, experimentBAfterStop, experimentBInterim, experimentBMistagged, telemetryExport,
} from "../src/pilot/demo-data.ts";
import { PilotError } from "../src/pilot/errors.ts";
import { candidateTag, DAY_MS, ms } from "../src/pilot/ids.ts";
import type { JournalEntry } from "../src/pilot/store.ts";
import type { ExperimentSpec, TelemetryImport } from "../src/pilot/types.ts";
import { BUSY_PREFIX, FALSE_STOP_PER_LOOK, interimLooksAllowed, lookGate, renderWatch, watch, type Look, type LogExporter } from "../src/pilot/watch.ts";
import { pickVersion, pilotRecorder } from "../src/pilot/wrap.ts";
import { replayedPilot, tmp, json } from "./pilot-cli-helpers.ts";

// ---------------------------------------------------------------------------------------------------------------
// The look gate. A spec with a 14-day window and a 2-day lag, as the demo's second experiment has.
// ---------------------------------------------------------------------------------------------------------------

const START = "2026-10-27T00:00:00Z";
const CUTOFF = "2026-11-12T00:00:00Z";
const spec = { window: { start: START, end: "2026-11-10T00:00:00Z" }, analysis_cutoff: CUTOFF } as unknown as ExperimentSpec;
const at = (s: string) => new Date(s);
const look = (when: string, over: Partial<Look> = {}): Look => ({ at: when, final: false, recommendation: "hold", ...over });
const gate = (looks: Look[], now: string, interimDays?: number) => lookGate({ spec, looks, now: at(now), interimDays });

test("gate: the number of interim looks is the days from the start to the cutoff, divided by the spacing, rounded up", () => {
  assert.equal(interimLooksAllowed(spec, 1), 16);
  assert.equal(interimLooksAllowed(spec, 3), 6);
  assert.equal(FALSE_STOP_PER_LOOK.toFixed(6), "0.001000");
  assert.throws(() => interimLooksAllowed(spec, 0), PilotError);
  assert.throws(() => interimLooksAllowed(spec, 1.5), PilotError);
});

test("gate rule 1: a keep or a revert ends it, even before the cutoff and with looks to spare", () => {
  for (const recommendation of ["keep", "revert"] as const) {
    assert.equal(gate([look("2026-10-30T09:00:00Z", { recommendation })], "2026-11-02T09:00:00Z").action, "done");
  }
});

test("gate rule 2: a recorded final analysis is never redone, even when it only held", () => {
  const g = gate([look("2026-11-12T09:00:00Z", { final: true })], "2026-11-15T09:00:00Z");
  assert.equal(g.action, "done");
  assert.match((g as { why: string }).why, /never redone/);
});

test("gate rule 3: at or after the cutoff the final look is allowed, whatever the interim count", () => {
  const many = Array.from({ length: 16 }, (_, i) => look(`2026-10-${27 + i > 31 ? 31 : 27 + i}T09:00:00Z`));
  assert.deepEqual(gate(many, CUTOFF), { action: "final", used: 16, allowed: 16 });
  assert.equal(gate([], "2026-11-20T00:00:00Z").action, "final");
  assert.equal(gate([], "2026-11-11T23:59:59Z").action, "interim");
});

test("gate rule 4: before the window starts, wait for it", () => {
  assert.deepEqual(gate([], "2026-10-26T23:00:00Z"), { action: "wait", why: "The experiment window has not started.", next: START });
});

test("gate rule 5: used interim looks are counted by journal entry, so a clock stepping backwards cannot buy more", () => {
  // Sixteen looks stamped long before the window: no date rule stops the next one, only the count does.
  const stamped = Array.from({ length: 16 }, (_, i) => look(`2026-09-${String(1 + i).padStart(2, "0")}T09:00:00Z`));
  const g = gate(stamped, "2026-11-02T09:00:00Z");
  assert.equal(g.action, "wait");
  assert.equal((g as { next: string }).next, CUTOFF);
  // A clock that jumps back and forth never produces more looks than allowed.
  const looks: Look[] = [];
  let t = ms("2026-10-27T00:00:00Z");
  for (let i = 0; i < 400; i++) {
    t += (i % 3 === 0 ? -5 : 3) * DAY_MS / 2 + (i % 5) * 3_600_000;
    const now = new Date(Math.min(t, ms(CUTOFF) - 1));
    const g2 = lookGate({ spec, looks, now });
    if (g2.action === "interim") looks.push(look(now.toISOString().replace(".000Z", "Z")));
  }
  assert.ok(looks.length <= interimLooksAllowed(spec, 1), `${looks.length} looks`);
  assert.ok(looks.length > 0);
});

test("gate rule 6: one look per UTC day, and the next one waits for the next UTC midnight", () => {
  const g = gate([look("2026-10-30T01:00:00Z")], "2026-10-30T23:59:00Z");
  assert.deepEqual([g.action, (g as { next: string }).next], ["wait", "2026-10-31T00:00:00Z"]);
  assert.equal(gate([look("2026-10-30T23:59:00Z")], "2026-10-31T00:00:00Z").action, "interim", "a new UTC date, however few hours later");
  // Any look on today's date counts, not only the newest.
  assert.equal(gate([look("2026-10-30T01:00:00Z"), look("2026-11-01T01:00:00Z")], "2026-10-30T12:00:00Z").action, "wait");
  // A clock behind the newest look waits.
  assert.equal(gate([look("2026-11-01T01:00:00Z")], "2026-10-30T12:00:00Z").action, "wait");
});

test("gate rule 6 with --interim-days: whole UTC days since the newest look, and never later than the cutoff", () => {
  const looks = [look("2026-10-30T20:00:00Z")];
  const g = gate(looks, "2026-11-01T23:00:00Z", 3);
  assert.deepEqual([g.action, (g as { next: string }).next], ["wait", "2026-11-02T00:00:00Z"]);
  assert.equal(gate(looks, "2026-11-02T00:00:00Z", 3).action, "interim");
  // The newest look decides, not the first one listed.
  assert.equal(gate([look("2026-10-28T09:00:00Z"), look("2026-11-01T01:00:00Z")], "2026-11-02T09:00:00Z", 3).action, "wait");
  const late = gate([look("2026-11-10T20:00:00Z")], "2026-11-11T10:00:00Z", 5);
  assert.equal((late as { next: string }).next, CUTOFF);
});

test("gate rule 7: otherwise one interim look may run", () => {
  assert.deepEqual(gate([], "2026-10-27T00:00:00Z"), { action: "interim", used: 0, allowed: 16 });
});

test("renderWatch says what an interim look can and cannot end, and never invents a recommendation", () => {
  const text = renderWatch({ pilot_id: "p", experiment: { id: "a".repeat(64), spec: { ...spec, guards: [] } as unknown as ExperimentSpec }, now: START, did: [], gate: null, looks: [], interim_days: 1, files: null, refusal: null, verify: null, head: null });
  assert.ok(text.startsWith("# WAITING"));
  assert.match(text, /cannot end it/);
  assert.match(text, /Interim looks: 0 used of 16 allowed/);
});

// ---------------------------------------------------------------------------------------------------------------
// Ticks, on the synthetic Fernhill pilot.
// ---------------------------------------------------------------------------------------------------------------

const BASE: Omit<ArmPlan, "tag"> = { per_day: 320, resolved: 0.62, escalated: 0.12, refunded: 0.15, refund_usd: 28 };
const armsC = (tag: string, perDay = 320): ArmPlan[] => [
  { tag: DEMO.baseline_tag, ...BASE, per_day: perDay },
  { tag, per_day: perDay, resolved: 0.665, escalated: 0.12, refunded: 0.15, refund_usd: 28.4 },
];
const day = (iso: string, d: number) => new Date(ms(iso) + d * DAY_MS).toISOString().replace(".000Z", "Z");
const dayLabel = (iso: string) => iso.slice(0, 10);

// One pilot with a reviewed and approved experiment.
async function approved(start: string) {
  const ctx = await replayedPilot();
  assert.equal(await ctx.run(["experiment", "--candidate", ctx.eligible, "--start", start]), 0, ctx.lines.at(-1) ?? "");
  const experiment = ctx.last("experiment.specified");
  assert.equal(await ctx.run(["review", "--candidate", ctx.eligible]), 0);
  const spec = ctx.store.get<ExperimentSpec>("experiment", experiment);
  return { ctx, experiment, spec, tag: candidateTag(ctx.eligible), approve: async () => { assert.equal(await ctx.run(["approve", "--candidate", ctx.eligible, "--experiment", experiment, "--approver", DEMO.metric_owner]), 0); } };
}

// An export, written into the inbox beside its CSV.
function drop(inbox: string, name: string, x: { header: Record<string, unknown>; csv: string }): void {
  mkdirSync(inbox, { recursive: true });
  writeFileSync(join(inbox, String(x.header.rows_csv)), x.csv);
  writeFileSync(join(inbox, name), json(x.header));
}
const exportAt = (tag: string, start: string, days: number, exportedAt: string, id: string, perDay = 320) =>
  telemetryExport({ export_id: id, start, days, exported_at: exportedAt, assignment: "randomized", lag_days: 2, csv_name: `${id}.csv`, arms: armsC(tag, perDay) });

interface Clock { t: string }
function depsAt(ctx: { env: Record<string, string | undefined>; lines: string[] }, clock: Clock, over: Partial<PilotDeps> = {}): PilotDeps {
  return { say: (l) => { ctx.lines.push(l); }, env: {}, now: () => new Date(clock.t), ...over };
}
const watchText = (dir: string) => readFileSync(join(dir, "reports", "WATCH.md"), "utf8");
const analyses = (store: { find(s: string): JournalEntry[] }) => store.find("analysis.decided");
const experimentImports = (store: { find(s: string): JournalEntry[] }) => store.find("telemetry.imported").filter((e) => e.refs.purpose === "experiment");

test("no approval: nothing is imported or analysed, the tick succeeds, and the report says it waits for an approval", async () => {
  const { ctx, experiment } = await approved(DEMO.experiment_c_start);
  try {
    const inbox = join(tmp("watch-inbox-"), "in");
    drop(inbox, "a.json", exportAt("synthe-x", DEMO.experiment_c_start, 6, "2026-11-02T00:00:00Z", "a"));
    const clock = { t: "2026-11-03T09:00:00Z" };
    const before = ctx.store.journal().length;
    assert.equal(await watch(ctx.store, { inbox }, depsAt(ctx, clock)), 0);
    assert.equal(ctx.store.journal().length, before);
    assert.equal(experimentImports(ctx.store).length, 0);
    const text = watchText(ctx.dir);
    assert.ok(text.startsWith("# WAITING"));
    assert.match(text, /waits for an approval/);
    // Naming the unapproved experiment gives the same answer.
    assert.equal(await watch(ctx.store, { inbox, experiment: experiment.slice(0, 10) }, depsAt(ctx, clock)), 0);
    assert.equal(ctx.store.journal().length, before);
    assert.match(watchText(ctx.dir), /waits for an approval/);
  } finally { await ctx.stop(); }
});

test("usage: exactly one source, --assignment only with --log, a whole --interim-days, and --log needs an exporter", async () => {
  const { ctx } = await approved(DEMO.experiment_c_start);
  try {
    const d = depsAt(ctx, { t: "2026-11-03T09:00:00Z" });
    for (const flags of [{}, { inbox: "x", log: "y", assignment: "z" }, { inbox: "x", assignment: "z" }, { log: "y" }, { inbox: "x", "interim-days": "0" }, { inbox: "x", "interim-days": "1.5" }, { inbox: true }]) {
      await assert.rejects(() => watch(ctx.store, flags as never, d), (e: unknown) => e instanceof PilotError && e.code === "usage", JSON.stringify(flags));
    }
    await assert.rejects(() => watch(ctx.store, { log: "y", assignment: "z" }, d), /--log is not available in this build/);
  } finally { await ctx.stop(); }
});

test("an inbox of more than 500 files is refused at a due look", async () => {
  const { ctx, approve } = await approved(DEMO.experiment_c_start);
  try {
    await approve();
    const inbox = tmp("watch-many-");
    for (let i = 0; i < 501; i++) writeFileSync(join(inbox, `f${i}.json`), "{}");
    assert.equal(await watch(ctx.store, { inbox }, depsAt(ctx, { t: day(DEMO.experiment_c_start, 3) })), 1);
    assert.match(watchText(ctx.dir), /Refused \(usage\): 501 \.json files/);
    assert.equal(analyses(ctx.store).length, 0);
  } finally { await ctx.stop(); }
});

test("a busy watch lock is a clean no-op, and so is a busy evidence lock", async () => {
  const { ctx, approve, tag } = await approved(DEMO.experiment_c_start);
  try {
    await approve();
    const inbox = join(tmp("watch-inbox-"), "in");
    drop(inbox, "a.json", exportAt(tag, DEMO.experiment_c_start, 6, "2026-11-02T00:00:00Z", "a"));
    const clock = { t: "2026-11-03T09:00:00Z" };
    const before = ctx.store.journal().length;
    // Process 1 is alive and not ours, as in the store tests.
    writeFileSync(join(ctx.dir, "watch.lock"), "1");
    ctx.lines.length = 0;
    assert.equal(await watch(ctx.store, { inbox }, depsAt(ctx, clock)), 0);
    assert.ok(ctx.lines.some((l) => l.includes("another watch is running") || l.includes("Another watch is running")));
    assert.equal(ctx.store.journal().length, before);
    const { unlinkSync } = await import("node:fs");
    unlinkSync(join(ctx.dir, "watch.lock"));

    // The constant matches what the real lock says.
    writeFileSync(join(ctx.dir, "evidence.lock"), "1");
    await assert.rejects(() => ctx.store.exclusive("evidence", 600_000, async () => 0), (e: unknown) => e instanceof PilotError && e.message.startsWith(BUSY_PREFIX));
    assert.equal(await watch(ctx.store, { inbox }, depsAt(ctx, clock)), 0);
    assert.equal(ctx.store.journal().length, before);
    assert.equal(analyses(ctx.store).length, 0);
    unlinkSync(join(ctx.dir, "evidence.lock"));
    // Once the lock is free the same tick does the look.
    assert.equal(await watch(ctx.store, { inbox }, depsAt(ctx, clock)), 0, ctx.lines.slice(-4).join("|"));
    assert.equal(analyses(ctx.store).length, 1);
  } finally { await ctx.stop(); }
});

test("an interim look takes the newest pending export; the older one is superseded and never imported", async () => {
  const { ctx, approve, tag } = await approved(DEMO.experiment_c_start);
  try {
    await approve();
    const inbox = join(tmp("watch-inbox-"), "in");
    drop(inbox, "day4.json", exportAt(tag, DEMO.experiment_c_start, 4, day(DEMO.experiment_c_start, 4), "day4"));
    drop(inbox, "day6.json", exportAt(tag, DEMO.experiment_c_start, 6, day(DEMO.experiment_c_start, 6), "day6"));
    const clock = { t: day(DEMO.experiment_c_start, 7) };
    assert.equal(await watch(ctx.store, { inbox }, depsAt(ctx, clock)), 0, ctx.lines.slice(-5).join("|"));
    const imported = experimentImports(ctx.store).map((e) => ctx.store.get<TelemetryImport>("telemetry", e.refs.telemetry).export_id);
    assert.deepEqual(imported, ["day6"]);
    const text = watchText(ctx.dir);
    assert.match(text, /superseded: 1\n- day4\.json/);
    assert.match(text, /imported: 1\n- day6\.json/);
    assert.match(text, /Interim looks: 1 used of 16 allowed/);
    // The same day, another tick: no second look, and the older file is still never imported.
    clock.t = day(DEMO.experiment_c_start, 7).replace("T00:", "T10:");
    assert.equal(await watch(ctx.store, { inbox }, depsAt(ctx, clock)), 0);
    assert.equal(analyses(ctx.store).length, 1);
    assert.equal(experimentImports(ctx.store).length, 1);
    assert.match(watchText(ctx.dir), /A look was already made today/);
  } finally { await ctx.stop(); }
});

test("the final look takes the earliest export made at or after the cutoff; a later one is never imported and the result stands", async () => {
  const { ctx, approve, tag, spec: s } = await approved(DEMO.experiment_c_start);
  try {
    await approve();
    const inbox = join(tmp("watch-inbox-"), "in");
    drop(inbox, "interim.json", exportAt(tag, DEMO.experiment_c_start, 6, day(DEMO.experiment_c_start, 6), "interim"));
    // The later export is better for the candidate, so picking it would be a choice of result.
    const better = telemetryExport({ export_id: "later-and-better", start: DEMO.experiment_c_start, days: 14, exported_at: day(s.analysis_cutoff, 1), assignment: "randomized", lag_days: 2, csv_name: "later.csv", arms: armsC(tag).map((a, i) => (i === 1 ? { ...a, resolved: 0.7 } : a)) });
    drop(inbox, "later.json", better);
    drop(inbox, "first-final.json", exportAt(tag, DEMO.experiment_c_start, 14, s.analysis_cutoff, "first-final"));
    const clock = { t: day(s.analysis_cutoff, 2) };
    ctx.lines.length = 0;
    assert.equal(await watch(ctx.store, { inbox }, depsAt(ctx, clock)), 0, ctx.lines.join("|"));
    const imported = experimentImports(ctx.store).map((e) => ctx.store.get<TelemetryImport>("telemetry", e.refs.telemetry).export_id);
    assert.deepEqual(imported, ["first-final"]);
    const [last] = analyses(ctx.store).slice(-1);
    assert.equal(last.refs.final, "true");
    const recommendation = last.refs.recommendation;
    assert.match(ctx.lines.join("\n"), /final result stands/);
    assert.match(watchText(ctx.dir), /final result stands/);
    assert.match(watchText(ctx.dir), /superseded: 2/);
    // Later ticks change nothing.
    clock.t = day(s.analysis_cutoff, 3);
    assert.equal(await watch(ctx.store, { inbox }, depsAt(ctx, clock)), 0);
    assert.equal(analyses(ctx.store).length, 1);
    assert.equal(experimentImports(ctx.store).length, 1);
    assert.equal(analyses(ctx.store).at(-1)!.refs.recommendation, recommendation);
    assert.ok(watchText(ctx.dir).startsWith(`# ${recommendation.toUpperCase()}`));
  } finally { await ctx.stop(); }
});

test("the final look waits when only exports from before the cutoff exist", async () => {
  const { ctx, approve, tag, spec: s } = await approved(DEMO.experiment_c_start);
  try {
    await approve();
    const inbox = join(tmp("watch-inbox-"), "in");
    drop(inbox, "interim.json", exportAt(tag, DEMO.experiment_c_start, 6, day(DEMO.experiment_c_start, 6), "interim"));
    const clock = { t: day(s.analysis_cutoff, 1) };
    assert.equal(await watch(ctx.store, { inbox }, depsAt(ctx, clock)), 0);
    assert.equal(analyses(ctx.store).length, 0);
    assert.match(watchText(ctx.dir), new RegExp(`Waiting for an export made at or after ${s.analysis_cutoff}`));
  } finally { await ctx.stop(); }
});

test("an invalid file is reported with its code and the tick fails; a valid file put in next is still analysed", async () => {
  const { ctx, approve, tag } = await approved(DEMO.experiment_b_start);
  try {
    await approve();
    const inbox = join(tmp("watch-inbox-"), "in");
    drop(inbox, "bad.json", experimentBMistagged(tag));
    const clock = { t: "2026-10-24T09:00:00Z" };
    assert.equal(await watch(ctx.store, { inbox }, depsAt(ctx, clock)), 1);
    const text = watchText(ctx.dir);
    assert.match(text, /invalid: 1\n- bad\.json: [a-z_]+: /);
    assert.equal(analyses(ctx.store).length, 0);
    drop(inbox, "good.json", experimentBInterim(tag));
    assert.equal(await watch(ctx.store, { inbox }, depsAt(ctx, clock)), 1, "the bad file is re-read every tick");
    assert.equal(analyses(ctx.store).length, 1, "the good one was analysed");
    assert.match(watchText(ctx.dir), /invalid: 1/);
  } finally { await ctx.stop(); }
});

test("an early-stop revert at an interim look: WATCH.md leads with REVERT and later ticks import nothing", async () => {
  const { ctx, approve, tag } = await approved(DEMO.experiment_b_start);
  try {
    await approve();
    const inbox = join(tmp("watch-inbox-"), "in");
    drop(inbox, "day5.json", experimentBInterim(tag));
    const clock = { t: "2026-10-24T09:00:00Z" };
    assert.equal(await watch(ctx.store, { inbox }, depsAt(ctx, clock)), 0, ctx.lines.slice(-6).join("|"));
    assert.equal(analyses(ctx.store).at(-1)?.refs.recommendation, "revert");
    assert.ok(watchText(ctx.dir).startsWith("# REVERT"));
    assert.match(watchText(ctx.dir), /decision-[0-9a-f]{12}\.md/);
    drop(inbox, "after.json", experimentBAfterStop(tag));
    for (const t of ["2026-10-25T09:00:00Z", "2026-11-06T09:00:00Z"]) {
      clock.t = t;
      assert.equal(await watch(ctx.store, { inbox }, depsAt(ctx, clock)), 0);
      assert.equal(experimentImports(ctx.store).length, 1);
      assert.equal(analyses(ctx.store).length, 1);
      assert.ok(watchText(ctx.dir).startsWith("# REVERT"), watchText(ctx.dir).slice(0, 300));
    }
  } finally { await ctx.stop(); }
});

test("--log builds one export at a due look through the exporter; a refusal from it is reported", async () => {
  const { ctx, approve, tag } = await approved(DEMO.experiment_c_start);
  try {
    await approve();
    const out = join(tmp("watch-log-"), "out");
    const calls: string[] = [];
    const exporter: LogExporter = (i) => {
      calls.push(`${i.assignment}:${i.logDir}`);
      drop(out, "made.json", exportAt(tag, DEMO.experiment_c_start, 6, i.now.toISOString().replace(".000Z", "Z"), "from-log"));
      return { path: join(out, "made.json") };
    };
    const clock = { t: day(DEMO.experiment_c_start, 6) };
    assert.equal(await watch(ctx.store, { log: "/logs", assignment: "hash" }, depsAt(ctx, clock), exporter), 0, ctx.lines.slice(-4).join("|"));
    assert.deepEqual(calls, ["hash:/logs"]);
    assert.equal(analyses(ctx.store).length, 1);
    // The same day: no look is allowed, so the exporter is not called.
    assert.equal(await watch(ctx.store, { log: "/logs", assignment: "hash" }, depsAt(ctx, clock), exporter), 0);
    assert.equal(calls.length, 1);
    clock.t = day(DEMO.experiment_c_start, 8);
    const refusing: LogExporter = () => { throw new PilotError("invalid_telemetry", "the log has no rows"); };
    assert.equal(await watch(ctx.store, { log: "/logs", assignment: "hash" }, depsAt(ctx, clock), refusing), 1);
    assert.match(watchText(ctx.dir), /Refused \(invalid_telemetry\): the log has no rows/);
    assert.equal(analyses(ctx.store).length, 1);
  } finally { await ctx.stop(); }
});

test("a tick every hour from the start to two days past the cutoff: capped interim looks, one a UTC day, exactly one final", async () => {
  const { ctx, approve, tag, spec: s } = await approved(DEMO.experiment_c_start);
  try {
    await approve();
    const inbox = join(tmp("watch-inbox-"), "in");
    const allowed = interimLooksAllowed(s, 1);
    const hours = Math.round((ms(s.analysis_cutoff) + 2 * DAY_MS - ms(s.window.start)) / 3_600_000);
    mkdirSync(inbox, { recursive: true });
    const clock = { t: s.window.start };
    for (let h = 0; h <= hours; h++) {
      clock.t = new Date(ms(s.window.start) + h * 3_600_000).toISOString().replace(".000Z", "Z");
      const days = Math.min(14, Math.floor(h / 24));
      if (days >= 1) drop(inbox, `export-${String(h).padStart(4, "0")}.json`, exportAt(tag, DEMO.experiment_c_start, days, clock.t, `h${h}`, 8));
      const code = await watch(ctx.store, { inbox }, depsAt(ctx, clock));
      assert.equal(code, 0, `hour ${h}: ${ctx.lines.slice(-4).join(" | ")}`);
    }
    const all = analyses(ctx.store);
    const interim = all.filter((e) => e.refs.final === "false");
    const finals = all.filter((e) => e.refs.final === "true");
    assert.ok(interim.length >= 1 && interim.length <= allowed, `${interim.length} interim looks`);
    assert.equal(finals.length, 1);
    const days = interim.map((e) => e.at.slice(0, 10));
    assert.equal(new Set(days).size, days.length, "one look per UTC day");
    // The final result comes from the first export made at or after the cutoff.
    const finalImport = experimentImports(ctx.store).map((e) => ctx.store.get<TelemetryImport>("telemetry", e.refs.telemetry)).filter((i) => ms(i.exported_at) >= ms(s.analysis_cutoff));
    assert.equal(finalImport.length, 1);
    assert.equal(finalImport[0].exported_at, s.analysis_cutoff);
    assert.equal(dayLabel(finalImport[0].exported_at), dayLabel(s.analysis_cutoff));
  } finally { await ctx.stop(); }
});

test("a whole watched experiment never touches GitHub or the network, even with a token in the environment", async () => {
  const { ctx, approve, tag, spec: s } = await approved(DEMO.experiment_c_start);
  try {
    assert.equal(await ctx.run(["review", "--candidate", ctx.eligible, "--publish", "--repo", DEMO.slug, "--base", DEMO.base, "--confirm", ctx.eligible]), 0);
    await approve();
    const seen = ctx.github.requests.length;
    assert.ok(seen > 0, "the review step did publish");
    const inbox = join(tmp("watch-inbox-"), "in");
    const trap: Partial<PilotDeps> = {
      env: { [GITHUB_TOKEN_ENV]: "test-token" },
      github: () => { throw new Error("watch called github"); },
      fetch: (() => { throw new Error("watch called fetch"); }) as typeof fetch,
    };
    const clock = { t: day(DEMO.experiment_c_start, 6) };
    drop(inbox, "d6.json", exportAt(tag, DEMO.experiment_c_start, 6, clock.t, "d6"));
    assert.equal(await watch(ctx.store, { inbox }, depsAt(ctx, clock, trap)), 0, ctx.lines.slice(-4).join("|"));
    clock.t = s.analysis_cutoff;
    drop(inbox, "final.json", exportAt(tag, DEMO.experiment_c_start, 14, clock.t, "final"));
    assert.equal(await watch(ctx.store, { inbox }, depsAt(ctx, clock, trap)), 0, ctx.lines.slice(-4).join("|"));
    assert.equal(analyses(ctx.store).length, 2);
    assert.equal(ctx.github.requests.length, seen);
    assert.match(watchText(ctx.dir), /Nothing was published\. This command never opens a pull request and never changes traffic\./);
    assert.ok(!ctx.lines.join("\n").includes("test-token"));
  } finally { await ctx.stop(); }
});

test("WATCH.md holds no conversation id or unit id from the exports", async () => {
  const { ctx, approve, tag } = await approved(DEMO.experiment_c_start);
  try {
    await approve();
    const inbox = join(tmp("watch-inbox-"), "in");
    drop(inbox, "d6.json", exportAt(tag, DEMO.experiment_c_start, 6, day(DEMO.experiment_c_start, 6), "d6"));
    // A file name with a control character is printed cleaned.
    drop(inbox, "bad\u001b[31m.json", { header: { format: "x" }, csv: "" });
    assert.equal(await watch(ctx.store, { inbox }, depsAt(ctx, { t: day(DEMO.experiment_c_start, 7) })), 1);
    const text = watchText(ctx.dir);
    for (const id of [`c-${DEMO.baseline_tag}-00-0000`, `c-${tag}-00-0000`, `u-${DEMO.baseline_tag}-00-0000`, "c-juniper-v14-00-0000"]) assert.ok(!text.includes(id), id);
    assert.ok(!text.includes("\u001b"));
    assert.match(text, /Journal\n\nHead: entry \d+, [0-9a-f]{64}\. Note it outside this directory/);
  } finally { await ctx.stop(); }
});

// ---------------------------------------------------------------------------------------------------------------
// Through the real command table, with a call log written by the real recorder.
// ---------------------------------------------------------------------------------------------------------------

// A log of `days` days from the window start, `perDay` conversations a day, split by the customer-side function
// the wrapper ships. The candidate does a little better, so a final analysis has something to say.
function splitLog(dir: string, s: ExperimentSpec, days: number, perDay: number, salt = "watch-test-salt"): void {
  let clock = new Date(0);
  const rec = pilotRecorder({ logDir: dir, agent: "Juniper", idKey: "watch-test-key-0123456789", now: () => clock });
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      const at = new Date(ms(s.window.start) + d * DAY_MS + Math.floor((i * DAY_MS) / perDay));
      const id = `conv-${d}-${i}`;
      const version = pickVersion({ key: id, salt, baseline: s.arms.baseline.tag, candidate: s.arms.candidate.tag, candidateShareBp: Math.round(s.allocation.candidate * 10000) });
      clock = at;
      rec.record({ promptVersion: version, conversationId: id, unitId: `unit-${d}-${i}`, segment: i % 3 === 0 ? "email" : "chat", startedAt: at });
      clock = new Date(at.getTime() + 600_000);
      const better = version === s.arms.candidate.tag ? 1 : 0;
      rec.outcome(id, { resolved: (i * 7 + d) % 100 < 60 + better * 4 ? 1 : 0, escalated: (i + d) % 8 === 0 ? 1 : 0, refund_usd: i % 7 === 0 ? 28 : 0 });
    }
  }
  assert.equal(rec.problems(), 0);
}
const exportFiles = (dir: string) => (existsSync(join(dir, "exports")) ? readdirSync(join(dir, "exports")).sort() : []);

test("watch --log through main: an interim look on day 2, the final at the cutoff, the export in exports/, and verify passes", async () => {
  const { ctx, approve, spec: s } = await approved(DEMO.experiment_c_start);
  try {
    await approve();
    const logDir = join(tmp("watch-recorder-"), "log");
    splitLog(logDir, s, 14, 120);
    const argv = ["watch", "--log", logDir, "--assignment", "randomized"];
    ctx.lines.length = 0;
    assert.equal(await ctx.run(argv, { now: () => new Date(day(s.window.start, 2)) }), 0, ctx.lines.slice(-5).join("|"));
    assert.equal(analyses(ctx.store).length, 1);
    assert.equal(analyses(ctx.store)[0].refs.final, "false");
    assert.equal(analyses(ctx.store)[0].refs.recommendation, "hold");
    const first = exportFiles(ctx.dir);
    assert.equal(first.length, 2, first.join(","));
    assert.ok(first.every((f) => f.startsWith("calllog-")));
    assert.equal(await ctx.run(argv, { now: () => new Date(day(s.window.start, 2)) }), 0);
    assert.equal(analyses(ctx.store).length, 1, "the same day: no second look");
    assert.equal(await ctx.run(argv, { now: () => new Date(s.analysis_cutoff) }), 0, ctx.lines.slice(-5).join("|"));
    const all = analyses(ctx.store);
    assert.equal(all.length, 2);
    assert.equal(all[1].refs.final, "true");
    assert.equal(await ctx.run(["verify"]), 0, ctx.lines.slice(-4).join("|"));
    assert.equal(exportFiles(ctx.dir).length, 4);
    assert.match(watchText(ctx.dir), /final result stands/);
  } finally { await ctx.stop(); }
});

test("watch --log takes --agent, and a wrong agent is a refusal", async () => {
  const { ctx, approve, spec: s } = await approved(DEMO.experiment_c_start);
  try {
    await approve();
    const logDir = join(tmp("watch-recorder-"), "log");
    splitLog(logDir, s, 4, 60);
    const now = { now: () => new Date(day(s.window.start, 3)) };
    assert.equal(await ctx.run(["watch", "--log", logDir, "--assignment", "randomized", "--agent", "Nobody"], now), 1);
    assert.match(watchText(ctx.dir), /Refused \(usage\): .*Nobody/);
    assert.equal(analyses(ctx.store).length, 0);
    assert.equal(await ctx.run(["watch", "--log", logDir, "--assignment", "randomized", "--agent", "Juniper"], now), 0, ctx.lines.slice(-4).join("|"));
    assert.equal(analyses(ctx.store).length, 1);
  } finally { await ctx.stop(); }
});

test("duplicate imports: the same file left in the inbox is never imported twice, and an identical copy under another name is not either", async () => {
  const { ctx, approve, tag } = await approved(DEMO.experiment_c_start);
  try {
    await approve();
    const inbox = join(tmp("watch-inbox-"), "in");
    const x = exportAt(tag, DEMO.experiment_c_start, 3, day(DEMO.experiment_c_start, 3), "d3");
    drop(inbox, "d3.json", x);
    const clock = { t: day(DEMO.experiment_c_start, 4) };
    assert.equal(await watch(ctx.store, { inbox }, depsAt(ctx, clock)), 0);
    assert.equal(analyses(ctx.store).length, 1);
    // The next day: the file is still there. Nothing new is imported.
    clock.t = day(DEMO.experiment_c_start, 5);
    assert.equal(await watch(ctx.store, { inbox }, depsAt(ctx, clock)), 0);
    // An identical copy, another name: same content, so the same record.
    copyFileSync(join(inbox, "d3.json"), join(inbox, "copy-of-d3.json"));
    clock.t = day(DEMO.experiment_c_start, 6);
    assert.equal(await watch(ctx.store, { inbox }, depsAt(ctx, clock)), 0, ctx.lines.slice(-4).join("|"));
    clock.t = day(DEMO.experiment_c_start, 7);
    assert.equal(await watch(ctx.store, { inbox }, depsAt(ctx, clock)), 0);
    const imports = experimentImports(ctx.store);
    assert.equal(imports.length, 1);
    assert.equal(new Set(imports.map((e) => e.key)).size, 1);
    assert.equal(analyses(ctx.store).length, 1);
    assert.match(watchText(ctx.dir), /imported: 2/);
  } finally { await ctx.stop(); }
});

test("restart and overlap: two watch commands started together give one analysis; the other does nothing", async () => {
  const { ctx, approve, tag } = await approved(DEMO.experiment_c_start);
  try {
    await approve();
    const inbox = join(tmp("watch-inbox-"), "in");
    drop(inbox, "d3.json", exportAt(tag, DEMO.experiment_c_start, 3, day(DEMO.experiment_c_start, 3), "d3"));
    const at = { now: () => new Date(day(DEMO.experiment_c_start, 4)) };
    ctx.lines.length = 0;
    const codes = await Promise.all([ctx.run(["watch", "--inbox", inbox], at), ctx.run(["watch", "--inbox", inbox], at)]);
    assert.deepEqual(codes, [0, 0], ctx.lines.join("|"));
    assert.equal(analyses(ctx.store).length, 1);
    assert.equal(experimentImports(ctx.store).length, 1);
    assert.ok(ctx.lines.some((l) => /Another watch is running|No look was allowed|already made today/i.test(l)), ctx.lines.join("|"));
  } finally { await ctx.stop(); }
});

test("missing telemetry: an empty or missing log folder at a due look is a refusal with no stack trace; the next tick with a good log succeeds", async () => {
  const { ctx, approve, spec: s } = await approved(DEMO.experiment_c_start);
  try {
    await approve();
    const empty = tmp("watch-empty-");
    const now = { now: () => new Date(day(s.window.start, 3)) };
    for (const log of [empty, join(empty, "does-not-exist")]) {
      ctx.lines.length = 0;
      assert.equal(await ctx.run(["watch", "--log", log, "--assignment", "randomized"], now), 1, log);
      assert.equal(analyses(ctx.store).length, 0);
      const said = ctx.lines.join("\n");
      assert.doesNotMatch(said, /\n\s+at |Error:|unexpected/);
      assert.match(watchText(ctx.dir), /Refused \([a-z_]+\)/);
    }
    const good = join(tmp("watch-recorder-"), "log");
    splitLog(good, s, 4, 60);
    assert.equal(await ctx.run(["watch", "--log", good, "--assignment", "randomized"], now), 0, ctx.lines.slice(-4).join("|"));
    assert.equal(analyses(ctx.store).length, 1);
  } finally { await ctx.stop(); }
});

test("malformed telemetry: a file that is not JSON is invalid and fails the tick, and a valid file beside it is still analysed", async () => {
  const { ctx, approve, tag } = await approved(DEMO.experiment_c_start);
  try {
    await approve();
    const inbox = join(tmp("watch-inbox-"), "in");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "garbage.json"), "{ this is not json");
    writeFileSync(join(inbox, "empty.json"), "");
    drop(inbox, "good.json", exportAt(tag, DEMO.experiment_c_start, 3, day(DEMO.experiment_c_start, 3), "good"));
    ctx.lines.length = 0;
    assert.equal(await watch(ctx.store, { inbox }, depsAt(ctx, { t: day(DEMO.experiment_c_start, 4) })), 1);
    assert.equal(analyses(ctx.store).length, 1, "the valid file was analysed");
    const text = watchText(ctx.dir);
    assert.match(text, /invalid: 2/);
    assert.match(text, /garbage\.json: [a-z_]+: /);
    assert.doesNotMatch(ctx.lines.join("\n"), /\n\s+at /);
  } finally { await ctx.stop(); }
});

test("stable final decision: ten more ticks with new and better exports never change the recommendation", async () => {
  const { ctx, approve, tag, spec: s } = await approved(DEMO.experiment_c_start);
  try {
    await approve();
    const inbox = join(tmp("watch-inbox-"), "in");
    drop(inbox, "final.json", exportAt(tag, DEMO.experiment_c_start, 14, s.analysis_cutoff, "final"));
    const clock = { t: day(s.analysis_cutoff, 1) };
    assert.equal(await watch(ctx.store, { inbox }, depsAt(ctx, clock)), 0, ctx.lines.slice(-4).join("|"));
    const decided = analyses(ctx.store);
    assert.equal(decided.length, 1);
    const recommendation = decided[0].refs.recommendation;
    const head = decided[0].hash;
    for (let i = 1; i <= 10; i++) {
      const better = telemetryExport({ export_id: `later-${i}`, start: DEMO.experiment_c_start, days: 14, exported_at: day(s.analysis_cutoff, 1 + i), assignment: "randomized", lag_days: 2, csv_name: `later-${i}.csv`, arms: armsC(tag).map((a, k) => (k === 1 ? { ...a, resolved: 0.65 + i * 0.01 } : a)) });
      drop(inbox, `later-${i}.json`, better);
      clock.t = day(s.analysis_cutoff, 1 + i);
      assert.equal(await watch(ctx.store, { inbox }, depsAt(ctx, clock)), 0, `tick ${i}`);
      assert.equal(analyses(ctx.store).length, 1, `tick ${i}`);
      assert.equal(analyses(ctx.store)[0].hash, head);
      assert.equal(analyses(ctx.store).at(-1)!.refs.recommendation, recommendation);
      assert.ok(watchText(ctx.dir).startsWith(`# ${recommendation.toUpperCase()}`), `tick ${i}`);
    }
    assert.equal(experimentImports(ctx.store).length, 1);
  } finally { await ctx.stop(); }
});

test("through main: a full watched experiment makes no request to GitHub and never calls deps.fetch, with both secrets in the environment", async () => {
  const { ctx, approve, tag, spec: s } = await approved(DEMO.experiment_c_start);
  try {
    assert.equal(await ctx.run(["review", "--candidate", ctx.eligible, "--publish", "--repo", DEMO.slug, "--base", DEMO.base, "--confirm", ctx.eligible]), 0);
    await approve();
    const seen = ctx.github.requests.length;
    const inbox = join(tmp("watch-inbox-"), "in");
    const secrets = { [GITHUB_TOKEN_ENV]: "gh-secret-for-test", ANTHROPIC_API_KEY: "provider-secret-for-test" };
    const fetchTrap = (() => { throw new Error("watch called fetch"); }) as typeof fetch;
    ctx.lines.length = 0;
    const run = (t: string) => ctx.run(["watch", "--inbox", inbox], { env: secrets, fetch: fetchTrap, now: () => new Date(t) });
    drop(inbox, "d6.json", exportAt(tag, DEMO.experiment_c_start, 6, day(DEMO.experiment_c_start, 6), "d6"));
    assert.equal(await run(day(DEMO.experiment_c_start, 7)), 0, ctx.lines.slice(-4).join("|"));
    drop(inbox, "final.json", exportAt(tag, DEMO.experiment_c_start, 14, s.analysis_cutoff, "final"));
    assert.equal(await run(day(s.analysis_cutoff, 1)), 0, ctx.lines.slice(-4).join("|"));
    assert.equal(analyses(ctx.store).length, 2);
    assert.equal(ctx.github.requests.length, seen, "no request reached the fake GitHub server");
    assert.ok(!ctx.lines.join("\n").includes("secret-for-test"));
    assert.ok(!watchText(ctx.dir).includes("secret-for-test"));
  } finally { await ctx.stop(); }
});

test("WATCH.md and stdout hold no conversation id, unit id, recorder token or raw id from the log", async () => {
  const { ctx, approve, spec: s } = await approved(DEMO.experiment_c_start);
  try {
    await approve();
    const logDir = join(tmp("watch-recorder-"), "log");
    splitLog(logDir, s, 6, 60);
    ctx.lines.length = 0;
    assert.equal(await ctx.run(["watch", "--log", logDir, "--assignment", "randomized"], { now: () => new Date(day(s.window.start, 5)) }), 0, ctx.lines.slice(-4).join("|"));
    const csv = exportFiles(ctx.dir).find((f) => f.endsWith(".csv"))!;
    const [head, ...rows] = readFileSync(join(ctx.dir, "exports", csv), "utf8").trimEnd().split("\n");
    const cols = head.split(",");
    const tokens = rows.flatMap((r) => { const c = r.split(","); return [c[cols.indexOf("conversation_id")], c[cols.indexOf("unit_id")]]; });
    assert.ok(tokens.length > 100 && tokens.every((t) => /^[a-p]{32}$/.test(t)));
    const outputs = [ctx.lines.join("\n"), watchText(ctx.dir)];
    for (const text of outputs) {
      assert.doesNotMatch(text, /conv-\d|unit-\d|watch-test-key/);
      for (const t of tokens.slice(0, 200)) assert.ok(!text.includes(t), "a token from the export is printed");
    }
  } finally { await ctx.stop(); }
});
