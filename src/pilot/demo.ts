import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pilotGithubRepo } from "./github.ts";
import { main } from "./main.ts";
import { activePack, GITHUB_TOKEN_ENV, type Flags, type PilotDeps } from "./commands.ts";
import {
  agentScript, BASELINE_PROMPT, baselineExport, CANARIES, DEMO, DEMO_ID_KEY, demoConfig, demoPack, demoTraffic, experimentBAfterStop, experimentBInterim, experimentBMistagged, experimentCFinal,
  experimentCInterim, experimentFailureCases, HUMAN_CANDIDATE_PROMPT, HUMAN_CANDIDATE_REORDERED_PROMPT, proposerScript, TRAFFIC,
} from "./demo-data.ts";
import { proposerContext } from "./discover.ts";
import { PilotError } from "./errors.ts";
import { FakeGitHub } from "./fake-github.ts";
import { candidateTag, shortId } from "./ids.ts";
import { PilotStore, type JournalEntry } from "./store.ts";
import type { ExperimentAnalysis, ExperimentSpec, FailureFinding, Pack, PromotionRequest, ReplayReport } from "./types.ts";
import { pilotRecorder } from "./wrap.ts";

// The synthetic pilot: every step of the loop, run through the same `main` the commands use, on invented data,
// with a scripted agent and a loopback stand-in for GitHub. It needs no credentials and sends nothing anywhere.
// Each step states what it expects; the demo fails if any expectation does not hold.

const GIT_ENV = { GIT_AUTHOR_NAME: "Fernhill Support Ops", GIT_AUTHOR_EMAIL: "support-ops@fernhill.invalid", GIT_COMMITTER_NAME: "Fernhill Support Ops", GIT_COMMITTER_EMAIL: "support-ops@fernhill.invalid", GIT_AUTHOR_DATE: "2026-09-28T09:00:00Z", GIT_COMMITTER_DATE: "2026-09-28T09:00:00Z" };

function git(args: string[], cwd: string): string {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("SYNTHE_") && !k.startsWith("GIT_"))), ...GIT_ENV };
  return execFileSync("git", args, { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

export async function demo(flags: Flags, deps: PilotDeps, prog = "node src/pilot/cli.ts"): Promise<number> {
  const startedAt = Date.now();
  const outFlag = flags.out;
  if (typeof outFlag !== "string" || !outFlag.trim()) throw new PilotError("usage", "--out is required: a new, empty directory for the demo's inputs, pilot records and reports.");
  const out = resolve(outFlag);
  if (existsSync(out) && readdirSync(out).length > 0) throw new PilotError("usage", `${out} is not empty. Give the demo a new directory so its records start clean.`);
  const inputs = join(out, "inputs");
  const repoDir = join(out, "customer-repo");
  const dir = join(out, "pilot");
  mkdirSync(inputs, { recursive: true });
  mkdirSync(join(repoDir, dirname(DEMO.prompt_path)), { recursive: true });
  const put = (name: string, content: string): string => { const path = join(inputs, name); writeFileSync(path, content); return path; };
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

  // The customer's repo, as a local git checkout: the baseline prompt is read from an exact commit of it.
  writeFileSync(join(repoDir, DEMO.prompt_path), BASELINE_PROMPT);
  git(["init", "-q", "-b", DEMO.base], repoDir);
  git(["add", DEMO.prompt_path], repoDir);
  git(["commit", "-q", "-m", "Juniper prompt v14"], repoDir);
  const commit = git(["rev-parse", "HEAD"], repoDir).trim();

  const github = new FakeGitHub(DEMO.slug, DEMO.base, { [DEMO.prompt_path]: BASELINE_PROMPT }, commit);
  const githubUrl = await github.start();

  const transcript: string[] = [];
  const failures: string[] = [];
  const outcomes: string[] = [];
  let clock = Date.parse("2026-10-17T09:00:00Z");
  let crashAt: string | null = null;
  const say = (line: string) => { transcript.push(line); deps.say(line); };
  // Nothing from the caller's environment reaches the demo's commands: no provider key is read because none is given.
  const inner: PilotDeps = {
    say: (line) => say(`    ${line}`),
    env: { [GITHUB_TOKEN_ENV]: "demo-token-for-the-loopback-server" },
    now: () => new Date((clock += 60_000)),
    github: (slug, token) => pilotGithubRepo(slug, token, githubUrl),
    fault: (point) => { if (point === crashAt) { crashAt = null; throw new Error(`injected crash at ${point}`); } },
  };
  const store = new PilotStore(dir);
  // The demo's calendar. Each export is imported on or after the day it says it was made, as a real one would be.
  const on = (day: string) => { clock = Date.parse(`${day}T09:00:00Z`); };
  const atTime = (iso: string) => { clock = Date.parse(iso); };
  let step = 0;
  const run = async (title: string, argv: string[]): Promise<number> => {
    say("");
    say(`[${++step}] ${title}`);
    say(`  $ ${prog} ${argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a).replaceAll(out, "<out>")).join(" ")}`);
    return main([...argv, "--dir", dir], inner);
  };
  const expect = (what: string, ok: boolean): void => {
    say(`  ${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  const lastOf = (stepName: string): JournalEntry => {
    const entry = store.last(stepName);
    if (!entry) throw new Error(`the demo expected a ${stepName} journal entry`);
    return entry;
  };
  const model = `scripted:${put("agent.script.json", json(agentScript()))}`;
  const proposer = `scripted:${put("proposer.script.json", json(proposerScript()))}`;
  const writeExport = (name: string, x: { header: Record<string, unknown>; csv: string }): string => { put(String(x.header.rows_csv), x.csv); return put(name, json(x.header)); };

  try {
    say("Synthe enterprise pilot: synthetic run for Fernhill Outfitters' support agent Juniper (all data invented).");
    say(`Inputs: ${inputs}   Pilot records and reports: ${dir}`);

    // ---- 1. Freeze the metric and baseline ----
    expect("init succeeds", await run("Freeze the contract and the baseline prompt", ["init", "--config", put("pilot.json", json(demoConfig())), "--repo-dir", repoDir]) === 0);
    expect("baseline report written from imported telemetry", await run("Import the baseline telemetry export", ["baseline", "--telemetry", writeExport("baseline.json", baselineExport())]) === 0 && existsSync(join(dir, "reports", "baseline.md")));
    expect("pack frozen", await run("Freeze the redacted conversation pack", ["pack", "--file", put("pack.v1.json", json(demoPack()))]) === 0);
    const packV1 = activePack(store);

    // ---- 2. Find a failure and replay targeted changes ----
    expect("discover succeeds", await run("Find recurring failures on the discovery cases", ["discover", "--model", model]) === 0);
    const finding = lastOf("finding.found").key;
    expect("the finding is built from discovery cases only", store.get<FailureFinding>("finding", finding).failing.every((x) => packV1.value.cases.find((c) => c.id === x.case_id)?.split === "discovery"));

    await run("Propose a change (first attempt)", ["propose", "--finding", finding, "--proposer", proposer]);
    const candA = lastOf("candidate.created").key;
    await run("Replay the first candidate", ["replay", "--candidate", candA, "--model", model]);
    const replayA = store.get<ReplayReport>("replay", lastOf("replay.paired").key);
    const guardA = replayA.new_blocking_guard_failures.find((x) => x.turn > 1) ?? replayA.new_blocking_guard_failures[0];
    expect("candidate 1 is rejected in replay", replayA.gate.eligible === false);
    expect(`the guard and the exact turn are named (${guardA?.check_id}, case ${guardA?.case_id}, turn ${guardA?.turn})`, guardA !== undefined);
    expect("tool calls outside the recording are marked unsupported, with the effect on coverage", replayA.coverage.excluded.some((x) => x.why === "unsupported") && replayA.coverage.paired_cases < 0.7);
    expect("a rejected candidate cannot get an experiment or a review", await run("Try to take the rejected candidate to an experiment", ["experiment", "--candidate", candA, "--start", DEMO.experiment_b_start]) === 1);
    outcomes.push(`Candidate ${shortId(candA)} (proposer, attempt 1): REJECTED IN REPLAY. Guard ${guardA?.check_id} newly fails in case ${guardA?.case_id} at turn ${guardA?.turn}; ${replayA.new_blocking_guard_failures.length} new blocking guard failures; ${Math.round(replayA.coverage.paired_cases * 100)}% of cases paired.`);

    await run("Propose a change (second attempt, with feedback from the first)", ["propose", "--finding", finding, "--proposer", proposer]);
    const candB = lastOf("candidate.created").key;
    await run("Replay the second candidate", ["replay", "--candidate", candB, "--model", model]);
    const replayB = lastOf("replay.paired");
    expect("candidate 2 passes the replay gate", store.get<ReplayReport>("replay", replayB.key).gate.eligible === true);

    // ---- 3. Review pull request ----
    expect("experiment specification written", await run("Write the experiment specification for the customer", ["experiment", "--candidate", candB, "--start", DEMO.experiment_b_start]) === 0);
    const expB = lastOf("experiment.specified").key;
    expect("local review bundle written, nothing published", await run("Write the review bundle (local by default)", ["review", "--candidate", candB]) === 0 && github.requests.length === 0);
    expect("publishing without the full candidate id is refused, nothing sent", await run("Try to publish with a short id as confirmation", ["review", "--candidate", candB, "--publish", "--repo", DEMO.slug, "--base", DEMO.base, "--confirm", shortId(candB)]) === 1 && github.requests.length === 0);
    expect("publishing to another repo is refused, nothing sent", await run("Try to publish to a different repo", ["review", "--candidate", candB, "--publish", "--repo", "fernhill/website", "--base", DEMO.base, "--confirm", candB]) === 1 && github.requests.length === 0);
    crashAt = "after-open-pr";
    expect("the publish command is interrupted right after the pull request opens", await run("Publish the review (interrupted)", ["review", "--candidate", candB, "--publish", "--repo", DEMO.slug, "--base", DEMO.base, "--confirm", candB]) === 1 && github.pulls.length === 1);
    expect("the retry finds the pull request instead of opening a second", await run("Publish the review (retry)", ["review", "--candidate", candB, "--publish", "--repo", DEMO.slug, "--base", DEMO.base, "--confirm", candB]) === 0 && github.pulls.length === 1);
    const writesAfterRetry = github.writes().length;
    expect("publishing again sends nothing", await run("Publish the review (again)", ["review", "--candidate", candB, "--publish", "--repo", DEMO.slug, "--base", DEMO.base, "--confirm", candB]) === 0 && github.pulls.length === 1 && github.writes().length === writesAfterRetry);

    // ---- 4. The customer's experiment ----
    const tagB = candidateTag(candB);
    const exportB = writeExport("experiment-1-day5.json", experimentBInterim(tagB));
    expect("analysis without a recorded approval is refused", await run("Try to analyse before anyone approved the experiment", ["analyze", "--experiment", expB, "--telemetry", exportB]) === 1 && store.find("analysis.decided").length === 0);
    expect("approval recorded against the exact candidate and experiment", await run("Record the approval", ["approve", "--candidate", candB, "--experiment", expB, "--approver", DEMO.metric_owner]) === 0);
    expect("an export dated in the future is refused, and nothing is imported", await run("Try to analyse an export dated after today", ["analyze", "--experiment", expB, "--telemetry", exportB]) === 1 && store.find("telemetry.imported").filter((e) => e.refs.purpose === "experiment").length === 0);
    on("2026-10-24");
    expect("an export with an unknown version tag is refused", await run("Try an export whose candidate arm carries the wrong tag", ["analyze", "--experiment", expB, "--telemetry", writeExport("experiment-1-mistagged.json", experimentBMistagged(tagB))]) === 1 && store.find("analysis.decided").length === 0);
    await run("Analyse the day-5 export of experiment 1", ["analyze", "--experiment", expB, "--telemetry", exportB]);
    const decisionB = store.get<ExperimentAnalysis>("analysis", lastOf("analysis.decided").key);
    expect("experiment 1: REVERT, by the predeclared early stop on a critical guard", decisionB.recommendation === "revert" && decisionB.stopped_by === "early_stop");
    expect("the rollback target is the baseline prompt and tag", decisionB.rollback.tag === DEMO.baseline_tag && decisionB.rollback.prompt_id === store.last("config.frozen")?.refs.baseline_prompt);
    const analysesBefore = store.find("analysis.decided").length;
    await run("Import the same export again (a retry)", ["analyze", "--experiment", expB, "--telemetry", exportB]);
    const again = store.get<ExperimentAnalysis>("analysis", lastOf("analysis.decided").key);
    expect("the retry counts nothing twice and gives the same decision record", store.find("analysis.decided").length === analysesBefore && again.arms.candidate.rows === decisionB.arms.candidate.rows && again.coverage.rows === decisionB.coverage.rows);
    // The head of the journal after the revert, as a reviewer would note it in the pull request.
    const headAfterRevert = store.journal().at(-1)?.hash ?? "";
    expect("the reverted candidate gets no second experiment", await run("Try to measure the reverted candidate again under a new experiment", ["experiment", "--candidate", candB, "--start", DEMO.experiment_c_start]) === 1 && store.find("experiment.specified").length === 1);
    outcomes.push(`Candidate ${shortId(candB)} (proposer, attempt 2): passed replay, pull request #${github.pulls[0]?.number}, experiment ${shortId(expB)}: REVERT (early stop: ${decisionB.guards.find((g) => g.status === "breach" || g.early_ci)?.name ?? "guard"} breached). Rollback target ${decisionB.rollback.tag}.`);

    // ---- 5. Close the loop ----
    on("2026-10-25");
    const request: PromotionRequest = {
      version: 1, base_pack_id: packV1.id, approver: DEMO.quality_lead, at: "2026-10-25T10:00:00Z",
      existing: [{ case_id: "ret-h01", reason: "The current prompt never states the return-by date here; keep it as a permanent check.", evidence: { replay_id: replayB.key, turn: 1, check_id: "states-return-deadline" } }],
      added: experimentFailureCases().map((c) => ({ case: c, reason: "During experiment 1 the candidate handed this late-return request to the support team.", evidence: { experiment_id: expB } })),
    };
    expect("approved failures promoted into a new pack version", await run("Promote approved failures into the next pack version", ["promote", "--request", put("promotion-request.json", json(request))]) === 0);
    const packV2 = activePack(store);
    const still = store.get<Pack>("pack", packV1.id);
    expect("the old pack is unchanged and still matches its id", JSON.stringify(still) === JSON.stringify(packV1.value) && packV2.id !== packV1.id && packV2.value.parent_pack_id === packV1.id);
    expect("held-out cases stay held out in the new pack", packV1.value.cases.filter((c) => c.split === "heldout").every((c) => packV2.value.cases.find((x) => x.id === c.id)?.split === "heldout") && packV2.value.cases.find((c) => c.id === "ret-h01")?.regression !== undefined);
    await run("Replay the reverted candidate on the new pack", ["replay", "--candidate", candB, "--model", model]);
    const replayB2 = store.get<ReplayReport>("replay", lastOf("replay.paired").key);
    expect("the new pack now catches the reverted candidate in replay", replayB2.gate.eligible === false && replayB2.new_blocking_guard_failures.some((x) => x.case_id.startsWith("late-exc-")));

    await run("Find recurring failures again, on the new pack", ["discover", "--model", model]);
    const finding2 = lastOf("finding.found").key;
    const context = proposerContext({ pack: packV2.value, baseline_prompt: BASELINE_PROMPT, finding: store.get<FailureFinding>("finding", finding2), attempt: 0, feedback: replayB2.gate.proposer_feedback, max_changed_lines: 6 });
    const proposerSees = JSON.stringify(context);
    expect("what a proposer is given holds no held-out case, promoted or not", !proposerSees.includes(CANARIES.heldout_order) && !proposerSees.includes(CANARIES.heldout_words) && !proposerSees.includes("late-exc-h01") && !proposerSees.includes("ret-h01"));

    expect("a person's candidate is accepted", await run("Take a candidate a person wrote", ["propose", "--finding", finding2, "--file", put("candidate-by-a-person.md", HUMAN_CANDIDATE_PROMPT), "--author", DEMO.quality_lead, "--rationale", "State the return-by date, and answer late-return requests with the policy instead of handing them over."]) === 0);
    const candC = lastOf("candidate.created").key;
    await run("Replay the third candidate on the new pack", ["replay", "--candidate", candC, "--model", model]);
    expect("candidate 3 passes the replay gate on the new pack", store.get<ReplayReport>("replay", lastOf("replay.paired").key).gate.eligible === true);
    await run("Write the experiment specification", ["experiment", "--candidate", candC, "--start", DEMO.experiment_c_start]);
    const expC = lastOf("experiment.specified").key;
    expect("second pull request opened for the new candidate", await run("Publish the review", ["review", "--candidate", candC, "--publish", "--repo", DEMO.slug, "--base", DEMO.base, "--confirm", candC]) === 0 && github.pulls.length === 2);
    await run("Record the approval", ["approve", "--candidate", candC, "--experiment", expC, "--approver", DEMO.metric_owner]);
    const tagC = candidateTag(candC);
    on("2026-11-02");
    await run("Analyse the day-6 export of experiment 2", ["analyze", "--experiment", expC, "--telemetry", writeExport("experiment-2-day6.json", experimentCInterim(tagC))]);
    const holdC = store.get<ExperimentAnalysis>("analysis", lastOf("analysis.decided").key);
    expect("experiment 2 at day 6: HOLD (too few mature conversations, window still open)", holdC.recommendation === "hold" && holdC.final === false);
    on("2026-11-12");
    await run("Analyse the final export of experiment 2", ["analyze", "--experiment", expC, "--telemetry", writeExport("experiment-2-final.json", experimentCFinal(tagC))]);
    const keepC = store.get<ExperimentAnalysis>("analysis", lastOf("analysis.decided").key);
    expect("experiment 2 at the cutoff: KEEP (primary clears the minimum effect, guards pass)", keepC.recommendation === "keep" && keepC.final === true);
    expect("the final export overlaps the day-6 export and no conversation is counted twice", keepC.coverage.rows === 14 * 640 && keepC.coverage.duplicates_dropped >= holdC.coverage.rows);
    const decisionsB = store.find("analysis.decided").filter((e) => e.refs.experiment === expB).length;
    expect("a reverted experiment takes no later export: it cannot come back as a keep", await run("Try to reopen the reverted experiment with a later export", ["analyze", "--experiment", expB, "--telemetry", writeExport("experiment-1-after-stop.json", experimentBAfterStop(tagB))]) === 1 && store.find("analysis.decided").filter((e) => e.refs.experiment === expB).length === decisionsB);
    outcomes.push(`Experiment ${shortId(expC)} at day 6: HOLD (${holdC.flags.join(", ")}).`);
    outcomes.push(`Candidate ${shortId(candC)} (written by a person): passed replay on pack v2, pull request #${github.pulls[1]?.number}, experiment ${shortId(expC)} at the cutoff: KEEP (${keepC.primary.name} ${keepC.primary.baseline.estimate?.toFixed(4)} to ${keepC.primary.candidate.estimate?.toFixed(4)}).`);
    outcomes.push(`Pack ${shortId(packV1.id)} (v1) promoted to ${shortId(packV2.id)} (v2): 3 approved regression cases; v1 unchanged; held-out cases still held out.`);

    // ---- 6. A fourth candidate, run on live traffic written by the real recorder, watched to its cutoff ----
    on("2026-11-13");
    expect("a second person-written candidate is accepted", await run("Take a candidate a person wrote (candidate 3's two lines in the other order)", ["propose", "--finding", finding2, "--file", put("candidate-by-a-person-2.md", HUMAN_CANDIDATE_REORDERED_PROMPT), "--author", DEMO.quality_lead, "--rationale", "The same two lines as the third candidate with the policy line first, to see whether the order changes anything for a customer."]) === 0);
    const candD = lastOf("candidate.created").key;
    expect("candidate 4 is a different candidate from candidate 3", candD !== candC);
    await run("Replay the fourth candidate on the new pack", ["replay", "--candidate", candD, "--model", model]);
    expect("candidate 4 passes the replay gate on the new pack", store.get<ReplayReport>("replay", lastOf("replay.paired").key).gate.eligible === true);
    // Experiment 2 is settled at its cutoff (2026-11-12), so experiment 3 starts after it: 2026-11-29.
    expect("experiment specification written (starts 2026-11-29, after experiment 2 is settled)", await run("Write the experiment specification", ["experiment", "--candidate", candD, "--start", DEMO.experiment_d_start]) === 0);
    const expD = lastOf("experiment.specified").key;
    expect("local review bundle written, nothing published", await run("Write the review bundle (local by default)", ["review", "--candidate", candD]) === 0);
    const requestsAfterReview = github.requests.length;
    expect("approval recorded against the exact candidate and experiment", await run("Record the approval", ["approve", "--candidate", candD, "--experiment", expD, "--approver", DEMO.metric_owner]) === 0);
    const tagD = candidateTag(candD);
    const specD = store.get<ExperimentSpec>("experiment", expD);

    // The agent, simulated: the real recorder, the real pickVersion and an injected clock. The id key below is a
    // fixed demo string; a real key comes from the team's secret store (at least 16 characters).
    const logDir = join(out, "agent-log");
    let recorderClock = 0;
    const traffic = demoTraffic({
      recorder: pilotRecorder({ logDir, agent: "Juniper", idKey: DEMO_ID_KEY, now: () => new Date(recorderClock) }),
      setClock: (t) => { recorderClock = t; },
      start: specD.window.start, days: 14, baseline: specD.arms.baseline.tag, candidate: tagD, salt: expD, candidateShareBp: Math.round(specD.allocation.candidate * 10000), model: DEMO.model,
    });
    const looksD = () => store.find("analysis.decided").filter((e) => e.refs.experiment === expD);
    const importsD = () => store.find("telemetry.imported").filter((e) => e.refs.scope === expD).length;
    const watchMd = () => readFileSync(join(dir, "reports", "WATCH.md"), "utf8");
    const tick = async (title: string, iso: string): Promise<{ code: number; out: string; md: string }> => {
      traffic.upTo(Date.parse(iso)); // the log holds everything that happened before this moment
      atTime(iso);
      const mark = transcript.length;
      const code = await run(title, ["watch", "--log", logDir, "--assignment", "randomized"]);
      return { code, out: transcript.slice(mark).join("\n"), md: watchMd() };
    };
    const lastLook = () => store.get<ExperimentAnalysis>("analysis", looksD().at(-1)?.refs.analysis ?? "");

    expect("watch --log without --assignment is refused, even while no look is due", await run("Try a watch tick without saying how traffic was assigned", ["watch", "--log", logDir]) === 1 && looksD().length === 0);
    const t0 = await tick("Watch tick before the experiment starts (2026-11-27)", "2026-11-27T09:00:00Z");
    expect("before the start: WAITING, nothing imported, nothing exported", t0.code === 0 && t0.md.startsWith("# WAITING") && importsD() === 0 && looksD().length === 0 && filesUnder(join(dir, "exports")).length === 0);
    const t1 = await tick("Watch tick at the end of day 1 (2026-11-29)", "2026-11-29T23:30:00Z");
    expect("day 1: one interim look, HOLD", t1.code === 0 && looksD().length === 1 && lastLook().recommendation === "hold" && lastLook().final === false && importsD() === 1);
    const t1b = await tick("Watch tick again on day 1, twenty minutes later", "2026-11-29T23:50:00Z");
    expect("day 1 again: no second look the same UTC day, nothing imported", t1b.code === 0 && looksD().length === 1 && importsD() === 1 && t1b.out.includes("already made today"));
    const t2 = await tick("Watch tick at the end of day 2 (2026-11-30)", "2026-11-30T23:30:00Z");
    expect("day 2: a second interim look, HOLD", t2.code === 0 && looksD().length === 2 && lastLook().recommendation === "hold" && lastLook().final === false);
    const t3 = await tick("Watch tick after the window ended (2026-12-14), before the cutoff", "2026-12-14T09:00:00Z");
    expect("after the window, before the cutoff: an interim look, still HOLD and not final", t3.code === 0 && looksD().length === 3 && lastLook().recommendation === "hold" && lastLook().final === false);
    const t4 = await tick("Watch tick at the cutoff (2026-12-15)", "2026-12-15T09:00:00Z");
    const finalD = lastLook();
    expect("the cutoff: the final analysis is HOLD (inconclusive), final", t4.code === 0 && looksD().length === 4 && finalD.recommendation === "hold" && finalD.final === true && t4.md.startsWith("# HOLD"));
    expect("the lift is real but smaller than the minimum effect, so it is not a keep", (finalD.primary.candidate.estimate ?? 0) - (finalD.primary.baseline.estimate ?? 0) < specD.primary.min_effect);
    const importsAtFinal = importsD();
    const exportsAtFinal = filesUnder(join(dir, "exports")).length;
    const t5 = await tick("Watch tick after the final analysis (2026-12-16)", "2026-12-16T09:00:00Z");
    expect("after the final: done, nothing imported or exported, still HOLD", t5.code === 0 && looksD().length === 4 && importsD() === importsAtFinal && filesUnder(join(dir, "exports")).length === exportsAtFinal && t5.md.startsWith("# HOLD") && t5.out.includes("No more looks"));

    const pl = traffic.planted;
    const byVersion = (m: Record<string, number>) => Object.entries(m).sort().map(([t, n]) => `${t} ${n}`).join(", ");
    const count = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);
    const noteNoOutcome = `${count(pl.no_outcome)} conversations have a recorded call and no outcome yet (by first-served version: ${byVersion(pl.no_outcome)})`;
    const noteTwo = `${count(pl.two_versions)} conversations were served by a second prompt version before or with the outcome (by first-served version: ${byVersion(pl.two_versions)})`;
    const noteAfter = `${pl.other_version_after_outcome} conversation was served by another prompt version only after the outcome was recorded. The row is unchanged.`;
    const noteRepeat = `${pl.outcome_after_other_version} of them has an outcome recorded again after that call. It is not used`;
    const noteOrphan = `${pl.outcome_without_call} conversations have an outcome but no recorded call`;
    const notesOk = (text: string) => [noteNoOutcome, noteTwo, noteAfter, noteRepeat, noteOrphan].every((n) => text.includes(n));
    expect(`the cutoff export notes carry the planted counts (${count(pl.no_outcome)} no outcome, ${count(pl.two_versions)} two versions, ${pl.other_version_after_outcome} after the outcome, ${pl.outcome_after_other_version} of them with the outcome recorded again, ${pl.outcome_without_call} outcome without a call), in the tick's output and in WATCH.md`, count(pl.no_outcome) === TRAFFIC.no_outcome.length && count(pl.two_versions) === TRAFFIC.call_before_outcome.length && pl.other_version_after_outcome === TRAFFIC.call_after_outcome.length && pl.outcome_after_other_version === TRAFFIC.repeat_after_other_call.length && pl.outcome_without_call === TRAFFIC.outcome_without_call.length && notesOk(t4.out) && notesOk(t4.md));
    expect("every conversation with a recorded call is a row, including the ones with no outcome or two versions", finalD.coverage.rows === 14 * TRAFFIC.per_day);
    expect("no new GitHub request was made after the review", github.requests.length === requestsAfterReview);
    const logText = filesUnder(logDir).filter((p) => p.endsWith(".jsonl")).map((p) => readFileSync(p, "utf8")).join("\n");
    const rawId = /fernhill-(conv|unit|orphan)-/;
    const pilotText = [...filesUnder(join(dir, "reports")), ...filesUnder(join(dir, "exports")), join(dir, "journal.jsonl")].map((p) => readFileSync(p, "utf8")).join("\n");
    const canariesList = Object.values(CANARIES);
    expect(`the ${filesUnder(logDir).filter((p) => p.endsWith(".jsonl")).length} log files hold no raw conversation or unit id and no message text`, logText.length > 0 && !rawId.test(logText) && !traffic.rawIds.filter((_, i) => i % 997 === 0).some((id) => logText.includes(id)) && !canariesList.some((c) => logText.toLowerCase().includes(c.toLowerCase())));
    expect("the exports, reports and journal hold no raw conversation or unit id either", !rawId.test(pilotText));
    // The final `verify` steps below recompute this experiment's decisions too.
    outcomes.push(`Candidate ${shortId(candD)} (written by a person, the same two lines in the other order): passed replay on pack v2, experiment ${shortId(expD)} watched from 2026-11-27 to its cutoff, final analysis HOLD (inconclusive): ${finalD.primary.name} ${finalD.primary.baseline.estimate?.toFixed(4)} to ${finalD.primary.candidate.estimate?.toFixed(4)}, the measured difference is below the ${specD.primary.min_effect} minimum effect (the simulated true lift is 0.01, real but smaller than that) (${finalD.flags.length ? finalD.flags.join(", ") : "no data flags"}). The log's ${count(pl.no_outcome)} calls with no outcome, ${count(pl.two_versions)} two-version conversations and ${pl.outcome_without_call} outcomes with no call are counted in the export notes.`);

    // ---- Evidence, and what left the machine ----
    expect("evidence summary written", await run("Rebuild the evidence summary", ["report"]) === 0);
    expect("every record matches its id and every decision recomputes to the same result", await run("Verify the records and recompute the decisions", ["verify"]) === 0);
    expect("the journal still holds the head that was noted after the revert", await run("Verify against the journal head noted after the revert", ["verify", "--head", headAfterRevert]) === 0);

    say("");
    say("Privacy checks (synthetic sensitive strings planted in the pack):");
    const canaries = Object.values(CANARIES);
    const leaks = (text: string) => canaries.some((c) => text.toLowerCase().includes(c.toLowerCase()));
    expect(`nothing sent to GitHub holds pack conversation text (${github.requests.length} requests checked)`, !github.requests.some((r) => leaks(r.body) || leaks(r.path)));
    expect("no report holds pack conversation text", !filesUnder(join(dir, "reports")).some((p) => leaks(readFileSync(p, "utf8"))));
    expect("the journal holds no pack conversation text", !leaks(readFileSync(join(dir, "journal.jsonl"), "utf8")));
    expect("nothing printed by the commands holds pack conversation text", !leaks(transcript.join("\n")));
    expect("the GitHub token went only to the loopback server and was never printed", github.requests.every((r) => r.authorization === "Bearer demo-token-for-the-loopback-server") && !transcript.join("\n").includes("demo-token-for-the-loopback-server"));
    expect("no provider credential was read: the commands saw only the GitHub token variable", Object.keys(inner.env).length === 1);

    say("");
    say("Outcomes:");
    for (const line of outcomes) say(`- ${line}`);
    const decisionFiles = [`replay-${shortId(candA)}-pack-v1.md`, `decision-${shortId(expB)}.md`, `decision-${shortId(expC)}.md`, `decision-${shortId(expD)}.md`];
    expect("each of the four outcomes has its decision file", decisionFiles.every((f) => existsSync(join(dir, "reports", f))));
    say("");
    say("The four outcomes, and the file that holds each decision:");
    say(`- Rejected in replay: candidate ${shortId(candA)}   ${join(dir, "reports", `replay-${shortId(candA)}-pack-v1.md`)}`);
    say(`- Reverted: candidate ${shortId(candB)}   ${join(dir, "reports", `decision-${shortId(expB)}.md`)}`);
    say(`- Kept: candidate ${shortId(candC)}   ${join(dir, "reports", `decision-${shortId(expC)}.md`)}`);
    say(`- Held at the final analysis (inconclusive): candidate ${shortId(candD)}   ${join(dir, "reports", `decision-${shortId(expD)}.md`)}`);
    say("");
    say("Evidence to open:");
    say(`- ${join(dir, "reports", "PILOT.md")}   the whole pilot, each line citing its record`);
    say(`- ${join(dir, "reports", `review-${shortId(candC)}`, "REVIEW.md")}   the review bundle that became pull request #${github.pulls[1]?.number}`);
    say(`- ${join(dir, "reports", `decision-${shortId(expB)}.md`)}   the revert`);
    say(`- ${join(dir, "reports", `decision-${shortId(expC)}.md`)}   the keep (the hold is the earlier file for the same experiment)`);
    say(`- ${join(dir, "reports", `decision-${shortId(expD)}.md`)}   the hold at the final analysis (watch wrote WATCH.md beside it)`);
    say(`- ${join(dir, "journal.jsonl")}   every step, in order`);
    say("");
    say(failures.length === 0 ? `Synthetic pilot passed: ${step} steps, every expectation held (${((Date.now() - startedAt) / 1000).toFixed(1)} s).` : `Synthetic pilot FAILED: ${failures.length} expectation(s) did not hold:`);
    for (const f of failures) say(`- ${f}`);
    return failures.length === 0 ? 0 : 1;
  } finally {
    await github.stop();
  }
}
