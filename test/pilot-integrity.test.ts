// Integrity defects found in review of the pilot's store, approval and publish paths. Each test here failed on the
// code before its fix; the commit that fixed it says which.
import assert from "node:assert/strict";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEMO, experimentCFinal, experimentFailureCases } from "../src/pilot/demo-data.ts";
import { canonicalJson } from "../src/core/evidence.ts";
import { sha256 } from "../src/core/safety.ts";
import { candidateTag } from "../src/pilot/ids.ts";
import { main } from "../src/pilot/main.ts";
import type { Approval, ExperimentAnalysis, PromotionRequest } from "../src/pilot/types.ts";
import { PilotStore, type JournalEntry } from "../src/pilot/store.ts";
import { replayedPilot, tmp, writeExport, json, type Ctx } from "./pilot-cli-helpers.ts";

const filesUnder = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? filesUnder(p) : [p]; }) : []);

// Runs the real `main` against any pilot directory, not only the context's own, with a clock far from the data.
async function run(dir: string, argv: string[], now = "2026-11-20T00:00:00Z"): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await main([...argv, "--dir", dir], { say: (l) => { lines.push(l); }, env: {}, now: () => new Date(now) });
  return { code, lines };
}

// A pilot that has been through every step that writes a record: replay, experiment, review, approval, a final
// decision, and a promotion. The eligible candidate's experiment is the one decided.
async function completePilot(): Promise<Ctx & { candidate: string; experiment: string }> {
  const ctx = await replayedPilot();
  const must = async (argv: string[]) => { if (await ctx.run(argv) !== 0) throw new Error(`setup failed at ${argv[0]}: ${ctx.lines.slice(-3).join(" | ")}`); };
  const candidate = ctx.eligible;
  await must(["experiment", "--candidate", candidate, "--start", DEMO.experiment_c_start]);
  const experiment = ctx.last("experiment.specified");
  await must(["review", "--candidate", candidate]);
  ctx.on("2026-10-26");
  await must(["approve", "--candidate", candidate, "--experiment", experiment, "--approver", "Tomas Lindqvist"]);
  ctx.on("2026-11-13");
  await must(["analyze", "--experiment", experiment, "--telemetry", writeExport(ctx, "final.json", experimentCFinal(candidateTag(candidate)))]);
  const request: PromotionRequest = {
    version: 1, base_pack_id: ctx.last("pack.frozen"), approver: DEMO.quality_lead, at: "2026-11-13T10:00:00Z", existing: [],
    added: experimentFailureCases().map((c) => ({ case: c, reason: "seen in the experiment", evidence: { experiment_id: experiment } })),
  };
  await must(["promote", "--request", ctx.put("promotion.json", json(request))]);
  return Object.assign(ctx, { candidate, experiment });
}

test("verify fails when any record a journal entry names is missing, whatever its kind", async () => {
  const ctx = await completePilot();
  try {
    assert.equal((await run(ctx.dir, ["verify"])).code, 0, "the untouched pilot verifies");
    const objects = join(ctx.dir, "objects");
    const files = filesUnder(objects);
    const kinds = new Set(files.map((f) => f.slice(objects.length + 1).split("/")[0]));
    for (const kind of ["arm", "finding", "candidate", "replay", "telemetry", "baseline", "experiment", "review", "approval", "analysis", "promotion", "promotion-request", "pack", "config", "prompt"]) {
      assert.ok(kinds.has(kind), `the fixture holds a ${kind} record`);
    }
    const copy = join(tmp("pilot-missing-"), "pilot");
    const undetected: string[] = [];
    for (const file of files) {
      rmSync(copy, { recursive: true, force: true });
      cpSync(ctx.dir, copy, { recursive: true });
      rmSync(join(copy, file.slice(ctx.dir.length + 1)));
      const result = await run(copy, ["verify"]);
      if (result.code === 0) undetected.push(file.slice(objects.length + 1, objects.length + 20));
      else assert.ok(result.lines.some((l) => /missing|is gone|not found|No \w+ record/i.test(l)), `a deleted file is named in the report: ${result.lines.join(" | ")}`);
    }
    assert.deepEqual(undetected, [], "every single deletion is reported");
  } finally { await ctx.stop(); }
});

// Rewrites a pilot's journal with extra entries inserted after the entry at `after`, chaining it again. This is
// what someone with write access to the directory could do; verify must still notice what the result says.
function rewriteJournal(dir: string, insert: (entries: JournalEntry[]) => { after: number; entry: Omit<JournalEntry, "seq" | "prev" | "hash"> }): void {
  const store = new PilotStore(dir);
  const entries = store.journal();
  const { after, entry } = insert(entries);
  const order: Omit<JournalEntry, "seq" | "prev" | "hash">[] = [];
  for (const e of entries) {
    const { seq: _s, prev: _p, hash: _h, ...rest } = e;
    order.push(rest);
    if (e.seq === after) order.push(entry);
  }
  let prev: string | null = null;
  const lines: string[] = [];
  let last: JournalEntry | null = null;
  for (const [i, rest] of order.entries()) {
    const body = { seq: i + 1, ...rest, prev };
    const hash = sha256(canonicalJson(body));
    last = { ...body, hash } as JournalEntry;
    lines.push(JSON.stringify(last));
    prev = hash;
  }
  writeFileSync(join(dir, "journal.jsonl"), `${lines.join("\n")}\n`);
  writeFileSync(join(dir, "journal.head"), `${JSON.stringify({ seq: last!.seq, hash: last!.hash })}\n`);
}

test("a rejection recorded after an approval stops the analysis, even when its clock time is earlier", async () => {
  const ctx = await replayedPilot();
  try {
    const must = async (argv: string[]) => { if (await ctx.run(argv) !== 0) throw new Error(`setup failed at ${argv[0]}: ${ctx.lines.slice(-3).join(" | ")}`); };
    const candidate = ctx.eligible;
    await must(["experiment", "--candidate", candidate, "--start", DEMO.experiment_c_start]);
    const experiment = ctx.last("experiment.specified");
    await must(["review", "--candidate", candidate]);
    const args = (extra: string[] = []) => ["approve", "--candidate", candidate, "--experiment", experiment, "--approver", "Tomas Lindqvist", ...extra];
    ctx.on("2026-10-26");
    await must(args());
    // The host clock steps back a day: the rejection is recorded after the approval but carries an earlier time.
    ctx.on("2026-10-25");
    await must(args(["--reject"]));
    const [yes, no] = ctx.store.find("approval.recorded");
    assert.ok(no.seq > yes.seq && no.at < yes.at, "recorded later, stamped earlier");
    const exported = writeExport(ctx, "final.json", experimentCFinal(candidateTag(candidate)));
    ctx.on("2026-11-13");
    assert.equal(await ctx.run(["analyze", "--experiment", experiment, "--telemetry", exported]), 1, "the experiment was rejected after it was approved");
    assert.ok(ctx.lines.some((l) => l.startsWith("Refused (unknown_approval)") && /rejection/.test(l)), ctx.lines.join(" | "));
    assert.equal(ctx.store.find("analysis.decided").length, 0);
  } finally { await ctx.stop(); }
});

test("verify fails a decision whose approval was followed by a rejection before it was made", async () => {
  const ctx = await completePilot();
  try {
    assert.equal((await run(ctx.dir, ["verify"])).code, 0);
    const copy = join(tmp("pilot-reject-"), "pilot");
    cpSync(ctx.dir, copy, { recursive: true });
    const store = new PilotStore(copy);
    const cited = store.last("analysis.decided")!;
    const approval = store.get<ExperimentAnalysis>("analysis", cited.key).approval_id;
    const given = store.get<Approval>("approval", approval);
    const rejection = store.put("approval", { ...given, decision: "rejected", at: "2026-10-26T00:00:00Z" });
    const approvedEntry = store.find("approval.recorded")[0];
    rewriteJournal(copy, () => ({ after: approvedEntry.seq, entry: { at: "2026-10-26T00:00:00Z", step: "approval.recorded", key: rejection, refs: { approval: rejection, candidate: given.candidate_id, experiment: given.experiment_id, decision: "rejected" } } }));
    const result = await run(copy, ["verify"]);
    assert.equal(result.code, 1, result.lines.join(" | "));
    assert.ok(result.lines.some((l) => /followed by a rejection/.test(l)), result.lines.join(" | "));
    assert.ok(readFileSync(join(copy, "journal.jsonl"), "utf8").includes('"decision":"rejected"'));
  } finally { await ctx.stop(); }
});
