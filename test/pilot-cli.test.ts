import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/pilot/main.ts";
import {
  BASELINE_PROMPT, baselineExport, CANARIES, DEMO, demoConfig, demoPack, experimentBAfterStop, experimentBInterim, experimentCFinal, experimentCInterim,
  experimentFailureCases, HUMAN_CANDIDATE_PROMPT,
} from "../src/pilot/demo-data.ts";
import { candidateTag, contentId } from "../src/pilot/ids.ts";
import type { Approval, ExperimentAnalysis, Pack, PromotionRequest } from "../src/pilot/types.ts";
import { asAggregates, frozenPilot, git, json, replayedPilot, tmp, workspace, writeExport } from "./pilot-cli-helpers.ts";

const CLI = join(import.meta.dirname, "..", "src", "pilot", "cli.ts");
const filesUnder = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? filesUnder(p) : [p]; }) : []);
const refused = (lines: string[], code: string): boolean => lines.some((l) => l.startsWith(`Refused (${code})`));

test("the synthetic pilot runs end to end from the real entry point, with no credentials in the environment", () => {
  const out = join(tmp("pilot-demo-"), "run");
  // A separate process with an almost empty environment: no provider key, no GitHub token, no SYNTHE_* settings.
  const result = spawnSync(process.execPath, [CLI, "demo", "--out", out], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  assert.equal(result.status, 0, result.stdout.split("\n").filter((l) => l.includes("FAIL")).join("\n") + result.stderr);
  const text = result.stdout;
  assert.ok(!text.includes("FAIL"));
  for (const outcome of ["REJECTED IN REPLAY", ": REVERT (early stop", "at day 6: HOLD", "at the cutoff: KEEP", "promoted to", "every expectation held"]) assert.ok(text.includes(outcome), outcome);
  // The evidence a reviewer opens exists and is consistent with the outcomes.
  const reports = join(out, "pilot", "reports");
  const summary = readFileSync(join(reports, "PILOT.md"), "utf8");
  for (const word of ["**REVERT** by the predeclared early stop", "**HOLD**", "**KEEP**", "not passed, kept out of review", "pull request #1", "pull request #2", "Rollback target"]) assert.ok(summary.includes(word), word);
  // Nothing the pilot wrote for people, and no record other than the packs themselves, holds conversation text.
  const leaks = (t: string) => Object.values(CANARIES).some((c) => t.toLowerCase().includes(c.toLowerCase()));
  assert.ok(leaks(readFileSync(join(out, "inputs", "pack.v1.json"), "utf8")), "the planted strings are really in the pack");
  for (const path of [...filesUnder(reports), join(out, "pilot", "journal.jsonl"), ...filesUnder(join(out, "pilot", "objects")).filter((p) => !p.includes(`${join("objects", "pack")}`))]) {
    assert.ok(!leaks(readFileSync(path, "utf8")), `${path} holds pack conversation text`);
  }
  assert.ok(!leaks(text), "the terminal output holds pack conversation text");

  // A second run produces the same records: every id is a function of the inputs.
  const again = join(tmp("pilot-demo-"), "run");
  assert.equal(spawnSync(process.execPath, [CLI, "demo", "--out", again], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } }).status, 0);
  const ids = (root: string) => filesUnder(join(root, "pilot", "objects")).map((p) => p.slice(root.length)).sort();
  assert.deepEqual(ids(again), ids(out));
  assert.equal(readFileSync(join(again, "pilot", "journal.jsonl"), "utf8"), readFileSync(join(out, "pilot", "journal.jsonl"), "utf8"));

  // verify, as its own process: clean, then it catches a changed record and a changed journal.
  const verify = () => spawnSync(process.execPath, [CLI, "verify", "--dir", join(out, "pilot")], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  assert.equal(verify().status, 0);
  const analysisDir = join(out, "pilot", "objects", "analysis");
  const target = join(analysisDir, readdirSync(analysisDir)[0]);
  const original = readFileSync(target, "utf8");
  writeFileSync(target, original.replace('"as_of": "2026', '"as_of": "2027'));
  assert.notEqual(readFileSync(target, "utf8"), original);
  const tampered = verify();
  assert.equal(tampered.status, 1);
  assert.match(tampered.stdout, /no longer matches its id/);
  writeFileSync(target, original);
  const journal = join(out, "pilot", "journal.jsonl");
  const lines = readFileSync(journal, "utf8");
  writeFileSync(journal, lines.replace('"recommendation":"revert"', '"recommendation":"keep"'));
  assert.equal(verify().status, 1);
  writeFileSync(journal, lines);
  assert.equal(verify().status, 0);
});

test("help and mistakes: the entry point explains itself and never guesses", async () => {
  const help = execFileSync(process.execPath, [CLI, "help"], { encoding: "utf8" });
  assert.match(help, /keep \/ hold \/ revert/);
  const lines: string[] = [];
  const deps = { say: (l: string) => { lines.push(l); }, env: {}, now: () => new Date(0) };
  assert.equal(await main(["launch"], deps), 1);
  assert.equal(await main(["init", "--confg", "x"], deps), 1);
  assert.equal(await main(["status", "--dir", tmp("pilot-empty-")], deps), 1);
  assert.ok(lines.some((l) => l.includes('"launch" is not a pilot command')));
  assert.ok(lines.some((l) => l.includes("Unknown option") || l.includes("--confg")));
  assert.ok(refused(lines, "not_found"));
});

test("init freezes one contract: it is repeatable, and a changed contract, repo or revision is refused", async () => {
  const ctx = await workspace();
  try {
    const config = ctx.put("pilot.json", json(demoConfig()));
    assert.equal(await ctx.run(["init", "--config", config, "--repo-dir", ctx.repoDir]), 0);
    assert.equal(await ctx.run(["init", "--config", config, "--repo-dir", ctx.repoDir]), 0, "the same init again is fine");
    assert.equal(ctx.store.find("config.frozen").length, 1);
    assert.equal(readFileSync(join(ctx.dir, ".gitignore"), "utf8"), "*\n", "the pilot directory keeps itself out of git");

    const changed = demoConfig() as { metric: { primary: { min_effect: number } } };
    changed.metric.primary.min_effect = 0.01;
    assert.equal(await ctx.run(["init", "--config", ctx.put("pilot-2.json", json(changed)), "--repo-dir", ctx.repoDir]), 1);
    assert.ok(refused(ctx.lines, "conflict"), "a frozen contract cannot be loosened after the fact");

    const other = await workspace();
    try {
      git(["remote", "add", "origin", "https://github.com/fernhill/website.git"], other.repoDir);
      assert.equal(await other.run(["init", "--config", other.put("pilot.json", json(demoConfig())), "--repo-dir", other.repoDir]), 1);
      assert.ok(refused(other.lines, "wrong_repo"));
      assert.equal(await other.run(["init", "--config", other.put("pilot.json", json(demoConfig())), "--repo-dir", other.repoDir, "--rev", "no-such-branch"]), 1);
      assert.ok(refused(other.lines, "wrong_revision"));
      assert.equal(await other.run(["init", "--config", other.put("pilot.json", json({ ...demoConfig(), agent: { name: "Juniper", prompt_path: "prompts/missing.md", baseline_tag: "juniper-v14" } })), "--repo-dir", other.repoDir]), 1);
      assert.equal(other.store.find("config.frozen").length, 0);
    } finally { await other.stop(); }
  } finally { await ctx.stop(); }
});

test("a frozen pack is never replaced: new versions come only from promote, which cannot uncover a held-out conversation", async () => {
  const ctx = await replayedPilot();
  try {
    const first = ctx.last("pack.frozen");
    const pack = demoPack();
    assert.equal(await ctx.run(["pack", "--file", ctx.put("same.json", json(pack))]), 0, "the same pack again is fine");
    assert.equal(ctx.store.find("pack.frozen").length, 1);

    // Any other pack is refused, including a "version 2" that names the frozen pack as its parent. Such a file
    // could drop checks, or bring a held-out conversation back as a discovery case under a new id.
    const edited: Pack = { ...pack, cases: pack.cases.slice(1) };
    const heldOut = pack.cases.find((c) => c.id === "ret-h02")!;
    const successor: Pack = { ...pack, pack_version: 2, parent_pack_id: first, cases: [...pack.cases.filter((c) => c.id !== "ret-h02"), { ...heldOut, id: "ret-h02-copy", split: "discovery" }] };
    for (const [name, value] of [["edited.json", edited], ["successor.json", successor]] as const) {
      assert.equal(await ctx.run(["pack", "--file", ctx.put(name, json(value))]), 1, name);
      assert.ok(refused(ctx.lines.slice(-1), "conflict"), ctx.lines.at(-1) ?? "");
    }
    assert.equal(ctx.last("pack.frozen"), first, "the active pack did not change");

    // promote is the only way to version a pack, and it refuses a held-out conversation in the discovery split,
    // whether it reuses the id or copies the conversation under a new one.
    await ctx.run(["experiment", "--candidate", ctx.eligible, "--start", DEMO.experiment_b_start]);
    const experiment = ctx.last("experiment.specified");
    const { provenance: _p, regression: _r, ...copy } = { ...heldOut, id: "copy-of-h02", split: "discovery" as const };
    const request = (added: PromotionRequest["added"]): PromotionRequest => ({ version: 1, base_pack_id: first, approver: "Imogen Hartley", at: "2026-10-17T10:00:00Z", existing: [], added });
    const attempts: [string, PromotionRequest][] = [
      ["copy.json", request([{ case: copy, reason: "copied", evidence: { experiment_id: experiment } }])],
      ["same-id.json", request([{ case: { ...copy, id: "ret-h02" }, reason: "same id", evidence: { experiment_id: experiment } }])],
    ];
    for (const [name, value] of attempts) {
      assert.equal(await ctx.run(["promote", "--request", ctx.put(name, json(value))]), 1, name);
      assert.ok(refused(ctx.lines.slice(-1), "holdout_leak"), `${name}: ${ctx.lines.at(-1) ?? ""}`);
    }
    assert.equal(ctx.store.find("pack.promoted").length, 0);
    assert.equal(ctx.store.list("promotion-request").length, 0, "a refused request, which may hold the very content it was refused for, is not kept");

    // A legitimate promotion still works, and the held-out cases of version 1 stay held out in version 2.
    const good = request(experimentFailureCases().map((c) => ({ case: c, reason: "seen in the experiment", evidence: { experiment_id: experiment } })));
    assert.equal(await ctx.run(["promote", "--request", ctx.put("good.json", json(good))]), 0, ctx.lines.at(-1) ?? "");
    const v2 = ctx.store.get<Pack>("pack", ctx.last("pack.promoted"));
    assert.equal(v2.parent_pack_id, first);
    assert.deepEqual(v2.cases.filter((c) => c.split === "heldout").map((c) => c.id).sort(), [...pack.cases.filter((c) => c.split === "heldout").map((c) => c.id), "late-exc-h01"].sort());
    assert.equal(contentId(ctx.store.get<Pack>("pack", first)), first, "version 1 is untouched");
  } finally { await ctx.stop(); }
});

test("nothing runs on a model the operator did not name, and a live run needs the recorded approval", async () => {
  const ctx = await frozenPilot();
  try {
    let fetched = 0;
    const fetchSpy = (async () => { fetched++; return new Response("{}"); }) as typeof fetch;
    assert.equal(await ctx.run(["discover"], { fetch: fetchSpy }), 1);
    assert.ok(refused(ctx.lines, "usage"));
    ctx.env.ANTHROPIC_API_KEY = "a-key-that-must-not-be-used";
    ctx.env.SYNTHE_ANTHROPIC_KEY = "another-key-that-must-not-be-used";
    assert.equal(await ctx.run(["discover", "--live", "--confirm-endpoint", "https://api.anthropic.com", "--confirm-data", "anything"], { fetch: fetchSpy }), 1);
    assert.ok(refused(ctx.lines, "live_not_approved"), "pilot.json has provider: null");
    assert.equal(fetched, 0, "no request was made");
    assert.equal(ctx.store.find("arm.replayed").length, 0);
  } finally { await ctx.stop(); }
});

test("a rejected candidate cannot reach review, and publishing needs every part of the authorisation", async () => {
  const ctx = await replayedPilot();
  try {
    const { rejected, eligible } = ctx;
    assert.equal(await ctx.run(["experiment", "--candidate", rejected, "--start", DEMO.experiment_b_start]), 1);
    assert.equal(await ctx.run(["review", "--candidate", rejected]), 1);
    assert.ok(refused(ctx.lines, "replay_gate_failed"));
    assert.equal(ctx.store.find("review.bundled").length, 0);

    assert.equal(await ctx.run(["review", "--candidate", eligible]), 1, "no review before the experiment plan exists");
    assert.equal(await ctx.run(["experiment", "--candidate", eligible, "--start", DEMO.experiment_b_start]), 0);
    assert.equal(await ctx.run(["review", "--candidate", eligible]), 0);
    assert.equal(ctx.github.requests.length, 0, "a local review sends nothing");

    const publish = ["review", "--candidate", eligible, "--publish", "--repo", DEMO.slug, "--base", DEMO.base, "--confirm", eligible];
    const token = ctx.env.SYNTHE_PILOT_GITHUB_TOKEN;
    delete ctx.env.SYNTHE_PILOT_GITHUB_TOKEN;
    ctx.env.GITHUB_TOKEN = "ambient-token";
    ctx.env.GH_TOKEN = "ambient-token";
    assert.equal(await ctx.run(publish), 1);
    assert.ok(refused(ctx.lines, "unauthorized_publish"), "an ambient GitHub token is not enough");
    ctx.env.SYNTHE_PILOT_GITHUB_TOKEN = token;
    assert.equal(await ctx.run(publish.slice(0, -2)), 1, "no --confirm");
    assert.equal(await ctx.run([...publish.slice(0, -1), eligible.slice(0, 40)]), 1, "a prefix is not a confirmation");
    assert.equal(await ctx.run(publish.map((a) => (a === DEMO.base ? "release" : a))), 1, "another base branch");
    assert.equal(ctx.github.requests.length, 0, "every refusal came before any request");

    // The base branch moved on: the candidate was built from a prompt that is no longer there.
    ctx.github.branches.get(DEMO.base)?.set(DEMO.prompt_path, `${BASELINE_PROMPT}- A line someone else merged.\n`);
    assert.equal(await ctx.run(publish), 1);
    assert.ok(refused(ctx.lines, "wrong_revision"));
    assert.equal(ctx.github.writes().length, 0);
    ctx.github.branches.get(DEMO.base)?.set(DEMO.prompt_path, BASELINE_PROMPT);

    // An interruption between the commit and the pull request, then a retry: one pull request, with the candidate.
    assert.equal(await ctx.run(publish, { fault: (point) => { if (point === "after-commit") throw new Error("crash"); } }), 1);
    assert.equal(ctx.github.pulls.length, 0);
    assert.equal(await ctx.run(publish), 0);
    const requestsAfterPublish = ctx.github.requests.length;
    assert.equal(await ctx.run(publish), 0);
    assert.equal(ctx.github.requests.length, requestsAfterPublish, "a review already published is not sent again, not even to look");
    assert.equal(ctx.github.pulls.length, 1);
    assert.equal(ctx.store.find("review.published").length, 1);
    const pull = ctx.github.pulls[0];
    assert.equal(pull.base, DEMO.base);
    assert.equal(pull.head, `synthe-pilot/${eligible.slice(0, 12)}`);
    assert.equal(ctx.github.branches.get(pull.head)?.get(DEMO.prompt_path), ctx.store.getPrompt(eligible));
    assert.ok(pull.body.includes(eligible) && pull.body.includes("It is not an estimate of business impact."));
    assert.ok(ctx.github.requests.every((r) => r.authorization === "Bearer test-token"));
    assert.ok(!ctx.lines.join("\n").includes("test-token") && !ctx.lines.join("\n").includes("ambient-token"), "no token is ever printed");
  } finally { await ctx.stop(); }
});

test("a candidate that copies conversation text into the prompt cannot be reviewed or published", async () => {
  const ctx = await replayedPilot();
  try {
    const leaking = `${BASELINE_PROMPT}- After you check eligibility, tell the customer the return-by date. Example: order ${CANARIES.discovery_order}, where ${CANARIES.discovery_words}.\n`;
    assert.equal(await ctx.run(["propose", "--finding", ctx.finding, "--file", ctx.put("leaking.md", leaking), "--author", "A reviewer", "--rationale", "Adds an example."]), 0);
    const candidate = ctx.last("candidate.created");
    assert.equal(await ctx.run(["replay", "--candidate", candidate, "--model", ctx.model]), 0);
    assert.equal(await ctx.run(["experiment", "--candidate", candidate, "--start", DEMO.experiment_b_start]), 0);
    const before = ctx.lines.length;
    assert.equal(await ctx.run(["review", "--candidate", candidate, "--publish", "--repo", DEMO.slug, "--base", DEMO.base, "--confirm", candidate]), 1);
    assert.ok(refused(ctx.lines, "egress_blocked"));
    const said = ctx.lines.slice(before).join("\n");
    assert.ok(!said.includes(CANARIES.discovery_order) && !said.includes("Glen Arrow"), "the refusal does not repeat what it found");
    assert.equal(ctx.github.requests.length, 0);
    assert.equal(ctx.store.find("review.bundled").length, 0);
    assert.ok(!existsSync(join(ctx.dir, "reports", `review-${candidate.slice(0, 12)}`)), "no review file was written");
  } finally { await ctx.stop(); }
});

test("an analysis needs an approval of exactly that candidate and experiment, and only one change is in flight", async () => {
  const ctx = await replayedPilot();
  try {
    const { eligible } = ctx;
    await ctx.run(["experiment", "--candidate", eligible, "--start", DEMO.experiment_b_start]);
    const experiment = ctx.last("experiment.specified");
    await ctx.run(["review", "--candidate", eligible]);
    const exported = writeExport(ctx, "day5.json", experimentBInterim(candidateTag(eligible)));
    ctx.on("2026-10-24");

    assert.equal(await ctx.run(["analyze", "--experiment", experiment, "--telemetry", exported]), 1);
    assert.ok(refused(ctx.lines, "unknown_approval"));
    assert.equal(ctx.store.find("telemetry.imported").filter((e) => e.refs.purpose === "experiment").length, 0, "nothing is imported for an unapproved experiment");

    assert.equal(await ctx.run(["approve", "--candidate", eligible.slice(0, 12), "--experiment", experiment, "--approver", "Tomas Lindqvist"]), 1, "short candidate id");
    assert.match(ctx.lines.at(-1) ?? "", /full 64-character candidate and experiment ids/);

    // A record written straight into the store is not an approval: it answers no review bundle of this pilot.
    const forged: Approval = { version: 1, pilot_id: DEMO.pilot_id, candidate_id: eligible, experiment_id: experiment, review_id: "0".repeat(64), scope: "experiment", decision: "approved", approver: "", at: "2026-10-24T08:00:00Z" };
    ctx.store.record("approval.recorded", ctx.store.put("approval", forged), { approval: contentId(forged), candidate: eligible, experiment, decision: "approved" }, "2026-10-24T08:00:00Z");
    assert.equal(await ctx.run(["analyze", "--experiment", experiment, "--telemetry", exported]), 1);
    assert.ok(refused(ctx.lines.slice(-1), "unknown_approval"), ctx.lines.at(-1) ?? "");
    assert.equal(await ctx.run(["approve", "--candidate", eligible, "--experiment", ctx.finding, "--approver", "Tomas Lindqvist"]), 1, "an id that is not this experiment");
    assert.equal(await ctx.run(["approve", "--candidate", eligible, "--experiment", experiment]), 1, "no approver");
    assert.equal(ctx.store.find("approval.recorded").length, 1, "only the forged record so far");

    assert.equal(await ctx.run(["approve", "--candidate", eligible, "--experiment", experiment, "--approver", "Tomas Lindqvist", "--reject"]), 0);
    assert.equal(await ctx.run(["analyze", "--experiment", experiment, "--telemetry", exported]), 1, "a rejection is not an approval");
    assert.equal(await ctx.run(["approve", "--candidate", eligible, "--experiment", experiment, "--approver", "Tomas Lindqvist"]), 0);
    assert.equal(await ctx.run(["approve", "--candidate", eligible, "--experiment", experiment, "--approver", "Tomas Lindqvist"]), 0);
    assert.equal(ctx.store.find("approval.recorded").length, 3, "the repeat added nothing");

    // A second change while the first is approved and undecided.
    assert.equal(await ctx.run(["propose", "--finding", ctx.finding, "--file", ctx.put("c.md", HUMAN_CANDIDATE_PROMPT), "--author", "Imogen Hartley", "--rationale", "A second idea."]), 0);
    const second = ctx.last("candidate.created");
    await ctx.run(["replay", "--candidate", second, "--model", ctx.model]);
    assert.equal(await ctx.run(["experiment", "--candidate", second, "--start", DEMO.experiment_c_start]), 1);
    assert.ok(refused(ctx.lines, "experiment_in_flight"));

    // The decision, then the same decision again from the stored evidence alone.
    assert.equal(await ctx.run(["analyze", "--experiment", experiment, "--telemetry", exported]), 0);
    const first = ctx.last("analysis.decided");
    assert.equal(ctx.store.get<ExperimentAnalysis>("analysis", first).recommendation, "revert");
    assert.equal(await ctx.run(["analyze", "--experiment", experiment]), 0);
    assert.equal(await ctx.run(["analyze", "--experiment", experiment, "--telemetry", exported]), 0);
    assert.equal(ctx.last("analysis.decided"), first, "re-running and re-importing give the same decision record");
    assert.equal(ctx.store.find("analysis.decided").length, 1);
    assert.equal(ctx.store.find("telemetry.imported").filter((e) => e.refs.purpose === "experiment").length, 1);

    // The revert settled the first experiment, so the second change may start now.
    assert.equal(await ctx.run(["experiment", "--candidate", second, "--start", DEMO.experiment_c_start]), 0);

    // A stopped experiment stays stopped: a later export, even a rosy one, cannot turn the revert into a keep.
    ctx.on("2026-11-12");
    assert.equal(await ctx.run(["analyze", "--experiment", experiment, "--telemetry", writeExport(ctx, "after-stop.json", experimentBAfterStop(candidateTag(eligible)))]), 1);
    assert.ok(refused(ctx.lines.slice(-1), "conflict"), ctx.lines.at(-1) ?? "");
    assert.match(ctx.lines.at(-1) ?? "", /already ended with revert/);
    // Telemetry for another experiment's candidate tag is refused here.
    assert.equal(await ctx.run(["analyze", "--experiment", experiment, "--telemetry", writeExport(ctx, "other.json", experimentCFinal(candidateTag(second)))]), 1);
    assert.equal(ctx.store.find("analysis.decided").length, 1);
    assert.equal(ctx.store.find("telemetry.imported").filter((e) => e.refs.purpose === "experiment").length, 1);
    assert.equal(await ctx.run(["verify"]), 0, ctx.lines.slice(-3).join(" | "));

    // verify recomputes each decision: a record that is intact in itself but does not follow from the evidence,
    // or that cites an export this experiment never imported, is caught.
    const real = ctx.store.get<ExperimentAnalysis>("analysis", first);
    const rosy = { ...real, recommendation: "keep" as const, reasons: ["looks fine"] };
    ctx.store.record("analysis.decided", ctx.store.put("analysis", rosy), { analysis: contentId(rosy), experiment, recommendation: "keep", final: "false" }, "2026-11-12T10:00:00Z");
    assert.equal(await ctx.run(["verify"]), 1);
    assert.ok(ctx.lines.some((l) => l.includes("does not follow from its telemetry imports")), ctx.lines.slice(-4).join(" | "));
  } finally { await ctx.stop(); }
});

test("baseline imports are idempotent, and a wrong export is refused before anything is stored", async () => {
  const ctx = await frozenPilot();
  try {
    const reports = () => ctx.store.find("baseline.reported").length;
    const imports = () => ctx.store.find("telemetry.imported").length;
    assert.deepEqual([reports(), imports()], [1, 1]);
    assert.equal(await ctx.run(["baseline", "--telemetry", join(ctx.inputs, "baseline.json")]), 0);
    assert.deepEqual([reports(), imports()], [1, 1], "the same export again changes nothing");
    assert.ok(ctx.lines.some((l) => l.includes("already imported")));

    const header = JSON.parse(readFileSync(join(ctx.inputs, "baseline.json"), "utf8"));
    for (const [name, change, code] of [
      ["denominator.json", { denominator: "all_conversations" }, "telemetry_denominator_mismatch"],
      ["units.json", { units: { ...header.units, resolved: "percent of chats" } }, "telemetry_unit_mismatch"],
      ["truncated.json", { expected_rows: header.expected_rows + 500 }, "telemetry_incomplete"],
      ["escape.json", { rows_csv: "../customer-repo/prompts/juniper.md" }, "invalid_telemetry"],
    ] as const) {
      assert.equal(await ctx.run(["baseline", "--telemetry", ctx.put(name, json({ ...header, export_id: name, ...change }))]), 1, name);
      assert.ok(refused(ctx.lines, code) || (code === "invalid_telemetry" && refused(ctx.lines, "usage")), `${name}: ${ctx.lines.at(-1) ?? ""}`);
    }
    assert.deepEqual([reports(), imports()], [1, 1]);
  } finally { await ctx.stop(); }
});

test("aggregate exports give the same decision as rows, a newer one replaces an older one, and verify still recomputes", async () => {
  const rowsCtx = await replayedPilot();
  const ctx = await replayedPilot();
  try {
    const decide = async (c: typeof ctx, exportFile: (tag: string) => string) => {
      await c.run(["experiment", "--candidate", c.eligible, "--start", DEMO.experiment_c_start]);
      const experiment = c.last("experiment.specified");
      await c.run(["review", "--candidate", c.eligible]);
      await c.run(["approve", "--candidate", c.eligible, "--experiment", experiment, "--approver", "Tomas Lindqvist"]);
      c.on("2026-11-02");
      assert.equal(await c.run(["analyze", "--experiment", experiment, "--telemetry", exportFile(candidateTag(c.eligible))]), 0, c.lines.at(-1) ?? "");
      return { experiment, analysis: c.store.get<ExperimentAnalysis>("analysis", c.last("analysis.decided")) };
    };
    const fromRows = await decide(rowsCtx, (tag) => writeExport(rowsCtx, "day6.json", experimentCInterim(tag)));
    const fromAggregates = await decide(ctx, (tag) => ctx.put("day6-aggregates.json", json(asAggregates(experimentCInterim(tag), "fernhill-exp2-day6-aggregates"))));
    assert.equal(fromAggregates.analysis.recommendation, "hold");
    assert.equal(fromAggregates.analysis.recommendation, fromRows.analysis.recommendation);
    assert.deepEqual(fromAggregates.analysis.guards.map((g) => [g.name, g.status, g.difference]), fromRows.analysis.guards.map((g) => [g.name, g.status, g.difference]));
    assert.equal(fromAggregates.analysis.arms.candidate.mature, fromRows.analysis.arms.candidate.mature);

    // A later cumulative aggregate export for the whole window. The older one is set aside, not added.
    const tag = candidateTag(ctx.eligible);
    ctx.on("2026-11-12");
    assert.equal(await ctx.run(["analyze", "--experiment", fromAggregates.experiment, "--telemetry", ctx.put("final-aggregates.json", json(asAggregates(experimentCFinal(tag), "fernhill-exp2-final-aggregates")))]), 0, ctx.lines.at(-1) ?? "");
    const final = ctx.store.get<ExperimentAnalysis>("analysis", ctx.last("analysis.decided"));
    assert.equal(final.final, true);
    assert.equal(final.recommendation, "keep");
    assert.equal(final.arms.candidate.mature, 14 * 320, "only the newest cumulative export is counted");
    assert.ok(final.flags.includes("superseded_aggregate"));
    assert.equal(final.telemetry_ids.length, 1);
    assert.equal(await ctx.run(["verify"]), 0, ctx.lines.slice(-4).join(" | "));
    assert.equal(await rowsCtx.run(["verify"]), 0);
    assert.equal(await ctx.run(["report"]), 0);
  } finally { await ctx.stop(); await rowsCtx.stop(); }
});

test("a replay made with one script is never reused for another script of the same name", async () => {
  const ctx = await frozenPilot();
  try {
    assert.equal(await ctx.run(["discover", "--model", ctx.model]), 0);
    assert.equal(ctx.store.find("arm.replayed").length, 1);
    assert.equal(await ctx.run(["discover", "--model", ctx.model]), 0);
    assert.equal(ctx.store.find("arm.replayed").length, 1, "the same script reuses its replay");
    const other = `scripted:${ctx.put("agent-2.script.json", json({ version: 1, name: "juniper-sim", fallback: "I cannot help with that.", rules: [] }))}`;
    assert.equal(await ctx.run(["discover", "--model", other]), 0);
    assert.equal(ctx.store.find("arm.replayed").length, 2, "a different script under the same name is replayed on its own");
  } finally { await ctx.stop(); }
});

test("a wrong export leaves no trace, so the next correct one still works", async () => {
  const ctx = await replayedPilot();
  try {
    await ctx.run(["experiment", "--candidate", ctx.eligible, "--start", DEMO.experiment_c_start]);
    const experiment = ctx.last("experiment.specified");
    await ctx.run(["review", "--candidate", ctx.eligible]);
    await ctx.run(["approve", "--candidate", ctx.eligible, "--experiment", experiment, "--approver", "Tomas Lindqvist"]);
    const tag = candidateTag(ctx.eligible);
    const imports = () => ctx.store.find("telemetry.imported").filter((e) => e.refs.purpose === "experiment").length;
    const interim = experimentCInterim(tag);

    // Dated in the future: an export cannot be imported before it was made.
    assert.equal(await ctx.run(["analyze", "--experiment", experiment, "--telemetry", writeExport(ctx, "day6.json", interim)]), 1);
    assert.ok(refused(ctx.lines.slice(-1), "invalid_telemetry") && /later than now/.test(ctx.lines.at(-1) ?? ""), ctx.lines.at(-1) ?? "");
    assert.equal(imports(), 0);

    ctx.on("2026-11-02");
    // Made with another metric query than the baseline (which carried no query hash): the two numbers would not
    // be counted the same way, so the export is refused.
    const otherQuery = { header: { ...interim.header, export_id: "other-query", query_hash: "c".repeat(64) }, csv: interim.csv };
    assert.equal(await ctx.run(["analyze", "--experiment", experiment, "--telemetry", writeExport(ctx, "day6-other-query.json", otherQuery)]), 1);
    assert.ok(refused(ctx.lines.slice(-1), "telemetry_denominator_mismatch"), ctx.lines.at(-1) ?? "");
    assert.equal(imports(), 0);

    assert.equal(await ctx.run(["analyze", "--experiment", experiment, "--telemetry", join(ctx.inputs, "day6.json")]), 0, ctx.lines.at(-1) ?? "");
    assert.equal(imports(), 1);
    const held = ctx.last("analysis.decided");

    // A re-export of the same period with one recorded outcome changed, under a new export id: refused, and not kept.
    const lines = interim.csv.split("\n");
    const flip = lines.findIndex((l) => /,1,0,/.test(l));
    lines[flip] = lines[flip].replace(",1,0,", ",0,0,");
    const edited = { header: { ...interim.header, export_id: "fernhill-exp2-day6-edited", rows_csv: "day6-edited.csv" }, csv: lines.join("\n") };
    ctx.on("2026-11-03");
    assert.equal(await ctx.run(["analyze", "--experiment", experiment, "--telemetry", writeExport(ctx, "day6-edited.json", edited)]), 1);
    assert.ok(refused(ctx.lines.slice(-1), "telemetry_conflict"), ctx.lines.at(-1) ?? "");
    assert.equal(imports(), 1, "the conflicting export was not recorded");
    assert.equal(ctx.last("analysis.decided"), held);

    // The experiment is not stuck: the correct final export still imports and decides.
    ctx.on("2026-11-12");
    assert.equal(await ctx.run(["analyze", "--experiment", experiment, "--telemetry", writeExport(ctx, "final.json", experimentCFinal(tag))]), 0, ctx.lines.at(-1) ?? "");
    assert.equal(ctx.store.get<ExperimentAnalysis>("analysis", ctx.last("analysis.decided")).recommendation, "keep");
    assert.equal(imports(), 2);
    assert.equal(await ctx.run(["verify"]), 0, ctx.lines.slice(-3).join(" | "));

    // The same for the baseline: a contradicting re-export is refused and the original still imports.
    const base = baselineExport();
    const baseLines = base.csv.split("\n");
    baseLines[1] = baseLines[1].replace(/,(0|1),(0|1),/, (_m, a) => `,${a === "1" ? 0 : 1},0,`);
    const baselines = () => ctx.store.find("telemetry.imported").filter((e) => e.refs.purpose === "baseline").length;
    assert.equal(await ctx.run(["baseline", "--telemetry", writeExport(ctx, "baseline-edited.json", { header: { ...base.header, export_id: "edited", rows_csv: "baseline-edited.csv" }, csv: baseLines.join("\n") })]), 1);
    assert.ok(refused(ctx.lines.slice(-1), "telemetry_conflict"), ctx.lines.at(-1) ?? "");
    assert.equal(baselines(), 1);
    assert.equal(await ctx.run(["baseline", "--telemetry", join(ctx.inputs, "baseline.json")]), 0);
    assert.equal(baselines(), 1);
  } finally { await ctx.stop(); }
});

test("verify notices entries cut off the end of the journal, and a crash-damaged record does not block a retry", async () => {
  const ctx = await replayedPilot();
  try {
    assert.equal(await ctx.run(["verify"]), 0);
    assert.ok(ctx.lines.some((l) => /^Journal head: entry \d+, [0-9a-f]{64}$/.test(l)));
    const journal = join(ctx.dir, "journal.jsonl");
    const whole = readFileSync(journal, "utf8");
    const kept = whole.trimEnd().split("\n").slice(0, -3).join("\n");
    writeFileSync(journal, `${kept}\n`);
    assert.equal(await ctx.run(["verify"]), 1);
    assert.ok(ctx.lines.some((l) => l.includes("entries were removed or changed")), ctx.lines.slice(-3).join(" | "));
    assert.equal(await ctx.run(["status"]), 1, "nothing else runs on a shortened journal either");
    writeFileSync(journal, whole);
    assert.equal(await ctx.run(["verify"]), 0);

    // A record file left empty by a crash between creating and writing it. Its name is the hash of what belongs
    // there, so the retry puts the right content back instead of refusing for ever.
    const arms = join(ctx.dir, "objects", "arm");
    const victim = join(arms, readdirSync(arms)[0]);
    const before = readFileSync(victim, "utf8");
    writeFileSync(victim, "");
    assert.equal(await ctx.run(["verify"]), 1);
    assert.equal(await ctx.run(["replay", "--candidate", ctx.eligible, "--model", ctx.model]), 1, "a damaged record is refused when read");
    appendFileSync(victim, "{");
    const id = victim.split("/").at(-1)!.replace(".json", "");
    ctx.store.put("arm", JSON.parse(before));
    assert.equal(contentId(JSON.parse(readFileSync(victim, "utf8"))), id, "storing the record again repairs the file");
    assert.equal(await ctx.run(["verify"]), 0);
  } finally { await ctx.stop(); }
});

test("an unexpected error does not print its message, which can quote data, unless asked to", async () => {
  const ctx = await frozenPilot();
  try {
    const boom = () => { throw new Error("CANARY-ERROR-TEXT order ORD-1234 for Thaddeus"); };
    assert.equal(await ctx.run(["pack", "--file", join(ctx.inputs, "pack.v1.json")], { now: boom }), 1);
    assert.ok(!ctx.lines.join("\n").includes("CANARY-ERROR-TEXT"));
    assert.match(ctx.lines.at(-1) ?? "", /unexpected Error and stopped.*SYNTHE_PILOT_DEBUG=1/);
    ctx.env.SYNTHE_PILOT_DEBUG = "1";
    assert.equal(await ctx.run(["pack", "--file", join(ctx.inputs, "pack.v1.json")], { now: boom }), 1);
    assert.ok(ctx.lines.at(-1)?.includes("CANARY-ERROR-TEXT"));
  } finally { await ctx.stop(); }
});

test("init reads the repo it was pointed at, whatever git settings the shell carries", async () => {
  const ctx = await workspace();
  const other = tmp("pilot-other-repo-");
  git(["init", "-q", "-b", "main"], other);
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = join(other, ".git");
  try {
    assert.equal(await ctx.run(["init", "--config", ctx.put("pilot.json", json(demoConfig())), "--repo-dir", ctx.repoDir]), 0, ctx.lines.at(-1) ?? "");
    assert.equal(ctx.store.last("config.frozen")?.refs.commit, ctx.commit, "the commit comes from --repo-dir, not from GIT_DIR");
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved;
    await ctx.stop();
  }
  // The origin must be this repo on GitHub: the same path on another host, or another name, is refused.
  for (const [origin, ok] of [
    ["https://github.com/Fernhill/Support-Agent.git", true], ["git@github.com:fernhill/support-agent.git", true], ["ssh://git@github.com/fernhill/support-agent", true],
    ["https://evil.example/fernhill/support-agent.git", false], ["https://github.com/fernhill/support-agent-fork.git", false], ["https://github.com/other/fernhill/support-agent-x", false],
  ] as const) {
    const c = await workspace();
    try {
      git(["remote", "add", "origin", origin], c.repoDir);
      assert.equal(await c.run(["init", "--config", c.put("pilot.json", json(demoConfig())), "--repo-dir", c.repoDir]), ok ? 0 : 1, origin);
      if (!ok) assert.ok(refused(c.lines, "wrong_repo"), origin);
    } finally { await c.stop(); }
  }
});
