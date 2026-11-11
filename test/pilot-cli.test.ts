import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/pilot/cli.ts";
import {
  BASELINE_PROMPT, CANARIES, DEMO, demoConfig, demoPack, experimentBInterim, experimentCFinal, HUMAN_CANDIDATE_PROMPT,
} from "../src/pilot/demo-data.ts";
import { candidateTag } from "../src/pilot/ids.ts";
import type { ExperimentAnalysis, Pack } from "../src/pilot/types.ts";
import { frozenPilot, git, json, replayedPilot, workspace, writeExport } from "./pilot-cli-helpers.ts";

const CLI = join(import.meta.dirname, "..", "src", "pilot", "cli.ts");
const filesUnder = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? filesUnder(p) : [p]; }) : []);
const refused = (lines: string[], code: string): boolean => lines.some((l) => l.startsWith(`Refused (${code})`));

test("the synthetic pilot runs end to end from the real entry point, with no credentials in the environment", () => {
  const out = join(mkdtempSync(join(tmpdir(), "pilot-demo-")), "run");
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
  const again = join(mkdtempSync(join(tmpdir(), "pilot-demo-")), "run");
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
  assert.equal(await main(["status", "--dir", mkdtempSync(join(tmpdir(), "pilot-empty-"))], deps), 1);
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

test("a frozen pack is never replaced, and a held-out case can never come back as a discovery case", async () => {
  const ctx = await frozenPilot();
  try {
    const first = ctx.last("pack.frozen");
    const pack = demoPack();
    assert.equal(await ctx.run(["pack", "--file", ctx.put("same.json", json(pack))]), 0, "the same pack again is fine");
    assert.equal(ctx.store.find("pack.frozen").length, 1);

    const edited: Pack = { ...pack, cases: pack.cases.slice(1) };
    assert.equal(await ctx.run(["pack", "--file", ctx.put("edited.json", json(edited))]), 1);
    assert.ok(refused(ctx.lines, "conflict"));

    // A "new version" that quietly moves a held-out case into the discovery split.
    const leaky: Pack = { ...pack, pack_version: 2, parent_pack_id: first, cases: pack.cases.map((c) => (c.id === "ret-h02" ? { ...c, split: "discovery" as const } : c)) };
    assert.equal(await ctx.run(["pack", "--file", ctx.put("leaky.json", json(leaky))]), 1);
    assert.ok(refused(ctx.lines, "holdout_leak"));
    assert.equal(ctx.last("pack.frozen"), first, "the active pack did not change");
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
    assert.equal(await ctx.run(publish), 0);
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

    assert.equal(await ctx.run(["analyze", "--experiment", experiment, "--telemetry", exported]), 1);
    assert.ok(refused(ctx.lines, "unknown_approval"));
    assert.equal(ctx.store.find("telemetry.imported").filter((e) => e.refs.purpose === "experiment").length, 0, "nothing is imported for an unapproved experiment");

    assert.equal(await ctx.run(["approve", "--candidate", eligible.slice(0, 12), "--experiment", experiment, "--approver", "Tomas Lindqvist"]), 1, "short candidate id");
    assert.equal(await ctx.run(["approve", "--candidate", eligible, "--experiment", ctx.finding, "--approver", "Tomas Lindqvist"]), 1, "an id that is not this experiment");
    assert.equal(await ctx.run(["approve", "--candidate", eligible, "--experiment", experiment]), 1, "no approver");
    assert.equal(ctx.store.find("approval.recorded").length, 0);

    assert.equal(await ctx.run(["approve", "--candidate", eligible, "--experiment", experiment, "--approver", "Tomas Lindqvist", "--reject"]), 0);
    assert.equal(await ctx.run(["analyze", "--experiment", experiment, "--telemetry", exported]), 1, "a rejection is not an approval");
    assert.equal(await ctx.run(["approve", "--candidate", eligible, "--experiment", experiment, "--approver", "Tomas Lindqvist"]), 0);
    assert.equal(await ctx.run(["approve", "--candidate", eligible, "--experiment", experiment, "--approver", "Tomas Lindqvist"]), 0);
    assert.equal(ctx.store.find("approval.recorded").length, 2, "the repeat added nothing");

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

    // Telemetry for another experiment's candidate tag is refused here.
    assert.equal(await ctx.run(["analyze", "--experiment", experiment, "--telemetry", writeExport(ctx, "other.json", experimentCFinal(candidateTag(second)))]), 1);
    assert.ok(refused(ctx.lines, "telemetry_version_mismatch") || refused(ctx.lines, "telemetry_window_mismatch"));
    assert.equal(ctx.store.find("analysis.decided").length, 1);
    assert.equal(await ctx.run(["verify"]), 0);
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
      assert.ok(refused(ctx.lines, code) || (code === "invalid_telemetry" && refused(ctx.lines, "usage")), `${name}: ${ctx.lines.at(-1)}`);
    }
    assert.deepEqual([reports(), imports()], [1, 1]);
  } finally { await ctx.stop(); }
});
