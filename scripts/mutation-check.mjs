// Breaks each safety rule on purpose and checks that a test fails. Restores every file, even if stopped.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const RULE = "src/core/merge-rule.ts";
const DECIDE = "src/loop/decide.ts";
const SCORE = "src/loop/score.ts";
const WRITE = "src/loop/write.ts";
const STATE = "src/core/state.ts";
const GITHUB = "src/github/repo.ts";
const SHARE = "src/core/share.ts";
const REPORT = "src/loop/report.ts";
const EVIDENCE = "src/core/evidence.ts";
const WORKFLOW = "templates/synthe.yml";

// Every test file, so a new one is never left out of the check.
const TESTS = readdirSync("test").filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`);

const allMutations = [
  ["history accepts unvalidated text", "src/core/candidate-history.ts", 'Object.keys(entry).sort().join(",") !== "fingerprint,scope"', 'false'],
  ["history ignores the goal", "src/core/candidate-history.ts", 'JSON.stringify([goal, prompt])', 'JSON.stringify([prompt])'],
  ["history ignores the current prompt", "src/core/candidate-history.ts", 'JSON.stringify([goal, prompt])', 'JSON.stringify([goal])'],
  ["history keeps unbounded candidates", "src/core/candidate-history.ts", '.slice(-MAX_CANDIDATE_MEMORY)', ''],
  ["materially identical variants bypass history", "src/core/candidate-history.ts", 'text.normalize("NFKC").toLowerCase().match(/[\\p{L}\\p{N}]+/gu)?.join(" ") ?? ""', 'text'],
  ["repeated candidates are scored again", WRITE, 'if (tried.has(fingerprint))', 'if (false)'],
  ["same-round duplicate angles are scored", WRITE, '    tried.add(fingerprint);', ''],
  ["format-only candidates are scored", WRITE, 'if (fingerprint === candidateFingerprint(prompt))', 'if (false)'],
  ["exact no-op edits are accepted", WRITE, 'return text.trim() === prompt.trim() ?', 'return false ?'],
  ["history leaks decision reasons to writer", WRITE, '${history}', '${history}\\n${state.rounds.map((round) => round.reasons.join(" ")).join(" ")}'],
  ["local try forgets previous candidates", "src/cli/try-round.ts", 'state.candidateHistory = validateCandidateMemory(saved.history);', 'state.candidateHistory = [];'],
  ["local try drops candidate writes", "src/cli/try-round.ts", 'written.candidates.map((candidate) => candidate.text)', '[]'],
  ["local try accepts unknown history versions", "src/cli/try-round.ts", 'saved.version !== 1', 'false'],
  ["local try overwrites another run lock", "src/cli/try-round.ts", 'openSync(lock, "wx", 0o600)', 'openSync(lock, "w", 0o600)'],
  ["scheduled rounds forget rejected candidates", DECIDE, 'if (current !== null) state.candidateHistory =', 'if (false) state.candidateHistory ='],
  ["an absent share setting sends data", SHARE, 'goal.share === "numbers" || goal.share === "detail" || goal.share === "full"', 'goal.share !== "none"'],
  ["DO_NOT_TRACK is ignored", "src/cli/init.ts", '["1", "true"].includes(env.DO_NOT_TRACK?.toLowerCase() ?? "")', 'false'],
  ["numbers-only sends text", SHARE, 'if (goal.share !== "detail" && goal.share !== "full") return payload;', 'if (goal.share === "none") return payload;'],
  ["init records no notice version", "src/cli/init.ts", "goal.share_notice = SHARE_NOTICE_VERSION;", ""],
  ["full sends prompt after the cutoff", SHARE, 'now.getTime() < Date.parse(FULL_SHARE_UNTIL)', 'true'],
  ["detail sends the prompt", SHARE, 'goal.share === "full" && now.getTime()', 'true && now.getTime()'],
  ["example input dropped", SHARE, '        input: limited(record.example.input, 2000),\n', ''],
  ["a share failure fails the round", SHARE, 'return `Sharing skipped: ${error instanceof Error && error.message === "timed out" ? "request timed out" : "request failed"}.`;', "throw error;"],
  ["a cancelled run still decides", WORKFLOW, "if: ${{ !cancelled() && needs.write.result", "if: ${{ always() && needs.write.result"],
  ["the decide condition loses its ${{ }} and YAML drops !cancelled()", WORKFLOW, "if: ${{ !cancelled() && needs.write.result != 'skipped' && needs.write.outputs.go != 'false' }}", "if: !cancelled() && needs.write.result != 'skipped' && needs.write.outputs.go != 'false'"],
  ["no scenario wins needed", RULE, "if (split.p > max_p) return", "if (false) return"],
  ["no held-back gain needed", RULE, "held < beforeHoldout + min_improvement", "held < beforeHoldout"],
  ["no training gain needed", RULE, "after < before + min_improvement", "after < before"],
  ["unpaired scenarios allowed", RULE, 'if (split === null) return `${c.id}: test cases could not be compared`;', ""],
  ["unknown scores pair as wins", RULE, 'if (typeof other !== "number" || !Number.isFinite(other) || typeof r.score !== "number" || !Number.isFinite(r.score)) return null;', ""],
  ["different scenario counts allowed", RULE, " || after.length !== before.length", ""],
  ["duplicate candidate rows allowed", RULE, " || new Set(after.map((r) => r.id)).size !== after.length", ""],
  ["ties count as wins", RULE, "if (r.score > other) wins++", "if (r.score >= other) wins++"],
  ["sign test halved", RULE, "tail / 2 ** n", "tail / 2 ** (n + 1)"],
  ["revert ignores the margin", RULE, "is < was - noise_margin && worse.p <= max_p", "worse.p <= max_p"],
  ["revert ignores scenario wins", RULE, "is < was - noise_margin && worse.p <= max_p", "is < was - noise_margin"],
  ["revert uses training rows only", RULE, "const now = [...scores.baselineTrain, ...scores.baselineHoldout];", "const now = [...scores.baselineTrain];"],
  ["guardrail unknown passes", RULE, "rows.filter((r) => r.violation === null || ", "rows.filter((r) => "],
  ["held-back guardrails ignored", RULE, "addedBreaks(c.train, scores.baselineTrain) + addedBreaks(c.holdout, scores.baselineHoldout)", "addedBreaks(c.train, scores.baselineTrain)"],
  ["fixing some breaks but not all still blocks", RULE, " && before.get(r.id) !== true", ""],
  ["unknown row becomes a mean", RULE, "rows.some((r) => r.score === null || !Number.isFinite(r.score))", "false"],
  ["revert hits a teammate's edit", DECIDE, " && last.mergedHash === scores.baselineHash", ""],
  ["identical candidate merges", DECIDE, ' ?? (text.trim() === current.trim() ? "candidate is the current prompt" : null)', ""],
  ["prompt change ignored", DECIDE, "sha256(current) !== scores.baselineHash", "false"],
  ["any stop resumes on new scenarios", STATE, "!/rounds in a row found no winner$/.test(s.stopped) || ", ""],
  ["resumes without a scenario change", STATE, " || s.scenariosHash === scenariosHash", ""],
  ["held-back test goes to the highest average", SCORE, "\n    .filter((c) => trainingProblem(c, scores.baselineTrain, goal) === null)", ""],
  ["writer studies held-back replies", WRITE, "lessonText(state, prompt, train)", "lessonText(state, prompt, scenarios)"],
  ["writer studies a stale prompt's replies", WRITE, " || state.lessons.promptHash !== sha256(prompt)", ""],
  ["winner read from the wrong side", SCORE, 'const challengerWon = v.better === (first ? "A" : "B");', 'const challengerWon = v.better === "A";'],
  ["revert without a live prior challenge", DECIDE, " && scores.prior ? scores.prior : null", " ? scores.baselineTrain : null"],
  ["an edit lands where its text appears twice", WRITE, 'if (text.indexOf(e.find, at + 1) !== -1) return { problem: "an edit\'s text appears more than once" };', ""],
  ["any number of edits allowed", WRITE, "if (edits.length > MAX_EDITS) return", "if (false) return"],
  ["spend saved only at the end", DECIDE, "  await repo.writeState(state);\n  let stall = true;", "  let stall = true;"],
  ["a merge recovered after a crash is forgotten", DECIDE, "state.lastMerge = { pr: pr.number, priorPrompt: p.land.priorPrompt, mergedHash: sha256(p.land.text), reverted: false };", ""],
  ["a rate limit stops the run", DECIDE, 'token: "GitHub refused the workflow\'s token",', 'token: "GitHub refused the workflow\'s token", rate_limited: "rate limited",'],
  ["every 403 means no permission", GITHUB, "isRateLimited(res.status, res.headers, text) ? \"rate_limited\"", "false ? \"rate_limited\""],
  ["a quote not in the reply confirms a break", SCORE, " && squash(text).includes(squash(v.quote))", ""],
  ["a failed re-check lets the merge through", SCORE, "if (verdict === false) {", "if (verdict !== true) {"],
  ["propose mode merges anyway", DECIDE, "    if (landing.propose) {", "    if (false) {"],
  ["a merge blocked by review closes the pull request", DECIDE, 'if (merged.problem === "blocked") {', "if (false) {"],
  ["rounds run while a proposal waits", DECIDE, "    if (pr?.open) {\n      // Backup runs check", "    if (false) {\n      // Backup runs check"],
  ["a proposal merged by a person isn't tracked", DECIDE, "      state.lastMerge = { pr: p.pr, priorPrompt: p.priorPrompt, mergedHash: sha256(live), reverted: false };", ""],
  ["judge always sees the challenger first", SCORE, "await duel(s, (set.indexOf(s) % 2 === 0) !== flip, current, mine)", "await duel(s, true, current, mine)"],
  ["a break is excused without confirming the current prompt's", SCORE, "      if (cur?.violation === true) {\n", "      if (cur?.violation === true) { checks.excusedConfirmed++; return; }\n      if (false) {\n"],
  ["a POST or PUT is repeated after a server error", GITHUB, 'if (method === "POST" || method === "PUT") return res;', ""],
  ["a review-blocked proposal isn't saved before a crash", DECIDE, "      landing.propose = true;\n      await repo.writeState(state);\n", ""],
  ["settling trusts the proposed text over what merged", DECIDE, "const live = source === null ? null : readPrompt(source, goal, p.text);", "const live = p.text;"],
  ["scoring pays when there's nothing to compare", SCORE, "  if (safe.length === 0 && !hasPrior) {", "  if (false) {"],
  ["an edit may add talk of judging or scores", WRITE, "if (added.length > judgingWords(e.find, own).length) return", "if (false) return"],
  ["the judge never sees the business policy", SCORE, "goal.policy?.trim() ? `\\nBusiness policy", "false ? `\\nBusiness policy"],
  ["setup defaults an unclear merge answer to automatic", "src/cli/init.ts", "if (auto === null) { auto = false;", "if (auto === null) { auto = true;"],
  ["unknown cost merges", DECIDE, "input.costUsd === null", "false"],
  ["identical candidate scored", SCORE, " && c.text.trim() !== baseline.trim()", ""],
  ["candidates trained on held-back scenarios", SCORE, "const duels = await challenge(c.id, c.text, train, trainReplies);", "const duels = await challenge(c.id, c.text, scenarios, new Map([...trainReplies, ...(await holdReplies())]));"],
  ["writer sees held-back scenarios", WRITE, 'const train = scenarios.filter((s) => s.split === "train");', "const train = scenarios;"],
  ["a busy API round counts as a stall", DECIDE, "run `npx synthe restart` later.\";\n      stall = false;", "run `npx synthe restart` later.\";"],
  ["a key failure is read as a busy API", "src/loop/failure.ts", "kind: /\\bkey\\b/i.test(plain) ? \"key\" : \"busy\"", "kind: \"busy\""],
  ["every team runs at the same minute", "src/cli/init.ts", ".replaceAll(\"__MINUTE__\", String(minute))", ".replaceAll(\"__MINUTE__\", \"23\")"],
  ["a refused pull request keeps the run going", DECIDE, "state.stopped = e.plain;", ""],
  ["issues being off crashes decide", DECIDE, "if (!(e instanceof Refusal)) throw e;\n    const note", "throw e;\n    const note"],
  ["an unclear merge answer is never read back", GITHUB, "if (back.ok && (await back.json()).merged === true) return { merged: true };", ""],
  ["a cut-off agent reply is unknown", "src/model/client.ts", "const cutOff = allowCutOff === true && res.stop_reason === \"max_tokens\" && text.length > 0;", "const cutOff = false;"],
  ["duplicate scenario ids allowed", "src/core/goal.ts", "if (lineOf.has(s.id)) throw", "if (false) throw"],
  ["restart reopens a finished run", "src/cli/restart.ts", "if (isFinished(stopped) && !failedOut && !roundsRaised) {", "if (false) {"],
  ["restart spends after unknown cost", "src/cli/restart.ts", "if (state.spendUnknown) return", "if (false) return"],
  ["a busy outage retries without limit", DECIDE, "record.failure === \"busy\" && busyInARow <= BUSY_RETRIES", "record.failure === \"busy\""],
  ["a failed round still queues the next", DECIDE, "const finished = Boolean(input.scores && input.candidates && record.outcome !== \"failed\");", "const finished = true;"],
  ["a fork's closed PR starts a round", "src/action.ts", "if (event.action !== \"closed\" || !own || !(setupMerged || roundBranch)) {", "if (event.action !== \"closed\" || !(setupMerged || roundBranch)) {"],
  ["closing the setup PR unmerged starts a round", "src/action.ts", "pr?.head?.ref === \"synthe/setup\" && pr.merged === true && state.round === 0", "pr?.head?.ref === \"synthe/setup\" && state.round === 0"],
  ["new test cases can't restart a stalled run", "src/cli/restart.ts", "if (resumeIfScenariosChanged(next, scenariosHash))", "if (false)"],
  ["a merged proposal still waits an hour", "src/action.ts", "return !pr || pr.open;", "return true;"],
  ["wake-ups run a round every time", "src/action.ts", "if (step === \"write\" && process.env.GITHUB_EVENT_NAME === \"schedule\" && since < ROUND_GAP_MS && !state.chainReady && !state.proposal) {", "if (false) {"],
  ["a manual run waits for the hour", "src/action.ts", "if (step === \"write\" && process.env.GITHUB_EVENT_NAME === \"schedule\" && since < ROUND_GAP_MS && !state.chainReady && !state.proposal) {", "if (step === \"write\" && since < ROUND_GAP_MS && !state.chainReady && !state.proposal) {"],
  ["every proposal check writes state", "src/loop/decide.ts", "if (recovered || state.issue === null) {", "if (true) {"],
  ["the judge outvotes the team's checks", "src/loop/score.ts", "if (theirs && mine.failed !== theirs.failed) judged.row.score = mine.failed < theirs.failed ? WIN : LOSS;", ""],
  ["a half-answered check counts as checked", "src/loop/score.ts", "if (!Array.isArray(rows) || rows.length !== checks.length || checks.some((_, i) => rows.filter((r) => r.check === i + 1).length !== 1)) return { verdicts: null", "if (!Array.isArray(rows)) return { verdicts: null"],
  ["repo secrets reach the model", "src/cli/init.ts", "${redactSecrets(f.text)}", "${f.text}"],
  ["calibrate ignores unsteady marking", "src/cli/calibrate.ts", "} else if (flips >= MIN_MISSES && r.steady / r.applied < STEADY) {", "} else if (false) {"],
  ["calibrate ignores the team's answers", "src/cli/calibrate.ts", "} else if (misses >= MIN_MISSES && r.agreed / r.asked < AGREE) {", "} else if (false) {"],
  ["calibrate shows held-back cases", "src/cli/calibrate.ts", "const cases = scenarios.filter((s) => s.split === \"train\").slice(0, CASES);", "const cases = scenarios.slice(0, CASES);"],
  ["a reworded check keeps getting asked", "src/cli/calibrate.ts", "    if (reworded.has(it.c)) continue;", "    if (false) continue;"],
  ["setup's review shows held-back cases", "src/cli/calibrate.ts", "const cases = scenarios.filter((s) => s.split === \"train\").slice(0, SETUP_CASES);", "const cases = scenarios.slice(0, SETUP_CASES);"],
  ["calibrate trusts too little evidence", "src/cli/calibrate.ts", "} else if (r.applied < MIN_APPLIED) {", "} else if (false) {"],
  ["calibrate trusts checks nobody answered", "src/cli/calibrate.ts", "} else if (r.asked === 0) {", "} else if (false) {"],
  ["migrate's score drop threshold is inverted", "src/cli/migrate.ts", "if (judgeDrop > MAX_DROP)", "if (judgeDrop < MAX_DROP)"],
  ["migrate doesn't report cost", "src/cli/migrate.ts", "lines.push(...costSection(costBefore, costAfter));", ""],
  ["a guard drop of exactly the margin blocks the merge", RULE, "> goal.merge_rule.guard_margin", ">= goal.merge_rule.guard_margin"],
  ["guards are ignored", RULE, "    if (goal.counter_checks?.length) {\n      if (guardBefore === null", "    if (false) {\n      if (guardBefore === null"],
  ["a missing guard verdict is skipped past", RULE, "if (guardBefore === null || guardAfter === null) {", "if (false) {"],
  ["an unknown guard is treated as a pass", RULE, "!Number.isSafeInteger(r.guardApplicable) || !Number.isSafeInteger(r.guardFailed)", "false"],
  ["guards decide the winner", SCORE, "if (mine) Object.assign(judged.row, { guardFailed: mine.failed, guardApplicable: mine.applicable });", "if (mine) Object.assign(judged.row, { guardFailed: mine.failed, guardApplicable: mine.applicable, ...(theirs && mine.failed !== theirs.failed ? { score: mine.failed < theirs.failed ? WIN : LOSS } : {}) });"],
  ["a guard is marked again for every challenger", SCORE, "JSON.stringify([s.id, text, kind, noise ? sample : \"\"])", "JSON.stringify([s.id, text, kind, Math.random()])"],
  ["a guard that repeats a check is accepted", "src/core/goal.ts", "if (same !== undefined) bad(", "if (false) bad("],
  ["a duplicate guard is accepted", "src/core/goal.ts", "if (dup !== undefined) bad(", "if (false) bad("],
  ["a failed guard request stops setup", "src/cli/init.ts", "  } catch {\n    return null;\n  }\n}\n\nexport function buildGoal", "  } catch (e) {\n    throw e;\n  }\n}\n\nexport function buildGoal"],
  ["guard denominator counts rows instead of applicable marks", RULE, "rows.reduce((n, r) => n + r.guardApplicable!, 0)", "rows.length"],
  ["guard negative and impossible counts accepted", RULE, "r.guardApplicable! < 0 || r.guardFailed! < 0 || r.guardFailed! > r.guardApplicable!", "false"],
  ["guard duplicate IDs accepted", RULE, "new Set(rows.map((r) => r.id)).size !== rows.length || ", ""],
  ["guard drop rounded before safety comparison", RULE, "const exactBefore = guardRate([...scores.baselineTrain, ...currentHeld], false)!;", "const exactBefore = guardRate([...scores.baselineTrain, ...currentHeld])!;"],
  ["guard booleans silently coerced", SCORE, "rows.some((r) => !r || typeof r.applies !== \"boolean\" || typeof r.passes !== \"boolean\")", "false"],
  ["guards share main check cache", SCORE, "JSON.stringify([s.id, text, kind, noise ? sample : \"\"])", "JSON.stringify([s.id, text, noise ? sample : \"\"])"],
  ["noise shares independent check and guard marks", SCORE, "noise ? sample : \"\"", "\"\""],
  ["noise hides position disagreement", SCORE, "if (noise && current !== mine) {", "if (false) {"],
  ["noise judges identical replies", SCORE, "if (noise && current === challenger) return", "if (false) return"],
  ["noise fits hidden cases", SCORE, "const train = scenarios.filter((s) => s.split === \"train\");\n  const first", "const train = scenarios;\n  const first"],
  ["noise missing checks accepted", SCORE, "if (noise && (!mine || !theirs)) judged.row.score = null;", ""],
  ["noise unknown guard spread becomes zero", SCORE, "spread, margin: spread ?? 3", "spread: spread ?? 0, margin: spread ?? 0"],
  ["noise too few guard samples trusted", SCORE, " || train.length < 5", ""],
  ["noise probability ignores opposite direction", SCORE, "Math.min(1, 2 * signP(Math.max(split.wins, split.losses), Math.min(split.wins, split.losses)))", "split.p"],
  ["init enables unmeasured guards by default", "src/cli/init.ts", "checks.length && (await yesNo(io, \"Enable experimental guards? Type y to opt in, or n to keep them off: \")) === true", "checks.length"],
  ["init accepts incomplete guard pairs", "src/cli/init.ts", "guards.length === checks.length && guards.length > 0", "guards.length > 0"],
  ["writer reads protected round reasons", WRITE, "`Round ${r.round}: ${r.outcome}.`", "`Round ${r.round}: ${r.outcome}. ${r.reasons.join(\" \")}`"],
  ["writer can target guard attack and evidence tests", WRITE, "|counter[_ -]checks?|guard checks?|attack cases?|evidence files?", ""],
  ["writer reads a protected prompt path", WRITE, "if (protectedPath) return", "if (false) return"],
  ["writer reads a scenario file as its prompt", WRITE, "goal.prompt.path === goal.scenarios", "false"],
  ["guard attack evidence paths writable", "src/core/safety.ts", "  /(^|\\/)\\.synthe\\//, /(^|\\/)synthe\\.json$/,\n", ""],
  ["verify skips the hash check", EVIDENCE, "if (hashEvidence(r) !== r.sha256) return", "if (false) return"],
  ["verify skips the chain check", EVIDENCE, "if (hashEvidence(prev) !== r.prevEvidenceHash) return", "if (false) return"],
  ["verify skips the verdict recompute", EVIDENCE, "const problem = recomputeProblem(r, goal, splits);", "const problem = null as string | null;"],
  ["verify skips the score coverage check", EVIDENCE, "if (dropped) return", "if (false) return"],
  ["verify trusts the stored guard rates", EVIDENCE, "if (guardRate(guardRows(base), guards) !== r.guardsBefore) return", "if (false) return"],
  ["verify skips the prompt commit check", EVIDENCE, 'if (typeof r.commit === "string" && /^[0-9a-f]{40}$/.test(r.commit)) {', "if (false) {"],
  ["calibration kappa sign flipped", "src/cli/calibrate.ts", "const kappa = (po - pe) / (1 - pe);", "const kappa = (po - pe) / (1 + pe);"],
  ["calibration swaps true-positive and true-negative rates", "src/cli/calibrate.ts", "return { tpr: tp / (tp + fn), tnr: tn / (tn + fp), kappa, reading };", "return { tpr: tn / (tn + fp), tnr: tp / (tp + fn), kappa, reading };"],
  ["calibration prints numbers from too few labels", "src/cli/calibrate.ts", 'if (labels.length < MIN_APPLIED) return none("too few replies to judge");', 'if (false) return none("too few replies to judge");'],
  ["no-win section ranks the least failed check first", REPORT, "b[1] - a[1] || (a[0] < b[0] ? -1 : 1)", "a[1] - b[1] || (a[0] < b[0] ? -1 : 1)"],
  ["no-win section appears for other stop reasons", REPORT, "if (!budget && !/no winner$/.test(state.stopped)) return [];", "if (false) return [];"],
  ["no-win section drops the add-test-cases ask", REPORT, "if (top.length) asks.push(", "if (false) asks.push("],
  ["no-win section groups hidden-case failures as not clearly better", REPORT, 'outcome.includes("hidden")', 'outcome.includes("never-matches")'],
  ["decide forgets the round's check failure counts", DECIDE, "for (const check of row.failedChecks ?? []) failed[check] = (failed[check] ?? 0) + 1;", ""],
  ["attack subset test inverted", RULE, "const newAttacks = mine.filter((id) => !baselineFailed.has(id));", "const newAttacks = mine.filter((id) => baselineFailed.has(id));"],
  ["an unknown attack result passes", RULE, "if (baseFailed === null || !Array.isArray(mine)) {", "if (false) {"],
  ["attacks leaked into the writer input", SCORE, "const train = scenarios.filter((s) => s.split === \"train\");\n  const holdout", "const train = [...scenarios, ...attacks.map((a) => ({ id: a.id, input: a.input, expected: a.must, split: \"train\" as const }))].filter((s) => s.split === \"train\");\n  const holdout"],
];

const selectedFiles = process.argv.slice(2);
const nameFilter = process.env.MUTATION_MATCH ? new RegExp(process.env.MUTATION_MATCH) : null;
const mutations = allMutations.filter(([name, file]) => (selectedFiles.length === 0 || selectedFiles.includes(file)) && (!nameFilter || nameFilter.test(name)));
if (!mutations.length) throw new Error("No mutations match the requested files");
console.log(`Checking ${mutations.length} mutations${selectedFiles.length ? ` in ${selectedFiles.join(", ")}` : ""}`);
const baseline = spawnSync("node", ["--test", ...TESTS], { stdio: "inherit", timeout: 60000 });
if (baseline.status !== 0) throw new Error("Unmutated tests must pass before checking mutations");

// Every mutated file as it was before the run. Restoring each mutation from its own copy isn't enough on its own: a
// second run at the same time could restore a copy the first had mutated, leaving a break in the source. This check
// caught exactly that once, after it had been committed.
const before = new Map([...new Set(mutations.map(([, file]) => file))].map((f) => [f, readFileSync(f, "utf8")]));

let survived = 0;
for (const [name, file, from, to] of mutations) {
  const original = readFileSync(file, "utf8");
  if (!original.includes(from)) { console.log(`STALE     ${name}`); survived++; continue; }
  const restore = () => writeFileSync(file, original);
  process.once("SIGINT", restore);
  try {
    writeFileSync(file, original.replace(from, to));
    const { status } = spawnSync("node", ["--test", ...TESTS], { stdio: "ignore", timeout: 60000 });
    if (status === 0 || status === null) survived++;
    console.log(`${status === null ? "TIMED OUT" : status === 0 ? "SURVIVED " : "killed   "} ${name}`);
  } finally {
    restore();
    process.removeListener("SIGINT", restore);
  }
}
const changed = [...before].filter(([f, text]) => readFileSync(f, "utf8") !== text).map(([f]) => f);
for (const f of changed) writeFileSync(f, before.get(f));
if (changed.length) console.log(`RESTORED  ${changed.join(", ")}: a file differed from before the run; check no other mutation run was going at the same time`);
console.log(survived ? `FAILED: ${survived} of ${mutations.length} not killed` : `OK: ${mutations.length} of ${mutations.length} killed`);
process.exitCode = survived || changed.length ? 1 : 0;
