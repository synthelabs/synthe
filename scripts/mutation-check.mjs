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
const WORKFLOW = "templates/synthe.yml";

// Every test file, so a new one is never left out of the check.
const TESTS = readdirSync("test").filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`);

const mutations = [
  ["round state loses a concurrent own-key budget", GITHUB, 'saved.ownKeyFromUsd !== undefined', 'false'],
  ["conflicting state writes never retry", GITHUB, 'if (result.status === 409 && attempt < RETRIES) continue;', ''],
  ["event: own key loses to credit", "src/model/client.ts", 'if (key?.trim()) return anthropicModel(key.trim());', 'if (false) return anthropicModel(key.trim());'],
  ["event: credit is treated as busy", "src/loop/failure.ts", 'kind: "credit", message: e.message', 'kind: "busy", message: e.message'],
  ["event: credit requests are retried", "src/model/client.ts", 'refusedHeaders.set("x-should-retry", "false");', 'refusedHeaders.set("x-should-retry", "true");'],
  ["event: credit does not stop the chain", DECIDE, 'state.stopped = "credit";', 'state.stopped = null;'],
  ["event: agent mode prompts", "src/cli/init.ts", 'if (!agent && (await yesNo(io, "Use these checks? Type y, or n to write your own: ")) === false)', 'if ((await yesNo(io, "Use these checks? Type y, or n to write your own: ")) === false)'],
  ["event: codes are mistaken for keys", "src/cli/init.ts", 'const event = !key.startsWith("sk-ant-");', 'const event = key.startsWith("sk-ant-");'],
  ["event: budget is not four dollars", "src/cli/init.ts", 'if (event) goal.budget = { max_usd: EVENT_BUDGET_USD };', 'if (event) goal.budget = { max_usd: 3 };'],
  ["an absent share setting sends data", SHARE, 'goal.share === "numbers" || goal.share === "detail" || goal.share === "full"', 'goal.share !== "none"'],
  ["DO_NOT_TRACK is ignored", "src/cli/init.ts", '["1", "true"].includes(env.DO_NOT_TRACK?.toLowerCase() ?? "")', 'false'],
  ["numbers-only sends text", SHARE, 'if (goal.share !== "detail" && goal.share !== "full") return payload;', 'if (goal.share === "none") return payload;'],
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
  ["spend saved only at the end", DECIDE, "  state.pending = { round, at: record.at, costUsd: input.costUsd };\n  await repo.writeState(state);", "  state.pending = { round, at: record.at, costUsd: input.costUsd };"],
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
  ["restart reopens a finished run", "src/cli/restart.ts", "if (isFinished(stopped) && (!failedOut || /^budget/.test(stopped)) && !roundsRaised && !budgetAvailable) {", "if (false) {"],
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
  ["key resets the own-key budget on every switch", "src/cli/key.ts", "if (state.ownKeyFromUsd !== undefined) {", "if (false) {"],
  ["key takes ANTHROPIC_API_KEY without a terminal", "src/cli/key.ts", "if (!own && !terminal) {", "if (!own && !app && !terminal) {"],
  ["a failed confirm's local files block a retry", "src/cli/init.ts", "      (await io.run(\"gh\", [\"api\", `repos/${slug}/contents/${path}", "      existsSync(join(root, path)) || (await io.run(\"gh\", [\"api\", `repos/${slug}/contents/${path}"],
  ["budget stop keeps offering a fresh key budget", "src/loop/report.ts", "state.ownKeyFromUsd === undefined ? \"Run `npx synthe key`", "true ? \"Run `npx synthe key`"],
  ["proxy sign-in failure reads as a bad key", "src/loop/report.ts", "end.plain === PROXY_AUTH_MESSAGE ? ", "false ? "],
];

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
    const { status } = spawnSync(process.execPath, [...process.execArgv, "--test", ...TESTS], { stdio: "ignore", timeout: 60000 });
    if (status === 0) survived++;
    console.log(`${status === 0 ? "SURVIVED " : "killed   "} ${name}`);
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
