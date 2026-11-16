// Integrity defects found in review of the pilot's store, approval and publish paths. Each test here failed on the
// code before its fix; the commit that fixed it says which.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEMO, experimentCFinal, experimentCInterim, experimentFailureCases } from "../src/pilot/demo-data.ts";
import { canonicalJson } from "../src/core/evidence.ts";
import { sha256 } from "../src/core/safety.ts";
import { candidateTag } from "../src/pilot/ids.ts";
import { main } from "../src/pilot/main.ts";
import type { Approval, ExperimentAnalysis, PromotionRequest, ReplayReport, ReviewBundle } from "../src/pilot/types.ts";
import { makeApproval } from "../src/pilot/approval.ts";
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

// Starts several test/pilot-worker.ts processes, releases them together, and returns what each printed.
async function inParallel(jobs: string[][]): Promise<{ code: number | null; out: string }[]> {
  const root = tmp("pilot-procs-");
  const go = join(root, "go");
  const children = jobs.map((job, i) => {
    const child = spawn(process.execPath, [join(import.meta.dirname, "pilot-worker.ts"), join(root, `ready-${i}`), go, ...job], { stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH ?? "" } });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    return new Promise<{ code: number | null; out: string }>((resolve) => { child.on("close", (code) => { resolve({ code, out }); }); });
  });
  const deadline = Date.now() + 60_000;
  while (jobs.some((_, i) => !existsSync(join(root, `ready-${i}`))) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  writeFileSync(go, "go");
  return Promise.all(children);
}

test("two processes appending to one journal never fork it", async () => {
  // Before the fix a process could take a lock that another had just released or not yet written, so two of them
  // wrote the same sequence number: most runs of this broke the chain.
  for (let round = 0; round < 3; round++) {
    const dir = join(tmp("pilot-lock-"), "pilot");
    mkdirSync(dir, { recursive: true });
    const done = await inParallel([1, 2, 3].map((n) => ["record", dir, `w${n}`, "40"]));
    for (const d of done) assert.equal(d.code, 0, d.out);
    const entries = new PilotStore(dir).journal();
    assert.equal(entries.length, 120, `round ${round}: every entry from every process is in one unbroken chain`);
  }
});

test("an empty or half-written lock is a live owner that has not finished writing, until it is old", () => {
  const dir = join(tmp("pilot-emptylock-"), "pilot");
  mkdirSync(dir, { recursive: true });
  const store = new PilotStore(dir);
  const lock = join(dir, "journal.lock");
  for (const text of ["", "12ab"]) {
    writeFileSync(lock, text);
    assert.throws(() => store.record("step", "k", { a: "1" }, "2026-11-01T00:00:00Z"), (e: unknown) => (e as { code?: string }).code === "conflict", `fresh lock holding "${text}"`);
    assert.equal(readFileSync(lock, "utf8"), text, "a live lock is left alone");
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old);
    store.record("step", `old-${text}`, { a: "1" }, "2026-11-01T00:00:00Z");
    assert.ok(!existsSync(lock));
  }
});

// A pilot with an approved experiment, ready for a final export, and the path of that export.
async function approvedPilot(): Promise<Ctx & { candidate: string; experiment: string; exported: string }> {
  const ctx = await replayedPilot();
  const must = async (argv: string[]) => { if (await ctx.run(argv) !== 0) throw new Error(`setup failed at ${argv[0]}: ${ctx.lines.slice(-3).join(" | ")}`); };
  const candidate = ctx.eligible;
  await must(["experiment", "--candidate", candidate, "--start", DEMO.experiment_c_start]);
  const experiment = ctx.last("experiment.specified");
  await must(["review", "--candidate", candidate]);
  ctx.on("2026-10-26");
  await must(["approve", "--candidate", candidate, "--experiment", experiment, "--approver", "Tomas Lindqvist"]);
  const exported = writeExport(ctx, "final.json", experimentCFinal(candidateTag(candidate)));
  return Object.assign(ctx, { candidate, experiment, exported });
}

test("two analyses of the same experiment at once leave a journal that still verifies", async () => {
  // Before the fix both read the journal, both found nothing imported, and both recorded their own import and
  // a decision, so the stored decision of the first no longer followed from the imports recorded before the second.
  for (let round = 0; round < 3; round++) {
    const ctx = await approvedPilot();
    try {
      // Two different exports, as when the customer sends the day-6 look and the final one close together.
      const interim = writeExport(ctx, "day6.json", experimentCInterim(candidateTag(ctx.candidate)));
      const job = (file: string) => ["main", ctx.dir, "2026-11-13T00:00:00Z", "analyze", "--experiment", ctx.experiment, "--telemetry", file];
      const done = await inParallel([job(interim), job(ctx.exported)]);
      const results = done.map((d) => JSON.parse(d.out) as { code: number; lines: string[] });
      assert.ok(results.some((r) => r.code === 0), "one of them decided");
      for (const r of results.filter((x) => x.code !== 0)) assert.ok(r.lines.some((l) => /Another pilot command/.test(l)), `the other was told to wait: ${r.lines.join(" | ")}`);
      const verified = await run(ctx.dir, ["verify"]);
      assert.equal(verified.code, 0, `round ${round}: ${verified.lines.join(" | ")}`);
      assert.equal(ctx.store.find("analysis.decided").length, 1);
    } finally { await ctx.stop(); }
  }
});

// An eligible candidate with an experiment and a review, whose pack was then promoted to version 2, on which the
// candidate was replayed again and did not pass.
async function outgrownPilot(): Promise<Ctx & { candidate: string; experiment: string }> {
  const ctx = await replayedPilot();
  const must = async (argv: string[]) => { if (await ctx.run(argv) !== 0) throw new Error(`setup failed at ${argv[0]}: ${ctx.lines.slice(-3).join(" | ")}`); };
  const candidate = ctx.eligible;
  await must(["experiment", "--candidate", candidate, "--start", DEMO.experiment_c_start]);
  const experiment = ctx.last("experiment.specified");
  await must(["review", "--candidate", candidate]);
  const request: PromotionRequest = {
    version: 1, base_pack_id: ctx.last("pack.frozen"), approver: DEMO.quality_lead, at: "2026-10-18T10:00:00Z", existing: [],
    added: experimentFailureCases().map((c) => ({ case: c, reason: "seen in an earlier experiment", evidence: { experiment_id: experiment } })),
  };
  await must(["promote", "--request", ctx.put("promotion.json", json(request))]);
  await must(["replay", "--candidate", candidate, "--model", ctx.model]);
  assert.equal(ctx.store.get<ReplayReport>("replay", ctx.last("replay.paired")).gate.eligible, false, "the candidate no longer passes on the new pack");
  return Object.assign(ctx, { candidate, experiment });
}

test("approve refuses a candidate whose replay does not pass on the active pack, but a rejection is still recorded", async () => {
  const ctx = await outgrownPilot();
  try {
    const args = ["approve", "--candidate", ctx.candidate, "--experiment", ctx.experiment, "--approver", "Tomas Lindqvist"];
    assert.equal(await ctx.run(args), 1);
    assert.ok(ctx.lines.some((l) => l.startsWith("Refused (replay_gate_failed)")), ctx.lines.join(" | "));
    assert.equal(ctx.store.find("approval.recorded").length, 0);
    assert.equal(await ctx.run([...args, "--reject"]), 0, "saying no is always allowed");
  } finally { await ctx.stop(); }
});

test("verify flags an approval recorded while the candidate did not pass replay on the active pack", async () => {
  const ctx = await outgrownPilot();
  try {
    assert.equal((await run(ctx.dir, ["verify"])).code, 0);
    // Written straight into the store, as an operator with write access could.
    const entry = ctx.store.find("review.bundled").at(-1)!;
    const bundle = { id: entry.key, value: ctx.store.get<ReviewBundle>("review", entry.key) };
    const approval = makeApproval({ pilot_id: bundle.value.pilot_id, bundle, candidate_id: ctx.candidate, experiment_id: ctx.experiment, approver: "Tomas Lindqvist", decision: "approved", at: "2026-10-26T09:00:00Z" });
    const id = ctx.store.put("approval", approval);
    ctx.store.record("approval.recorded", id, { approval: id, candidate: ctx.candidate, experiment: ctx.experiment, decision: "approved" }, approval.at);
    const result = await run(ctx.dir, ["verify"]);
    assert.equal(result.code, 1, result.lines.join(" | "));
    assert.ok(result.lines.some((l) => /did not pass replay|no replay/.test(l)), result.lines.join(" | "));
  } finally { await ctx.stop(); }
});

test("a journal line cut off by a crash is ignored, noted by verify, and removed by the next record", async () => {
  const ctx = await approvedPilot();
  try {
    const path = join(ctx.dir, "journal.jsonl");
    const before = readFileSync(path, "utf8");
    const head = readFileSync(join(ctx.dir, "journal.head"), "utf8");
    const count = ctx.store.journal().length;
    const next = JSON.stringify({ seq: count + 1, at: "2026-11-01T00:00:00Z", step: "torn.marker", key: "x", refs: {}, prev: ctx.store.journal().at(-1)!.hash, hash: "0".repeat(64) });
    // Two ways to be cut off: in the middle of a line, and just before its newline (a whole, valid-looking line).
    for (const torn of [next.slice(0, 70), next]) {
      writeFileSync(path, before);
      writeFileSync(join(ctx.dir, "journal.head"), head);
      appendFileSync(path, torn);
      assert.equal(ctx.store.journal().length, count, "the torn line is not an entry");
      const status = await run(ctx.dir, ["status"]);
      assert.equal(status.code, 0, status.lines.join(" | "));
      const verified = await run(ctx.dir, ["verify"]);
      assert.equal(verified.code, 0, verified.lines.join(" | "));
      assert.ok(verified.lines.some((l) => /^Note: .*unfinished|cut off/i.test(l)), verified.lines.join(" | "));
      ctx.store.record("worker.step", "after-torn", { a: "1" }, "2026-11-01T00:00:00Z");
      assert.equal(ctx.store.journal().length, count + 1, "the new entry is appended after the last whole line");
      assert.ok(readFileSync(path, "utf8").endsWith("\n"));
      assert.ok(!readFileSync(path, "utf8").includes("torn.m"), "the torn fragment is gone");
    }
  } finally { await ctx.stop(); }
});

test("an export dated at or after the cutoff is refused when it is even a minute ahead of the clock, an interim one is allowed the usual skew", async () => {
  const ctx = await approvedPilot();
  try {
    const tag = candidateTag(ctx.candidate);
    const imports = () => ctx.store.find("telemetry.imported").filter((e) => e.refs.purpose === "experiment").length;
    // The final export says it was made at the cutoff, 00:00 on 2026-11-12. The clock says 23:56 the day before:
    // accepted, it would read as a final analysis four minutes before the experiment is allowed to end.
    const final = writeExport(ctx, "final.json", experimentCFinal(tag));
    const refusal = await run(ctx.dir, ["analyze", "--experiment", ctx.experiment, "--telemetry", final], "2026-11-11T23:56:00Z");
    assert.equal(refusal.code, 1, refusal.lines.join(" | "));
    assert.equal(imports(), 0);
    assert.ok(refusal.lines.some((l) => l.startsWith("Refused (invalid_telemetry)") && /later than now/.test(l)), refusal.lines.join(" | "));
    // An interim look (the day-6 export, made 2026-11-02T00:00Z) three minutes ahead of the clock is within the skew.
    const interim = writeExport(ctx, "day6.json", experimentCInterim(tag));
    const early = await run(ctx.dir, ["analyze", "--experiment", ctx.experiment, "--telemetry", interim], "2026-11-01T23:57:00Z");
    assert.equal(early.code, 0, early.lines.join(" | "));
    // The same final export a minute after its own time is fine.
    const ok = await run(ctx.dir, ["analyze", "--experiment", ctx.experiment, "--telemetry", final], "2026-11-12T00:01:00Z");
    assert.equal(ok.code, 0, ok.lines.join(" | "));
  } finally { await ctx.stop(); }
});

test("an experiment cannot be specified to start in the past unless that is said outright", async () => {
  const ctx = await replayedPilot();
  try {
    const args = (start: string, extra: string[] = []) => ["experiment", "--candidate", ctx.eligible, "--start", start, ...extra];
    assert.equal(await ctx.run(args("2020-01-01T00:00:00Z")), 1);
    assert.ok(ctx.lines.some((l) => l.startsWith("Refused (usage)") && /allow-past-start/.test(l)), ctx.lines.join(" | "));
    assert.equal(ctx.store.find("experiment.specified").length, 0);
    assert.equal(await ctx.run(args("2020-01-01T00:00:00Z", ["--allow-past-start"])), 0, ctx.lines.join(" | "));
    assert.equal(ctx.store.find("experiment.specified").length, 1);
    assert.equal(await ctx.run(args(DEMO.experiment_c_start)), 0, "a start in the future needs no flag");
  } finally { await ctx.stop(); }
});

test("an approval recorded after the traffic started holds the result, whatever the export says", async () => {
  const ctx = await replayedPilot();
  try {
    const must = async (argv: string[]) => { if (await ctx.run(argv) !== 0) throw new Error(`setup failed at ${argv[0]}: ${ctx.lines.slice(-3).join(" | ")}`); };
    await must(["experiment", "--candidate", ctx.eligible, "--start", DEMO.experiment_c_start]);
    const experiment = ctx.last("experiment.specified");
    await must(["review", "--candidate", ctx.eligible]);
    // The split started on 2026-10-27; the approval is recorded two weeks into it.
    ctx.on("2026-11-10");
    await must(["approve", "--candidate", ctx.eligible, "--experiment", experiment, "--approver", "Tomas Lindqvist"]);
    ctx.on("2026-11-13");
    await must(["analyze", "--experiment", experiment, "--telemetry", writeExport(ctx, "final.json", experimentCFinal(candidateTag(ctx.eligible)))]);
    const analysis = ctx.store.get<ExperimentAnalysis>("analysis", ctx.last("analysis.decided"));
    assert.equal(analysis.final, true);
    assert.ok(analysis.flags.includes("traffic_before_approval"), analysis.flags.join(","));
    assert.equal(analysis.recommendation, "hold", "the same data with an approval before the split is a keep");
    assert.ok(analysis.reasons.some((r) => /started before the approval/.test(r)));
    assert.equal((await run(ctx.dir, ["verify"])).code, 0, "and the decision still verifies");
  } finally { await ctx.stop(); }
});

// Publishing the review of the eligible candidate, as the documented command line has it.
const publishArgs = (candidate: string) => ["review", "--candidate", candidate, "--publish", "--repo", DEMO.slug, "--base", DEMO.base, "--confirm", candidate];
// Someone else's commit lands on the base branch.
async function moveBase(ctx: Ctx): Promise<void> {
  const res = await fetch(`${ctx.github.url}/repos/${DEMO.slug}/contents/README.md`, { method: "PUT", body: JSON.stringify({ branch: DEMO.base, content: Buffer.from("hello").toString("base64"), message: "docs", sha: "x" }) });
  assert.equal(res.status, 200);
}
async function experimentReady(): Promise<Ctx & { candidate: string }> {
  const ctx = await replayedPilot();
  for (const argv of [["experiment", "--candidate", ctx.eligible, "--start", DEMO.experiment_c_start], ["review", "--candidate", ctx.eligible]]) {
    if (await ctx.run(argv) !== 0) throw new Error(`setup failed at ${argv[0]}: ${ctx.lines.slice(-3).join(" | ")}`);
  }
  return Object.assign(ctx, { candidate: ctx.eligible });
}

test("publishing again after the base branch moved finds the pull request that is already open", async () => {
  const ctx = await experimentReady();
  try {
    assert.equal(await ctx.run(publishArgs(ctx.candidate)), 0, ctx.lines.slice(-2).join(" | "));
    assert.equal(ctx.github.pulls.length, 1);
    await moveBase(ctx);
    const writes = ctx.github.writes().length;
    assert.equal(await ctx.run(publishArgs(ctx.candidate)), 0, ctx.lines.slice(-2).join(" | "));
    assert.ok(ctx.lines.some((l) => l.startsWith("Found the existing pull request #1")), ctx.lines.slice(-2).join(" | "));
    assert.equal(ctx.github.pulls.length, 1);
    assert.equal(ctx.github.writes().length, writes, "the retry wrote nothing");
  } finally { await ctx.stop(); }
});

test("a publication that stopped after the commit finishes when retried, although the base moved in between", async () => {
  const ctx = await experimentReady();
  try {
    assert.equal(await ctx.run(publishArgs(ctx.candidate), { fault: (point) => { if (point === "after-commit") throw new Error("crash"); } }), 1);
    assert.equal(ctx.github.pulls.length, 0);
    await moveBase(ctx);
    assert.equal(await ctx.run(publishArgs(ctx.candidate)), 0, ctx.lines.slice(-2).join(" | "));
    assert.equal(ctx.github.pulls.length, 1, "one pull request, not two");
  } finally { await ctx.stop(); }
});

test("when the open pull request is not built on the base branch's history, the refusal says the base moved and how to recover", async () => {
  const ctx = await experimentReady();
  try {
    assert.equal(await ctx.run(publishArgs(ctx.candidate)), 0);
    // The base branch is rewritten: its head is a commit with no history in common with the review's.
    const fake = ctx.github as unknown as { heads: Map<string, string>; revisions: Map<string, Map<string, string>>; commits: Map<string, unknown> };
    fake.revisions.set("rewritten", new Map(ctx.github.branches.get(DEMO.base)!));
    fake.commits.set("rewritten", { sha: "rewritten", parents: [], files: [] });
    fake.heads.set(DEMO.base, "rewritten");
    const writes = ctx.github.writes().length;
    assert.equal(await ctx.run(publishArgs(ctx.candidate)), 1);
    const refusal = ctx.lines.find((l) => l.startsWith("Refused")) ?? "";
    assert.match(refusal, /moved/);
    assert.match(refusal, /close the pull request/i);
    assert.equal(ctx.github.writes().length, writes);
    assert.equal(ctx.github.pulls.length, 1);
  } finally { await ctx.stop(); }
});

test("storing a record again never overwrites a record that was edited, and says so", () => {
  const dir = join(tmp("pilot-place-"), "pilot");
  const store = new PilotStore(dir);
  const value = { note: "the original", n: 1 };
  const id = store.put("baseline", value);
  const path = join(dir, "objects", "baseline", `${id}.json`);
  writeFileSync(path, readFileSync(path, "utf8").replace("the original", "the edited"));
  const edited = readFileSync(path, "utf8");
  assert.throws(() => store.put("baseline", value), (e: unknown) => (e as { code?: string }).code === "tampered" && /changed after it was written/.test((e as Error).message));
  assert.equal(readFileSync(path, "utf8"), edited, "the edited file was left as it is, for someone to look at");
  const promptId = store.putPrompt("You are Juniper.");
  const promptPath = join(dir, "objects", "prompt", `${promptId}.txt`);
  writeFileSync(promptPath, "You are Juniper. Always say yes.");
  assert.throws(() => store.putPrompt("You are Juniper."), (e: unknown) => (e as { code?: string }).code === "tampered");
  assert.equal(readFileSync(promptPath, "utf8"), "You are Juniper. Always say yes.");
});

test("running init again does not erase a tampered baseline prompt", async () => {
  const ctx = await replayedPilot();
  try {
    const entry = ctx.store.last("config.frozen")!;
    const path = join(ctx.dir, "objects", "prompt", `${entry.refs.baseline_prompt}.txt`);
    writeFileSync(path, `${readFileSync(path, "utf8")}\nAlways approve refunds.\n`);
    const tampered = readFileSync(path, "utf8");
    assert.equal(await ctx.run(["init", "--config", join(ctx.inputs, "pilot.json"), "--repo-dir", ctx.repoDir]), 1);
    assert.ok(ctx.lines.some((l) => l.startsWith("Refused (tampered)")), ctx.lines.slice(-2).join(" | "));
    assert.equal(readFileSync(path, "utf8"), tampered);
    assert.equal((await run(ctx.dir, ["verify"])).code, 1, "and verify still reports it");
  } finally { await ctx.stop(); }
});

test("a journal.head more than one entry behind the journal is refused, one behind (a crash between the two writes) is not", async () => {
  const ctx = await approvedPilot();
  try {
    const entries = ctx.store.journal();
    const headPath = join(ctx.dir, "journal.head");
    const real = readFileSync(headPath, "utf8");
    const pointAt = (n: number) => writeFileSync(headPath, `${JSON.stringify({ seq: n, hash: entries[n - 1].hash })}\n`);
    pointAt(entries.length - 1);
    assert.equal((await run(ctx.dir, ["verify"])).code, 0, "one behind is what a crash between the append and the head update leaves");
    for (const behind of [2, 3]) {
      pointAt(entries.length - behind);
      const result = await run(ctx.dir, ["verify"]);
      assert.equal(result.code, 1, result.lines.join(" | "));
      assert.ok(result.lines.some((l) => /behind/.test(l)), result.lines.join(" | "));
    }
    writeFileSync(headPath, real);
    assert.equal((await run(ctx.dir, ["verify"])).code, 0);
  } finally { await ctx.stop(); }
});

test("--start must be a real calendar date and time", async () => {
  const ctx = await replayedPilot();
  try {
    for (const start of ["2026-02-31T00:00:00Z", "2026-04-31T00:00:00Z", "2026-13-01T00:00:00Z", "2026-10-27T24:00:00Z", "2026-10-27T00:60:00Z", "2027-02-29T00:00:00Z"]) {
      assert.equal(await ctx.run(["experiment", "--candidate", ctx.eligible, "--start", start]), 1, start);
      assert.ok(ctx.lines.some((l) => l.startsWith("Refused (usage)") && /real date/.test(l)), `${start}: ${ctx.lines.at(-1)}`);
    }
    assert.equal(ctx.store.find("experiment.specified").length, 0);
    assert.equal(await ctx.run(["experiment", "--candidate", ctx.eligible, "--start", "2028-02-29T00:00:00Z"]), 0, "a real leap day is fine");
  } finally { await ctx.stop(); }
});
